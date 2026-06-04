// Canonical catalog-query regression suite.
//
// Proves that arbitrary merchant vocabulary survives into retrieval and is
// verified against real catalog evidence without a hardcoded material or
// technology list. Also protects ordinary conversation from becoming an
// accidental hard filter.

import assert from "node:assert/strict";
import {
  buildCatalogSearchDocument,
  deriveCatalogRequirements,
  filterByCatalogRequirements,
  matchCatalogRequirement,
  normalizeCatalogText,
} from "../app/lib/catalog-query.server.js";
import { runProductTurn } from "../app/lib/product-turn-engine.server.js";

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

const knownCategories = ["sandals", "sneakers", "boots", "loafers"];

function requirements(message, options = {}) {
  return deriveCatalogRequirements({
    latestUserMessage: message,
    knownCategories,
    ...options,
  });
}

console.log("Catalog query — canonical evidence eval\n");

await test("CQ1 — arbitrary material before category becomes a concrete requirement", () => {
  assert.deepEqual(requirements("show me cork sandals").requiredTerms, ["cork"]);
  assert.deepEqual(requirements("memory foam sneakers").requiredTerms, ["memory foam"]);
});

await test("CQ2 — named technology works without CamelCase dependence", () => {
  assert.equal(normalizeCatalogText("BioRocker™ Technology"), "bio rocker technology");
  assert.deepEqual(
    requirements("Which sandals have BioRocker technology?").requiredTerms,
    ["bio rocker"],
  );
  assert.deepEqual(requirements("what is BioRocker?").requiredTerms, ["bio rocker"]);
});

await test("CQ3 — structured shopping facts do not become duplicate hard requirements", () => {
  const result = deriveCatalogRequirements({
    latestUserMessage: "i want pink sandals with arch support and i have bunions",
    knownCategories,
    scope: {
      color: "pink",
      category: "sandals",
      condition: "bunions",
      requestedClaim: { kind: "archSupport" },
    },
  });
  assert.deepEqual(result.requiredTerms, []);
});

await test("CQ4 — exclusions and subjective preferences do not become hard facts", () => {
  assert.deepEqual(requirements("anything besides sneakers and sandals").requiredTerms, []);
  assert.deepEqual(requirements("show me cute sandals").requiredTerms, []);
  assert.deepEqual(requirements("show me comfortable sandals").requiredTerms, []);
  assert.deepEqual(
    requirements("what other shoes have same support as Danika").requiredTerms,
    [],
  );
  assert.deepEqual(
    requirements("Which of these has the most cushioning like the Jillian?").requiredTerms,
    [],
  );
});

await test("CQ4b — ordinary long-form conversation never becomes a destructive hard filter", () => {
  assert.deepEqual(
    requirements(
      "My 7-year-old son has flat feet, the pediatrician said he might need orthotics but we want to try supportive shoes first before going that route — what do you carry for kids that has real arch support, not just marketing?",
    ).requiredTerms,
    [],
  );
  assert.deepEqual(
    requirements(
      "I ordered the wrong size on Monday, the package hasn't shipped yet. Do I have to cancel and reorder?",
    ).requiredTerms,
    [],
  );
});

await test("CQ4c — explicit product construction phrases remain high-confidence requirements", () => {
  assert.deepEqual(requirements("show me shoes with adjustable straps").requiredTerms, ["adjustable straps"]);
  assert.deepEqual(requirements("show me shoes with removable insoles").requiredTerms, ["removable insoles"]);
  assert.deepEqual(
    requirements("which one had the removable insole — it was a white sneaker").requiredTerms,
    ["removable insole"],
  );
});

await test("CQ5 — canonical document includes description, tags, product and variant attributes", () => {
  const document = buildCatalogSearchDocument({
    title: "Sample Sandal",
    description: "A cork midsole with BioRocker technology.",
    tags: ["Travel Ready"],
    attributes: { footbed: "Memory Foam" },
    variants: [{ attributesJson: { material: "Stretch Knit" } }],
  });
  assert.match(document.sources.description, /cork midsole/);
  assert.match(document.sources.tags, /travel ready/);
  assert.match(document.sources.attributes, /memory foam/);
  assert.match(document.sources.variants, /stretch knit/);
});

