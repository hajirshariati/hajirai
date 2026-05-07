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

await test("falls through when reply doesn't map", async () => {
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
  assert.equal(out.handled, false);
  assert.equal(events.length, 0);
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

await test("emits next question on Layer-2 keyword reply ('for my mom')", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "for my mom" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, true);
  assert.equal(events[0].type, "text");
  // Should advance to q_condition (next after q_gender).
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
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      // 65 years old: no chip text, no pronoun, no kin keyword —
      // L1 + L2 both miss, so the gate must call Layer 3.
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
  // Should advance to q_condition.
  assert.match(events[0].text, /pain or condition/i);
});

await test("Layer 3: returns null → falls through to LLM", async () => {
  const { events, encoder, controller } = makeMockSse();
  const fakeAnthropic = {
    messages: {
      create: async () => ({ content: [{ text: '{"value":null}' }] }),
    },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "assistant", content: "Who are these for? <<Men>><<Women>><<Kids>>" },
      { role: "user", content: "I'm not really sure how to answer that" },
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
