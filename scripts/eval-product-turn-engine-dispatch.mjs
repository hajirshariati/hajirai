// Dispatcher-level eval. Exercises the engine end-to-end with
// PRODUCT_TURN_ENGINE_ENABLED forced ON, asserting the contract
// the chat.jsx dispatcher relies on:
//
//   1. Engine output products preserve UI fields (title/handle/
//      image/price/url) from the input candidates — the
//      regression that was P0-2 before the flag flip.
//   2. extractProductCards in chat-tools applies the merchant
//      ClaimRule via ctx.claimConfig — the regression that was
//      P0-1 before the flag flip.
//   3. The engine handles the two clearest live shapes from the
//      spec: "pink sandals + arch support + bunions" and
//      "plantar fasciitis women's sandals."
//   4. Compare / named-product turns DECLINE so the old path
//      still handles them.
//
// Pure offline — no DB, no Shopify. Uses synthetic merchant config
// (same shape getMerchantClaimConfig produces after seed).

import assert from "node:assert/strict";
import { runProductTurn } from "../app/lib/product-turn-engine.server.js";
import {
  attachClaimFactsToCard,
  buildProductClaimFacts,
} from "../app/lib/product-claim-facts.server.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Product Turn Engine — dispatcher eval\n");

const FIXTURE_CLAIM_CONFIG = {
  rules: [
    {
      claim: "archSupport",
      ruleType: "category_group",
      appliesToGroup: "Footwear",
      excludeGroups: ["Orthotics", "Accessories"],
    },
  ],
  categoryGroups: [
    {
      name: "Footwear",
      categories: [
        "sneakers", "sandals", "boots", "loafers", "oxfords",
        "clogs", "slip-ons", "slippers", "mary-janes", "wedges-heels",
      ],
    },
    { name: "Accessories", categories: ["accessories"] },
    { name: "Orthotics",   categories: ["orthotics"] },
  ],
  colorFamilies: [
    {
      name: "neutral",
      members: ["black", "white", "tan", "brown", "gray", "taupe", "beige", "ivory", "navy"],
    },
  ],
};

const ctxBase = { shop: "fixture.myshopify.com" };

// A search_products-shaped candidate. The engine MUST preserve
// these UI fields end-to-end so the widget renders cards.
const uiCandidate = ({ title, handle, image = `https://cdn/${handle}.jpg`, url = `https://shop/products/${handle}`, price = "129.95", productType = "Sandals", description = "Sport sandal.", tags = [], attributes = { category: "Sandals", gender: "Women" } }) =>
  ({ title, handle, image, url, price, priceRange: `$${price}`, productType, description, descriptionSnippet: "", tags, attributes });

// ─── P0-1 regression: extractProductCards uses ctx.claimConfig ──

