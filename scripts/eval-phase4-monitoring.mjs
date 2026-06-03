// Phase 4 — sales polish + monitoring transcript harness.
//
// Exercises the 9 live bug shapes from the spec and applies the
// audit checks the user listed as monitoring requirements:
//
//   AUDIT CHECKS
//   ──────────────────────────────────────────────────────────────
//   A. empty_text_with_products
//        Engine emitted products but text is empty.
//   B. missing_cta_with_scope
//        Engine emitted products with scope but no CTA payload.
//   C. low_price
//        Any product card with parseable price < $5 (unless the
//        scenario specifically says the item is under $5).
//   D. duplicate_contact_label
//        CTA label contains "Contact Contact" (case-insensitive).
//   E. irrelevant_shoe_chips
//        Chips for a shoe-type question include groups outside
//        Footwear (e.g. <<Accessories>>, <<Orthotics>>).
//   F. repeated_orthotic_ack
//        "Got it — <attribute>. An orthotic can definitely help"
//        ack appears in the gate response when the attribute was
//        already in accumulated answers.
//   G. no_quick_replies_on_policy
//        Policy turn handled but followUps is empty.
//   H. generic_fallback_with_facts_available
//        Composer emitted a bland "Here are the matching styles I
//        found." style line when verified facts existed.
//
// Pure offline — engines run with fixtures, no DB, no Anthropic.

import assert from "node:assert/strict";
import {
  runProductTurn,
} from "../app/lib/product-turn-engine.server.js";
import {
  runPolicyTurn,
} from "../app/lib/policy-engine.server.js";
import {
  filterForbiddenCategoryChips,
  narrowChipAllowListForGroup,
} from "../app/lib/chip-filter.server.js";
import { buildAcknowledgmentPrefix } from "../app/lib/orthotic-flow-gate.server.js";

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

console.log("Phase 4 — sales polish + monitoring eval\n");

// ─── Fixtures ──────────────────────────────────────────────────

const CLAIM_CONFIG = {
  rules: [
    { claim: "archSupport", ruleType: "category_group", appliesToGroup: "Footwear", excludeGroups: ["Orthotics", "Accessories"] },
  ],
  categoryGroups: [
    { name: "Footwear", categories: ["sneakers", "sandals", "boots", "loafers", "oxfords", "clogs", "slip-ons", "slippers", "mary-janes", "wedges-heels"] },
    { name: "Accessories", categories: ["accessories"] },
    { name: "Orthotics", categories: ["orthotics"] },
  ],
  colorFamilies: [
    { name: "neutral", members: ["black", "white", "tan", "brown", "gray", "taupe", "beige", "ivory", "navy"] },
  ],
};

const MERCHANT_GROUPS = [
  { name: "Footwear", categories: ["Sneakers", "Sandals", "Boots", "Clogs", "Loafers", "Oxfords", "Slip Ons", "Slippers", "Mary Janes", "Wedges Heels"] },
  { name: "Orthotics", categories: ["Orthotics"] },
  { name: "Accessories", categories: ["Accessories"] },
];

const sandalCard = (over = {}) => ({
  title: "Maui Sandal - White",
  handle: "maui-white",
  url: "https://shop/products/maui-white",
  image: "https://cdn/maui.jpg",
  price: "139.95",
  priceRange: "$139.95",
  price_formatted: "$139.95",
  compare_at_price: 13995,
  productType: "Sandals",
  description: "Sandal with Built-In Arch Support.",
  tags: [],
  attributes: { category: "Sandals", gender: "Women" },
  ...over,
});

const ctxBase = {
  shop: "fixture.myshopify.com",
  supportUrl: "https://example.com/support",
  supportLabel: "Customer Care",
  storefrontSearchUrlPattern: "https://shop.example/search?q={q}",
};

// ─── AUDIT CHECKS as helpers ───────────────────────────────────

