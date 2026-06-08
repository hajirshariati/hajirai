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
const BROWSE_CTX = {
  ...ctxBase,
  merchantGroups: [
    {
      name: "Footwear",
      categories: ["Sneakers", "Sandals", "Clogs", "Boots"],
      triggers: ["shoe", "shoes", "footwear"],
    },
    { name: "Accessories", categories: ["Accessories"], triggers: ["accessory", "accessories"] },
    { name: "Orthotics", categories: ["Orthotics"], triggers: ["orthotic", "orthotics"] },
  ],
  catalogCategories: ["Sneakers", "Sandals", "Clogs", "Boots", "Accessories", "Orthotics"],
  fullCatalogCategories: ["Sneakers", "Sandals", "Clogs", "Boots", "Accessories", "Orthotics"],
  categoryGenderMap: {
    sneakers: { display: "Sneakers", genders: ["men", "women"] },
    sandals: { display: "Sandals", genders: ["men", "women"] },
    clogs: { display: "Clogs", genders: ["men"] },
    boots: { display: "Boots", genders: ["women"] },
    accessories: { display: "Accessories", genders: ["women", "unisex"] },
    orthotics: { display: "Orthotics", genders: ["men", "women", "kids", "unisex"] },
  },
};

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
  assert.match(out.answerText, /sandal/i);
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

