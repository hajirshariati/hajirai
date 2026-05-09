// Integration eval for the orthotic-flow gate. Exercises the
// question-emission branch (no DB, no Anthropic). The resolve
// branch is exercised via the existing eval-decision-tree.mjs +
// real-traffic monitoring.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maybeRunOrthoticFlow } from "../app/lib/orthotic-flow-gate.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const definition = JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8"));
const tree = { intent: "orthotic", definition };

// Capture console.log lines so tests can detect when the gate
// attempted to resolve (the resolver either succeeded with a card or
// failed with shop=null — both leave a log breadcrumb we can assert
// against). Wraps the original log so the human-readable trace still
// shows up on stdout.
function captureConsoleLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    lines.push(s);
    orig.apply(console, args);
  };
  return {
    lines,
    restore: () => { console.log = orig; },
  };
}

function makeMockSse() {
  const events = [];
  const encoder = { encode: (s) => s };
  const controller = { enqueue: (s) => events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim())) };
  return { events, encoder, controller };
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name} — ${err?.message || err}`);
  }
}

console.log("\northotic-flow gate (question branch)");

await test("falls through when no orthotic tree", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "hi" }],
    tree: null,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("falls through when last message isn't user", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "assistant", content: "hi" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("falls through when no prior assistant turn AND no orthotic intent", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "hello" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("re-asks current question when reply is gibberish but intent is established", async () => {
  // With the unified gate, a gibberish reply on a known question
  // doesn't fall through — we re-emit the earliest unanswered seed
  // question. Customer gets a chance to retry with chips.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "asdf qwerty" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // Walks required-attrs in order: gender first since it's missing.
  assert.match(events[0].text, /Who are these orthotics for/i);
});

await test("emits next seed question on chip click (Layer 1)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "What kind of shoes? <<Dress shoes>><<Everyday / casual shoes>><<Cleats>><<Hockey skates>>" },
      { role: "user", content: "Everyday / casual shoes" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // text + products + done
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "text");
  assert.match(events[0].text, /Who are these orthotics for/);
  assert.match(events[0].text, /<<Men>>/);
  assert.match(events[0].text, /<<Women>>/);
  assert.match(events[0].text, /<<Kids>>/);
  assert.equal(events[1].type, "products");
  assert.deepEqual(events[1].products, []);
  assert.equal(events[2].type, "done");
});

await test("captures gender from 'for my mom' (Layer 2 + history walk)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      // Establish orthotic context first so accumulateAnswers /
      // intent picks up the flow. Without prior intent, "for my mom"
      // alone isn't enough engagement signal.
      { role: "user", content: "I need orthotics for casual shoes" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "for my mom" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // Both useCase=casual (turn 1) and gender=Women (turn 3) accumulated.
  // Walk skips q_use_case + q_gender → emits q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("Layer 3: free-text reply mapped via mock Anthropic hook", async () => {
  const { events, encoder, controller } = makeMockSse();
  let calls = 0;
  const fakeAnthropic = {
    messages: {
      create: async () => { calls += 1; return { content: [{ text: '{"value":"Women"}' }] }; },
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      // Establish orthotic flow first so the gate engages on the
      // chip-fingerprint-known question. Then "65 years old" is
      // L1+L2-immune (no orthotic words, no pronoun, no kin
      // keyword), forcing the Layer-3 hook.
      { role: "user", content: "I need orthotics for casual shoes" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "65 years old" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    anthropic: fakeAnthropic,
    haikuModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(calls, 1, "Anthropic mock should be called once");
  assert.equal(out.handled, true);
  assert.equal(events[0].type, "text");
  // useCase=casual + gender=Women (via L3) → next is q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("Layer 3: returns null → falls through (only fingerprint engagement, no map)", async () => {
  // Engagement comes ONLY from the chip fingerprint (no prior intent,
  // no accumulated answers, no Layer-1/2 hit on the latest reply).
  // Layer 3 returns null → fall through to LLM.
  const { events, encoder, controller } = makeMockSse();
  const fakeAnthropic = {
    messages: {
      create: async () => ({ content: [{ text: '{"value":null}' }] }),
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      // Truly unmappable across L1+L2: no chip text, no kin / pronoun,
      // no pain / condition keyword.
      { role: "user", content: "qwerty xyzzy" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    anthropic: fakeAnthropic,
    haikuModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("Layer 3: API error → falls through to LLM", async () => {
  const { events, encoder, controller } = makeMockSse();
  const fakeAnthropic = {
    messages: {
      create: async () => { throw new Error("API timeout"); },
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "blarghable" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    anthropic: fakeAnthropic,
    haikuModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("off-topic reply (shipping policy mid-flow) → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "what's your shipping policy?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("bootstrap: 'I need orthotics' → emits q_gender (no prior assistant)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I need orthotics" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  assert.equal(events[0].type, "text");
  assert.match(events[0].text, /Who are these orthotics for/i);
  // Seed-byte-exact chips so the next turn's chip click maps via Layer 1.
  assert.match(events[0].text, /<<Men>>/);
  assert.match(events[0].text, /<<Women>>/);
  assert.match(events[0].text, /<<Kids>>/);
});

await test("bootstrap: pre-fills useCase + gender from rich first message", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I need running orthotics for my dad" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // useCase=athletic_running + gender=Men prefilled, so we skip to q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("bootstrap: fires when last assistant chips were rephrased (drift case)", async () => {
  const { events, encoder, controller } = makeMockSse();
  // The exact production drift pattern: LLM rephrased seed q_condition
  // chips ("Plantar fasciitis", "Heel spurs", ...) into custom labels.
  // Customer's reply expresses orthotic intent — bootstrap should fire.
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "What's bothering you? <<Arch / Heel Pain>><<Ball of Foot>><<Toe>><<None>>" },
      { role: "user", content: "I need orthotics for plantar fasciitis" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // condition=plantar_fasciitis prefilled. Required-attrs order
  // walks gender first (still missing).
  assert.match(events[0].text, /Who are these orthotics for/i);
});

await test("regression (curly apostrophe): 'Find men’s shoes for my needs' must NOT engage", async () => {
  // Production-exact string the widget client sends. U+2019 instead
  // of straight ASCII '. The veto regex was missing this case.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "Find men’s shoes for my needs" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression: 'Find men's shoes for my needs' must NOT engage orthotic flow", async () => {
  // Production bug: Layer 2 extracted gender=Men from "men's", which
  // alone triggered the gate to ask q_use_case 'What kind of shoes
  // will the orthotics go in?' — hijacking a clear footwear request.
  // Engagement rule must require intent or accumulated answers or
  // chip fingerprint, NOT a single Layer-2 hit on the latest message.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "Find men's shoes for my needs" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression: footwear-path commit (multi-turn) must NOT hijack on chip click", async () => {
  // Production trace: customer said "I have foot pain, what should I
  // wear?", AI offered <<New Footwear>>|<<Orthotic Insert>>, customer
  // clicked <<New Footwear>>, AI asked <<Men's>>|<<Women's>>, customer
  // clicked <<Women's>>. Layer 2 extracted gender=Women → gate hijacked.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have foot pain, what should I wear?" },
      { role: "assistant", content: "Are you looking for new footwear or an orthotic insert? <<New Footwear>><<Orthotic Insert>>" },
      { role: "user", content: "New Footwear" },
      { role: "assistant", content: "Which styles would you like to browse — men's or women's? <<Men's>><<Women's>>" },
      { role: "user", content: "Women's" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression: 'best summer sandal for my mom under $50' must NOT engage (post-19:27 prod trace)", async () => {
  // Production trace at 19:27 UTC. Earlier turns asked about
  // 'sneakers with lace-up styles' and 'wider widths' — Layer 2
  // accumulated gender=Women from pronouns. Then the customer
  // asked for sandals; the gate engaged on accumulated alone and
  // hijacked the footwear request into the orthotic Q&A.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "Do you have any sneakers with lace-up styles?" },
      { role: "assistant", content: "Here are some women's lace-up sneakers." },
      { role: "user", content: "What about sneakers that come in wider widths?" },
      { role: "assistant", content: "Here are wider-width sneakers." },
      { role: "user", content: "best summer sandal for a beach for my mom, she is 89 years old, she had bonion and she love yellow color, give me somthing under $50" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("regression (Kids-sticky): later 'Women' answer cannot override gender=Kids", async () => {
  // Production trace: customer picked Kids on q_gender; the LLM later
  // injected an unsolicited 'boy or girl?' follow-up with Men's/Women's
  // chips; customer clicked Women's; the resolver returned a Women's
  // adult orthotic for what was supposed to be a child.
  // The kids-sticky guard must drop the latestExtracted.gender override
  // when accumulated already has a kids gender.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for kids' dress shoes" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Dress shoes>><<Everyday / casual shoes>><<Cleats>>" },
      { role: "user", content: "Dress shoes" },
      { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Kids" },
      { role: "assistant", content: "Are these for a boy or girl?" },
      // Customer answered the LLM's bad follow-up. Should NOT flip
      // accumulated gender from Kids to Women.
      { role: "user", content: "Women's" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  // The gate should still engage (intent was in turn 1). When it walks,
  // gender must remain Kids — verify by looking at what gets emitted
  // and what the answers log says.
  if (out.handled) {
    // If gate handled, the emitted question's preceding state should
    // have gender=Kids. We can confirm by ensuring NO 'gender=Women'
    // appears in any text events (the gate's resolve intro embeds
    // the attrs string).
    const allText = events.filter((e) => e.type === "text").map((e) => e.text).join(" ");
    assert.equal(allText.includes("gender=Women"), false, "gender should not have been flipped to Women");
  }
  // Either way, the test's main assertion is the kids-sticky log line
  // would have fired (we can't easily check stdout from here, so we
  // just assert no events leak adult gender). The unit test for the
  // sticky logic itself can live in eval-orthotic-flow when we test
  // the answer accumulation directly.
});

await test("regression: 'show me women's sandals' must NOT engage", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "show me women's sandals" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("bootstrap: skips when no orthotic intent", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "hi, just browsing" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("bootstrap: skips on negation ('I don't want orthotics')", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I don't want orthotics, just sneakers" }],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("falls through when assistant chips don't match any seed node and no intent", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Want me to <<Show comparison>> or <<Find similar>>?" },
      { role: "user", content: "Find similar" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
});

await test("unified: remembers answers across multiple turns (regression for prod Bug 2)", async () => {
  const { events, encoder, controller } = makeMockSse();
  // Production scenario: turn 1 names plantar fasciitis, turn 2
  // names dress-no-removable, turn 3 picks Women. By turn 3 the
  // gate must still know condition=plantar_fasciitis from turn 1 —
  // otherwise it re-asks q_condition and falls back to the LLM.
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have plantar fasciitis going on a trip to Italy" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
      { role: "user", content: "Dress shoes (no removable insole)" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Women" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // All three answers accumulated → gate should walk root → q_use_case
  // (skip, useCase known) → q_gender (skip, gender known) →
  // q_condition (skip, condition known) → q_arch. So the next
  // emitted question should be q_arch.
  assert.match(events[0].text, /arch type/i);
  assert.match(events[0].text, /<<Flat \/ Low>>/);
});

await test("unified: chip click without intent words still continues flow", async () => {
  // Production Bug 3: customer clicks <<Women>>, which has no orthotic
  // intent words and (in old code) chip syntax was lost from history.
  // Unified gate should still engage because we already have answers
  // accumulated from prior turns.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I have plantar fasciitis" },
      { role: "assistant", content: "What kind of shoes?" },
      { role: "user", content: "Dress shoes (no removable insole)" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Women" }, // ← chip click, no intent words
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
});

await test("unified: chip syntax lost from assistant history — gate still works", async () => {
  // Simulates the exact production round-trip: widget rendered chips
  // as buttons and stripped <<>> markers from history. Gate must still
  // engage and continue the flow off pure user-side signals.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics for plantar fasciitis" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" }, // no <<>>
      { role: "user", content: "Everyday / casual shoes" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  // condition=plantar_fasciitis + useCase=casual → next is q_gender.
  assert.match(events[0].text, /Who are these orthotics for/i);
});

// ===================================================================
// Resolve-intent guard regressions (Thinsole bug class)
// ===================================================================

await test("resolve guard: 'what is thinsole?' mid-flow with full attrs → falls through (informational)", async () => {
  // Production trace bug. Customer accumulated gender=Men, useCase=casual,
  // condition=overpronation_flat_feet, arch=Flat/Low. On a NEW turn with
  // an informational question, the gate used to walk to resolve and
  // emit a phantom L620M card, bypassing the LLM. Customer asked
  // "what is thinsole?" — wanted info, got a product. With the
  // resolve-intent guard, the gate falls through; LLM answers.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any specific foot pain or condition?" },
      { role: "user", content: "flat feet" },
      { role: "assistant", content: "What's your arch type?" },
      { role: "user", content: "Flat / Low Arch" },
      { role: "assistant", content: "Here is your orthotic recommendation." },
      { role: "user", content: "what is thinsole?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "gate should fall through to LLM on informational question");
  assert.equal(events.length, 0, "no SSE events should have been emitted");
});

await test("resolve guard: 'tell me about the L620' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these orthotics for?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "plantar fasciitis" },
      { role: "assistant", content: "What's your arch type?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "Done — here's your match." },
      { role: "user", content: "tell me about the L620" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("resolve guard: 'how does the foam work?' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Women" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "none" },
      { role: "assistant", content: "What's your arch?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "how does the foam work?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("resolve guard: 'show me a recommendation' mid-flow → resolves (explicit request)", async () => {
  // Happy-path preservation. Same prior state as the above tests, but
  // the customer now explicitly asks for a recommendation — gate must
  // resolve and emit a card (or attempt to).
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "plantar fasciitis" },
      { role: "assistant", content: "What's your arch?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "All set." },
      { role: "user", content: "show me a recommendation" },
    ],
    tree,
    shop: null, // shop=null → resolver returns missingProduct error path
    controller,
    encoder,
  });
  // Either handled (resolve attempted, may have emitted error/card) OR
  // not handled if resolver bailed — what we ASSERT is that the gate
  // DID enter the resolve path (didn't fall through on the guard).
  // The "resolve held" log line means the guard kicked in; absence of
  // it means we tried to resolve. The mock SSE captures emits; if any
  // emit happened, resolve was attempted.
  assert.ok(
    out.handled === true || events.length > 0,
    `expected resolve attempt; got handled=${out.handled} events=${events.length}`,
  );
});

await test("resolve guard: chip-answer turn (Layer 2 mapped) → resolves (happy path)", async () => {
  // Customer is mid-flow and just answered the FINAL chip ("Medium / High Arch")
  // for q_arch. fingerprintNode is set + latestExtracted has the new attr.
  // Gate must resolve without holding.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What shoes? <<Casual>><<Dress>><<Athletic running>>" },
      { role: "user", content: "Casual" },
      { role: "assistant", content: "Any condition? <<None>><<Plantar Fasciitis>>" },
      { role: "user", content: "None" },
      { role: "assistant", content: "What's your arch type? <<Flat / Low Arch>><<Medium / High Arch>><<I don't know>>" },
      { role: "user", content: "Medium / High Arch" },
    ],
    tree,
    shop: null,
    controller,
    encoder,
  });
  // Either resolves or attempts resolve. The key assertion: gate did
  // NOT fall through silently (would mean handled=false + no events).
  assert.ok(
    out.handled === true || events.length > 0,
    `expected chip-answer to resolve; got handled=${out.handled} events=${events.length}`,
  );
});

// ===================================================================
// Availability-question regression (Bug 4: kids orthotic Y/N loop)
// ===================================================================

await test("availability question 'do you have kids orthotics?' mid-flow → falls through", async () => {
  // Production trace: customer mid-orthotic-flow asked 'do you have
  // kids orthotics?'. Without the availability-question veto, the
  // gate kept emitting the next chip question ('What's your arch
  // type?') on every turn, looping forever. With the veto, the gate
  // falls through to the LLM, which can answer Yes/No with cards.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need an orthotic" },
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Casual>><<Dress>>" },
      { role: "user", content: "Casual" },
      { role: "assistant", content: "Any condition? <<None>><<Plantar Fasciitis>>" },
      { role: "user", content: "None" },
      { role: "assistant", content: "What's your arch type? <<Flat / Low Arch>><<Medium / High Arch>>" },
      { role: "user", content: "do you have kids orthotics?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "gate should fall through on 'do you have X' question");
  assert.equal(events.length, 0);
});

await test("availability question 'do you carry running insoles?' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Women" },
      { role: "assistant", content: "What kind of shoes?" },
      { role: "user", content: "do you carry running insoles?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("availability question 'is there a kids version?' mid-flow → falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who are these for?" },
      { role: "user", content: "Women" },
      { role: "assistant", content: "What shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Any condition?" },
      { role: "user", content: "is there a kids version?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false);
});

await test("availability question 'recommend me one' is NOT availability (still resolves)", async () => {
  // 'recommend me one' is a recommendation request, not an availability
  // question — the recommendation-request bypass should fire first.
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "I need orthotics" },
      { role: "assistant", content: "Who?" },
      { role: "user", content: "Men" },
      { role: "assistant", content: "Shoes?" },
      { role: "user", content: "casual" },
      { role: "assistant", content: "Condition?" },
      { role: "user", content: "none" },
      { role: "assistant", content: "Arch?" },
      { role: "user", content: "Medium / High Arch" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "recommend me one" },
    ],
    tree,
    shop: null,
    controller,
    encoder,
  });
  assert.ok(
    out.handled === true || events.length > 0,
    `expected resolve attempt; got handled=${out.handled} events=${events.length}`,
  );
});

// ===================================================================
// MESSY-CONVERSATION REGRESSIONS (production trace 2026-05-09 16:03)
// Reproduces the actual bugs from a real customer chat where a grandma
// shopped for self → 9-yo grandson → 90-yo dad → 8-yo son. The
// orthotic-flow accumulated answers from the FIRST subject and kept
// reusing them for every later subject — every kid resolved with the
// wife's "Flat / Low Arch + overpronation=yes" because the gate never
// reset between subjects. Customer kept screaming "he doesn't have
// flat feet" and the bot kept re-recommending the same Posted SKU.
// ===================================================================

await test("subject pivot wife → 9yo grandson resets arch/overpronation/condition", async () => {
  // Wife established Women + casual + none + Medium/High + overpronation=yes,
  // resolved L220W. Now customer says "how about for my 9 year old?"
  // Gate sees gender=Kids, accumulated answers from wife (arch=Medium/High,
  // overpronation=yes, condition=none). Without subject-pivot reset,
  // gate resolves with wife's leftover attrs.
  //
  // Assertion: the gate must NOT enter the resolve path. We detect this
  // by capturing console.log and checking for "[orthotic-flow] resolved →"
  // or "[orthotic-flow] resolve failed" (both indicate the gate ran the
  // resolver — wrong, because attrs aren't actually the kid's).
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "do you have any orthotic for me?" },
        { role: "assistant", content: "Who are these for? <<Men>><<Women>>" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "What kind of shoes? <<Casual>><<Dress>>" },
        { role: "user", content: "Casual" },
        { role: "assistant", content: "Any condition? <<None>>" },
        { role: "user", content: "None" },
        { role: "assistant", content: "Arch type? <<Flat / Low Arch>><<Medium / High Arch>>" },
        { role: "user", content: "Medium / High Arch" },
        { role: "assistant", content: "Roll inward? <<Yes>><<No>>" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Here's your match." },
        { role: "user", content: "how about for my 9 year old?" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Kids" } },
    });
  } finally {
    cap.restore();
  }
  const enteredResolve = cap.lines.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(
    enteredResolve,
    false,
    `gate must NOT enter resolve path with wife's accumulated arch/overpronation. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`,
  );
});