function auditProductEngineOut(out, scenario = {}) {
  const warnings = [];
  const text = String(out?.answerText || "").trim();
  const products = Array.isArray(out?.products) ? out.products : [];

  // A. empty text with products
  if (products.length > 0 && text.length === 0) {
    warnings.push({ code: "A:empty_text_with_products", details: { products: products.length } });
  }

  // B. missing CTA when scope exists
  const scopeExists = !!(out?.scope?.category || out?.scope?.gender || out?.scope?.color);
  if (products.length > 0 && scopeExists && !out?.cta) {
    warnings.push({ code: "B:missing_cta_with_scope", details: { scope: out.scope } });
  }

  // C. low price
  const LOW_PRICE_FLOOR = 5;
  for (const p of products) {
    const cents = Number(p?.compare_at_price) || (Number(parseFloat(p?.price)) * 100);
    const dollars = Number.isFinite(cents) ? cents / 100 : NaN;
    if (Number.isFinite(dollars) && dollars > 0 && dollars < LOW_PRICE_FLOOR && !scenario.allowLowPrice) {
      warnings.push({ code: "C:low_price", details: { handle: p?.handle, dollars } });
    }
  }

  // D. duplicate contact label
  if (/Contact\s+Contact\b/i.test(out?.cta?.label || "")) {
    warnings.push({ code: "D:duplicate_contact_label", details: { label: out.cta.label } });
  }

  // G. no quick replies on policy turn — surfaced in policy audit below.

  // H. generic fallback when verified facts available
  if (
    /^Here are the matching styles I found\.?$/i.test(text)
    && products.some((p) => p?._claimFacts)
  ) {
    warnings.push({ code: "H:generic_fallback_with_facts_available" });
  }

  return warnings;
}

function auditPolicyEngineOut(out) {
  const warnings = [];
  const followUps = Array.isArray(out?.followUps) ? out.followUps : [];
  if (out?.decline === false && followUps.length === 0) {
    warnings.push({ code: "G:no_quick_replies_on_policy" });
  }
  if (/Contact\s+Contact\b/i.test(out?.cta?.label || "")) {
    warnings.push({ code: "D:duplicate_contact_label", details: { label: out.cta.label } });
  }
  return warnings;
}

function auditChipText(text) {
  const warnings = [];
  // E. irrelevant chips for shoe-type question
  if (/<<\s*(?:Accessories|Orthotics)\s*>>/.test(text)) {
    warnings.push({ code: "E:irrelevant_shoe_chips", details: { text } });
  }
  return warnings;
}

// ─── Live bug scenarios ────────────────────────────────────────

await test("P4-1 — pink sandals + arch support + bunions: text, products, CTA, no warnings", async () => {
  const cards = [
    sandalCard({ title: "Piper Arch Support Sandal - Pink", handle: "piper-pink", price: "129.95", price_formatted: "$129.95", compare_at_price: 12995, tags: ["Bunions"] }),
    sandalCard({ title: "Vicki Braided Thong - Pink", handle: "vicki-pink", price: "119.95", price_formatted: "$119.95", compare_at_price: 11995, tags: ["Bunions"] }),
    sandalCard({ title: "Jillian Antique Rose", handle: "jillian-rose", price: "149.95", price_formatted: "$149.95", compare_at_price: 14995, tags: ["Bunions"] }),
  ];
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "i want pink sandals with arch support and i have bunions",
      sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink", condition: "bunions" }, inferred: {} },
    },
    { forceEnable: true, searchFn: async () => cards, claimConfig: CLAIM_CONFIG },
  );
  assert.ok(!out.decline);
  assert.ok(out.answerText.length > 30);
  assert.equal(out.products.length, 3);
  assert.ok(out.cta, "expected a storefront CTA");
  assert.equal(out.cta.kind, "storefront_search");
  // The text MUST honestly mention bunions (verified) and refer
  // the customer to the View All button now that CTA fires.
  assert.match(out.answerText, /bunions/i);
  assert.match(out.answerText, /view all button/i);
  // Follow-ups present (3 chips).
  assert.ok(Array.isArray(out.followUps) && out.followUps.length >= 2);
  // Compare must be one of the chips.
  assert.ok(out.followUps.some((q) => /compare/i.test(q)));
  // Color is set so "Show other colors" should appear.
  assert.ok(out.followUps.some((q) => /other colors|filter by color/i.test(q)));
  // Run the full audit. Zero warnings.
  assert.deepEqual(auditProductEngineOut(out), []);
});

