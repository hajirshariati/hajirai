// Visualize "scene theme" invariants — the configurable brand look for AI
// styling previews. The default theme keeps the setting in a soft background
// that FADES into a clean white floor the shopper walks on; merchants can
// override it via ShopConfig.visualizeScenePrompt.
//
// Run: node scripts/eval-image-styling.mjs

import assert from "node:assert/strict";
import { buildStylistPrompt, DEFAULT_VIZ_SCENE_THEME } from "../app/lib/image-styling.server.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

console.log("\nvisualize scene-theme invariants\n");

test("default theme describes the white-floor-fade brand look", () => {
  assert.match(DEFAULT_VIZ_SCENE_THEME, /white/i, "mentions white");
  assert.match(DEFAULT_VIZ_SCENE_THEME, /floor|surface/i, "mentions the floor/surface");
  assert.match(DEFAULT_VIZ_SCENE_THEME, /fade|dissolve/i, "the setting fades into the white");
  assert.match(DEFAULT_VIZ_SCENE_THEME, /background/i, "the setting lives in the background");
  assert.match(DEFAULT_VIZ_SCENE_THEME, /every image|consistent/i, "applied consistently to every image");
});

test("the default theme is applied when no merchant override is set", () => {
  const p = buildStylistPrompt({ productTitle: "Kendall Sandal", styleContext: "an elegant dinner" });
  assert.ok(p.includes(DEFAULT_VIZ_SCENE_THEME), "prompt carries the default brand theme");
  // Per-turn setting still chosen from the styleContext.
  assert.match(p, /elegant dinner/, "styleContext still picks the setting");
  assert.match(p, /BACKGROUND setting/i, "the setting is placed in the background, not the foreground");
});

test("a merchant override REPLACES the default theme verbatim", () => {
  const custom = "Studio look: seamless charcoal sweep, dramatic side light, no background scene.";
  const p = buildStylistPrompt({ productTitle: "Kendall Sandal", styleContext: "the gym", sceneTheme: custom });
  assert.ok(p.includes(custom), "custom theme present");
  assert.ok(!p.includes(DEFAULT_VIZ_SCENE_THEME), "default theme NOT also injected");
});

test("an empty/blank override falls back to the default theme", () => {
  for (const v of ["", "   ", null, undefined]) {
    const p = buildStylistPrompt({ productTitle: "X", styleContext: "", sceneTheme: v });
    assert.ok(p.includes(DEFAULT_VIZ_SCENE_THEME), `blank (${JSON.stringify(v)}) ⇒ default theme`);
  }
});

test("product-fidelity + composition rules survive regardless of theme", () => {
  const p = buildStylistPrompt({ productTitle: "Kendall Sandal", styleContext: "a beach", sceneTheme: "anything" });
  assert.match(p, /DO NOT CHANGE THE PRODUCT/i, "product is still locked");
  assert.match(p, /WALKING/i, "motion rule kept");
  assert.match(p, /razor-sharp/i, "footwear-sharp composition kept");
  assert.match(p, /No text, watermarks/i, "no-text rule kept");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
