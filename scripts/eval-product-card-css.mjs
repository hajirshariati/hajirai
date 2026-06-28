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

test("mobile CAROUSEL well is capped (~118-128px) and drops the 1/1 square", () => {
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*aspect-ratio: auto/, "no forced 1/1 on mobile");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*height: 124px/, "carousel well height ~118-128px");
  // The well centers the image (flex), so the photo sits on white, not stretched.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*display: flex[^}]*(align-items: center|justify-content: center)/, "well flex-centers the photo");
});

test("mobile CAROUSEL photo is naturally sized + contain (never stretched/cover)", () => {
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*max-width: 82%/, "photo capped to 82% width");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*max-height: 92px/, "photo capped ~88-96px tall");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*object-fit: contain/, "contain, not cover");
  // Crucially the image is auto-sized, NOT forced to fill (which would gutter).
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img img \{[^}]*width: auto[^}]*height: auto/, "image is auto-sized, not stretched to fill");
  assert.doesNotMatch(MOBILE, /\.ai-chat-product-img img \{[^}]*object-fit: cover/, "no cover on mobile product images");
});

test("mobile SINGLE/featured card is a compact HORIZONTAL grid (96px / 1fr)", () => {
  assert.match(MOBILE, /:only-child \{[^}]*display: grid/, "single card is a grid");
  assert.match(MOBILE, /:only-child \{[^}]*grid-template-columns: 96px 1fr/, "96px image column + flexible text");
  assert.match(MOBILE, /:only-child \.ai-chat-product-img \{[^}]*width: 96px[^}]*height: 96px/, "96px image well");
  assert.match(MOBILE, /:only-child \.ai-chat-product-img img \{[^}]*max-width: 86px[^}]*max-height: 86px/, "photo capped at 86px");
});

test("the single card TOP-aligns the image (no centered floating gaps above/below)", () => {
  // align-items:start on the grid → image top-aligns with the title, instead of
  // centering a small image in a tall content column (the empty-space bug).
  assert.match(MOBILE, /:only-child \{[^}]*align-items: start/, "image top-aligned with the title");
  assert.doesNotMatch(MOBILE, /:only-child \{[^}]*align-items: center/, "NOT centered (that caused the top/bottom gaps)");
  assert.match(MOBILE, /:only-child \.ai-chat-product-info \{[^}]*justify-content: flex-start/, "info hugs the top, tight vertical rhythm");
});

test("the single card hugs its content (no stretched min-height / dead space)", () => {
  assert.match(MOBILE, /:only-child \.ai-chat-product-title \{[^}]*min-height: 0/, "title doesn't reserve dead 2-line height");
  assert.match(MOBILE, /:only-child \.ai-chat-product-cta \{[^}]*max-width: 160px/, "CTA sized to content, not full-width");
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
  // The text column can shrink so a long title can't push the card wide.
  assert.match(MOBILE, /:only-child \.ai-chat-product-info \{[^}]*min-width: 0/, "info column can shrink");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