await test("P4-2 — white women's sandals: realistic prices, CTA present", async () => {
  const cards = [
    sandalCard({ title: "Lexa Quarter Strap Wedge - Ivory", handle: "lexa-ivory", price: "140.00", price_formatted: "$140.00", compare_at_price: 14000, attributes: { category: "Wedges Heels", gender: "Women" } }),
    sandalCard({ title: "Grace Adjustable Woven Wedge", handle: "grace-white", price: "150.00", price_formatted: "$150.00", compare_at_price: 15000, attributes: { category: "Wedges Heels", gender: "Women" } }),
    sandalCard({ title: "Avril Quarter Strap - White", handle: "avril-white", price: "150.00", price_formatted: "$150.00", compare_at_price: 15000, attributes: { category: "Wedges Heels", gender: "Women" } }),
  ];
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "show me white heels",
      sessionMemory: { explicit: { gender: "women", category: "wedges-heels", color: "white" }, inferred: {} },
    },
    { forceEnable: true, searchFn: async () => cards, claimConfig: CLAIM_CONFIG },
  );
  assert.ok(out.cta && out.cta.kind === "storefront_search");
  // The C:low_price audit must NOT trip.
  const warnings = auditProductEngineOut(out);
  assert.equal(warnings.filter((w) => w.code === "C:low_price").length, 0,
    `expected no low_price warnings; got ${JSON.stringify(warnings)}`);
});

await test("P4-3 — shipping policy: CTA + quick replies present, no duplicate label", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "how long does shipping take?" },
    {
      forceEnable: true,
      retrievedChunks: [
        { similarity: 0.6, fileType: "faqs", sectionTitle: "SHIPPING", content: "3-7 business days standard." },
      ],
    },
  );
  assert.ok(!out.decline);
  assert.equal(out.cta?.kind, "external_link");
  assert.ok(Array.isArray(out.followUps) && out.followUps.length >= 2);
  // Specifically shipping-relevant chips.
  assert.ok(out.followUps.some((q) => /track/i.test(q) || /international/i.test(q) || /expedited/i.test(q)));
  // Audit
  assert.deepEqual(auditPolicyEngineOut(out), []);
});

await test("P4-4 — warranty fallback (no chunks): CTA + quick replies present, honest text", async () => {
  const out = await runPolicyTurn(
    { ...ctxBase, latestUserMessage: "do you have warranty?" },
    { forceEnable: true, retrievedChunks: [] },
  );
  assert.ok(!out.decline);
  assert.match(out.answerText, /don't have/i);
  assert.match(out.answerText, /contact button below/i);
  assert.doesNotMatch(out.answerText, /https?:\/\//, "no raw URL when CTA exists");
  assert.equal(out.cta?.kind, "external_link");
  assert.ok(out.followUps.length >= 2);
  assert.deepEqual(auditPolicyEngineOut(out), []);
});

await test("P4-5 — orthotic ack does NOT repeat condition once it's in answers", () => {
  // Live bug: Haiku re-extracts foot_pain on every chip. Ack only
  // when attribute is genuinely new.
  const ack = buildAcknowledgmentPrefix({
    latestExtracted: { gender: "women", condition: "foot_pain" },
    rawUserText: "Women",
    answers: { condition: "foot_pain" }, // already known
  });
  assert.doesNotMatch(ack, /foot pain/i,
    `must NOT re-ack a condition already in answers; got "${ack}"`);
});

await test("P4-6 — plantar fasciitis sandals: warm sentence, verified claim, no generic fallback", async () => {
  const cards = [
    sandalCard({ title: "Whit Sport Sandal", handle: "whit", tags: ["Plantar Fasciitis"] }),
    sandalCard({ title: "Jess Adjustable Sandal", handle: "jess", tags: ["Plantar Fasciitis"] }),
    sandalCard({ title: "Jillian Sport Sandal", handle: "jillian", tags: ["Plantar Fasciitis"] }),
  ];
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "I have plantar fasciitis, what women's sandals do you recommend?",
      sessionMemory: { explicit: { gender: "women", category: "sandals", condition: "plantar_fasciitis" }, inferred: {} },
    },
    { forceEnable: true, searchFn: async () => cards, claimConfig: CLAIM_CONFIG },
  );
  // Honest mention of plantar fasciitis (every card has the tag).
  assert.match(out.answerText, /plantar fasciitis/i);
  // No generic fallback.
  assert.doesNotMatch(out.answerText, /^Here are the matching styles I found\.?$/);
  assert.deepEqual(auditProductEngineOut(out), []);
});

