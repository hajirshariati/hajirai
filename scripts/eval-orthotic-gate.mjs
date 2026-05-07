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

await test("falls through when no prior assistant chip turn", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "I need orthotics" }],
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

await test("falls through when assistant chips don't match any seed node", async () => {
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