await test("D6b — 'which one had the removable insole' is NOT a compare-shape decline", async () => {
  const candidates = [
    uiCandidate({
      title: "Darcy Arch Support Slip-On Sneaker - White",
      handle: "darcy-white",
      productType: "Sneakers",
      attributes: { category: "Sneakers", gender: "Women", color: "White" },
      price: "129.95",
    }),
    uiCandidate({
      title: "Carly Arch Support Sneaker - White Sparkle",
      handle: "carly-white-sparkle",
      productType: "Sneakers",
      description: "A white sneaker with a removable insole.",
      attributes: { category: "Sneakers", gender: "Women", color: "White Sparkle" },
      price: "139.95",
    }),
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "which one had the removable insole — it was a white women's sneaker around $140",
    sessionMemory: {
      explicit: { gender: "women", category: "sneakers", color: "white" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => candidates,
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, `ordinary product-finding 'which one had' must not decline as compare; got ${JSON.stringify(out?.diagnostics)}`);
  assert.deepEqual(
    out.products.map((product) => product.handle),
    ["carly-white-sparkle"],
    "only the product with catalog evidence for a removable insole should survive",
  );
});

// ─── Grounded browse clarifier path ──────────────────────────────

await test("D7 — broad 'show me shoes' asks grounded category choices, not legacy-agent chips", async () => {
  let searchCalled = false;
  const out = await runProductTurn({
    ...BROWSE_CTX,
    latestUserMessage: "show me shoes",
    sessionMemory: { explicit: { gender: "women" }, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => {
      searchCalled = true;
      return [];
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, `engine should clarify broad browse turns; got ${JSON.stringify(out?.diagnostics)}`);
  assert.equal(searchCalled, false, "clarifier should not search before the customer chooses a grounded category");
  assert.equal(out.products.length, 0);
  assert.deepEqual(out.choices, ["Sneakers", "Sandals", "Boots"]);
  assert.ok(!out.choices.includes("Accessories"), "shoe-style clarifier must not offer Accessories");
  assert.ok(!out.choices.includes("Orthotics"), "shoe-style clarifier must not offer Orthotics");
});

await test("D7aa — broad shoe request with no gender asks only catalog-backed genders", async () => {
  const out = await runProductTurn({
    ...BROWSE_CTX,
    latestUserMessage: "show me shoes",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => {
      throw new Error("clarifier should not search");
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, `engine should own broad browse; got ${JSON.stringify(out?.diagnostics)}`);
  assert.deepEqual(out.choices, ["Men's", "Women's"]);
  assert.ok(!out.choices.includes("Kids"), "must not offer Kids unless kids footwear exists in the catalog");
});

await test("D7aaa — 'hi I need new shoes' clarifies broad footwear, not new-arrivals or orthotics", async () => {
  const out = await runProductTurn({
    ...BROWSE_CTX,
    latestUserMessage: "hi i need new shoes",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => {
      throw new Error("clarifier should not search before gender/category is known");
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, `engine should own vague first-turn footwear requests; got ${JSON.stringify(out?.diagnostics)}`);
  assert.equal(out.products.length, 0);
  assert.deepEqual(out.choices, ["Men's", "Women's"]);
  assert.ok(!out.choices.includes("Kids"), "must not offer kids shoes unless kids footwear exists");
  assert.ok(!out.answerText.toLowerCase().includes("orthotic"), "vague shoes request must not pivot to orthotics");
});

await test("D7ab — generic product browse can ask top-level merchant groups from catalog evidence", async () => {
  const out = await runProductTurn({
    ...BROWSE_CTX,
    latestUserMessage: "show me products",
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => {
      throw new Error("clarifier should not search");
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline);
  assert.deepEqual(out.choices, ["Footwear", "Accessories", "Orthotics"]);
});

await test("D7a — color-only shopping scope is engine-owned, not legacy-agent owned", async () => {
  let receivedScope = null;
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "i need pink shoes",
    sessionMemory: { explicit: { gender: "women", color: "pink" }, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async (scope) => {
      receivedScope = scope;
      return [
        uiCandidate({
          title: "Emily Lace-Up Sneaker - Peach",
          handle: "emily-peach",
          productType: "Sneakers",
          attributes: { category: "Sneakers", gender: "Women", color_family: "pink" },
        }),
      ];
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline,
    `color-only product request must be handled by engine; got ${JSON.stringify(out?.diagnostics)}`);
  assert.equal(receivedScope?.color, "pink");
  assert.equal(receivedScope?.category || "", "");
  assert.deepEqual(out.products.map((product) => product.handle), ["emily-peach"]);
  assert.match(out.answerText, /\bpink\b/i);
  assert.equal(out.cta?.color, "pink");
  assert.equal(out.cta?.gender, "women");
});

await test("D7b — category-less technology definition is owned by the engine and keeps only proven cards", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what is BioRocker?",
    messages: [{ role: "user", content: "what is BioRocker?" }],
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [
      uiCandidate({
        title: "Savannah Sandal",
        handle: "savannah",
        description: "Designed with BioRocker Technology for a natural stride.",
      }),
      uiCandidate({
        title: "Plain Sandal",
        handle: "plain-sandal",
        description: "An everyday sandal.",
      }),
    ],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline,
    `concrete catalog definition must be engine-owned; got ${JSON.stringify(out?.diagnostics)}`);
  assert.deepEqual(out.scope.requiredCatalogTerms, ["bio rocker"]);
  assert.deepEqual(out.products.map((product) => product.handle), ["savannah"]);
  assert.match(
    out.answerText,
    /^BioRocker is our technology for a natural stride/i,
  );
  assert.match(out.answerText, /I'd start with Savannah Sandal as one style that uses it/i);
  assert.doesNotMatch(
    out.answerText,
    /product description|catalog evidence|explicitly mentions|verified|configured|merchant/i,
  );
});

await test("D7bb — merchant product data restores branded concept casing from a lowercase question", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what is bio rocker?",
    messages: [{ role: "user", content: "what is bio rocker?" }],
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [
        uiCandidate({
          title: "Savannah Sandal",
          handle: "savannah",
          description: "Designed with BioRocker™ Technology for a natural stride.",
        }),
    ],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline);
  assert.match(out.answerText, /^BioRocker is our /);
  assert.doesNotMatch(out.answerText, /^bio rocker /);
});

await test("D7c — immediate technology continuation stays in the engine without a category", async () => {
  const message = "Which other shoe styles feature this technology?";
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: message,
    messages: [
      { role: "user", content: "what is BioRocker?" },
      { role: "assistant", content: "BioRocker is used in selected products." },
      { role: "user", content: message },
    ],
    sessionMemory: { explicit: {}, inferred: {} },
  }, {
    forceEnable: true,
    searchFn: async () => [
      uiCandidate({
        title: "Savannah Sandal",
        handle: "savannah",
        description: "Designed with BioRocker Technology for a natural stride.",
      }),
      uiCandidate({
        title: "Plain Sandal",
        handle: "plain-sandal",
        description: "An everyday sandal.",
      }),
    ],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline,
    `immediate concrete-topic continuation must be engine-owned; got ${JSON.stringify(out?.diagnostics)}`);
  assert.equal(out.scope.catalogQueryContinuedFromPrior, true);
  assert.deepEqual(out.scope.requiredCatalogTerms, ["bio rocker"]);
  assert.deepEqual(out.products.map((product) => product.handle), ["savannah"]);
  assert.ok(out.answerText.length > 0, "engine must not emit confident empty text");
  assert.match(
    out.answerText,
    /For styles with BioRocker, I'd start with Savannah Sandal because it includes the feature you asked about/i,
  );
  assert.doesNotMatch(out.answerText, /product description|catalog evidence|explicitly mentions/i);
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

await test("D11 — condition claim drops unproven runner-ups from the carousel", async () => {
  // Bug 2 regression. Live failure (2026-06-03 kids flat-feet query):
  // engine showed 10 orthotics — 1 tagged for flat_feet + 9 unrelated
  // (cleats, skate, accessories). When the customer asks for a
  // specific condition, the carousel should be wall-to-wall proven
  // matches; no padding with off-condition SKUs.
  const flatFeetMatch = uiCandidate({
    title: "L1320 Thinsoles Posted Orthotics",
    handle: "l1320-thinsoles",
    productType: "Orthotics",
    attributes: { category: "Orthotics", gender: "Kids" },
    tags: ["flat feet"],
  });
  const cleats = uiCandidate({
    title: "L1220 Cleats Posted Orthotics",
    handle: "l1220-cleats",
    productType: "Orthotics",
    attributes: { category: "Orthotics", gender: "Kids" },
    tags: ["high arch"],
  });
  const skate = uiCandidate({
    title: "Bauer Skate Aetrex Insole",
    handle: "bauer-skate",
    productType: "Orthotics",
    attributes: { category: "Orthotics", gender: "Kids" },
    tags: [],
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what orthotics do you have for kids with flat feet",
    sessionMemory: {
      explicit: { gender: "kids", category: "orthotics", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [flatFeetMatch, cleats, skate],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline,
    `engine must handle kids flat-feet orthotics; got decline ` +
      `rungs=${out.diagnostics?.rungs?.join("|")}`);
  // Only the flat-feet-tagged card should display. Cleats + skate
  // are dropped because the customer asked for a specific condition.
  assert.equal(out.products.length, 1,
    `expected only the flat-feet match; got ${out.products.length} cards: ` +
      out.products.map((p) => p.handle).join(","));
  assert.equal(out.products[0].handle, "l1320-thinsoles");
  assert.equal(out.diagnostics?.selectionReason, "all_proven",
    "condition-claim selection must reach all_proven (deferred dropped)");
});

await test("D12 — exact-gender families outrank unisex fallbacks in selection", async () => {
  // Bug A regression (2026-06-03 kids flat-feet): unisex cleats
  // orthotic (L1220u) surfaced ahead of the merchant's
  // kid-gender-tagged orthotics. Unisex is a fit FALLBACK; when an
  // exact-gender match exists, it must win.
  const kidsTagged = uiCandidate({
    title: "L1320 Kids Posted Orthotics",
    handle: "l1320-kids",
    productType: "Orthotics",
    attributes: { category: "Orthotics", gender: "Kid" },
    tags: ["flat feet"],
  });
  const unisexCleats = uiCandidate({
    title: "L1220 Unisex Cleats Posted Orthotics",
    handle: "l1220-unisex",
    productType: "Orthotics",
    attributes: { category: "Orthotics", gender: "Unisex" },
    tags: ["flat feet"],
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "kids' orthotics for flat feet",
    sessionMemory: {
      explicit: { gender: "kid", category: "orthotics", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [kidsTagged, unisexCleats],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.equal(out.products.length, 1,
    `unisex fallback must drop when an exact-gender match exists; got cards: ` +
      out.products.map((p) => p.handle).join(","));
  assert.equal(out.products[0].handle, "l1320-kids");
});

await test("D13 — all-unisex pool under specific gender drops gender from label", async () => {
  // Bug B regression: when no exact-gender SKUs exist in the catalog
  // and only unisex cards remain, the composer must NOT label them
  // "kid orthotics" — the card title literally says "Unisex".
  const unisexCleats = uiCandidate({
    title: "L1220 Unisex Cleats Posted Orthotics",
    handle: "l1220-unisex",
    productType: "Orthotics",
    attributes: { category: "Orthotics", gender: "Unisex" },
    tags: ["flat feet"],
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "kids' orthotics for flat feet",
    sessionMemory: {
      explicit: { gender: "kid", category: "orthotics", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [unisexCleats],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.equal(out.products.length, 1);
  assert.ok(
    !/\bkids?'?\s+orthotic/i.test(out.answerText),
    `composer must not say "kid orthotics" over a Unisex card; got: ${out.answerText}`,
  );
  assert.ok(
    /\borthotic/i.test(out.answerText),
    `composer must still say "orthotics" — just without the kid prefix; got: ${out.answerText}`,
  );
});

await test("D14 — engine reads resolverState category when memory has only claim/color/gender", async () => {
  let observedScope = null;
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "52 year old nurse, black slip on, plantar fasciitis",
    sessionMemory: {
      explicit: { gender: "women", color: "black", condition: "plantar_fasciitis" },
      inferred: {},
    },
    resolverState: {
      matched_constraints: { gender: "women", color: "black", condition: "plantar_fasciitis" },
      inferred_constraints: { category: { value: "slip-ons", reason: "resolver_candidates" } },
    },
  }, {
    forceEnable: true,
    searchFn: async (scope) => {
      observedScope = scope;
      return [
        uiCandidate({
          title: "Emma Slip-On - Black",
          handle: "emma-black",
          productType: "Slip Ons",
          attributes: { category: "Slip Ons", gender: "Women", color: "Black" },
          tags: ["Plantar Fasciitis"],
        }),
      ];
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline, `engine should not decline when resolver supplied category; diagnostics=${JSON.stringify(out.diagnostics)}`);
  assert.equal(observedScope.category, "slip-ons");
  assert.ok(out.products.length > 0);
});

await test("D15 — resolver-picked kids orthotic candidates do not trigger named-product decline", async () => {
  let searchCalls = 0;
  const kidsCandidates = [
    uiCandidate({
      title: "Kids Orthotics",
      handle: "l1700y-m",
      productType: "Orthotics",
      attributes: { category: "Orthotics", gender: "Kids" },
    }),
    uiCandidate({
      title: "Kids Posted Orthotics",
      handle: "l1720y-m",
      productType: "Orthotics",
      attributes: { category: "Orthotics", gender: "Kids" },
    }),
    uiCandidate({
      title: "Kids Orthotics W/ Metatarsal Support",
      handle: "l1750y-m",
      productType: "Orthotics",
      attributes: { category: "Orthotics", gender: "Kids" },
    }),
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Do you have kids orthotics?",
    sessionMemory: {
      explicit: { gender: "kids", category: "orthotics", specificProduct: "l1700y-m" },
      inferred: {},
    },
    resolverState: {
      type: "resolver_state",
      matched_constraints: { gender: "kids", category: "orthotics", specificProduct: "l1700y-m" },
      inferred_constraints: {},
      candidate_products: kidsCandidates.map(({ handle, title }) => ({ handle, title })),
      recommended_next_action: { type: "recommend", reason: "3 products match" },
    },
  }, {
    forceEnable: true,
    searchFn: async () => {
      searchCalls += 1;
      return kidsCandidates;
    },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline,
    `resolver-backed specificProduct must not decline; diagnostics=${JSON.stringify(out?.diagnostics)}`);
  assert.equal(searchCalls, 1);
  assert.deepEqual(out.products.map((p) => p.handle), ["l1700y-m", "l1720y-m", "l1750y-m"]);
  assert.match(out.answerText, /kids'?|orthotic/i);
});

await test("D16 — kids+footwear empty pool emits honest coverage message, not 'try a different style or color'", async () => {
  // Live failure 2026-06-03 19:28:27 — customer asked
  // "My 7-year-old son has flat feet, the pediatrician said he might
  //  need orthotics but we want to try supportive shoes first…"
  // The catalog has NO kids footwear (only kids orthotics +
  // accessories). The generic empty_pool composer emitted
  // "I couldn't find kid footwear in our current catalog. Try a
  //  different style or color?" — a misleading dead-end. Customer
  // changing style or color won't surface kids shoes that don't
  // exist. Engine should acknowledge the structural gap honestly
  // and offer the kids orthotics we DO carry.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "supportive shoes for my 7-year-old with flat feet",
    sessionMemory: {
      explicit: { gender: "kid", category: "footwear", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.equal(out.products.length, 0);
  assert.match(out.answerText, /don't\s+carry\s+kids/i,
    `expected honest 'don't carry kids' shoes' message; got: ${out.answerText}`);
  assert.match(out.answerText, /orthotic/i,
    `expected the message to point to kids orthotics; got: ${out.answerText}`);
  assert.doesNotMatch(out.answerText, /try\s+a\s+different\s+style\s+or\s+color/i,
    `'try a different style or color' must not appear for the kids-no-footwear case`);
});

await test("D17 — 'wide width' excludes products tagged helps_with=Narrow Feet", async () => {
  // Live trace 2026-06-03 19:51:34 — customer asked "Do you have
  // wide width?" on men's sneakers. The carousel included Miles
  // (tagged helps_with=['Arch Pain','Ball of Foot Pain','Flat Feet',
  //  'Heel Pain','High Instep','Metatarsalgia','Narrow Feet']), even
  // though "Narrow Feet" is exactly what disqualifies a sneaker for
  // a wide-width shopper. Two compounding bugs:
  //   1. MERCHANT_CONDITION_TAG_MAP didn't include "narrow feet" /
  //      "wide feet" — those metafield values were dropped silently.
  //   2. scope.width was never converted to a requestedClaim — so
  //      the selector ran no_claim_requested and kept everything.
  // Both fixed; this test locks in the behavior.
  const dash = uiCandidate({
    title: "Dash Arch Support Men's Sneaker - Grey",
    handle: "dash-grey",
    productType: "Sneakers",
    attributes: { category: "Sneakers", gender: "Men", helps_with: ["Arch Pain", "Heel Pain"] },
  });
  const milesBlack = uiCandidate({
    title: "Miles Arch Support Sneaker - Black",
    handle: "miles-black",
    productType: "Sneakers",
    attributes: {
      category: "Sneakers", gender: "Men",
      helps_with: ["Arch Pain", "Ball of Foot Pain", "Flat Feet", "Heel Pain", "High Instep", "Metatarsalgia", "Narrow Feet"],
    },
  });
  const milesTan = uiCandidate({
    title: "Miles Arch Support Sneaker - Tan",
    handle: "miles-tan",
    productType: "Sneakers",
    attributes: {
      category: "Sneakers", gender: "Men",
      helps_with: ["Arch Pain", "Flat Feet", "Heel Pain", "Narrow Feet"],
    },
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Do you have wide width?",
    sessionMemory: {
      explicit: { gender: "men", category: "sneakers", width: "wide" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [dash, milesBlack, milesTan],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline,
    `engine must handle the wide-width query; got decline rungs=${out.diagnostics?.rungs?.join("|")}`);
  const handles = out.products.map((p) => p.handle);
  assert.ok(!handles.some((h) => /miles/i.test(h)),
    `Miles (tagged Narrow Feet) MUST be excluded for wide-width; got ${handles.join(",")}`);
  assert.ok(handles.includes("dash-grey"),
    `Dash (no narrow-feet tag) must remain; got ${handles.join(",")}`);
});

await test("D18 — width filter is a no-op when no narrow/wide-feet tag exists", async () => {
  // Products with no width signal at all pass through — we only
  // exclude the ones the merchant has actively tagged for the
  // OPPOSITE width. Otherwise this would over-filter every catalog
  // that doesn't use the foot-width helps_with vocabulary.
  const a = uiCandidate({
    title: "A", handle: "a",
    productType: "Sneakers",
    attributes: { category: "Sneakers", gender: "Men", helps_with: ["Arch Pain"] },
  });
  const b = uiCandidate({
    title: "B", handle: "b",
    productType: "Sneakers",
    attributes: { category: "Sneakers", gender: "Men" }, // no helps_with at all
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "wide width sneakers",
    sessionMemory: {
      explicit: { gender: "men", category: "sneakers", width: "wide" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [a, b],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.equal(out.products.length, 2,
    `untagged products must pass through; got ${out.products.map((p) => p.handle).join(",")}`);
});

await test("D19 — complex 'dressy + walking' multi-criteria turn declines (let LLM handle)", async () => {
  // Live trace 2026-06-03 Italy turn. Customer asked for ONE pair
  // of shoes for sightseeing + nicer-restaurants dinner + flat
  // feet support + 8-10 mile cobblestone walks. The engine reduced
  // it to (gender=women, category=sandals, condition=flat_feet,
  // useCase=walking) and returned 6 sandals including flip-flops
  // — flip-flops being the antithesis of "dressy enough for a
  // restaurant". The engine can't synthesize conflicting use
  // cases; it MUST decline so the LLM agent reads the whole ask
  // and applies judgement.
  const italyMsg =
    "I'm going on a 10-day trip to Italy in August where I'll be walking 8-10 miles a day on cobblestones, " +
    "I need ONE pair of shoes that works for both daytime sightseeing and dinner at nicer restaurants, " +
    "I have flat feet and tend to get arch pain after about 3 miles — what do you have that's both " +
    "supportive and looks dressy enough for a restaurant?";
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: italyMsg,
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", useCase: "walking", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [uiCandidate({ title: "Maui Flip", handle: "maui-w" })],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline,
    `engine must decline the multi-criteria dressy+walking ask; got handled with cards=${out.products?.length}`);
  assert.ok(
    Array.isArray(out.diagnostics?.rungs) && out.diagnostics.rungs.includes("declined:scope-too-thin"),
    `expected scope-too-thin rung for complex turn; got rungs=${out.diagnostics?.rungs?.join("|")}`,
  );
});

await test("D20 — short focused query (no dressy conflict) still takes the engine", async () => {
  // Sanity: don't over-decline. Short queries with a single use
  // case must stay on the engine path so the warm copy + claim
  // verification still runs.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "women's sandals for flat feet",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [
      uiCandidate({
        title: "Whit Sport Sandal", handle: "whit",
        attributes: { category: "Sandals", gender: "Women", helps_with: ["Flat Feet"] },
        tags: ["flat feet"],
      }),
    ],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline, `simple women's-sandals-for-flat-feet must NOT decline; got rungs=${out.diagnostics?.rungs?.join("|")}`);
  assert.ok(out.products.length >= 1);
});

await test("D21 — Maui men's and women's never collapse into the same family", async () => {
  // Live trace 2026-06-03 Italy turn (screenshot): a women's-scope
  // carousel surfaced "Maui Orthotic Men's Flips - Black" because
  // familyKey returned `t:maui` for both, so the women's-only
  // search candidate "expanded" to include the men's variant. Fix:
  // familyKey now prefixes with `_gender`. This test locks it in.
  const womensFlip = uiCandidate({
    title: "Maui Orthotic Women's Flips - Black",
    handle: "maui-w-black",
    productType: "Sandals",
    attributes: { category: "Sandals", gender: "Women", helps_with: ["Flat Feet"] },
    tags: ["flat feet"],
  });
  const mensFlip = uiCandidate({
    title: "Maui Orthotic Men's Flips - Black",
    handle: "maui-m-black",
    productType: "Sandals",
    attributes: { category: "Sandals", gender: "Men", helps_with: ["Flat Feet"] },
    tags: ["flat feet"],
  });
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "women's flat-feet sandals",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", condition: "flat_feet" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    // searchFn supplies both — simulating the prior bug where the
    // search leaked a men's product into a women's-scope retrieval.
    searchFn: async () => [womensFlip, mensFlip],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  const handles = out.products.map((p) => p.handle);
  // Even if both are in the retrieval pool, the women's preference
  // (preferExactGenderOverUnisex on the proven set + gender-keyed
  // families) must drop the men's product.
  assert.ok(!handles.includes("maui-m-black"),
    `Maui men's must NOT appear in a women's-scope carousel; got ${handles.join(",")}`);
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

// ─── Account/loyalty/order questions decline ─────────────────────

await test("D22 — 'how many points do I have?' DECLINES (LLM path owns account data)", async () => {
  let searchCalled = false;
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "how many points i have?",
    sessionMemory: {
      explicit: { gender: "women", category: "sneakers" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => { searchCalled = true; return []; },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && out.decline, "loyalty turn must decline so LLM with loyalty context answers");
  assert.equal(searchCalled, false, "engine must NOT search the catalog on loyalty turns");
  assert.ok(
    (out.diagnostics?.rungs || []).some((r) => r === "declined:account_question"),
    `expected declined:account_question rung; got ${(out.diagnostics?.rungs || []).join("|")}`,
  );
});

await test("D22b — order tracking declines", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "where is my order?",
  }, {
    forceEnable: true,
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && out.decline);
});

await test("D22c — referral question declines", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "how do I share my referral link?",
  }, {
    forceEnable: true,
    searchFn: async () => [],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && out.decline);
});

// ─── Pronoun + review-shape reuses prior product cards ──────────

await test("D23 — 'return rate on these?' reuses priorProductCards (no fresh search)", async () => {
  let searchCalled = false;
  const priorCards = [
    {
      title: "Danika Navy Sneaker",
      handle: "danika-navy-ap105w",
      image: "https://cdn/danika.jpg",
      url: "https://shop/products/danika-navy-ap105w",
      price: "159.95",
      priceRange: "$159.95",
      productType: "Sneakers",
      description: "Sneaker with arch support.",
      descriptionSnippet: "",
      tags: [],
      attributes: { category: "Sneakers", gender: "Women" },
    },
    {
      title: "Charlotte Sneaker",
      handle: "charlotte-sneaker",
      image: "https://cdn/charlotte.jpg",
      url: "https://shop/products/charlotte-sneaker",
      price: "149.95",
      priceRange: "$149.95",
      productType: "Sneakers",
      description: "Casual sneaker.",
      descriptionSnippet: "",
      tags: [],
      attributes: { category: "Sneakers", gender: "Women" },
    },
  ];
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "what is the return rate on these?",
    sessionMemory: {
      explicit: { gender: "women", category: "sneakers" },
      inferred: {},
    },
    priorProductCards: priorCards,
  }, {
    forceEnable: true,
    searchFn: async () => { searchCalled = true; return []; },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, "review+pronoun follow-up should be engine-handled");
  assert.equal(searchCalled, false, "engine must reuse priorProductCards, not re-search");
  assert.ok(
    (out.diagnostics?.rungs || []).some((r) => r.startsWith("retrieved:") && r.endsWith("_prior_cards")),
    `expected retrieved:N_prior_cards rung; got ${(out.diagnostics?.rungs || []).join("|")}`,
  );
  // The two prior cards must come through unchanged (engine drops nothing
  // here — both have category/gender tags so claim fact attach succeeds).
  const titles = out.products.map((p) => p.title).sort();
  assert.deepEqual(titles, ["Charlotte Sneaker", "Danika Navy Sneaker"]);
});

await test("D24 — pronoun-only follow-up without priorProductCards goes through normal search", async () => {
  let searchCalled = false;
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "do these run small?",
    sessionMemory: {
      explicit: { gender: "women", category: "sneakers" },
      inferred: {},
    },
    priorProductCards: [],
  }, {
    forceEnable: true,
    searchFn: async () => { searchCalled = true; return [uiCandidate({ title: "Maui", handle: "maui" })]; },
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline);
  assert.equal(searchCalled, true, "no prior cards → engine falls back to normal search");
});

// ─── Multi-criteria conflict (dressy + active) on short messages ──

await test("D25 — short 'walking 8 miles, dressy shoe' declines (multi-criteria conflict)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "i'm walking 8 miles, i need a dressy shoe, what do you suggest?",
  }, {
    forceEnable: true,
    searchFn: async () => [uiCandidate({ title: "Whit Sandal", handle: "whit" })],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && out.decline,
    `dressy+walking conflict must decline regardless of length; got rungs=${(out?.diagnostics?.rungs || []).join("|")}`);
});

await test("D25b — focused 'sandals for plantar fasciitis' still owned by engine (no false multi-criteria trigger)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "women's sandals for plantar fasciitis",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", condition: "plantar_fasciitis" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => [uiCandidate({ title: "Vicki", handle: "vicki" })],
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, "focused single-criteria query must stay with engine");
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
