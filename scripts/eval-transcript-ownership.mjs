// End-to-end OWNERSHIP transcript — one threaded conversation, not isolated
// cases. It walks the exact live-QA sequence and asserts the contract at every
// turn: TurnPlan owns the workflow, deterministic evidence owns the cards, and
// the orthotic gate never repeats a seed question through confusion/correction/
// frustration.
//
// Sequence (live QA 2026-06-30):
//   supportive shoes → i can't see any → sandals instead → women's instead →
//   plantar fasciitis both → what? → I said I'm a man → are you stupid →
//   I like the second one → does it come in black → add it to cart →
//   Gabby with a dress → Savannah 7 wide → size 9
//
// Run: node scripts/eval-transcript-ownership.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planTurn, planForcesProductDisplay } from "../app/lib/turn-plan.server.js";
import { maybeRunOrthoticFlow } from "../app/lib/orthotic-flow-gate.server.js";
import { resolveTurnIntent, isBroadGenderRequest, broadGenderRequestGender } from "../app/lib/turn-intent.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const orthoticTree = { intent: "orthotic", definition: JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8")) };

let pass = 0, fail = 0;
const fails = [];
let step = 0;
function turn(label, fn) {
  step += 1;
  const name = `T${step}. ${label}`;
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}

// Assert a TurnPlan-level contract: workflow, searchRequired, cards expected.
function plan(input, { wf, search, cards, gender }) {
  const p = planTurn(input);
  const wfOk = Array.isArray(wf) ? wf.includes(p.workflow) : p.workflow === wf;
  assert.ok(wfOk, `workflow: expected ${JSON.stringify(wf)}, got "${p.workflow}"`);
  assert.equal(p.searchRequired, search, `searchRequired: expected ${search}, got ${p.searchRequired}`);
  assert.equal(planForcesProductDisplay(p), cards, `cardsExpected: expected ${cards}, got ${planForcesProductDisplay(p)}`);
  if (gender !== undefined) assert.equal(p.gender, gender, `gender: expected ${gender}, got ${p.gender}`);
  return p;
}

function mockSse() {
  const events = [];
  return {
    events,
    encoder: { encode: (s) => s },
    controller: { enqueue: (s) => events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim())) },
  };
}
async function orthoticDefers(messages) {
  const { events, encoder, controller } = mockSse();
  const out = await maybeRunOrthoticFlow({ messages, tree: orthoticTree, shop: "t.myshopify.com", controller, encoder });
  assert.equal(out.handled, false, `gate must DEFER, got handled=${out.handled}`);
  const reEmit = events.some((e) => e?.type === "text" && /What kind of shoes will the orthotics go in/i.test(e.text || ""));
  assert.equal(reEmit, false, "gate must NOT re-emit the seed question");
}

console.log("\nownership transcript\n");

