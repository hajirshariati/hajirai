import assert from "node:assert/strict";
import {
  productIsVisibleToChat,
  variantScopedPriceValues,
} from "../app/lib/chat-tool-variant-helpers.server.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

const variant = ({ size, width, price, inventoryQty = 2, sku = null }) => ({
  sku: sku || `SKU-${size}-${width || "M"}`,
  price,
  inventoryQty,
  optionsJson: JSON.stringify({ Size: size, Width: width }),
});

console.log("Chat-tools variant wiring eval\n");

await test("productIsVisibleToChat hides draft and archived products", () => {
  assert.equal(productIsVisibleToChat({ status: "ACTIVE" }), true);
  assert.equal(productIsVisibleToChat({ status: null }), true);
  assert.equal(productIsVisibleToChat({ status: "DRAFT" }), false);
  assert.equal(productIsVisibleToChat({ status: "archived" }), false);
});

await test("variantScopedPriceValues uses only the requested in-stock size/width", () => {
  const product = {
    variants: [
      variant({ size: "9", width: "Medium", price: "79.95" }),
      variant({ size: "10", width: "Wide", price: "119.95" }),
      variant({ size: "10", width: "Medium", price: "89.95", inventoryQty: 0 }),
    ],
  };
  assert.deepEqual(variantScopedPriceValues(product, { size: "10", width: "wide" }), [119.95]);
});

await test("variantScopedPriceValues returns no prices when the requested variant is not in stock", () => {
  const product = {
    variants: [
      variant({ size: "10", width: "Medium", price: "89.95", inventoryQty: 0 }),
      variant({ size: "9", width: "Medium", price: "79.95" }),
    ],
  };
  assert.deepEqual(variantScopedPriceValues(product, { size: "10" }), []);
});

await test("variantScopedPriceValues unscoped path ignores out-of-stock variant prices", () => {
  const product = {
    variants: [
      variant({ size: "9", width: "Medium", price: "79.95", inventoryQty: 0 }),
      variant({ size: "10", width: "Medium", price: "109.95" }),
    ],
  };
  assert.deepEqual(variantScopedPriceValues(product), [109.95]);
});

if (failed === 0) {
  console.log(`\nPASS  ${passed} passed, 0 failed`);
  process.exit(0);
}

console.log(`\nFAIL  ${passed} passed, ${failed} failed`);
for (const f of failures) {
  console.log(`  ${f.name}:`);
  console.log(`    ${f.err?.stack || f.err}`);
}
process.exit(1);
