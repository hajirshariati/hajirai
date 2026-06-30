// Named-family evidence lock eval — the "evidence locked onto the wrong query"
// class. For named-product advisory/comparison/availability turns, the named
// family (Jillian/Savannah) must drive evidence, and the alignment validator
// must RECOVER the named family before suppressing cards.
//
// Covers:
//   5. namedProduct over-detection — "plantar" (from "Plantar Fasciitis Kit")
//      and "sandals" must NOT count as named families.
//   1. extractCatalogProductFamilies returns the real families per turn.
//   4. alignCardsToAnswerText recovers (prepends) the named family instead of
//      suppressing 8→0 when the catalog has it.
//   A/B/C same-session sequence.
//
// Run: node scripts/eval-named-family-evidence.mjs

import assert from "node:assert/strict";
import { extractCatalogProductFamilies, detectSpecificProduct } from "../app/lib/catalog-resolver.server.js";
import { alignCardsToAnswerText } from "../app/lib/emit-finalize.server.js";
import { planTurn, WORKFLOWS as W, resolvedFamilyGender } from "../app/lib/turn-plan.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}
const run = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; } };

// Catalog fixture mirroring the real Aetrex shop: real families + the
// condition-named Orthotics SKU that caused the "plantar" false positive.
const FACTS = [
  { title: "Jillian Braided Quarter Strap Sandal" },
  { title: "Savannah Adjustable Quarter Strap Sandal" },
  { title: "Danika Arch Support Sneaker" },
  { title: "Tamara Wedge Sandal" },
  { title: "Men Plantar Fasciitis Kit" },
  { title: "Carly Sparkle Sneaker" },
  // Brand-prefixed accessory + an orthotic SKU — the exact rows that turned
  // "foot"/"aetrex" into false families/specifics (live trace 2026-06-30).
  { title: "Aetrex Foot Roller", productHandle: "a001538" },
  { title: "Unisex Thinsoles Orthotics", productHandle: "l1300u-m" },
];
const families = (msg) => extractCatalogProductFamilies("aetrex.myshopify.com", msg, { _testFacts: FACTS });
const specific = (msg) => detectSpecificProduct("aetrex.myshopify.com", msg, { _testFacts: FACTS });

// ── 2026-06-30: generic need/body/brand words must NOT become families/specifics ──
await run("mixed shoes-or-orthotics: 'foot'/'aetrex' are not product families", async () => {
  const msg = "Help me find Aetrex shoes or orthotics for foot pain or all-day comfort";
  assert.deepEqual(await families(msg), [], "no families — foot/aetrex/shoes/orthotics are all stopwords");
});
await run("mixed shoes-or-orthotics: does NOT resolve to a single product (a001538)", async () => {
  const msg = "Help me find Aetrex shoes or orthotics for foot pain or all-day comfort";
  const handle = await specific(msg);
  assert.equal(handle, null, `must not resolve to a lone product (got ${handle})`);
});
await run("'foot pain' alone is not the Aetrex Foot Roller", async () => {
  assert.deepEqual(await families("shoes for foot pain"), [], "foot is a body word, not a family");
  assert.equal(await specific("shoes for foot pain"), null, "no single product from a need phrase");
});

// ── 5. over-detection fixed ───────────────────────────────────────────
await run("'plantar fasciitis ... sandals' names NO family (was 'plantar')", async () => {
  const f = await families("I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?");
  assert.deepEqual(f, []);
});
await run("'sandals'/'sneakers'/'shoes' are not families", async () => {
  assert.deepEqual(await families("show me some sandals and sneakers and shoes"), []);
});
await run("generic 'arch support walking dressy' names no family", async () => {
  assert.deepEqual(await families("something dressy with arch support for walking"), []);
});

