import assert from "node:assert/strict";
import {
  canonicalizeCatalogConstraints,
  colorExistsInCatalogScope,
  computeCatalogConstraintDomains,
  deriveCatalogMatchContract,
  readAttributeCI,
} from "../app/lib/catalog-matcher.server.js";

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

console.log("Catalog matcher eval\n");

const facetIndex = {
  categoryByGender: {
    sneakers: ["men", "women"],
    orthotics: ["men", "women", "unisex"],
    sandals: ["women"],
  },
  colorByGenderCategory: {
    "men:sneakers": ["white", "black", "navy"],
    "women:sneakers": ["white", "pink"],
    "women:sandals": ["red", "tan"],
    "unisex:orthotics": ["black"],
  },
};

test("M1 — canonicalizes mixed-case filter aliases", () => {
  const out = canonicalizeCatalogConstraints({
    Gender: "Men",
    Category: "Walking Shoes",
    Color: "Off White",
    width: "Wide",
  });
  assert.equal(out.gender, "men");
  assert.equal(out.category, "sneakers");
  assert.equal(out.color, "white");
  assert.equal(out.width, "Wide");
  assert.equal(out.Gender, undefined);
  assert.equal(out.Category, undefined);
});

test("M2 — color existence honors gender/category tuple scope", () => {
  assert.equal(colorExistsInCatalogScope("White", "Men", "Walking Shoes", facetIndex), true);
  assert.equal(colorExistsInCatalogScope("Red", "Men", "Sneakers", facetIndex), false);
  assert.equal(colorExistsInCatalogScope("Red", "Women", "Sandals", facetIndex), true);
});

test("M3 — domain inference uses the shared tuple space", () => {
  const domains = computeCatalogConstraintDomains({ color: "red", category: "sandals" }, facetIndex);
  assert.equal(domains.gender.inferred, "women");
  assert.deepEqual(domains.gender.domain, ["women"]);
});

test("M4 — case-insensitive attribute lookup accepts merchant metafield shapes", () => {
  const bag = { Color: "White", "Category For Filter": "Sneakers", Gender: "Men" };
  assert.equal(readAttributeCI(bag, "color"), "White");
  assert.equal(readAttributeCI(bag, "category"), "Sneakers");
  assert.equal(readAttributeCI(bag, "gender"), "Men");
});

test("M5 — response contract distinguishes exact, near, and true no-match", () => {
  assert.equal(
    deriveCatalogMatchContract({ products: [{ handle: "dash" }], constraints: { gender: "Men" } }).status,
    "exact_match",
  );
  assert.equal(
    deriveCatalogMatchContract({
      products: [{ handle: "dash" }],
      constraints: { gender: "Men", color: "Red" },
      relaxedFilters: { color: "red" },
    }).status,
    "near_match",
  );
  assert.equal(
    deriveCatalogMatchContract({
      constraints: { gender: "Men", color: "Red" },
      impossibleConstraints: [{ field: "color", value: "red" }],
    }).status,
    "true_no_match",
  );
});

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nCatalog matcher eval: ${passed}/${passed + failed} passed`);
