import assert from "node:assert/strict";
import {
  filterProductCardsToCatalogScope,
  ensureCompleteCustomerText,
  productPoolSatisfiesCatalogScope,
  buildCodeOwnedProductListingText,
  repairProductTurnAssembly,
  repairProductResponseText,
  stripMissingSkus,
  createTurnResult,
} from "../app/lib/response-contract.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Response contract eval\n");

const whiteMensSneakerPool = [
  {
    title: "Dash Arch Support Men's Sneaker - White",
    productType: "Walking Shoes",
    _gender: "Men",
    _category: "Sneakers",
    _attributes: { Color: "White", Gender: "Men", Category: "Sneakers" },
  },
];

const ctx = {
  sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } },
  classifiedIntent: { attributes: {} },
  resolverState: { type: "resolver_state", matched_constraints: {}, inferred_constraints: {} },
};

test("R1 — exact-scope card pool satisfies current scope", () => {
  assert.equal(productPoolSatisfiesCatalogScope(whiteMensSneakerPool, ctx.sessionMemory.explicit), true);
});

test("R2 — contradictory denial is stripped when exact products are present", () => {
  const text = "We don't have any white men's sneakers in stock right now. Good news — we actually do carry white men's sneakers! Here are two styles.";
  const out = repairProductResponseText({ text, pool: whiteMensSneakerPool, ctx });
  assert.equal(out.changed, true);
  assert.equal(/don't have|in stock right now/i.test(out.text), false);
  assert.match(out.text, /actually do carry|matching styles/i);
  assert.equal(out.contract.status, "exact_match");
});

test("R3 — unrelated product pool does not erase a true denial", () => {
  const text = "We don't have white men's sneakers in stock right now.";
  const out = repairProductResponseText({
    text,
    pool: [{ title: "Black Sandal", _gender: "Women", _category: "Sandals", _attributes: { Color: "Black" } }],
    ctx,
  });
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
});

test("R4 — product turn strips clarifying chips instead of showing ask+answer", () => {
  const text = "What type of men's footwear are you looking for? Here are our men's black sandals — two good options. <<Sandals>><<Sneakers>><<Clogs>><<Accessories>>";
  const pool = [
    {
      title: "Maui Men's Sandal - Black",
      _gender: "men",
      _category: "sandals",
      _attributes: { Color: "Black", Gender: "Men", Category: "Sandals" },
    },
  ];
  const out = repairProductTurnAssembly({ text, pool });
  assert.equal(out.changed, true);
  assert.equal(/<</.test(out.text), false);
  assert.equal(/^what type/i.test(out.text), false);
  assert.match(out.text, /men's black sandals/i);
});

test("R5 — scoped card filter drops off-category semantic cards", () => {
  const mixedPool = [
    {
      title: "Danika Arch Support Sneaker - Pink",
      _gender: "women",
      _category: "sneakers",
      _attributes: { Color: "Pink", Gender: "Women", Category: "Sneakers" },
    },
    {
      title: "Vicki Braided Thong Sandal - Light Pink",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Pink", Gender: "Women", Category: "Sandals" },
    },
  ];
  const scoped = filterProductCardsToCatalogScope(mixedPool, {
    sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } },
  });
  assert.equal(scoped.products.length, 1);
  assert.equal(scoped.products[0].title, "Vicki Braided Thong Sandal - Light Pink");
  assert.equal(scoped.dropped, 1);
  assert.equal(scoped.enforcedColor, true);
});

test("R6 — scoped card filter keeps same-category alternatives when exact color is unavailable", () => {
  const alternatives = [
    {
      title: "Kendall Sandal - Burgundy",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Burgundy", Gender: "Women", Category: "Sandals" },
    },
    {
      title: "Vania Sandal - Wine",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Wine", Gender: "Women", Category: "Sandals" },
    },
  ];
  const scoped = filterProductCardsToCatalogScope(alternatives, {
    sessionMemory: { explicit: { gender: "women", category: "sandals", color: "red" } },
  });
  assert.equal(scoped.products.length, 2);
  assert.equal(scoped.dropped, 0);
  assert.equal(scoped.enforcedColor, false);
});

test("R7 — listing text is code-owned and strips checkable claims", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are six pink women's sandals, all with arch support and under $80.",
    cards: [
      { title: "Vicki Braided Thong Sandal - Light Pink Gloss", _gender: "women", _category: "sandals", _attributes: { Color: "Pink" } },
      { title: "Jillian Sport Sandal - Shimmer Blush", _gender: "women", _category: "sandals", _attributes: { Color: "Pink" } },
    ],
    ctx: { latestUserMessage: "show me pink sandals", sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /pink women's sandals/i);
  assert.doesNotMatch(out.text, /\b(?:six|two|all|both|every|under|\$|arch support|size)\b/i);
});