// ── 2026-06-30: generic SHOPPER-INTENT words must NOT become families ─────────
// Even when the catalog has SKUs whose first meaningful token IS a selection /
// ordinal / choice word, those words are intent markers, not product names.
// Live trace: "…What would you pick first?" logged families=[first] → named
// search query="first".
const INTENT_WORD_FACTS = [
  ...FACTS,
  { title: "First Step Comfort Trainer", productHandle: "first-step" },
  { title: "Premier Option Walking Shoe", productHandle: "premier-option" },
  { title: "Best Choice Orthotic Insole", productHandle: "best-choice" },
  { title: "Pairs Perfect Loafer", productHandle: "pairs-perfect" },
];
const intentFamilies = (msg) => extractCatalogProductFamilies("aetrex.myshopify.com", msg, { _testFacts: INTENT_WORD_FACTS });
await run("selection/ordinal words ('first','pick','option','pair','best') are not families", async () => {
  // The exact reported message.
  assert.deepEqual(
    await intentFamilies("I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?"),
    [],
    "'first'/'pick' must never become a product family",
  );
  for (const msg of [
    "which option is best?",
    "what's the best one?",
    "show me another pair",
    "which would you pick first or second?",
    "what are my options?",
  ]) {
    assert.deepEqual(await intentFamilies(msg), [], `no families from intent words: "${msg}"`);
  }
  // A REAL family alongside the intent words is still found.
  assert.deepEqual(await intentFamilies("Which would you pick first, Jillian or Savannah?"), ["jillian", "savannah"]);
});

// ── 2026-06-30: named availability must not search with STALE gender ──────────
// Prior context gender=men; user asks "Do you have Danika in black size 8.5?"
// (a women's style). The named-family search must NOT be constrained by the
// stale men's gender (which would miss the women's-only Danika and force a
// relaxedFilters.gender retry). chat.jsx applies the gender filter ONLY when
// the CURRENT message states a gender; otherwise the resolved family gender
// drives. These assert the two helpers that decision composes from.
await run("named availability: resolved family gender corrects stale men's gender → women's Danika", async () => {
  // chat.jsx drops the stale gender from the named-family search (it isn't
  // stated in "Do you have Danika in black size 8.5?"), so the women's-only
  // Danika is found rather than filtered out by gender=men. Its catalog gender
  // is then authoritative for the rest of the turn — the final card is women's.
  const danikaCards = [
    { title: "Danika Arch Support Sneaker - Black", _gender: "women" },
    { title: "Danika Arch Support Sneaker - Navy", _gender: "women" },
  ];
  assert.equal(resolvedFamilyGender(danikaCards), "women", "resolved family gender corrects the stale men's gender");
  // A genuinely mixed family is left to the stated gender (no false override).
  assert.equal(resolvedFamilyGender([{ title: "X", _gender: "men" }, { title: "Y", _gender: "women" }]), null);
});

// ── 1. real families extracted ────────────────────────────────────────
await run("'Should I get Jillian or something else?' → [jillian]", async () => {
  assert.deepEqual(await families("I want something cute but I'll be standing all day at a wedding. Should I get Jillian or something else?"), ["jillian"]);
});
await run("'Jillian or Savannah?' → [jillian, savannah]", async () => {
  assert.deepEqual(await families("Which is better for all-day walking, Jillian or Savannah?"), ["jillian", "savannah"]);
});
await run("'Savannah in champagne size 7 wide' → [savannah]", async () => {
  assert.deepEqual(await families("Do you have Savannah in champagne size 7 wide?"), ["savannah"]);
});