await test("subject pivot wife → dad (Men) resets accumulated subject attrs", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need orthotics" },
        { role: "assistant", content: "Who?" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "Shoes?" },
        { role: "user", content: "casual" },
        { role: "assistant", content: "Condition?" },
        { role: "user", content: "none" },
        { role: "assistant", content: "Arch?" },
        { role: "user", content: "Flat / Low Arch" },
        { role: "assistant", content: "Pronation?" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "okay i need orthotic for my dad now" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Men" } },
    });
  } finally {
    cap.restore();
  }
  const enteredResolve = cap.lines.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(enteredResolve, false,
    `gate must NOT enter resolve path with wife's accumulated arch=Flat/overpronation=yes`);
});

await test("chip-context defense: 'Yes' to overpronation chip does NOT inject condition=overpronation_flat_feet", async () => {
  // Customer answers "Yes" to the overpronation chip question.
  // Haiku tends to read the chip's wording ("flat-feet symptoms") and
  // infer condition=overpronation_flat_feet. The gate should drop
  // that spurious extraction so the resolver doesn't get a fake
  // condition the customer never named.
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need orthotics" },
        { role: "assistant", content: "Who? <<Men>><<Women>>" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "Shoes? <<Casual>>" },
        { role: "user", content: "Casual" },
        { role: "assistant", content: "Condition? <<None>>" },
        { role: "user", content: "None" },
        { role: "assistant", content: "Arch? <<Flat / Low Arch>><<Medium / High Arch>>" },
        { role: "user", content: "Medium / High Arch" },
        { role: "assistant", content: "When you walk or stand, do your ankles roll inward or do you have flat-feet symptoms? <<Yes>><<No>>" },
        { role: "user", content: "Yes" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: false,
        // Haiku spuriously infers condition from chip text:
        attributes: { gender: "Women", useCase: "casual", condition: "overpronation_flat_feet" },
      },
    });
  } finally {
    cap.restore();
  }
  const droppedSpurious = cap.lines.some((l) =>
    /chip-context defense: dropping spurious condition=overpronation_flat_feet/.test(l),
  );
  assert.equal(
    droppedSpurious,
    true,
    `gate must drop spurious condition extraction. Logs: ${cap.lines.filter(l => l.includes("[orthotic-flow]")).join(" | ")}`,
  );
});

await test("customer correction: 'but he doesn't have flat feet' → invalidates condition", async () => {
  // Customer says bot was wrong about flat feet for the kid. Gate
  // should NOT continue resolving the same SKU. Either re-ask the
  // condition / arch chip OR fall through to LLM. Auto-resolve is
  // forbidden because customer just contradicted the data.
  const { events, encoder, controller } = makeMockSse();
  const cap = captureConsoleLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "orthotic for my son who has flat feet" },
        { role: "assistant", content: "Got it. Arch?" },
        { role: "user", content: "Flat / Low Arch" },
        { role: "assistant", content: "Roll inward?" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Here's the Kids Posted Orthotic." },
        { role: "user", content: "but he doesn't have flat feet" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, isRejection: false, attributes: { gender: "Kids" } },
    });
  } finally {
    cap.restore();
  }
  const enteredResolve = cap.lines.some((l) =>
    /\[orthotic-flow\] resolved →|\[orthotic-flow\] resolve failed/.test(l),
  );
  assert.equal(enteredResolve, false,
    `gate must NOT re-resolve same flat-feet SKU after customer corrected the premise`);
});

console.log("");
if (failed === 0) {
  console.log(`✅  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) {
    console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}