test("R8 — relaxed color listing line tells the truth", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are brown men's sneakers.",
    cards: [
      { title: "Chase Arch Support Sneaker - Silver", _gender: "men", _category: "sneakers", _attributes: { Color: "Silver" } },
      { title: "Dash Arch Support Men's Sneaker - Black", _gender: "men", _category: "sneakers", _attributes: { Color: "Black" } },
    ],
    ctx: { latestUserMessage: "do you have brown sneakers for men?", sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "brown" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /couldn'?t find brown men's sneakers/i);
  assert.match(out.text, /other colors/i);
  assert.doesNotMatch(out.text, /^here are (?:the )?brown/i);
});

test("R8b — listing line does not call family-color matches exact colors", () => {
  const out = buildCodeOwnedProductListingText({
    text: "Here are red women's sneakers.",
    cards: [
      { title: "Dani Arch Support Sneaker - Burgundy", _gender: "women", _category: "sneakers", _attributes: { Color: "Burgundy", color_family: "Red" } },
      { title: "Runner Arch Support Sneaker - Terracotta", _gender: "women", _category: "sneakers", _attributes: { Color: "Terracotta", color_family: "Red" } },
    ],
    ctx: { latestUserMessage: "any in red?", sessionMemory: { explicit: { gender: "women", category: "sneakers", color: "red" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /couldn'?t find exact red women's sneakers/i);
  assert.match(out.text, /similar colors/i);
  assert.doesNotMatch(out.text, /^here are (?:the )?red/i);
});

test("R8c — listing line keeps exact named colors when present", () => {
  const out = buildCodeOwnedProductListingText({
    text: "I couldn't find black sandals.",
    cards: [
      { title: "Jess Adjustable Quarter Strap Sandal - Black Sparkle", _gender: "women", _category: "sandals", _attributes: { Color: "Black Sparkle" } },
      { title: "Charli Thong Sandal - Black", _gender: "women", _category: "sandals", _attributes: { Color: "Black" } },
    ],
    ctx: { latestUserMessage: "black sandals?", sessionMemory: { explicit: { gender: "women", category: "sandals", color: "black" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /black women's sandals/i);
  assert.doesNotMatch(out.text, /couldn'?t find/i);
});

test("R9 — direct variant fact questions keep LLM text path", () => {
  const text = "Chase also comes in black, navy, and silver.";
  const out = buildCodeOwnedProductListingText({
    text,
    cards: [{
      title: "Chase Arch Support Sneaker - White",
      _gender: "men",
      _category: "sneakers",
      _attributes: { Color: "White" },
      _variantFacts: { availableColors: ["White", "Black", "Navy", "Silver"] },
    }],
    ctx: { latestUserMessage: "are there other colors?", sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } } },
  });
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
});

test("R10 — coherence guard trims dangling strip-chain fragments", () => {
  const out = ensureCompleteCustomerText({
    text: "Good news — across these sneakers, the widest option available is medium width. None of these styles offer a dedicated wide width option, so the width options are.",
  });
  assert.equal(out.changed, true);
  assert.equal(/width options are\.$/i.test(out.text), false);
  assert.match(out.text, /medium width\./i);
});

test("R11 — missing SKU strip repairs orphaned article", () => {
  const out = stripMissingSkus("I don't see an L9999 in our catalog.", ["L9999"]);
  assert.equal(out, "I don't see that in our catalog.");
});

test("R12 — color availability denial is repaired from variant facts", () => {
  const out = repairProductTurnAssembly({
    text: "These are only available in White.",
    pool: [{
      title: "Chase Arch Support Sneaker - White",
      handle: "chase-white-am210m",
      _attributes: { Color: "White", Category: "Sneakers", Gender: "Men" },
      _variantFacts: {
        availableColors: ["White", "Black", "Navy", "Silver"],
        byColor: [
          { color: "White" },
          { color: "Black" },
          { color: "Navy" },
          { color: "Silver" },
        ],
      },
    }],
    ctx: { sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } } },
  });
  assert.equal(out.changed, true);
  assert.equal(/only available|only white|no other colors/i.test(out.text), false);
  assert.match(out.text, /Black/i);
  assert.match(out.text, /Navy/i);
  assert.match(out.text, /Silver/i);
});

test("R13 — direct color-range answer is completed from variant facts", () => {
  const out = repairProductTurnAssembly({
    text: "Both styles come in quite a range of colors. Here's what's available for each.",
    pool: [{
      title: "Chase Arch Support Sneaker - White",
      handle: "chase-white-am210m",
      _attributes: { Color: "White", Category: "Sneakers", Gender: "Men" },
      _variantFacts: {
        availableColors: ["White", "Black", "Navy", "Silver"],
        styleAvailableColors: ["White", "Black", "Navy", "Silver"],
      },
    }],
    ctx: { latestUserMessage: "are there other colors?", sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /Black/i);
  assert.match(out.text, /Navy/i);
  assert.match(out.text, /Silver/i);
});

test("R14 — product pitch without cards is repaired before emit", () => {
  const out = createTurnResult({
    text: "Take a look — these are the closest matches I've got.",
    products: [],
    flags: { productSearchAttempted: true },
  });
  assert.equal(out.products.length, 0);
  assert.doesNotMatch(out.text, /closest matches|take a look|here are/i);
  assert.match(out.text, /exact request/i);
});

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nResponse contract eval: ${passed}/${passed + failed} passed`);