// ── 4. alignment recovers named family instead of suppressing 8→0 ──────
const JILLIAN = { title: "Jillian Braided Quarter Strap Sandal - Navy", handle: "jillian-navy" };
const DRESSY_ALTS = [
  { title: "Tamara Wedge Sandal - Black", handle: "tamara-black" },
  { title: "Mae Block Heel - Black", handle: "mae-black" },
  { title: "Naomi Wedge - Off White", handle: "naomi-ow" },
];
check("wedding/Jillian: text names Jillian, cards are dressy alts → recover-prepend (NOT 8→0)", () => {
  const text = "For all-day standing at a wedding, the Jillian is cute and comfortable but not the strongest support; if support matters more, try these dressier picks.";
  const r = alignCardsToAnswerText({
    text,
    cards: DRESSY_ALTS,
    evidencePool: [JILLIAN, ...DRESSY_ALTS],
    namedFamilies: ["jillian"],
    keepAlternatives: true,
  });
  assert.equal(r.changed, true);
  assert.equal(r.reason, "recovered-prepend");
  assert.match(r.cards[0].title, /Jillian/);              // named family first
  assert.ok(r.cards.length >= 2, "alternatives kept after Jillian");
  assert.notEqual(r.cards.length, 0, "never suppressed to zero when catalog has Jillian");
});
check("availability: recover replaces (named product only, no alternatives)", () => {
  const r = alignCardsToAnswerText({
    text: "Yes — the Savannah comes in Champagne.",
    cards: [{ title: "Danika Sneaker", handle: "danika" }],
    evidencePool: [{ title: "Savannah Sandal - Champagne", handle: "savannah" }, { title: "Danika Sneaker", handle: "danika" }],
    namedFamilies: ["savannah"],
    keepAlternatives: false,
  });
  assert.equal(r.reason, "recovered-replace");
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0].title, /Savannah/);
});
check("already aligned (Jillian shown) → no change", () => {
  const r = alignCardsToAnswerText({
    text: "The Jillian is a great pick.",
    cards: [JILLIAN, ...DRESSY_ALTS],
    evidencePool: [JILLIAN, ...DRESSY_ALTS],
    namedFamilies: ["jillian"],
    keepAlternatives: true,
  });
  assert.equal(r.changed, false);
  assert.equal(r.reason, "aligned");
});
check("named family truly absent from evidence → suppress (last resort)", () => {
  const r = alignCardsToAnswerText({
    text: "The Jillian is lovely.",
    cards: DRESSY_ALTS,
    evidencePool: DRESSY_ALTS, // no Jillian anywhere
    namedFamilies: ["jillian"],
    keepAlternatives: true,
  });
  assert.equal(r.reason, "suppressed-mismatch");
  assert.equal(r.cards.length, 0);
});
check("generic condition answer naming no family → untouched", () => {
  const r = alignCardsToAnswerText({
    text: "For plantar fasciitis, look for arch support and cushioning.",
    cards: DRESSY_ALTS,
    evidencePool: DRESSY_ALTS,
    namedFamilies: [],
    keepAlternatives: true,
  });
  assert.equal(r.changed, false);
});

// ── A/B/C same-session sequence (plan + families together) ────────────
await run("A: Disney sandals-or-sneakers → no named family, recommendation", async () => {
  const msg = "I'm going to Disney and walking 10 miles a day. I want sandals, but should I actually get sneakers instead?";
  assert.deepEqual(await families(msg), []);
  const plan = planTurn({ message: msg, namedProduct: false, attrs: { useCase: "walking" } });
  assert.ok([W.CONDITION_RECOMMENDATION, W.COMPARISON, W.BROWSE].includes(plan.workflow));
});
await run("B: PF vacation → namedProduct false, condition_recommendation", async () => {
  const msg = "I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?";
  const fams = await families(msg);
  assert.deepEqual(fams, []);
  const plan = planTurn({ message: msg, namedProduct: fams.length > 0, attrs: { condition: "plantar_fasciitis", useCase: "walking" } });
  assert.equal(plan.workflow, W.CONDITION_RECOMMENDATION);
});
await run("C: Jillian or Savannah → both families, comparison", async () => {
  const msg = "Which is better for all-day walking, Jillian or Savannah?";
  const fams = await families(msg);
  assert.deepEqual(fams, ["jillian", "savannah"]);
  const plan = planTurn({ message: msg, namedProduct: fams.length > 0, attrs: { useCase: "walking" } });
  assert.equal(plan.workflow, W.COMPARISON);
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