// Conversation state we thread forward.
const PRIOR = { hasPriorCards: true };
const FOCUS = { title: "Danika Arch Support Sneaker", handle: "danika-black-dm500w" };
// An active orthotic flow waiting on use-case (gender already given).
const orthoMessages = (lastUser) => [
  { role: "user", content: "I have plantar fasciitis, should I get shoes or orthotics?" },
  { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
  { role: "user", content: "men" },
  { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
  { role: "user", content: lastUser },
];

await turn("'supportive shoes for walking or standing' → condition_reco, cards", () => {
  plan({ message: "Show me supportive shoes for walking or standing all day" },
    { wf: "condition_recommendation", search: true, cards: true });
});

await turn("'i can't see any' → display_recovery (re-show prior), cards", () => {
  plan({ message: "i can't see any", ...PRIOR, priorAssistantText: "Here are our women's supportive walking shoes." },
    { wf: "display_recovery", search: false, cards: true });
});

await turn("'sandals instead' → browse category refinement, search, cards", () => {
  plan({ message: "sandals instead", ...PRIOR },
    { wf: "browse", search: true, cards: true });
});

await turn("'women's instead' → browse gender refinement, gender=women, cards", () => {
  plan({ message: "women's instead", ...PRIOR },
    { wf: "browse", search: true, cards: true, gender: "women" });
});

await turn("'plantar fasciitis, shoes orthotics or both' → condition_reco, cards", () => {
  plan({ message: "I have plantar fasciitis and flat feet. Should I buy shoes, orthotics, or both?" },
    { wf: ["condition_recommendation", "multi_recommendation"], search: true, cards: true });
});

await turn("'what?' → orthotic gate DEFERS on first occurrence (no repeat)", async () => {
  await orthoticDefers(orthoMessages("what?"));
});

await turn("'I said I'm a man' → orthotic gate DEFERS (no repeat)", async () => {
  await orthoticDefers(orthoMessages("i said i'm a man"));
});

await turn("'are you stupid?' → orthotic gate DEFERS (no repeat)", async () => {
  await orthoticDefers(orthoMessages("are you stupid?"));
});

await turn("'I like the second one' → product_focus, no search, cards", () => {
  // chat.jsx resolves the ordinal to a focus card before planTurn; simulate.
  plan({ message: "I like the second one", focusProduct: FOCUS, ...PRIOR },
    { wf: "product_focus", search: false, cards: true });
});

await turn("'does it come in black?' → availability on focus, search, cards", () => {
  plan({ message: "does it come in black?", focusProduct: FOCUS, ...PRIOR },
    { wf: "availability", search: true, cards: true });
});

await turn("'add it to cart' → cart_handoff on focus, no search, cards", () => {
  plan({ message: "add it to my cart", focusProduct: FOCUS, ...PRIOR },
    { wf: "cart_handoff", search: false, cards: true });
});

await turn("'wear Gabby with a dress' → named_product_advisory (styling), cards", () => {
  plan({ message: "i want to wear gabby with a short white dress", namedProduct: true },
    { wf: "named_product_advisory", search: true, cards: true });
});

await turn("'is the Savannah in size 7 wide?' → availability (named), cards", () => {
  plan({ message: "is the Savannah available in size 7 wide?", namedProduct: true },
    { wf: "availability", search: true, cards: true });
});

await turn("'size 9?' → availability follow-up on focus, search, cards", () => {
  plan({ message: "what about size 9?", focusProduct: { title: "Savannah Sandal - Champagne" }, ...PRIOR },
    { wf: "availability", search: true, cards: true });
});

// ── Broad-gender chain (the exact PRD bug) ───────────────────────────────
// supportive shoes (no sneakers) → black? → wide? → heel pain both → for my dad
// → "Show me men's options". By the final turn the scope has accumulated
// category=footwear, color=black, width=wide, condition=heel_pain. The broad
// gender ask must (a) route to browse gender=men, (b) be detected as a broad
// gender request at runtime, (c) DROP all that stale scope at the intent layer.
await turn("CHAIN: 'Show me men's options' → browse gender=men, broad, stale dropped", () => {
  const staleScope = { gender: "men", category: "footwear", color: "black", width: "wide", condition: "heel_pain" };
  const p = planTurn({ message: "Show me men's options", hasPriorCards: true, attrs: { gender: "men" } });
  assert.equal(p.workflow, "browse", `expected browse, got ${p.workflow}`);
  assert.equal(p.gender, "men");
  assert.ok(planForcesProductDisplay(p), "must show cards");
  // Runtime detector the deterministic gender-only pin keys off of.
  assert.equal(isBroadGenderRequest("Show me men's options"), true);
  assert.equal(broadGenderRequestGender("Show me men's options"), "men");
  // Intent layer drops every stale subject-bound constraint (no men's wedges/
  // boots/wide/black/heel-pain search).
  const intent = resolveTurnIntent({ latestUserText: "Show me men's options", previousScope: staleScope });
  for (const k of ["category", "color", "width", "condition"]) {
    assert.ok(intent.staleKeysToDrop.includes(k), `intent must drop ${k}; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  }
});

console.log("");
if (fail === 0) {
  console.log(`✅  ${pass} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${pass} passed, ${fail} failed\n`);
  for (const f of fails) console.log(`  ${f.name}\n    ${f.err.message}`);
  process.exit(1);
}
