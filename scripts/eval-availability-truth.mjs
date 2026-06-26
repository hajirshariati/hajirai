// Availability Truth eval — classify a family + color/size/width request
// against real variant inventory and produce AVAILABLE / UNAVAILABLE /
// UNKNOWN / NOT_FOUND plus the contract answer text.
//
// Run: node scripts/eval-availability-truth.mjs

import assert from "node:assert/strict";
import {
  classifyAvailability,
  buildAvailabilityAnswer,
  resolveAvailabilityRequest,
  isAvailabilityFollowUp,
  AVAILABILITY_RESULT as R,
} from "../app/lib/availability-truth.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const variant = (size, color, qty, width) => ({
  sku: `${color}-${size}${width || ""}`,
  inventoryQty: qty,
  optionsJson: JSON.stringify({ Size: size ? String(size) + (width === "wide" ? "W" : "") : undefined, Color: color }),
});

// Catalog fixture (Shopify-style products with variants).
const JILLIAN_BLACK = {
  handle: "jillian-black", title: "Jillian Braided Quarter Strap Sandal - Black",
  variants: [variant(7, "Black", 3), variant(8, "Black", 5), variant(9, "Black", 0)],
};
const JILLIAN_NAVY = {
  handle: "jillian-navy", title: "Jillian Braided Quarter Strap Sandal - Navy",
  variants: [variant(7, "Navy", 2), variant(8, "Navy", 4)],
};
// Savannah Champagne: variants carry NO size data (untracked) → UNKNOWN.
const SAVANNAH_CHAMPAGNE = {
  handle: "savannah-champ", title: "Savannah Adjustable Quarter Strap Sandal - Champagne",
  variants: [{ sku: "champ", inventoryQty: null, optionsJson: JSON.stringify({ Color: "Champagne" }) }],
};
const SAVANNAH_BLACK = {
  handle: "savannah-black", title: "Savannah Adjustable Quarter Strap Sandal - Black",
  variants: [variant(7, "Black", 4), variant(8, "Black", 2)],
};
const ROMY = { handle: "romy", title: "Romy Wedge Sandal - Tan", variants: [variant(8, "Tan", 5)] };
const CATALOG = [JILLIAN_BLACK, JILLIAN_NAVY, SAVANNAH_CHAMPAGNE, SAVANNAH_BLACK, ROMY];

const classify = (family, color, size, width) => classifyAvailability({ products: CATALOG, family, color, size, width });

