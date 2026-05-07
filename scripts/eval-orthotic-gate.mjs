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
  // Walks root → q_use_case (no useCase known) → emit q_use_case.
  assert.match(events[0].text, /What kind of shoes/i);
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

await test("bootstrap: 'I need orthotics' → emits q_use_case (no prior assistant)", async () => {
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
  assert.match(events[0].text, /What kind of shoes/i);
  // Seed-byte-exact chips so the next turn's chip click maps via Layer 1.
  assert.match(events[0].text, /<<Dress shoes>>/);
  assert.match(events[0].text, /<<Everyday \/ casual shoes>>/);
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
  // condition=plantar_fasciitis prefilled. With no useCase/gender, bootstrap
  // walks from root → q_use_case (use-case is the root, not skipped).
  assert.match(events[0].text, /What kind of shoes/i);
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
