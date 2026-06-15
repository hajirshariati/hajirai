// "Visualize My Look" CTA gating eval. The CTA must appear ONLY when:
// the feature is enabled, a supported provider + its key are set, and
// the turn ends with exactly ONE product that has an image.
//
// Run: node scripts/eval-visualize-cta.mjs

import assert from "node:assert/strict";
import { buildVisualizeCtaEvent } from "../app/lib/visualize-cta.server.js";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

const enabledGemini = { visualizeLookEnabled: true, imageProvider: "gemini", geminiApiKey: "k", visualizeLookLabel: "Visualize My Look" };
const enabledOpenai = { visualizeLookEnabled: true, imageProvider: "openai", openaiApiKey: "k", visualizeLookLabel: "See It Styled" };
const product = { handle: "maui-black", title: "Maui Sandal", image: "https://cdn.example/x.jpg" };
const messages = [{ role: "user", content: "heels to go with my blue dress" }];

console.log("\nvisualize-cta gating eval\n");

test("fires for enabled + gemini key + single product with image", () => {
  const ev = buildVisualizeCtaEvent({ config: enabledGemini, product, messages });
  assert.ok(ev && ev.type === "visualize_cta");
  assert.equal(ev.productHandle, "maui-black");
  assert.equal(ev.label, "Visualize My Look");
  assert.match(ev.styleContext, /blue dress/);
});

test("fires for openai provider with its key + custom label", () => {
  const ev = buildVisualizeCtaEvent({ config: enabledOpenai, product, messages });
  assert.ok(ev && ev.label === "See It Styled");
});

test("falls back to default label when blank", () => {
  const ev = buildVisualizeCtaEvent({ config: { ...enabledGemini, visualizeLookLabel: "" }, product, messages });
  assert.equal(ev.label, "Visualize My Look");
});

test("null when feature disabled", () => {
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, visualizeLookEnabled: false }, product, messages }), null);
});

test("null when provider unsupported / unset", () => {
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, imageProvider: "" }, product, messages }), null);
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, imageProvider: "midjourney" }, product, messages }), null);
});

test("null when the selected provider's key is missing", () => {
  assert.equal(buildVisualizeCtaEvent({ config: { ...enabledGemini, geminiApiKey: "" }, product, messages }), null);
  assert.equal(buildVisualizeCtaEvent({ config: { visualizeLookEnabled: true, imageProvider: "openai", openaiApiKey: "" }, product, messages }), null);
});

test("null when product has no image (can't style what we can't see)", () => {
  assert.equal(buildVisualizeCtaEvent({ config: enabledGemini, product: { handle: "x", title: "X" }, messages }), null);
});

test("null when product has no handle", () => {
  assert.equal(buildVisualizeCtaEvent({ config: enabledGemini, product: { image: "https://x/y.jpg" }, messages }), null);
});

test("accepts featuredImageUrl as the image source", () => {
  const ev = buildVisualizeCtaEvent({ config: enabledGemini, product: { handle: "h", title: "T", featuredImageUrl: "https://x/y.jpg" }, messages });
  assert.ok(ev && ev.productImage === "https://x/y.jpg");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