await test("D1 — buildProductClaimFacts: merchant ClaimRule applies via shopContext.claimConfig", () => {
  // Card has NO "arch support" literal AND NO footbed attribute.
  // The only proof source available is the merchant ClaimRule
  // (Footwear group). If claimConfig isn't passed in, archSupport
  // must fall back to "none". When claimConfig IS passed,
  // archSupport must promote to true via the data-driven rule.
  const product = {
    title: "Plain Sandal",
    handle: "plain-sandal",
    productType: "Sandals",
    description: "A sandal.",
    tags: [],
    attributes: { category: "Sandals", gender: "Women" },
  };
  const without = buildProductClaimFacts(product, { shop: "fixture.myshopify.com" });
  assert.equal(without.archSupport.value, false,
    `no claimConfig → archSupport=false; got source=${without.archSupport.source}`);
  assert.equal(without.archSupport.source, "none");

  const withConfig = buildProductClaimFacts(product, {
    shop: "fixture.myshopify.com",
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.equal(withConfig.archSupport.value, true,
    `claimConfig present → archSupport=true via claim_rule_category_group; got source=${withConfig.archSupport.source}`);
  assert.equal(withConfig.archSupport.source, "claim_rule_category_group");
});

// ─── P0-2 regression: engine preserves UI fields ────────────────

await test("D2 — engine output products keep title/handle/image/url/price from the input candidates", async () => {
  const candidates = [
    uiCandidate({ title: "Piper Terracotta", handle: "piper-terracotta" }),
    uiCandidate({ title: "Vicki Light Pink", handle: "vicki-light-pink" }),
    uiCandidate({ title: "Jillian Antique Rose", handle: "jillian-antique-rose" }),
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "i want pink sandals with arch support and i have bunions",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", color: "pink", condition: "bunions" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => candidates,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, "engine should handle this turn");
  assert.equal(out.products.length, 3);
  for (const card of out.products) {
    assert.ok(card.title, `card lost title: ${JSON.stringify(card)}`);
    assert.ok(card.handle, `card lost handle: ${JSON.stringify(card)}`);
    assert.ok(card.image, `card lost image: ${JSON.stringify(card)}`);
    assert.ok(card.url, `card lost url: ${JSON.stringify(card)}`);
    assert.ok(card.price || card.priceRange, `card lost price/priceRange: ${JSON.stringify(card)}`);
    // And the facts envelope is still there.
    assert.ok(card._claimFacts, `card missing _claimFacts: ${JSON.stringify(card)}`);
    assert.equal(card._archSupport, true,
      `card should have archSupport=true via merchant ClaimRule; got ${card._archSupport}`);
  }
});

// ─── Live spec shapes ────────────────────────────────────────────

await test("D3 — 'pink sandals + arch support + bunions' is handled (text + cards, no zeroing)", async () => {
  const candidates = [
    {
      title: "Piper Arch Support Strap Sandal - Terracotta",
      handle: "piper-terracotta-au1305w",
      image: "https://cdn/piper.jpg",
      url: "https://shop/products/piper-terracotta-au1305w",
      price: "129.95",
      productType: "Sandals",
      description: "Sandal with Built-In Arch Support.",
      tags: ["Bunions"],
      attributes: { category: "Sandals", gender: "Women" },
    },
    {
      title: "Vicki Braided Thong Sandal - Light Pink Gloss",
      handle: "vicki-light-pink-gloss-st3519w",
      image: "https://cdn/vicki.jpg",
      url: "https://shop/products/vicki-light-pink-gloss-st3519w",
      price: "119.95",
      productType: "Sandals",
      description: "Sandal with arch support.",
      tags: ["Bunions"],
      attributes: { category: "Sandals", gender: "Women" },
    },
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "i want pink sandals with arch support and i have bunions",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", color: "pink", condition: "bunions" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => candidates,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.ok(out.answerText.length > 30, `useful text required; got "${out.answerText}"`);
  assert.equal(out.products.length, 2);
  assert.match(out.answerText, /bunions/i);
  assert.match(out.answerText, /sandals/i);
});

await test("D4 — 'plantar fasciitis women's sandals' is handled with useful text", async () => {
  const candidates = [
    {
      title: "Whit Sport Sandal - Champagne",
      handle: "whit-champagne",
      image: "https://cdn/whit.jpg",
      url: "https://shop/products/whit-champagne",
      price: "139.95",
      productType: "Sandals",
      description: "Sport sandal with Built-In Arch Support.",
      tags: ["Plantar Fasciitis"],
      attributes: { category: "Sandals", gender: "Women" },
    },
    {
      title: "Jess Adjustable Quarter Strap Sandal - Pewter",
      handle: "jess-pewter",
      image: "https://cdn/jess.jpg",
      url: "https://shop/products/jess-pewter",
      price: "149.95",
      productType: "Sandals",
      description: "Adjustable sandal with arch support.",
      tags: ["Plantar Fasciitis"],
      attributes: { category: "Sandals", gender: "Women" },
    },
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "I have plantar fasciitis, what women's sandals do you recommend?",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", condition: "plantar_fasciitis" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => candidates,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.match(out.answerText, /plantar fasciitis/i);
  assert.ok(out.answerText.length > 30, `useful text required; got "${out.answerText}"`);
  assert.doesNotMatch(out.answerText, /^Here are the matching styles I found\.?$/i);
});

await test("D4b — 'show me what's new' is a badge-backed product turn, not scope-too-thin", async () => {
  let seenScope = null;
  const candidates = [
    uiCandidate({
      title: "New Arrival Sandal",
      handle: "new-arrival-sandal",
      productType: "Sandals",
      attributes: { category: "Sandals", gender: "Women", badge: "New" },
    }),
    uiCandidate({
      title: "New Arrival Sneaker",
      handle: "new-arrival-sneaker",
      productType: "Sneakers",
      attributes: { category: "Sneakers", gender: "Women", badge: "New" },
    }),
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Show me what's new",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async (scope) => {
      seenScope = scope;
      return candidates;
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, `engine should handle new-arrival turns; got ${JSON.stringify(out?.diagnostics)}`);
  assert.equal(seenScope?.modifier, "new");
  assert.equal(seenScope?.badge, "new");
  assert.equal(out.cta?.modifier, "new");
  assert.match(out.answerText, /new/i);
  assert.equal(out.products.length, 2);
});

// ─── Decline path: compare / named-product still fall back to old path

await test("D5 — 'Which has the most cushioning like the Jillian?' DECLINES (old path takes it)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Which of these has the most cushioning like the Jillian?",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline, "named-anchor + compare turn must decline in Phase 1");
});

await test("D6 — 'other shoes with same support as Danika' DECLINES (old path takes it)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what other shoes have same support as Danika?",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline, "named-anchor turn must decline in Phase 1");
});

// ─── Decline path: turn missing a category still falls back ─────

await test("D7 — bare 'show me shoes' (no category resolved yet) DECLINES so the agent can clarify", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "show me shoes",
    sessionMemory: { explicit: { gender: "women" }, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline);
});