// ── single-turn classification ────────────────────────────────────────
check("Jillian black size 8 → AVAILABLE", () => {
  const v = classify("jillian", "black", "8");
  assert.equal(v.result, R.AVAILABLE);
  assert.match(buildAvailabilityAnswer(v), /Yes — the Jillian is available in Black, size 8\./);
});
check("Jillian black size 9 (OOS) → UNAVAILABLE", () => {
  const v = classify("jillian", "black", "9");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.match(buildAvailabilityAnswer(v), /not seeing the Jillian available in Black, size 9/i);
});
check("Jillian size 8.5 (not carried, sizes known) → UNAVAILABLE", () => {
  assert.equal(classify("jillian", null, "8.5").result, R.UNAVAILABLE);
});
check("Jillian in pink (color not carried) → UNAVAILABLE", () => {
  const v = classify("jillian", "pink");
  assert.equal(v.result, R.UNAVAILABLE);
  assert.equal(v.reason, "color_not_carried");
});
check("Jillian in black (color only, in stock) → AVAILABLE", () => {
  assert.equal(classify("jillian", "black").result, R.AVAILABLE);
});
check("Savannah champagne size 7 wide (no variant data) → UNKNOWN", () => {
  const v = classify("savannah", "champagne", "7", "wide");
  assert.equal(v.result, R.UNKNOWN);
  assert.equal(v.reason, "no_variant_inventory");
  const txt = buildAvailabilityAnswer(v);
  assert.match(txt, /I can find the Savannah in Champagne/);
  assert.match(txt, /can't verify size 7 wide/);
  assert.match(txt, /product page/);
});
check("Savannah black size 7 → AVAILABLE (different color has data)", () => {
  assert.equal(classify("savannah", "black", "7").result, R.AVAILABLE);
});
check("Is Savannah available in champagne (color only, untracked=available) → AVAILABLE", () => {
  // untracked inventory (qty null) is treated as available
  assert.equal(classify("savannah", "champagne").result, R.AVAILABLE);
});
check("Savannah in wide (width only, no width data on champagne/black) → UNAVAILABLE or UNKNOWN", () => {
  const v = classify("savannah", null, null, "wide");
  assert.ok([R.UNAVAILABLE, R.UNKNOWN].includes(v.result));
});
check("Tamara (not in catalog) → NOT_FOUND", () => {
  const v = classify("tamara", "black", "8");
  assert.equal(v.result, R.NOT_FOUND);
  assert.match(buildAvailabilityAnswer(v), /not finding that exact Tamara style/);
});

// ── answer text never contains banned phrases ─────────────────────────
check("no availability answer says 'take a look' / 'tell me more'", () => {
  for (const r of [R.AVAILABLE, R.UNAVAILABLE, R.UNKNOWN, R.NOT_FOUND]) {
    const txt = buildAvailabilityAnswer({ result: r, family: "jillian", color: "black", size: "8", product: JILLIAN_BLACK });
    assert.doesNotMatch(txt, /take a look|tell me more|closest match/i);
  }
});

// ── display: the verdict always carries the one family product ─────────
check("verdict.product is the named family product (for card display)", () => {
  const v = classify("jillian", "black", "8");
  assert.equal(v.product.handle, "jillian-black");
});

// ── #8 same-session request resolution (no stale leakage) ─────────────
check("B after Disney: Savannah availability ignores stale category/sneakers", () => {
  // Prior turn was Disney sneakers; latest names Savannah champagne 7 wide.
  const req = resolveAvailabilityRequest({
    namedFamilies: ["savannah"],
    latestConstraints: { color: "champagne", size: "7", width: "wide" },
    focusProduct: { title: "Carly Sparkle Sneaker - Black" }, // stale Disney anchor
    isFollowUp: isAvailabilityFollowUp("Do you have Savannah in champagne size 7 wide?"),
  });
  assert.equal(req.family, "savannah");        // NOT carly/sneaker
  assert.equal(req.color, "champagne");        // NOT stale black
  assert.equal(req.size, "7");
  assert.equal(req.width, "wide");
});
check("'what about size 9?' follow-up keeps Jillian + black, overrides size", () => {
  assert.equal(isAvailabilityFollowUp("What about size 9?"), true);
  const req = resolveAvailabilityRequest({
    namedFamilies: [], // the follow-up names no family
    latestConstraints: { size: "9" },
    focusProduct: { title: "Jillian Braided Quarter Strap Sandal - Black" },
    isFollowUp: true,
  });
  assert.equal(req.family, "jillian");   // inherited from focus
  assert.equal(req.color, "black");      // inherited prior color
  assert.equal(req.size, "9");           // new size from latest
});
check("Savannah availability after 'cute black sandals under $100' does NOT inherit black", () => {
  const req = resolveAvailabilityRequest({
    namedFamilies: ["savannah"],
    latestConstraints: { color: "champagne", size: "7", width: "wide" },
    focusProduct: null,
    isFollowUp: false, // fresh named question, not a follow-up
  });
  assert.equal(req.family, "savannah");
  assert.equal(req.color, "champagne");  // NOT inherited black/under-$100
});
check("non-follow-up does not inherit family from a stale focus", () => {
  const req = resolveAvailabilityRequest({
    namedFamilies: [],
    latestConstraints: { size: "7" },
    focusProduct: { title: "Jillian Braided Quarter Strap Sandal - Black" },
    isFollowUp: false,
  });
  assert.equal(req.family, null); // no family named, not a follow-up → don't guess
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
