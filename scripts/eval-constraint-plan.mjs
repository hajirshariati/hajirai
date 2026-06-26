// ConstraintPlan / EvidencePlan — the structured decomposition layer.
//
// Run: node scripts/eval-constraint-plan.mjs

import assert from "node:assert/strict";
import {
  extractConstraintPlan,
  detectCategoryNouns,
  isCompatibilityAsk,
  isMultiRecommendationAsk,
  CATEGORY_NOUN_SET,
} from "../app/lib/constraint-plan.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}
const plan = (message, extra = {}) => extractConstraintPlan({ message, ...extra });

// ── #2. Category nouns are NEVER product families ─────────────────────
check("category nouns are recognized as categories", () => {
  for (const w of ["sandal", "sandals", "sneaker", "sneakers", "slipper", "slippers", "boot", "boots", "wedge", "wedges", "loafer", "loafers", "orthotic", "orthotics", "shoe", "shoes"]) {
    assert.ok(CATEGORY_NOUN_SET.has(w), `"${w}" should be a category noun`);
  }
});
check("a category noun passed as namedFamily is stripped from productFamilies", () => {
  const p = plan("Compare Jillian and the sandals", { namedFamilies: ["jillian", "sandal", "sandals", "savannah"] });
  assert.deepEqual(p.productFamilies, ["jillian", "savannah"]);
});
check("'show me sandals' yields category sandals, NO product family", () => {
  const p = plan("show me sandals");
  assert.deepEqual(p.categories, ["sandals"]);
  assert.deepEqual(p.productFamilies, []);
});

// ── #3. Multi-recommendation → one slot per category ──────────────────
check("'one sandal, one sneaker, and one slipper for heel pain' → 3 slots", () => {
  const p = plan("Give me one sandal, one sneaker, and one slipper for heel pain");
  assert.equal(p.askType, "multi_recommendation");
  assert.deepEqual(p.categories, ["sandals", "sneakers", "slippers"]);
  assert.equal(p.slots.length, 3, "exactly one slot per category");
  assert.equal(p.conditions[0], "heel pain");
  for (const s of p.slots) { assert.equal(s.limit, 1); assert.match(s.query, /heel pain/); }
  assert.match(p.slots[0].query, /sandals/);
  assert.match(p.slots[1].query, /sneakers/);
  assert.match(p.slots[2].query, /slippers/);
});
check("'heel pain' is a CONDITION, not the Heels category", () => {
  const p = plan("Give me one sandal for heel pain");
  assert.ok(!p.categories.includes("heels"), `categories leaked heels: ${p.categories}`);
  assert.deepEqual(p.conditions, ["heel pain"]);
});
check("'flat feet' is a CONDITION, not the Flats category", () => {
  const p = plan("supportive sandals for flat feet");
  assert.ok(!p.categories.includes("flats"), `categories leaked flats: ${p.categories}`);
  assert.deepEqual(p.conditions, ["flat feet"]);
});
check("'wedges and heels for a wedding' → heels IS a category here", () => {
  const p = plan("show me cute wedges and heels for a wedding");
  assert.deepEqual(p.categories, ["wedges", "heels"]);
  assert.equal(p.useCases[0], "wedding");
});

// ── #8a. orthotics + supportive sandals (mixed recommendation) ────────
check("'orthotics AND supportive sandals for flat feet' → multi, searches sandals", () => {
  const p = plan("I need orthotics AND supportive sandals for my flat feet — what should I buy?");
  assert.equal(p.askType, "multi_recommendation");
  assert.ok(p.categories.includes("sandals"));
  assert.ok(p.categories.includes("orthotics"));
  assert.ok(p.slots.some((s) => s.category === "sandals" && /supportive/.test(s.query)));
});

// ── #4 / #8b. Compatibility — not a browse ────────────────────────────
check("'Can I put orthotics inside the Jillian sandal?' → compatibility", () => {
  const p = plan("Can I put orthotics inside the Jillian sandal?", { namedFamilies: ["jillian"] });
  assert.equal(p.askType, "compatibility");
  assert.deepEqual(p.productFamilies, ["jillian"]);
  assert.equal(p.slots.length, 0, "compatibility builds no broad browse slots");
});
check("compatibility detector: containment vs shopping", () => {
  assert.equal(isCompatibilityAsk("can I put my orthotics in the Jillian?"), true);
  assert.equal(isCompatibilityAsk("do these inserts fit inside the Savannah?"), true);
  assert.equal(isCompatibilityAsk("I need orthotics and supportive sandals"), false);
  assert.equal(isCompatibilityAsk("show me orthotics"), false);
});

// ── #8d. Browse with structured constraints ───────────────────────────
check("'cute black sandals under $100' → browse, category/color/price", () => {
  const p = plan("Show me cute black sandals under $100");
  assert.equal(p.askType, "browse");
  assert.deepEqual(p.categories, ["sandals"]);
  assert.equal(p.constraints.color, "black");
  assert.equal(p.constraints.priceMax, 100);
});

// ── #8e. Kids must never fall back to adult ───────────────────────────
check("'kids red shoes' → gender=kids (never adult fallback)", () => {
  const p = plan("Do you have kids red shoes?");
  assert.equal(p.constraints.gender, "kids");
  assert.equal(p.constraints.color, "red");
  assert.deepEqual(p.categories, ["shoes"]);
});

// ── #8f. Off-topic → no product plan ──────────────────────────────────
check("'what's the weather?' → other, no slots, no categories", () => {
  const p = plan("What's the weather?");
  assert.equal(p.askType, "other");
  assert.equal(p.slots.length, 0);
  assert.deepEqual(p.categories, []);
});

// ── detectors are sane ────────────────────────────────────────────────
check("isMultiRecommendationAsk needs 2+ categories + a reco frame", () => {
  assert.equal(isMultiRecommendationAsk("give me one sandal and one sneaker"), true);
  assert.equal(isMultiRecommendationAsk("show me sandals"), false, "one category is not multi");
  assert.equal(isMultiRecommendationAsk("the weather is nice"), false);
});
check("detectCategoryNouns dedupes + preserves order", () => {
  assert.deepEqual(detectCategoryNouns("sandals, then more sandals, then sneakers"), ["sandals", "sneakers"]);
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
