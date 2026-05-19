import assert from "node:assert/strict";
import {
  productPoolSatisfiesCatalogScope,
  repairProductResponseText,
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

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nResponse contract eval: ${passed}/${passed + failed} passed`);
