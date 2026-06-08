// End-to-end Product Turn Engine eval — runs the regression
// conversations the spec listed through the engine with the flag
// forced ON, using catalog fixtures (no DB, no Shopify call).
//
// The engine is `runProductTurn(ctx, { searchFn, claimConfig,
// forceEnable: true })`. searchFn is injected with a fixture
// catalog; claimConfig is a synthetic merchant-config bag (so this
// harness verifies the engine works for ANY merchant, not just
// Aetrex). The Aetrex categories/colors below are stand-ins for
// the live shop's data — they're test fixtures, not code lists.
//
// Each scenario asserts:
//   - engine returned (didn't decline)
//   - answerText is non-empty AND has useful content
//   - composer never invents the claim across the pool when
//     evidence is partial
//   - same-base-style families collapse for compare
//   - stale memory does NOT contaminate pivots

import assert from "node:assert/strict";
import {
  runProductTurn,
  resolveTurnScope,
  groupVariantsByBaseStyle,
  selectByProvenFacts,
} from "../app/lib/product-turn-engine.server.js";

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

console.log("Product Turn Engine — transcript eval\n");

// ─── synthetic merchant config (not Aetrex-specific code) ───────
// The harness builds a config the same way getMerchantClaimConfig
// would after the default seed. Tests can swap groups/families to
// prove the engine has no Aetrex-shaped assumptions in code.
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

// Catalog fixture — minimal product entries for the engine's input.
// canonical product shape: {title, handle, productType, description,
// descriptionSnippet, tags, attributes, price, compareAtPrice}
const PINK_SANDAL_POOL = [
  {
    title: "Piper Arch Support Strap Sandal - Terracotta",
    handle: "piper-terracotta-au1305w",
    productType: "Sandals",
    description: "Sandal with Built-In Arch Support.",
    tags: ["Bunions"],
    attributes: { category: "Sandals", gender: "Women" },
  },
  {
    title: "Vicki Braided Thong Sandal - Light Pink Gloss",
    handle: "vicki-light-pink-gloss-st3519w",
    productType: "Sandals",
    description: "Sandal with arch support.",
    tags: ["Bunions"],
    attributes: { category: "Sandals", gender: "Women" },
  },
  {
    title: "Jillian Braided Quarter Strap Sandal - Antique Rose",
    handle: "jillian-antique-rose-sc443w",
    productType: "Sandals",
    description: "Sandal with arch support.",
    tags: ["Bunions"],
    attributes: { category: "Sandals", gender: "Women" },
  },
];

const PLANTAR_FASCIITIS_POOL = [
  {
    title: "Whit Sport Sandal - Champagne",
    handle: "whit-champagne-ss303w",
    productType: "Sandals",
    description: "Sport sandal with Built-In Arch Support.",
    tags: ["Plantar Fasciitis"],
    attributes: { category: "Sandals", gender: "Women" },
  },
  {
    title: "Jillian Sport Sandal - Black",
    handle: "jillian-sport-black-l8000w",
    productType: "Sandals",
    description: "Sport sandal.",
    tags: [],
    attributes: { category: "Sandals", gender: "Women" },
  },
  {
    title: "Jess Adjustable Quarter Strap Sandal - Pewter Sparkle",
    handle: "jess-pewter-sparkle-se206w",
    productType: "Sandals",
    description: "Adjustable sandal with arch support.",
    tags: ["Plantar Fasciitis"],
    attributes: { category: "Sandals", gender: "Women" },
  },
];

const JILLIAN_COLORWAYS_POOL = [
  {
    title: "Jillian Shimmer Blush",
    handle: "jillian-shimmer-blush-sc440w",
    productType: "Sandals",
    description: "Sandal with arch support.",
    tags: [],
    attributes: { category: "Sandals", gender: "Women" },
  },
  {
    title: "Jillian Coral",
    handle: "jillian-coral-sc441w",
    productType: "Sandals",
    description: "Sandal with arch support.",
    tags: [],
    attributes: { category: "Sandals", gender: "Women" },
  },
];

const MENS_DRESS_POOL = [
  {
    title: "Dana Navy",
    handle: "dana-navy-dm305m",
    productType: "Oxfords",
    description: "Men's dress oxford with arch support.",
    tags: [],
    attributes: { category: "Oxfords", gender: "Men" },
  },
  {
    title: "Liam Dark Brown",
    handle: "liam-dark-brown-lb500m",
    productType: "Loafers",
    description: "Men's loafer with arch support.",
    tags: [],
    attributes: { category: "Loafers", gender: "Men" },
  },
];

