// Mobile compact product-card invariants (Aetrex theme extension stylesheet).
//
// The normal chat product cards (carousel + single/featured) live in the
// widget's CSS file, separate from the visualizer JS. On mobile the product
// IMAGE used to dominate the card (1/1 square at full card width). These
// assertions lock in the compact mobile layout WITHOUT touching desktop:
// carousel images capped ~120px, single card becomes a horizontal row with a
// ~100px image, and product images use object-fit:contain.
//
// Run: node scripts/eval-product-card-css.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(
  join(here, "..", "extensions", "hajirai-chat-widget", "assets", "hajirai-chat-widget.css"),
  "utf8",
);

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

// Return the body text of the FIRST `@media (max-width: 600px)` block (the one
// that holds the showcase product-card rules), brace-balanced.
function mobileBlock() {
  const start = CSS.indexOf("@media (max-width: 600px)");
  assert.notEqual(start, -1, "mobile @media block not found");
  let i = CSS.indexOf("{", start), depth = 0;
  for (let j = i; j < CSS.length; j++) {
    if (CSS[j] === "{") depth += 1;
    else if (CSS[j] === "}") { depth -= 1; if (depth === 0) return CSS.slice(i, j + 1); }
  }
  throw new Error("could not bound the mobile @media block");
}

// Everything OUTSIDE any max-width media query — i.e. the desktop base rules.
// (Good enough to confirm desktop sizing wasn't altered.)
const DESKTOP = CSS.split("@media (max-width:")[0] + CSS.split("@media (max-width: 600px)")[0];

console.log("\nmobile compact product-card invariants\n");

const MOBILE = mobileBlock();

test("mobile image WELLS are clean WHITE (no gray gutters/bars)", () => {
  // Catch-all base override kills the #f3f4f6 placeholder fill on mobile.
  assert.match(MOBILE, /\.ai-chat-product-img \{\s*background: #fff/, "base image well is white on mobile");
  // Carousel + single wells are explicitly white.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*background: #fff/, "carousel well white");
  assert.match(MOBILE, /:only-child \.ai-chat-product-img \{[^}]*background: #fff/, "single-card well white");
  // No gray fill anywhere in the mobile block.
  assert.doesNotMatch(MOBILE, /background:\s*#f[0-9a-f]{2,5}\b(?<!#fff)/i, "no light-gray background on mobile");
  assert.doesNotMatch(MOBILE, /#f3f4f6|#f7f7f7|#eee|#ececec/i, "no known gray placeholder colors");
});

test("mobile CAROUSEL well is TIGHT (~112px) and drops the 1/1 square", () => {
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*aspect-ratio: auto/, "no forced 1/1 on mobile");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*height: 112px/, "carousel well is tight, not a tall empty box");
  // The well centers the image (flex), so the photo sits on white, not stretched.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*display: flex[^}]*(align-items: center|justify-content: center)/, "well flex-centers the photo");
});

test("mobile CAROUSEL photo FILLS the well (less empty space) + contain, never cover", () => {
  // Photo fills the well height (minus the small padding) instead of floating.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*max-width: 90%/, "photo uses most of the width");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*max-height: 100%/, "photo fills the well height — no big empty margins");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*object-fit: contain/, "contain, not cover");
  // Crucially the image is auto-sized, NOT forced to fill (which would gutter).
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*width: auto[^}]*height: auto/, "image is auto-sized, ratio preserved");
  assert.doesNotMatch(MOBILE, /\.ai-chat-product-img img \{[^}]*object-fit: cover/, "no cover on mobile product images");
});

test("mobile SINGLE card: image left, title/price right, CTAs in a full-width BOTTOM row", () => {
  // 3-row grid with a "cta cta" row spanning both columns.
  assert.match(MOBILE, /:only-child \{[^}]*display: grid/, "single card is a grid");
  assert.match(MOBILE, /:only-child \{[^}]*grid-template-columns: 88px minmax\(0, 1fr\)/, "88px image column + flexible text");
  assert.match(MOBILE, /:only-child \{[^}]*grid-template-areas:\s*"img title"\s*"img price"\s*"cta cta"/, "img spans title/price; CTAs full-width bottom row");
  // info dissolves so its children join the card grid.
  assert.match(MOBILE, /:only-child \.ai-chat-product-info \{[^}]*display: contents/, "info is display:contents");
  assert.match(MOBILE, /:only-child \.ai-chat-product-title \{[^}]*grid-area: title/, "title placed");
  assert.match(MOBILE, /:only-child \.ai-chat-product-price \{[^}]*grid-area: price/, "price placed");
});

test("mobile SINGLE card: BOTH CTAs (View product + See It Styled) occupy the cta row", () => {
  // With viz → the actions row is the cta area; without viz → the bare CTA is.
  assert.match(MOBILE, /:only-child \.ai-chat-viz-actions \{[^}]*grid-area: cta/, "actions row spans the bottom");
  assert.match(MOBILE, /:only-child \.ai-chat-viz-actions \{[^}]*width: 100%/, "full-width row");
  assert.match(MOBILE, /:only-child \.ai-chat-product-cta \{[^}]*grid-area: cta/, "no-viz View product takes the same row");
  assert.match(MOBILE, /:only-child \.ai-chat-product-cta \{[^}]*justify-self: start/, "no-viz CTA is content-sized, left-aligned (not a full-width bar)");
});

test("mobile SINGLE card: the two CTAs are a MATCHED pair (same height/padding/radius)", () => {
  assert.match(MOBILE, /:only-child \.ai-chat-product-cta \{[^}]*min-height: 38px[^}]*padding: 8px 16px/, "View product sizing");
  // See It Styled must override its inline styles to match.
  assert.match(MOBILE, /:only-child \.ai-chat-viz-btn \{[^}]*min-height: 38px !important[^}]*padding: 8px 16px !important/, "See It Styled matches (overrides inline)");
  assert.match(MOBILE, /:only-child \.ai-chat-viz-btn \{[^}]*border-radius: 9px !important/, "matched radius");
});