// ─── Flag default: when PRODUCT_TURN_ENGINE_ENABLED is unset, the
//     engine returns null so the agent path proceeds untouched.

await test("D8 — default (flag unset) returns null (production behavior is unchanged)", async () => {
  const prev = process.env.PRODUCT_TURN_ENGINE_ENABLED;
  delete process.env.PRODUCT_TURN_ENGINE_ENABLED;
  try {
    const out = await runProductTurn({
      ...ctxBase,
      latestUserMessage: "i want pink sandals with arch support and i have bunions",
      sessionMemory: { explicit: { gender: "women", category: "sandals" }, inferred: {} },
    }, {
      // intentionally NOT forceEnable
      searchFn: async () => [],
      claimConfig: FIXTURE_CLAIM_CONFIG,
    });
    assert.equal(out, null, "flag unset must short-circuit to null");
  } finally {
    if (prev === undefined) delete process.env.PRODUCT_TURN_ENGINE_ENABLED;
    else process.env.PRODUCT_TURN_ENGINE_ENABLED = prev;
  }
});

// ─── Live 2026-06-04: empty pool must NOT emit a CTA ───────────
//
// Customer clicked "Do you have the Carly Arch Support Sneaker in
// other colors?" while session memory carried gender=kids from a
// prior orthotic turn. Engine retrieved 0 cards (catalog has no
// kids' sneakers) but still emitted "View All Kids' Sneakers" —
// pointing to an empty storefront page. The composer correctly
// said "I couldn't find …" but the misleading CTA right below
// made the bot look broken.

await test("D9 — empty pool does NOT emit a misleading View All CTA", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Do you have the Carly Arch Support Sneaker in other colors?",
    sessionMemory: {
      // Stale gender=kids carried from a prior orthotic turn.
      explicit: { gender: "kids", category: "sneakers" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    // Simulate the catalog having no kids' sneakers — searchFn returns [].
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, "engine should still handle the turn");
  assert.equal(out.products.length, 0, "no products in empty pool");
  // The honest "I couldn't find …" text is fine; the CTA must NOT fire.
  assert.equal(out.cta, null,
    `empty pool must not emit a CTA; got ${JSON.stringify(out.cta)}`);
  // Follow-ups should also be empty (no products to refine).
  assert.ok(!Array.isArray(out.followUps) || out.followUps.length === 0,
    `empty pool should not emit follow-ups; got ${JSON.stringify(out.followUps)}`);
  // Text is honest.
  assert.match(out.answerText, /couldn't find/i);
});

await test("D10 — non-empty pool DOES emit a CTA (regression check)", async () => {
  // Sanity: the new gate must not break the normal happy path.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "show me women's sandals",
    sessionMemory: { explicit: { gender: "women", category: "sandals" }, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [uiCandidate({ title: "Maui", handle: "maui" })],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.ok(out.products.length >= 1);
  assert.ok(out.cta, "non-empty pool must still emit a CTA");
  assert.equal(out.cta.kind, "storefront_search");
});

// ──────────────────────────────────────────────────────────────
console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  process.exit(1);
}