await test("P4-7 — same support as Danika (similar-product): CTA + quick replies + warm copy", async () => {
  const danikaSimilar = {
    reference: { handle: "danika-white", title: "Danika Sneaker - White" },
    products: [
      sandalCard({ title: "Chase Sneaker - Navy", handle: "chase-navy", attributes: { category: "Sneakers", gender: "Women", footbed: "ap" }, productType: "Sneakers" }),
      sandalCard({ title: "Molly Sneaker - Tan", handle: "molly-tan", attributes: { category: "Sneakers", gender: "Women", footbed: "ap" }, productType: "Sneakers" }),
    ],
  };
  const out = await runProductTurn(
    {
      ...ctxBase,
      similarMatchAttributes: ["footbed"],
      latestUserMessage: "what other shoes have same support as Danika",
      sessionMemory: { explicit: {}, inferred: {} },
    },
    {
      forceEnable: true,
      searchFn: async () => [],
      similarFn: async () => danikaSimilar,
      resolveNamedProductFn: async () => "danika-white",
      claimConfig: CLAIM_CONFIG,
    },
  );
  assert.ok(!out.decline);
  assert.ok(out.cta, "similar-product turn must carry a CTA");
  assert.ok(Array.isArray(out.followUps) && out.followUps.length >= 2);
  // Should suggest Danika-family colors at minimum.
  assert.ok(out.followUps.some((q) => /Danika/i.test(q) || /colors/i.test(q)));
  assert.deepEqual(auditProductEngineOut(out), []);
});

await test("P4-8 — black/neutral wedges: color-family resolved, CTA fires, follow-ups present", async () => {
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "Do you have wedges in black or neutral colors?",
      sessionMemory: { explicit: { gender: "women", category: "wedges-heels", color: "black" }, inferred: {} },
    },
    {
      forceEnable: true,
      searchFn: async () => [
        sandalCard({ title: "Sydney Champagne", handle: "sydney", attributes: { category: "Wedges Heels", gender: "Women" } }),
        sandalCard({ title: "Andrea Black", handle: "andrea", attributes: { category: "Wedges Heels", gender: "Women" } }),
      ],
      claimConfig: CLAIM_CONFIG,
    },
  );
  assert.equal(out.scope.colorFamily, "neutral");
  assert.ok(out.cta);
  assert.ok(out.followUps.length >= 2);
  assert.deepEqual(auditProductEngineOut(out), []);
});

