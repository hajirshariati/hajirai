// "See It Styled" widget-source invariants (Aetrex theme extension).
//
// The widget is a browser IIFE with no module exports and the repo has no DOM
// test harness, so we assert the structural guarantees the UX spec depends on
// directly against the source. These catch the regressions that matter:
// the styling action staying secondary, scene controls living OUTSIDE the
// clickable card, clicks never navigating, and the preview never auto-opening.
//
// Run: node scripts/eval-visualize-widget.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(here, "..", "extensions", "hajirai-chat-widget", "assets", "hajirai-chat-widget.js"),
  "utf8",
);

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

// Pull out a function body by name so assertions are scoped, not global.
function fnBody(name) {
  const start = SRC.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}") { depth -= 1; if (depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error(`could not bound function ${name}`);
}

console.log("\nvisualize widget-source invariants\n");

test("CTA is renamed to 'See It Styled' (old name migrated, not shown)", () => {
  assert.match(SRC, /'See It Styled'/);
  const label = fnBody("vizLabel");
  assert.match(label, /!==\s*'Visualize My Look'/, "old default must migrate to the new name");
});

test("CTA is styled as a SECONDARY warm-outline action (not the buy CTA)", () => {
  const body = fnBody("injectVizButton");
  assert.match(body, /#F4E8D3/, "soft warm fill");
  assert.match(body, /1px solid #C9A76D/, "subtle warm border");
  assert.match(body, /#8A6632/, "warm text");
  assert.match(body, /#EAD8B8/, "hover fill");
  assert.doesNotMatch(body, /box-shadow/, "no heavy shadow on the secondary CTA");
  assert.doesNotMatch(body, /linear-gradient/, "no loud gradient fill");
});

test("clicking 'See It Styled' stops propagation (never navigates the card)", () => {
  const body = fnBody("injectVizButton");
  assert.match(body, /e\.preventDefault\(\);e\.stopPropagation\(\);/);
  assert.match(body, /runVisualize\(cta,card\)/);
});

test("preview opens only ON CLICK — injectVizButton wires a handler, never auto-runs", () => {
  const body = fnBody("injectVizButton");
  // runVisualize is reached ONLY through the click/keydown handler `go`.
  assert.ok(
    body.includes("var go=function(e){if(e){e.preventDefault();e.stopPropagation();}runVisualize(cta,card)}"),
    "runVisualize must be wrapped in the propagation-stopping click handler",
  );
  assert.ok(body.includes("addEventListener('click',go)"), "click handler wired");
  // The only runVisualize call in injectVizButton is inside `go`.
  assert.equal(body.split("runVisualize(").length - 1, 1, "no second, bare runVisualize call");
});

test("scene selector lives in the preview PANEL (host), not the product card", () => {
  const body = fnBody("injectVizOptions");
  assert.match(SRC, /function injectVizOptions\(host,cta,card\)/, "signature takes host first, not the card");
  assert.match(body, /host\.appendChild\(wrap\)/, "options appended to the host panel");
  assert.doesNotMatch(body, /ai-chat-product-info/, "options must NOT be injected into the card body");
});

test("scene pills stop propagation (clicking a scene never opens the product page)", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /e\.preventDefault\(\);e\.stopPropagation\(\);/);
});

test("scene selector wording is 'Choose a setting' (not 'Try another setting')", () => {
  assert.match(SRC, /Choose a setting/);
  assert.doesNotMatch(SRC, /Try another setting/);
});

test("scene labels are data-driven from the server-sent set (per category)", () => {
  const body = fnBody("injectVizOptions");
  assert.match(body, /cta\.scenes/, "uses the category-matched scenes from the event");
  assert.match(SRC, /var DEFAULT_VIZ_SCENES=/, "has a fallback set");
});

test("disclaimer reads 'AI style preview. Product details may vary.'", () => {
  assert.match(SRC, /AI style preview\. Product details may vary\./);
  assert.doesNotMatch(SRC, /AI-generated — may not exactly match/);
});

test("the generated image renders in a dedicated host, separate from the card", () => {
  const run = fnBody("runVisualize");
  assert.match(run, /ai-chat-viz-image/, "image host element created");
  assert.match(run, /card\.parentNode\.insertBefore\(host,card\.nextSibling\)/, "panel is a sibling AFTER the card");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
