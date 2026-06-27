// Latest-turn scope + condition-normalization regressions (PRD 2026-06-27).
//
// These lock the state/ownership-hygiene fixes from the Railway log: a new
// independent ask must NOT inherit the prior turn's category/color/condition/
// use-case; generic category words ("sneaker", "sandal") are never named
// product families; "Morton's neuroma" must never collapse into
// plantar_fasciitis; and a content-free reply ("not sure") never infers a
// condition. Pure modules → no DB / no LLM, fast and deterministic.

import assert from "node:assert/strict";
import {
  classifyTurnScope,
  isFollowUpTurn,
  scopeAttributesToTurn,
  isShortAmbiguousReply,
  hasPriorContext,
} from "../app/lib/turn-scope.js";
import { conditionFromText, statesAnyCondition } from "../app/lib/condition-normalize.js";
import { extractCatalogProductFamilies } from "../app/lib/catalog-resolver.server.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fail++; }
}

// Prior-turn facts standing in for "flat feet, black, sneaker" carried from a
// previous recommendation — the exact stale state the log shows leaking.
const PRIOR = {
  condition: "flat_feet",
  color: "black",
  category: "sneakers",
  useCase: "work",
  family: "sneaker",
};
const PRIOR_OPTS = { priorCardCount: 2, priorAttributes: PRIOR };

console.log("\n── Fix 1: latest-turn scope ──");

// Case B — explicit deictic follow-up keeps prior context.
check("B: 'Do any of those come in black?' → follow_up", () => {
  const r = classifyTurnScope("Do any of those come in black?", PRIOR_OPTS);
  assert.equal(r.scope, "follow_up");
  assert.equal(isFollowUpTurn("Do any of those come in black?", PRIOR_OPTS), true);
});

// Case C — a fresh independent need must NOT inherit flat_feet / black /
// sneaker; it searches only the current-turn vacation/walking/cute evidence.
check("C: 'vacation … cute' → new_independent, wipes flat_feet/black/sneaker", () => {
  const msg = "I'm going on vacation and walking a lot, but I still want something cute.";
  const r = classifyTurnScope(msg, PRIOR_OPTS);
  assert.equal(r.scope, "new_independent");
  const scoped = scopeAttributesToTurn(PRIOR, msg, { isFollowUp: false });
  assert.equal(scoped.condition, null, "flat_feet must be dropped");
  assert.equal(scoped.color, null, "black must be dropped");
  assert.equal(scoped.category, null, "sneaker category must be dropped");
  // useCase IS supported by THIS message (vacation/walking) → kept.
  assert.equal(scoped.useCase, "work"); // value untouched; only presence gates it
});

check("C: follow-up flag keeps everything (no accidental wipe on follow_up)", () => {
  const msg = "Do any of those come in black?";
  const scoped = scopeAttributesToTurn(PRIOR, msg, { isFollowUp: true });
  assert.deepEqual(scoped, PRIOR);
});

check("D: 'plantar fasciitis … 10-hour shifts' keeps condition + useCase", () => {
  const msg =
    "I have plantar fasciitis and flat feet, and I stand on concrete for 10-hour shifts. " +
    "Should I be looking at orthotics, shoes, or both?";
  // No prior context here — this is the opening turn, but the per-attribute
  // detectors must still recognize the condition/use-case it states.
  const scoped = scopeAttributesToTurn(
    { condition: "plantar_fasciitis", useCase: "standing", color: "black" },
    msg,
    { isFollowUp: false },
  );
  assert.equal(scoped.condition, "plantar_fasciitis", "condition is stated this turn");
  assert.equal(scoped.useCase, "standing", "use-case is stated this turn");
  assert.equal(scoped.color, null, "no color stated this turn → drop stale black");
});

check("no prior context → every turn is independent", () => {
  assert.equal(hasPriorContext({ priorCardCount: 0, priorAttributes: null }), false);
  assert.equal(classifyTurnScope("anything at all", {}).scope, "new_independent");
});

console.log("\n── Fix 2: generic category words are never named families ──");