await test("CQ6 — evidence matcher identifies the source that proves a requirement", () => {
  const fromDescription = matchCatalogRequirement(
    {
      title: "BioRocker Sandal",
      description: "Built with BioRocker technology.",
    },
    "BioRocker",
  );
  assert.equal(fromDescription.matched, true);
  assert.equal(
    fromDescription.source,
    "description",
    "descriptive proof should outrank a title-only mention",
  );

  const fromAttribute = matchCatalogRequirement(
    { attributes: { footbed: "Memory Foam" } },
    "memory foam",
  );
  assert.equal(fromAttribute.matched, true);
  assert.equal(fromAttribute.source, "attributes");

  const splitAcrossUnrelatedSources = matchCatalogRequirement(
    { title: "Memory Sneaker", description: "Foam outsole." },
    "memory foam",
  );
  assert.equal(
    splitAcrossUnrelatedSources.matched,
    false,
    "multi-word evidence must exist together in one canonical source",
  );
});

await test("CQ7 — hard filtering keeps only products with explicit canonical evidence", () => {
  const products = [
    { handle: "material-one", description: "Cork midsole." },
    { handle: "foam", attributes: { footbed: "Memory Foam" } },
    { handle: "plain", description: "Everyday sandal." },
  ];
  const result = filterByCatalogRequirements(products, ["cork"]);
  assert.deepEqual(result.products.map((product) => product.handle), ["material-one"]);
  assert.equal(result.matches.get("material-one")[0].source, "description");
});

await test("CQ8 — immediate anaphoric continuation inherits the prior concrete topic", () => {
  const result = requirements("Which other shoe styles feature this technology?", {
    messages: [
      { role: "user", content: "what is BioRocker?" },
      { role: "assistant", content: "BioRocker is used in selected products." },
      { role: "user", content: "Which other shoe styles feature this technology?" },
    ],
  });
  assert.deepEqual(result.requiredTerms, ["bio rocker"]);
  assert.equal(result.continuedFromPrior, true);
});

await test("CQ9 — an old topic does not leak through an unrelated immediate user turn", () => {
  const result = requirements("Which other shoe styles feature this technology?", {
    messages: [
      { role: "user", content: "what is BioRocker?" },
      { role: "assistant", content: "BioRocker is used in selected products." },
      { role: "user", content: "show me black boots" },
      { role: "assistant", content: "Here are black boots." },
      { role: "user", content: "Which other shoe styles feature this technology?" },
    ],
  });
  assert.deepEqual(result.requiredTerms, []);
  assert.equal(result.continuedFromPrior, false);
});

await test("CQ10 — engine filters injected candidates and recommends a verified starting product", async () => {
  const candidates = [
    {
      title: "Cork Trail Sandal",
      handle: "cork-trail",
      productType: "Sandals",
      description: "A lightweight sandal with a cork midsole.",
      attributes: { category: "Sandals", gender: "Women" },
      price: "129.95",
    },
    {
      title: "Plain Trail Sandal",
      handle: "plain-trail",
      productType: "Sandals",
      description: "A lightweight everyday sandal.",
      attributes: { category: "Sandals", gender: "Women" },
      price: "119.95",
    },
  ];
  const out = await runProductTurn({
    shop: "fixture.myshopify.com",
    latestUserMessage: "show me cork sandals",
    messages: [{ role: "user", content: "show me cork sandals" }],
    sessionMemory: {
      explicit: { category: "sandals", gender: "women" },
      inferred: {},
    },
  }, {
    forceEnable: true,
    searchFn: async () => candidates,
    claimConfig: { rules: [], categoryGroups: [], colorFamilies: [] },
  });

  assert.ok(out && !out.decline, "engine should handle the product turn");
  assert.deepEqual(out.products.map((product) => product.handle), ["cork-trail"]);
  assert.match(out.answerText, /I'd start with Cork Trail Sandal/i);
  assert.match(
    out.answerText,
    /For cork sandals, I'd start with Cork Trail Sandal because it includes the feature you asked about/i,
  );
  assert.doesNotMatch(out.answerText, /product description|catalog evidence|explicitly mentions/i);
  assert.doesNotMatch(out.answerText, /\bI found \d+/i);
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) {
    console.log(`  • ${failure.name}`);
    console.log(`    ${failure.err?.stack || failure.err}`);
  }
  process.exit(1);
}
