// Core-flows regression QA suite.
//
// 50 core scenarios across every workflow the chatbot must get right, asserting
// the DETERMINISTIC owners (TurnPlan + Availability Truth — the parts that don't
// need a live LLM) plus the cross-cutting invariants from
// docs/chatbot-ownership-map.md:
//   - expected workflow
//   - search required yes/no
//   - clarification allowed (proxy for "no gender question when info suffices")
//   - card count expected
//   - no handle / SKU / internal-field leak in answer text
//   - no broad CTA / URL in an exact-availability answer
//   - answer text and cards mention the same product family
//
// Pure modules only, so this runs in either repo with no DB. The live LLM
// phrasing is out of scope here — that's covered by manual PRD live-testing.
//
// Run: node scripts/eval-live-core-flows.mjs

import assert from "node:assert/strict";
import { planTurn, WORKFLOWS } from "../app/lib/turn-plan.server.js";
import { compactComparison } from "../app/lib/llm-owns-turn.server.js";
import {
  classifyAvailability,
  buildAvailabilityAnswer,
  familyOfTitle,
  AVAILABILITY_RESULT as R,
} from "../app/lib/availability-truth.js";

// Mirrors the chat.jsx comparison pin: one representative card per named
// family, capped at 4. Kept here as the deterministic card-count contract.
function pickComparisonCards(pool, families) {
  const picked = [];
  const seen = new Set();
  for (const fam of families) {
    if (seen.has(fam)) continue;
    const card = (pool || []).find((c) => familyOfTitle(c.title || "") === fam);
    if (card) { picked.push(card); seen.add(fam); }
  }
  return picked.slice(0, 4);
}

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// ── cross-cutting invariant helpers ───────────────────────────────────
const LEAK_PATTERNS = [
  /gid:\/\//i, /\.myshopify\.com/i, /\bhandle\s*[:=]/i, /optionsJson/i,
  /inventoryQty/i, /\bSKU\s*[:=]/i, /variant(_|\s)?id/i, /attributesJson/i,
];
function assertNoLeak(text, label) {
  for (const re of LEAK_PATTERNS) {
    assert.ok(!re.test(String(text || "")), `${label}: internal leak matched ${re}`);
  }
}
function assertNoBroadCTA(text, label) {
  assert.doesNotMatch(String(text || ""), /\bview all\b/i, `${label}: broad "View All" CTA in availability answer`);
  assert.doesNotMatch(String(text || ""), /https?:\/\//i, `${label}: URL in availability answer`);
}
function assertMentionsFamily(text, family, label) {
  assert.match(String(text || "").toLowerCase(), new RegExp(`\\b${family}\\b`), `${label}: text omits family "${family}"`);
}
// Card-count contract for an availability verdict (mirrors the chat.jsx pin):
// NOT_FOUND → 0, DISAMBIGUATION → one card per style, otherwise the family card.
function expectedAvailabilityCards(v) {
  if (v.result === R.NOT_FOUND) return 0;
  if (v.result === R.DISAMBIGUATION) return (v.styles || []).length;
  return 1;
}

// ══ Part 1 — workflow classification + search/clarify/gender ══════════
// Each row asserts the workflow owner's decision. `clarify` doubles as the
// "no gender question when enough info exists" check: clarify=false means the
// turn must act (search/answer), not stall with a question.
const PLAN = [
  // policy / account
  { name: "return policy → policy_account, no search", in: { message: "What's your return policy?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false, clarify: false },
  { name: "where is my order → policy_account", in: { message: "Where is my order #1234?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },
  { name: "do you offer exchanges → policy_account", in: { message: "Do you offer exchanges?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },
  { name: "shipping cost → policy_account", in: { message: "How much is shipping?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },

  // availability (named product in message)
  { name: "Jillian black size 8 → availability, search", in: { message: "Do you have the Jillian in black size 8?", namedProduct: true }, wf: WORKFLOWS.AVAILABILITY, search: true, clarify: false },
  { name: "Jillian in pink (soft color) → availability", in: { message: "Do you have the Jillian in pink?", namedProduct: true }, wf: WORKFLOWS.AVAILABILITY, search: true },
  { name: "Savannah champagne 7 wide → availability", in: { message: "Do you have Savannah in champagne size 7 wide?", namedProduct: true }, wf: WORKFLOWS.AVAILABILITY, search: true },
  // availability follow-ups (no named product, but prior cards / focus)
  { name: "'what about size 9?' w/ prior cards → availability", in: { message: "What about size 9?", hasPriorCards: true }, wf: WORKFLOWS.AVAILABILITY, search: true, clarify: false },
  { name: "'and in black?' w/ focus product → availability", in: { message: "And in black?", focusProduct: { title: "Jillian Braided Sandal - Navy" } }, wf: WORKFLOWS.AVAILABILITY, search: true },
  { name: "'do you have it in wide?' w/ focus → availability", in: { message: "Do you have it in wide?", focusProduct: { title: "Savannah Sandal - Champagne" } }, wf: WORKFLOWS.AVAILABILITY, search: true },

  // comparison
  { name: "Jillian vs Savannah → comparison", in: { message: "Jillian vs Savannah, which is better?", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true, clarify: false },
  { name: "'Jillian or Savannah?' → comparison", in: { message: "Jillian or Savannah?", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true },
  { name: "'which is better for all-day walking, Jillian or Savannah?' → comparison", in: { message: "Which is better for all-day walking, Jillian or Savannah?", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true, clarify: false },
  { name: "'should I get Jillian or Savannah for Disney walking?' → comparison", in: { message: "Should I get Jillian or Savannah for Disney walking?", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true },
  { name: "'compare Jillian and Savannah for plantar fasciitis' → comparison", in: { message: "Compare Jillian and Savannah for plantar fasciitis", namedProduct: true }, wf: WORKFLOWS.COMPARISON, search: true },

  // named-product advisory
  { name: "is the Jillian good for wide feet → advisory", in: { message: "Is the Jillian good for wide feet?", namedProduct: true }, wf: WORKFLOWS.NAMED_PRODUCT_ADVISORY, search: true, clarify: false },
  { name: "is the Lina worth it → advisory", in: { message: "Is the Lina worth it?", namedProduct: true }, wf: WORKFLOWS.NAMED_PRODUCT_ADVISORY, search: true },

  // condition / use-case recommendation — MUST NOT ask gender first
  { name: "plantar fasciitis rec → condition, search, no clarify", in: { message: "What do you recommend for plantar fasciitis?" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, clarify: false },
  { name: "standing all day → condition_recommendation", in: { message: "I need something for standing all day" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, clarify: false },
  { name: "flat feet rec → condition_recommendation", in: { message: "what's good for flat feet?" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true },
  { name: "condition rec, gender unstated → default women, no clarify", in: { message: "recommend something for heel pain" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, clarify: false, gender: "women" },
  { name: "condition rec for husband → men", in: { message: "shoes for my husband with plantar fasciitis" }, wf: WORKFLOWS.CONDITION_RECOMMENDATION, search: true, gender: "men" },

  // browse
  { name: "women's sandals browse → browse, search", in: { message: "show me women's sandals" }, wf: WORKFLOWS.BROWSE, search: true, clarify: false, gender: "women" },
  { name: "black wedges browse → browse, no clarify", in: { message: "show me black wedges" }, wf: WORKFLOWS.BROWSE, search: true, clarify: false },
  { name: "men's sneakers browse → men", in: { message: "do you have men's sneakers?" }, wf: WORKFLOWS.BROWSE, search: true, gender: "men" },
  { name: "bare 'do you have shoes?' → browse, MAY clarify", in: { message: "do you have shoes?" }, wf: WORKFLOWS.BROWSE, search: true, clarify: true },

  // sizing help (Failure A) — generic sizing must NOT search or show cards
  { name: "generic 'help choosing the right size' → sizing_help, no search", in: { message: "I need help choosing the right size" }, wf: WORKFLOWS.SIZING_HELP, search: false },
  { name: "'what size should I get?' no context → sizing_help, no search", in: { message: "What size should I get?" }, wf: WORKFLOWS.SIZING_HELP, search: false },
  { name: "'do these run true to size?' no context → sizing_help", in: { message: "Do these run true to size?" }, wf: WORKFLOWS.SIZING_HELP, search: false },
  { name: "'what size should I get in Jillian?' → advisory, search", in: { message: "What size should I get in Jillian?", namedProduct: true }, wf: WORKFLOWS.NAMED_PRODUCT_ADVISORY, search: true },
  { name: "sizing after a shown product (focus) → advisory", in: { message: "What size should I get?", focusProduct: { title: "Savannah Sandal - Champagne" } }, wf: WORKFLOWS.NAMED_PRODUCT_ADVISORY, search: true },

  // sale browse (Failure B) — shopping a sale is commerce, not support
  { name: "'show me current sales and promotions' → sale_browse, search", in: { message: "Show me current sales and promotions" }, wf: WORKFLOWS.SALE_BROWSE, search: true },
  { name: "'what's on sale?' → sale_browse", in: { message: "What's on sale?" }, wf: WORKFLOWS.SALE_BROWSE, search: true },
  { name: "'women's sneakers on sale' → sale_browse women", in: { message: "Show me women's sneakers on sale" }, wf: WORKFLOWS.SALE_BROWSE, search: true, gender: "women" },
  { name: "'discounted sandals under $100' → sale_browse", in: { message: "Show me discounted sandals under $100" }, wf: WORKFLOWS.SALE_BROWSE, search: true },
  // promo mechanics → policy, no search/cards
  { name: "'military discount?' → policy_account, no search", in: { message: "Do you have a military discount?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },
  { name: "'promo code on sale sandals?' → policy_account, no search", in: { message: "Can I use a promo code on sale sandals?" }, wf: WORKFLOWS.POLICY_ACCOUNT, search: false },

  // clarification / non-product / bad input
  { name: "'hi' → clarification, no search", in: { message: "hi" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "'help' → clarification", in: { message: "help" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "weather (off-topic) → clarification", in: { message: "what's the weather today?" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "keyboard mash → clarification", in: { message: "asdfghjkl qwerty" }, wf: WORKFLOWS.CLARIFICATION, search: false },
  { name: "empty message → clarification", in: { message: "" }, wf: WORKFLOWS.CLARIFICATION, search: false },
];

for (const t of PLAN) {
  check(t.name, () => {
    const plan = planTurn(t.in);
    assert.equal(plan.workflow, t.wf, `workflow: got ${plan.workflow}`);
    assert.equal(plan.searchRequired, t.search, `searchRequired: got ${plan.searchRequired}`);
    if (typeof t.clarify === "boolean") {
      assert.equal(plan.clarificationAllowed, t.clarify, `clarificationAllowed: got ${plan.clarificationAllowed}`);
    }
    if (t.gender) assert.equal(plan.gender, t.gender, `gender: got ${plan.gender}`);
  });
}

// ── same-session pivots: each turn re-planned independently ───────────
check("pivot: condition turn then a fresh policy turn re-classifies", () => {
  assert.equal(planTurn({ message: "what helps plantar fasciitis?" }).workflow, WORKFLOWS.CONDITION_RECOMMENDATION);
  assert.equal(planTurn({ message: "what's your return policy?" }).workflow, WORKFLOWS.POLICY_ACCOUNT);
});
check("pivot: browse then availability follow-up re-classifies", () => {
  assert.equal(planTurn({ message: "show me women's sandals" }).workflow, WORKFLOWS.BROWSE);
  assert.equal(planTurn({ message: "what about size 9?", hasPriorCards: true }).workflow, WORKFLOWS.AVAILABILITY);
});
check("pivot: availability then off-topic re-classifies to clarification", () => {
  assert.equal(planTurn({ message: "Do you have the Jillian in black size 8?", namedProduct: true }).workflow, WORKFLOWS.AVAILABILITY);
  assert.equal(planTurn({ message: "lol thanks anyway" }).workflow, WORKFLOWS.CLARIFICATION);
});

// ══ Part 2 — Availability Truth: result, card count, leak/CTA/family ══
const variant = (size, color, qty, width) => {
  const opts = [{ name: "Color", value: color }];
  if (size != null) opts.push({ name: "Size", value: `${size} US` });
  if (width) opts.push({ name: "Width", value: width === "wide" ? "Wide" : "Medium" });
  return { sku: `${color}-${size}${width || ""}`, inventoryQty: qty, optionsJson: JSON.stringify(opts) };
};
const JILLIAN_BLACK = { handle: "jil-blk", title: "Jillian Braided Quarter Strap Sandal - Black", variants: [variant(7, "Black", 3), variant(8, "Black", 5), variant(9, "Black", 0)] };
const JILLIAN_ROSE = { handle: "jil-rose", title: "Jillian Braided Quarter Strap Sandal - Rose", variants: [variant(7, "Rose", 2), variant(8, "Rose", 3)] };
const JILLIAN_SPORT_BLACK = { handle: "jil-sport-blk", title: "Jillian Sport Sandal - Black", variants: [variant(8, "Black", 4)] };
const SAVANNAH_CHAMP = { handle: "sav-champ", title: "Savannah Adjustable Quarter Strap Sandal - Champagne", variants: [variant(7, "Champagne", 4), variant("9 - 9.5", "Champagne", 2)] };
const ROMY = { handle: "romy", title: "Romy Wedge Sandal - Tan", variants: [variant(8, "Tan", 5)] };
const ONE_STYLE = [JILLIAN_BLACK, JILLIAN_ROSE, SAVANNAH_CHAMP, ROMY];
const MULTI_STYLE = [JILLIAN_BLACK, JILLIAN_ROSE, JILLIAN_SPORT_BLACK, SAVANNAH_CHAMP];

const AVAIL = [
  { name: "Jillian black 8 → AVAILABLE, 1 card", products: ONE_STYLE, args: { family: "jillian", color: "black", size: "8" }, result: R.AVAILABLE, family: "jillian" },
  { name: "Jillian black 9 (OOS) → UNAVAILABLE, 1 card", products: ONE_STYLE, args: { family: "jillian", color: "black", size: "9" }, result: R.UNAVAILABLE, family: "jillian" },
  { name: "Jillian pink (soft) → AVAILABLE Rose, 1 card", products: ONE_STYLE, args: { family: "jillian", color: "pink" }, result: R.AVAILABLE, family: "jillian", mentions: /rose/i },
  { name: "Savannah champagne 7 → AVAILABLE, 1 card", products: ONE_STYLE, args: { family: "savannah", color: "champagne", size: "7" }, result: R.AVAILABLE, family: "savannah" },
  { name: "Savannah champagne 9 (range label) → AVAILABLE", products: ONE_STYLE, args: { family: "savannah", color: "champagne", size: "9" }, result: R.AVAILABLE, family: "savannah" },
  { name: "Savannah champagne 7 wide (no width data) → UNKNOWN, 1 card", products: ONE_STYLE, args: { family: "savannah", color: "champagne", size: "7", width: "wide" }, result: R.UNKNOWN, family: "savannah" },
  { name: "Jillian orange (not carried) → UNAVAILABLE", products: ONE_STYLE, args: { family: "jillian", color: "orange" }, result: R.UNAVAILABLE, family: "jillian" },
  { name: "Tamara (absent) → NOT_FOUND, 0 cards", products: ONE_STYLE, args: { family: "tamara", color: "black", size: "8" }, result: R.NOT_FOUND, family: "tamara" },
  { name: "ambiguous 'Jillian black 8' across styles → DISAMBIGUATION, 2 cards", products: MULTI_STYLE, args: { family: "jillian", color: "black", size: "8", styleQuery: "do you have jillian in black size 8?" }, result: R.DISAMBIGUATION, family: "jillian" },
  { name: "'Jillian Braided black 8' → AVAILABLE Braided, 1 card", products: MULTI_STYLE, args: { family: "jillian", color: "black", size: "8", styleQuery: "do you have jillian braided in black size 8?" }, result: R.AVAILABLE, family: "jillian" },
  { name: "'Jillian Sport black 8' → AVAILABLE Sport, 1 card", products: MULTI_STYLE, args: { family: "jillian", color: "black", size: "8", styleQuery: "do you have jillian sport in black size 8?" }, result: R.AVAILABLE, family: "jillian" },
];

for (const t of AVAIL) {
  check(t.name, () => {
    const v = classifyAvailability({ products: t.products, ...t.args });
    assert.equal(v.result, t.result, `result: got ${v.result} reason=${v.reason}`);
    const text = buildAvailabilityAnswer(v);
    // card count contract
    assert.equal(expectedAvailabilityCards(v), t.result === R.NOT_FOUND ? 0 : t.result === R.DISAMBIGUATION ? 2 : 1, "card count");
    // cross-cutting invariants
    assertNoLeak(text, t.name);
    assertNoBroadCTA(text, t.name);
    if (t.result !== R.NOT_FOUND) assertMentionsFamily(text, t.family, t.name);
    if (t.mentions) assert.match(text, t.mentions, `${t.name}: text missing ${t.mentions}`);
    // never lie: soft color must not claim the literal requested color
    if (v.softColor) assert.doesNotMatch(text, new RegExp(`available in ${t.args.color}\\b`, "i"), `${t.name}: claimed unavailable color`);
    // the verdict's product (when present) is always the named family — never a random family
    if (v.product) assertMentionsFamily(v.product.title, t.family, `${t.name} (verdict product family)`);
  });
}

// ══ Part 3 — sale search input: onSale + clean query, never raw sentence ══
// emit-finalize pulls in the prisma-backed db layer, so this import only works
// where node_modules is installed (the private repo). In the public mirror it's
// skipped — the routing for sale_browse is already covered above; this part
// just confirms the search-input construction.
let scopedProductSearchInput = null;
try { ({ scopedProductSearchInput } = await import("../app/lib/emit-finalize.server.js")); }
catch { console.log("  · (skipping sale-search-input tests — emit-finalize needs node_modules)"); }
if (scopedProductSearchInput) {
  check("sale_browse search sets onSale=true and a clean query (not the raw sentence)", () => {
    const { input } = scopedProductSearchInput({ latestUserMessage: "Show me current sales and promotions", turnPlan: { workflow: "sale_browse" } });
    assert.equal(input.onSale, true, "onSale not set");
    assert.doesNotMatch(String(input.query), /promotions/i, "query echoed the raw sentence");
    assert.ok(String(input.query).length <= 30, `query too long/raw: ${input.query}`);
  });
  check("'discounted sandals under $100' → onSale + priceMax 100", () => {
    const { input } = scopedProductSearchInput({ latestUserMessage: "Show me discounted sandals under $100", turnPlan: { workflow: "sale_browse" } });
    assert.equal(input.onSale, true);
    assert.equal(input.priceMax, 100);
  });
  check("non-sale browse does NOT set onSale", () => {
    const { input } = scopedProductSearchInput({ latestUserMessage: "show me women's sandals", turnPlan: { workflow: "browse" } });
    assert.ok(!input.onSale, "onSale wrongly set on a non-sale browse");
  });
}

// ══ Part 4 — comparison card contract: ≤4 cards, one per named family ══
check("comparison pins one card per family from a flooded 9-card pool", () => {
  const flooded = [
    { title: "Jillian Braided Quarter Strap Sandal - Black" },
    { title: "Jillian Braided Quarter Strap Sandal - Rose" },
    { title: "Jillian Sport Sandal - Black" },
    { title: "Savannah Adjustable Quarter Strap Sandal - Champagne" },
    { title: "Savannah Adjustable Quarter Strap Sandal - Black" },
    { title: "Romy Wedge Sandal - Tan" },
    { title: "Lina Slide Sandal - Navy" },
    { title: "Mila Low Boot - Brown" },
    { title: "Darcy Flat - Nude" },
  ];
  const cards = pickComparisonCards(flooded, ["jillian", "savannah"]);
  assert.equal(cards.length, 2, "two-family comparison must pin exactly 2 cards");
  assert.ok(cards.length <= 4, "never more than 4");
  assert.match(cards[0].title, /Jillian/);
  assert.match(cards[1].title, /Savannah/);
  // no unrelated families leak in
  assert.ok(!cards.some((c) => /Romy|Lina|Mila|Darcy/.test(c.title)), "no unrelated families");
});
check("comparison with a missing family pins only the family that exists", () => {
  const pool = [{ title: "Jillian Braided Quarter Strap Sandal - Black" }];
  const cards = pickComparisonCards(pool, ["jillian", "savannah"]);
  assert.equal(cards.length, 1);
  assert.match(cards[0].title, /Jillian/);
});

// ── comparison compaction: <=4 sentences, <=110 words, deterministic ──
const WORDS = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const SENTS = (s) => String(s).trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
check("compactComparison caps a long draft to <=4 sentences and <=110 words", () => {
  const draft =
    "For all-day walking I would lean Savannah because it has a more active, supportive build with a contoured footbed and adjustable straps. " +
    "Jillian is prettier and very comfortable for casual all-day wear around town. " +
    "But Savannah is the safer choice if you will be on your feet for many hours. " +
    "If style matters most choose Jillian. If comfort mileage matters most choose Savannah. " +
    "Either way both are solid Aetrex picks with quality materials.";
  const out = compactComparison(draft);
  assert.ok(SENTS(out) <= 4, `sentences=${SENTS(out)}`);
  assert.ok(WORDS(out) <= 110, `words=${WORDS(out)}`);
  assert.ok(out.length < draft.length, "should have trimmed");
});
check("compactComparison leaves an already-concise verdict unchanged", () => {
  const concise =
    "For all-day walking I'd lean Savannah — more active, supportive build. " +
    "Jillian is prettier and fine for casual wear, but Savannah wins for hours on your feet. " +
    "Choose Jillian for style, Savannah for comfort mileage.";
  assert.equal(compactComparison(concise), concise);
  assert.ok(WORDS(concise) <= 110);
});
check("compactComparison hard-caps a single runaway sentence at 110 words", () => {
  const runaway = "Savannah " + "very ".repeat(200) + "supportive.";
  const out = compactComparison(runaway);
  assert.ok(WORDS(out) <= 110, `words=${WORDS(out)}`);
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