const NEUTRAL_WEDGES_POOL = [
  {
    title: "Sydney Champagne",
    handle: "sydney-champagne-ew751w",
    productType: "Wedges Heels",
    description: "Wedge with arch support.",
    tags: [],
    attributes: { category: "Wedges Heels", gender: "Women" },
  },
  {
    title: "Andrea Black",
    handle: "andrea-black-hw220w",
    productType: "Wedges Heels",
    description: "Wedge with arch support.",
    tags: [],
    attributes: { category: "Wedges Heels", gender: "Women" },
  },
];

const fixedSearch = (pool) => async () => pool;

const ctxBase = {
  shop: "fixture.myshopify.com",
};

// ─── scenarios ──────────────────────────────────────────────────

await test("E2E-1 — 'pink sandals + arch support + bunions' returns text AND products (no zeroing)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "i want pink sandals with arch support and i have bunions",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", color: "pink", condition: "bunions" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(PINK_SANDAL_POOL),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline, "engine must not decline");
  assert.ok(out.answerText && out.answerText.length > 30,
    `answerText too short: "${out?.answerText}"`);
  assert.ok(out.products.length === 3, `expected 3 products; got ${out?.products?.length}`);
  // All three pool cards have the bunions tag → all_proven path,
  // composer can say "tagged for bunions" truthfully.
  assert.match(out.answerText, /bunions/i,
    `expected proven-condition mention; got "${out.answerText}"`);
});

await test("E2E-2 — same-base-style colorways collapse for compare (Jillian × 2)", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "which has the most cushioning like the Jillian?",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(JILLIAN_COLORWAYS_POOL),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  // Engine declines named-product lookups in v1 — but the family
  // grouping primitive must still collapse the two Jillians for
  // the next-level compare logic. Test the primitive directly.
  const families = groupVariantsByBaseStyle(
    JILLIAN_COLORWAYS_POOL.map((p) => ({ ...p, _claimFacts: { productLine: { value: null } } })),
  );
  assert.equal(families.length, 1, `Jillian × 2 must collapse to 1 family; got ${families.length}`);
  assert.equal(families[0].variants.length, 2);
  // The engine itself declines this turn (named-product), as expected.
  assert.ok(out && out.decline, `named-product turn should decline; got ${JSON.stringify(out?.diagnostics)}`);
});

await test("E2E-3 — 'best dress shoes for men' after pink-sandals/bunions context drops stale scope", async () => {
  // The intent resolver's job is to clean memory BEFORE the engine
  // runs. Here we simulate that result: explicit memory shows only
  // the NEW scope (men + dress) after the turn-intent pivot, with
  // pink/sandals/bunions moved to stale.
  //
  // With the opt-in engine inversion, useCase=dress IS positive
  // retrieval evidence — engine can author "best dress shoes for
  // men" from the dress-tagged pool. Critical assertion remains the
  // same: stale scope (pink/sandals/bunions) must NOT leak.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "What are the best dress shoes for men?",
    sessionMemory: {
      explicit: { gender: "men", useCase: "dress" },
      inferred: {},
      stale: { color: "pink", category: "sandals", condition: "bunions" },
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(MENS_DRESS_POOL),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out && !out.decline,
    `engine should claim with useCase=dress + gender evidence; got ${JSON.stringify(out?.diagnostics)}`);
  // Critical: the scope the engine resolved must NOT contain stale
  // pink/sandals/bunions.
  assert.equal(out.diagnostics.scope.color, null,
    `stale color must not leak into scope; got ${out.diagnostics.scope.color}`);
  assert.equal(out.diagnostics.scope.category, null,
    `stale category must not leak into scope; got ${out.diagnostics.scope.category}`);
  assert.equal(out.diagnostics.scope.condition, null,
    `stale condition must not leak into scope; got ${out.diagnostics.scope.condition}`);
});

