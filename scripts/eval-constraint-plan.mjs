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
  cardMatchesSlotCategory,
  multiRecoTextCardMismatch,
  slotSearchCategory,
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

// ── 2026-06-30: slot ↔ card category guard (mixed shoes/orthotics) ────────
check("shoes slot REJECTS an orthotic/insole card (the l1300u-m bug)", () => {
  assert.equal(cardMatchesSlotCategory({ title: "Unisex Thinsoles Orthotics" }, "shoes"), false);
  assert.equal(cardMatchesSlotCategory({ title: "Memory Foam Insole for Shoes" }, "shoes"), false);
  assert.equal(cardMatchesSlotCategory({ title: "Aetrex Foot Roller" }, "shoes"), false, "accessory excluded too");
});
check("shoes slot ACCEPTS real footwear", () => {
  assert.equal(cardMatchesSlotCategory({ title: "Kendall Arch Support Thong Sandal" }, "shoes"), true);
  assert.equal(cardMatchesSlotCategory({ title: "Danika Arch Support Sneaker" }, "shoes"), true);
});
check("orthotics slot ONLY accepts orthotic/insole products", () => {
  assert.equal(cardMatchesSlotCategory({ title: "Unisex Thinsoles Orthotics" }, "orthotics"), true);
  assert.equal(cardMatchesSlotCategory({ title: "Kendall Arch Support Thong Sandal" }, "orthotics"), false);
});
check("specific footwear slots only accept their own category", () => {
  assert.equal(cardMatchesSlotCategory({ title: "Kendall Thong Sandal" }, "sandals"), true);
  assert.equal(cardMatchesSlotCategory({ title: "Danika Sneaker" }, "sandals"), false);
  assert.equal(cardMatchesSlotCategory({ title: "Danika Sneaker" }, "sneakers"), true);
});
check("classifies from product_type when the title omits the category word", () => {
  assert.equal(cardMatchesSlotCategory({ title: "Chase", product_type: "Sneakers" }, "sneakers"), true);
});

// ── 2026-06-29: umbrella "shoes" slot must search productType="Footwear" ──
// "shoes or orthotics" → the shoes slot used category="shoes", which matches no
// product's productType, so the condition-heavy query surfaced orthotics that
// the guard rejected → only an orthotic was shown. The slot search category
// must be remapped to "footwear".
check("slotSearchCategory maps the umbrella shoes/footwear to footwear", () => {
  assert.equal(slotSearchCategory("shoes"), "footwear");
  assert.equal(slotSearchCategory("footwear"), "footwear");
  assert.equal(slotSearchCategory("Shoes"), "footwear");
});
check("slotSearchCategory passes a narrow category through unchanged", () => {
  assert.equal(slotSearchCategory("sandals"), "sandals");
  assert.equal(slotSearchCategory("orthotics"), "orthotics");
  assert.equal(slotSearchCategory("sneakers"), "sneakers");
});

// ── text/card alignment invariant ─────────────────────────────────────────
check("promising both shoes+orthotics while showing only an orthotic is a mismatch", () => {
  const text = "Here's the best of each — a supportive shoe and an orthotic.";
  assert.equal(multiRecoTextCardMismatch({ text, cards: [{ title: "Unisex Thinsoles Orthotics" }] }), true);
});
check("promising both is satisfied when one footwear AND one orthotic are shown", () => {
  const text = "Both a supportive shoe and an orthotic below.";
  const cards = [{ title: "Danika Arch Support Sneaker" }, { title: "Unisex Thinsoles Orthotics" }];
  assert.equal(multiRecoTextCardMismatch({ text, cards }), false);
});
check("a single-category answer (no 'both' promise) is never a mismatch", () => {
  assert.equal(multiRecoTextCardMismatch({ text: "Here are supportive sneakers for work.", cards: [{ title: "Danika Sneaker" }] }), false);
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
