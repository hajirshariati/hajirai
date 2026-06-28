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

test("mobile CAROUSEL image is capped (~120px) and drops the 1/1 square", () => {
  // The showcase carousel image rule inside the mobile block.
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*aspect-ratio: auto/, "no forced 1/1 on mobile");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-img \{[^}]*max-height: 120px/, "carousel image capped ~120px");
});

test("mobile SINGLE/featured card becomes a compact HORIZONTAL row", () => {
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-card:only-child \{[^}]*flex-direction: row/, "single card is image-left/info-right");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-card:only-child \.ai-chat-product-img \{[^}]*width: 100px/, "compact ~100px image box");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-card:only-child \.ai-chat-product-img \{[^}]*max-height: 100px/, "single card image max-height ~90-110px");
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-card:only-child \.ai-chat-product-img \{[^}]*aspect-ratio: auto/, "no forced 1/1 on the single card image");
});

test("mobile product images use object-fit:contain (shoes never cropped)", () => {
  assert.match(MOBILE, /\.ai-chat-product-img img \{[^}]*object-fit: contain/, "contain on mobile product images");
});

test("the single card CTA stays tappable but capped (not full-width)", () => {
  assert.match(MOBILE, /\.ai-chat-products--showcase \.ai-chat-product-card:only-child \.ai-chat-product-cta \{[^}]*max-width: 160px/, "CTA sized to content");
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