test("mobile SINGLE card: compact image well, no wasted space (88px well, ≤80px photo)", () => {
  assert.match(MOBILE, /:only-child \.ai-chat-product-img \{[^}]*width: 88px[^}]*height: 88px/, "88px image well");
  assert.match(MOBILE, /:only-child \.ai-chat-product-img img \{[^}]*max-width: 80px[^}]*max-height: 80px/, "photo capped at 80px, centered");
  assert.match(MOBILE, /:only-child \.ai-chat-product-title \{[^}]*min-height: 0/, "title doesn't reserve dead 2-line height");
});

test("DESKTOP product-card sizing is UNCHANGED (rules are mobile-scoped)", () => {
  // Desktop carousel image keeps the 1/1 square aspect ratio.
  assert.match(DESKTOP, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*aspect-ratio: 1 \/ 1/, "desktop carousel image still 1/1");
  // Desktop base thumbnail is still 72px (untouched).
  assert.match(DESKTOP, /\.ai-chat-product-img \{\s*width: 72px;\s*height: 72px/, "desktop base thumbnail unchanged");
  // The desktop :only-child horizontal row (160px image) lives in min-width:601px.
  assert.match(CSS, /@media \(min-width: 601px\) \{[\s\S]*?:only-child \.ai-chat-product-img \{[^}]*width: 160px/, "desktop featured card (160px image) intact");
});

test("no horizontal-overflow / viewport-width hacks introduced on mobile", () => {
  assert.doesNotMatch(MOBILE, /overflow-x: (auto|scroll)/, "no horizontal scrollbars");
  assert.doesNotMatch(MOBILE, /100vw/, "no viewport-width rule that could overflow the bubble");
  // The text column uses minmax(0, 1fr) so a long title can't push the card wide.
  assert.match(MOBILE, /:only-child \{[^}]*grid-template-columns: 88px minmax\(0, 1fr\)/, "text column can shrink (minmax 0)");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
