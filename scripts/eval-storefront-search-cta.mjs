// Deterministic tests for buildStorefrontSearchCTA. Pure function,
// no API key required. Run: node scripts/eval-storefront-search-cta.mjs

import assert from "node:assert/strict";
import { buildStorefrontSearchCTA } from "../app/lib/storefront-search-cta.server.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err?.message || err}`);
  }
}

const AETREX = "https://www.aetrex.com/collections/shop?q={q}&tab=products";

console.log("\nbuildStorefrontSearchCTA\n");

// ── happy path: gender + category ──────────────────────────────────
test("women + sandals → women+sandals", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "women", category: "sandals" });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=women+sandals&tab=products");
  assert.equal(r.label, "View All Women's Sandals");
});

test("men + sneakers → men+sneakers", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "men", category: "sneakers" });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=men+sneakers&tab=products");
  assert.equal(r.label, "View All Men's Sneakers");
});

test("kids + orthotics → kids+orthotics", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "kids", category: "orthotics" });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=kids+orthotics&tab=products");
  assert.equal(r.label, "View All Kids's Orthotics");
});

// ── orthotic-gate path: gender + "orthotics" ──────────────────────
test("orthotic gate path: women's orthotics", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "Women",
    category: "orthotics",
    intent: "orthotic",
  });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=women+orthotics&tab=products");
  assert.equal(r.label, "View All Women's Orthotics");
});

// ── color modifier ─────────────────────────────────────────────────
test("women + pink + sandals → women+pink+sandals", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    color: "pink",
    category: "sandals",
  });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=women+pink+sandals&tab=products");
  assert.equal(r.label, "View All Pink Women's Sandals");
});

// ── modifier (new/sale) ────────────────────────────────────────────
test("'show me new men's sneakers' → new+men+sneakers", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "men",
    category: "sneakers",
    latestUserMessage: "show me your new men's sneakers please",
  });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=new+men+sneakers&tab=products");
  assert.equal(r.label, "View All New Men's Sneakers");
});

test("sale modifier detected", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "boots",
    latestUserMessage: "any women's boots on sale?",
  });
  assert(r.url.includes("q=sale+women+boots"), `got ${r.url}`);
  assert(r.label.startsWith("View All Sale"), `got "${r.label}"`);
});

// ── gender only (no category) ──────────────────────────────────────
test("gender only (no category) still produces a CTA", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "women" });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=women&tab=products");
  assert.equal(r.label, "View All Women's");
});

// ── category only ──────────────────────────────────────────────────
test("category only (no gender) still produces a CTA", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, category: "orthotics" });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=orthotics&tab=products");
  assert.equal(r.label, "View All Orthotics");
});

// ── nothing → null ─────────────────────────────────────────────────
test("no gender, no category → null", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX });
  assert.equal(r, null);
});

// ── unset / malformed pattern → null ──────────────────────────────
test("empty pattern → null", () => {
  const r = buildStorefrontSearchCTA({ pattern: "", gender: "women", category: "sneakers" });
  assert.equal(r, null);
});

test("pattern without {q} placeholder → null", () => {
  const r = buildStorefrontSearchCTA({
    pattern: "https://example.com/all-women",
    gender: "women",
    category: "sneakers",
  });
  assert.equal(r, null);
});

// ── multi-word category ────────────────────────────────────────────
test("multi-word category 'wedges heels' → +-encoded inside the token", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "wedges heels",
  });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=women+wedges+heels&tab=products");
  assert.equal(r.label, "View All Women's Wedges Heels");
});

// ── gender normalization ───────────────────────────────────────────
test("'mens' (no apostrophe) normalizes to 'men'", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "mens", category: "sandals" });
  assert(r.url.includes("q=men+sandals"));
});

test("'boys' normalizes to 'kids'", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "boys", category: "sneakers" });
  assert(r.url.includes("q=kids+sneakers"));
});

test("unknown gender drops the token (still emits CTA from category)", () => {
  const r = buildStorefrontSearchCTA({ pattern: AETREX, gender: "alien", category: "sneakers" });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=sneakers&tab=products");
  assert.equal(r.label, "View All Sneakers");
});

// ── case insensitivity ─────────────────────────────────────────────
test("category title-case input still produces lowercase URL", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "Women",
    category: "Sandals",
  });
  assert(r.url.includes("q=women+sandals"), `got ${r.url}`);
});

// ── different pattern works too ────────────────────────────────────
test("non-Aetrex URL pattern works", () => {
  const r = buildStorefrontSearchCTA({
    pattern: "https://other-store.com/search?query={q}",
    gender: "women",
    category: "sandals",
  });
  assert.equal(r.url, "https://other-store.com/search?query=women+sandals");
});

// ── overrides ──────────────────────────────────────────────────────
test("override: modifier+gender wins over auto-search", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "footwear",
    latestUserMessage: "what's currently on sale?",
    overrides: [
      { modifier: "sale", gender: "women", url: "https://www.aetrex.com/collections/womens-sale" },
    ],
  });
  assert.equal(r.url, "https://www.aetrex.com/collections/womens-sale");
  // Blank label → auto-generated label fallback
  assert.equal(r.label, "View All Sale Women's Footwear");
});

test("override: custom label is used when provided", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "men",
    latestUserMessage: "any deals?",
    overrides: [
      { modifier: "sale", gender: "men", url: "https://aetrex.com/collections/mens-sale", label: "Shop Men's Sale" },
    ],
  });
  assert.equal(r.url, "https://aetrex.com/collections/mens-sale");
  assert.equal(r.label, "Shop Men's Sale");
});

test("override: most-specific wins (gender+category beats gender-only)", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "orthotics",
    overrides: [
      { gender: "women", url: "https://aetrex.com/collections/womens" },
      { gender: "women", category: "orthotics", url: "https://aetrex.com/collections/womens-orthotics" },
    ],
  });
  assert.equal(r.url, "https://aetrex.com/collections/womens-orthotics");
});

test("override: no match → falls through to auto-search", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "sandals",
    overrides: [
      { modifier: "sale", url: "https://aetrex.com/collections/sale" },
    ],
  });
  assert.equal(r.url, "https://www.aetrex.com/collections/shop?q=women+sandals&tab=products");
});

test("override: rule with no constraints is ignored (would match everything)", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "sandals",
    overrides: [
      { url: "https://aetrex.com/collections/everything" },
    ],
  });
  assert(r.url.includes("?q=women+sandals"), `got ${r.url}`);
});

test("override: works even when search pattern is empty", () => {
  const r = buildStorefrontSearchCTA({
    pattern: "",
    gender: "women",
    overrides: [
      { gender: "women", url: "https://aetrex.com/collections/women" },
    ],
  });
  assert.equal(r.url, "https://aetrex.com/collections/women");
});

test("override: rule with bad data (no url) is skipped", () => {
  const r = buildStorefrontSearchCTA({
    pattern: AETREX,
    gender: "women",
    category: "sandals",
    overrides: [
      { gender: "women", url: "" },
      null,
      "not an object",
    ],
  });
  assert(r.url.includes("?q=women+sandals"), `got ${r.url}`);
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