await test("P4-9 — men's shoe-type question chips drop Accessories + Orthotics", () => {
  const text =
    "What type of men's shoes are you looking for? <<Sneakers>><<Sandals>><<Clogs>><<Accessories>><<Orthotics>>";
  const mensAllow = ["Sneakers", "Sandals", "Clogs", "Accessories", "Orthotics"];
  const scopedAllow = narrowChipAllowListForGroup(text, mensAllow, MERCHANT_GROUPS, "Footwear");
  const filtered = filterForbiddenCategoryChips(text, scopedAllow, mensAllow);
  // Audit the FILTERED text — no Accessories/Orthotics chips should
  // survive.
  assert.deepEqual(auditChipText(filtered.text), []);
  assert.ok(filtered.stripped.includes("Accessories"));
  assert.ok(filtered.stripped.includes("Orthotics"));
});

// ─── invariant checks ──────────────────────────────────────────

await test("P4-10 — composer NEVER emits the bland 'Here are the matching styles I found.' for engine turns", async () => {
  // Audit the CURRENT composer across all 4 selection-reason
  // branches to lock in the seller polish.
  const cards = [
    sandalCard({ title: "A", handle: "a", tags: ["Plantar Fasciitis"] }),
    sandalCard({ title: "B", handle: "b", tags: ["Plantar Fasciitis"] }),
  ];
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "show me women's sandals",
      sessionMemory: { explicit: { gender: "women", category: "sandals" }, inferred: {} },
    },
    { forceEnable: true, searchFn: async () => cards, claimConfig: CLAIM_CONFIG },
  );
  assert.notEqual(out.answerText.trim(), "Here are the matching styles I found.",
    `composer must produce richer copy; got "${out.answerText}"`);
  // The View All hint must appear (scope is gender+category → CTA fires).
  assert.match(out.answerText, /view all button/i);
});

await test("P4-11 — Phase 4 follow-ups never include unanswerable / contradicting / off-group chips", async () => {
  const cards = [
    sandalCard({ title: "A", handle: "a" }),
    sandalCard({ title: "B", handle: "b" }),
    sandalCard({ title: "C", handle: "c" }),
  ];
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "show me women's sandals",
      sessionMemory: { explicit: { gender: "women", category: "sandals" }, inferred: {} },
    },
    { forceEnable: true, searchFn: async () => cards, claimConfig: CLAIM_CONFIG },
  );
  for (const chip of out.followUps || []) {
    // Never push the customer away from their established gender.
    assert.doesNotMatch(chip, /\bmen'?s\b/i,
      `chip "${chip}" must not push from women's → men's`);
    // Never reference Accessories or Orthotics for a sandal turn.
    assert.doesNotMatch(chip, /\b(?:Accessories|Orthotics)\b/i,
      `chip "${chip}" must not reference off-group categories`);
    // Never reference an unverified medical claim.
    assert.doesNotMatch(chip, /\bbunions?|plantar|metatarsalgia|fasciitis\b/i,
      `chip "${chip}" must not invent a medical claim`);
  }
});

await test("P4-12 — every Phase 4 product CTA payload is convertible to {type:link,url,label}", async () => {
  const out = await runProductTurn(
    {
      ...ctxBase,
      latestUserMessage: "show me women's sandals",
      sessionMemory: { explicit: { gender: "women", category: "sandals" }, inferred: {} },
    },
    {
      forceEnable: true,
      searchFn: async () => [sandalCard({ title: "A", handle: "a" })],
      claimConfig: CLAIM_CONFIG,
    },
  );
  assert.ok(out.cta);
  assert.equal(out.cta.kind, "storefront_search");
  // Simulate dispatcher conversion. Engine cta carries gender +
  // category + (maybe) color — must be enough for the storefront
  // URL builder to produce a renderable {url,label}.
  const { buildStorefrontSearchCTA } = await import("../app/lib/storefront-search-cta.server.js");
  const built = buildStorefrontSearchCTA({
    pattern: ctxBase.storefrontSearchUrlPattern,
    gender: out.cta.gender,
    category: out.cta.category,
    color: out.cta.color,
  });
  assert.ok(built && built.url, "buildStorefrontSearchCTA must produce a URL");
  assert.ok(typeof built.label === "string" && built.label.length > 0);
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
