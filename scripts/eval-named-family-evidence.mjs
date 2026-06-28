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
import { planTurn, WORKFLOWS as W } from "../app/lib/turn-plan.server.js";

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