// Aetrex-style catalog: products named by family, plus a generic-sounding
// title to prove the singular category word still doesn't match.
const FACTS = [
  { title: "Jillian Braided Quarter Strap Sandal" },
  { title: "Tamara Slingback Sandal" },
  { title: "Danika Lace-Up Sneaker" },
  { title: "Chelsea Ankle Boot" },
];

check("A: 'one sandal and one sneaker for flat feet' extracts NO families", async () => {
  const fams = await extractCatalogProductFamilies(
    "test-shop",
    "Show me one sandal and one sneaker that would be good for flat feet.",
    { _testFacts: FACTS },
  );
  assert.deepEqual(fams, [], `expected [] but got ${JSON.stringify(fams)}`);
});

check("named family ('Jillian') still resolves — generic guard isn't over-broad", async () => {
  const fams = await extractCatalogProductFamilies(
    "test-shop",
    "Tell me about the Jillian.",
    { _testFacts: FACTS },
  );
  assert.deepEqual(fams, ["jillian"]);
});

console.log("\n── Fix 6: condition normalization (Morton's neuroma ≠ plantar fasciitis) ──");

check("F: \"Morton's neuroma\" → mortons_neuroma (never plantar_fasciitis)", () => {
  assert.equal(conditionFromText("For Morton's neuroma, do I need metatarsal or arch support?"), "mortons_neuroma");
  assert.equal(conditionFromText("mortons neuroma"), "mortons_neuroma");
  assert.equal(conditionFromText("I have a neuroma"), "mortons_neuroma");
});
check("plantar fasciitis → plantar_fasciitis", () => {
  assert.equal(conditionFromText("I have plantar fasciitis"), "plantar_fasciitis");
  assert.equal(conditionFromText("plantar fasciitis and flat feet"), "plantar_fasciitis");
});
check("metatarsalgia / ball-of-foot → metatarsalgia", () => {
  assert.equal(conditionFromText("metatarsalgia"), "metatarsalgia");
  assert.equal(conditionFromText("pain in the ball of my foot"), "metatarsalgia");
  assert.equal(conditionFromText("forefoot pain"), "metatarsalgia");
});
check("heel pain vs heel spur disambiguate", () => {
  assert.equal(conditionFromText("heel pain"), "heel_pain");
  assert.equal(conditionFromText("heel spurs"), "heel_spurs");
});
check("diabetic / neuropathy → diabetic", () => {
  assert.equal(conditionFromText("I'm diabetic"), "diabetic");
  assert.equal(conditionFromText("diabetes"), "diabetic");
  assert.equal(conditionFromText("peripheral neuropathy"), "diabetic");
});
check("E: \"Not sure\" infers NO condition (null, not metatarsalgia)", () => {
  assert.equal(conditionFromText("Not sure"), null);
  assert.equal(conditionFromText("maybe"), null);
  assert.equal(conditionFromText("I don't know"), null);
  assert.equal(statesAnyCondition("Not sure"), false);
});
check("'no specific pain / just comfort' → none only when allowNone", () => {
  assert.equal(conditionFromText("just comfort, no specific pain"), null);
  assert.equal(conditionFromText("just comfort, no specific pain", { allowNone: true }), "none");
  // ambiguous replies must NOT become "none" even with allowNone
  assert.equal(conditionFromText("not sure", { allowNone: true }), null);
});

console.log("\n── Fix 5: short / ambiguous reply only answers an active question ──");

check("E: 'Not sure' is a short-ambiguous reply", () => {
  assert.equal(isShortAmbiguousReply("Not sure"), true);
  assert.equal(isShortAmbiguousReply("not sure"), true);
  assert.equal(isShortAmbiguousReply("maybe"), true);
  assert.equal(isShortAmbiguousReply("I don't know"), true);
  assert.equal(isShortAmbiguousReply("idk"), true);
  assert.equal(isShortAmbiguousReply("either"), true);
});
check("a real ask is NOT a short-ambiguous reply", () => {
  assert.equal(isShortAmbiguousReply("I have plantar fasciitis"), false);
  assert.equal(isShortAmbiguousReply("Show me sandals for the beach"), false);
  assert.equal(isShortAmbiguousReply("not sure but I have heel pain"), false); // >4 words
});

console.log("");
console.log(`turn-scope eval: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