await test("E2E-4 — named-product turn DECLINES when no similarFn/resolveNamedProductFn is supplied", async () => {
  // Phase 1 behavior preserved: without the injectors the engine
  // falls through. This lets older callers (eval harnesses, fixture
  // mode) continue without the similar-product path activating.
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "What other shoes have same support as Danika?",
    sessionMemory: {
      explicit: { gender: "women", specificProduct: "danika" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch([]),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(out.decline, "named-product turns decline when injectors absent");
});

await test("E2E-5 — 'wedges in black or neutral' detects color-family from data-driven config", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "Do you have wedges in black or neutral colors?",
    sessionMemory: {
      explicit: { gender: "women", category: "wedges-heels", color: "black" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(NEUTRAL_WEDGES_POOL),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline, "engine should handle wedges turn");
  assert.equal(out.diagnostics.scope.color, "black");
  assert.equal(out.diagnostics.scope.colorFamily, "neutral",
    `expected colorFamily=neutral from data-driven config; got ${out.diagnostics.scope.colorFamily}`);
  // Engine must NOT carry stale gender=men anywhere — the explicit
  // scope is women only.
  assert.equal(out.diagnostics.scope.gender, "women");
});

await test("E2E-6 — 'plantar fasciitis women's sandals' produces useful text, not generic fallback", async () => {
  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "I have plantar fasciitis, what women's sandals do you recommend?",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", condition: "plantar_fasciitis" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(PLANTAR_FASCIITIS_POOL),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  assert.ok(out.answerText.length > 30, `answer too short: "${out.answerText}"`);
  // 2 of 3 cards have the tag → proven_preferred path.
  // Composer should mention plantar fasciitis truthfully for
  // selected (proven) ones.
  assert.match(out.answerText, /plantar fasciitis/i,
    `proven-condition mention expected; got "${out.answerText}"`);
  // Must never use the bland template line.
  assert.doesNotMatch(out.answerText, /^Here are the matching styles I found\.?$/i);
});

await test("E2E-7 — new category in fixture works without code-list change (merchant adds 'espadrilles')", async () => {
  // Custom config: merchant added "espadrilles" to Footwear.
  const customConfig = JSON.parse(JSON.stringify(FIXTURE_CLAIM_CONFIG));
  customConfig.categoryGroups
    .find((g) => g.name === "Footwear").categories.push("espadrilles");

  const espadrillePool = [
    {
      title: "Sun Espadrille - Natural",
      handle: "sun-espadrille-natural",
      productType: "Espadrilles",
      description: "Casual espadrille.",
      tags: [],
      attributes: { category: "Espadrilles", gender: "Women" },
    },
  ];

  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "show me espadrilles",
    sessionMemory: {
      explicit: { gender: "women", category: "espadrilles" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(espadrillePool),
    claimConfig: customConfig,
  });
  assert.ok(!out.decline);
  // The card MUST carry _archSupport=true via the brand rule because
  // espadrilles is in the merchant's Footwear group. No code list of
  // categories anywhere — purely config-driven.
  assert.equal(out.products[0]._archSupport, true,
    `merchant-added category must inherit claim rule; got _archSupport=${out.products[0]._archSupport} source=${out.products[0]._claimFacts?.archSupport?.source}`);
  assert.equal(out.products[0]._claimFacts.archSupport.source, "claim_rule_category_group");
});

await test("E2E-8 — new color family in fixture works without code-list change (merchant adds 'earth-tones')", async () => {
  const customConfig = JSON.parse(JSON.stringify(FIXTURE_CLAIM_CONFIG));
  customConfig.colorFamilies.push({
    name: "earth-tones",
    members: ["tan", "brown", "olive", "rust", "terracotta"],
  });

  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "any wedges in earth-tones?",
    sessionMemory: {
      explicit: { gender: "women", category: "wedges-heels" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(NEUTRAL_WEDGES_POOL),
    claimConfig: customConfig,
  });
  assert.equal(out.diagnostics.scope.colorFamily, "earth-tones",
    `merchant-added color family must resolve; got ${out.diagnostics.scope.colorFamily}`);
});

await test("E2E-9 — composer NEVER invents a claim across the pool when only partial proof exists", async () => {
  // Mixed pool: only 1 of 3 cards is tagged for the requested
  // condition. Composer must NOT say "all of these are tagged for…".
  const mixedPool = [
    {
      title: "A",
      handle: "a",
      attributes: { category: "Sandals", gender: "Women" },
      tags: ["Plantar Fasciitis"],
      description: "Arch support sandal.",
    },
    {
      title: "B",
      handle: "b",
      attributes: { category: "Sandals", gender: "Women" },
      tags: [],
      description: "Arch support sandal.",
    },
    {
      title: "C",
      handle: "c",
      attributes: { category: "Sandals", gender: "Women" },
      tags: [],
      description: "Arch support sandal.",
    },
  ];

  const out = await runProductTurn({
    ...ctxBase,
    latestUserMessage: "any sandals for plantar fasciitis?",
    sessionMemory: {
      explicit: { gender: "women", category: "sandals", condition: "plantar_fasciitis" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: fixedSearch(mixedPool),
    claimConfig: FIXTURE_CLAIM_CONFIG,
  });
  assert.ok(!out.decline);
  // Must not say "all" of these are tagged for plantar fasciitis,
  // because only 1 of the 3 is. Acceptable phrasing: "The selected
  // styles are tagged for plantar fasciitis" referring to the proven
  // ones only.
  assert.doesNotMatch(out.answerText, /all\s+(?:of\s+(?:these|them)\s+)?are\s+tagged\s+for\s+plantar\s+fasciitis/i,
    `composer made a universal claim with partial proof; got "${out.answerText}"`);
});

// ──────────────────────────────────────────────────────────────
console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) {
    console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}
