// Per-turn intent resolver eval.
//
// Pure-function tests for `resolveTurnIntent`. No DB, no Anthropic.
// Mirrors the 10 cases in the spec; failures here mean the intent
// scorer drifted from contract, not that a downstream consumer
// changed.

import assert from "node:assert/strict";
import {
  resolveTurnIntent,
  TurnIntentLabels as L,
} from "../app/lib/turn-intent.server.js";

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

console.log("Turn-intent eval\n");

// ---------------------------------------------------------------------------
// 1. Chip click survives — durable intent, text being short doesn't wipe.
// ---------------------------------------------------------------------------
await test("T1 — chip click is durable; text shortness doesn't wipe", () => {
  const intent = resolveTurnIntent({
    latestUserText: "Women",
    previousScope: { category: "sandals", color: "red" },
    choiceEvents: [
      { type: "chip_answer", userTurnIndex: 3, fact: { key: "gender", value: "women" } },
    ],
    turnIndex: 3,
  });
  assert.equal(intent.label, L.CONTINUE);
  assert.deepEqual(intent.staleKeysToDrop, []);
  assert.match(intent.reason, /chip_click/);
});

// ---------------------------------------------------------------------------
// 2. "how about mens?" keeps category/color (gender-only continuation).
// ---------------------------------------------------------------------------
await test("T2 — 'how about mens?' is gender-only continuation; keeps category/color", () => {
  const intent = resolveTurnIntent({
    latestUserText: "how about mens?",
    previousScope: { gender: "women", category: "sandals", color: "black" },
  });
  assert.equal(intent.label, L.CONTINUE);
  assert.deepEqual(intent.staleKeysToDrop, []);
  assert.equal(intent.reason, "gender_only_continuation");
});

// ---------------------------------------------------------------------------
// 3. "any pink ones?" keeps category, changes color (color pivot).
// ---------------------------------------------------------------------------
await test("T3 — 'any pink ones?' is color pivot; keeps category", () => {
  const intent = resolveTurnIntent({
    latestUserText: "any pink ones?",
    previousScope: { gender: "women", category: "sandals", color: "red" },
  });
  assert.equal(intent.label, L.PIVOT_COLOR);
  assert.deepEqual(intent.staleKeysToDrop, ["color"]);
});

// ---------------------------------------------------------------------------
// 4. "size 9?" refines on top of prior category/color.
// ---------------------------------------------------------------------------
await test("T4 — 'size 9?' is refine; keeps category/color", () => {
  const intent = resolveTurnIntent({
    latestUserText: "size 9?",
    previousScope: { gender: "women", category: "sandals", color: "red" },
  });
  assert.equal(intent.label, L.REFINE);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// 5. "wider?" refines prior size/category.
// ---------------------------------------------------------------------------
await test("T5 — 'wider?' is refine; keeps prior scope", () => {
  const intent = resolveTurnIntent({
    latestUserText: "wider?",
    previousScope: { gender: "women", category: "sneakers", size: "9" },
  });
  assert.equal(intent.label, L.REFINE);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// 6. "any type of shoe, cheapest" clears stale category/color.
// ---------------------------------------------------------------------------
await test("T6 — 'any type of shoe, cheapest' broad-resets category/color", () => {
  const intent = resolveTurnIntent({
    latestUserText: "any type of shoe, show me the cheapest one",
    previousScope: { gender: "women", category: "wedges-heels", color: "white" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  // Gender preserved; category-bound facts dropped.
  assert.ok(intent.staleKeysToDrop.includes("category"));
  assert.ok(intent.staleKeysToDrop.includes("color"));
  assert.ok(!intent.staleKeysToDrop.includes("gender"));
});

// ---------------------------------------------------------------------------
// 7. "is that your cheapest?" is meta, not a reset.
// ---------------------------------------------------------------------------
await test("T7 — 'is that your cheapest?' is meta; scope preserved", () => {
  const intent = resolveTurnIntent({
    latestUserText: "is that your cheapest shoe?",
    previousScope: { gender: "women", category: "wedges-heels", color: "white" },
  });
  assert.equal(intent.label, L.META);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// 8. "compare the first two" is meta/compare, not a listing rewrite.
// ---------------------------------------------------------------------------
await test("T8 — 'compare the first two' is meta; scope preserved", () => {
  const intent = resolveTurnIntent({
    latestUserText: "compare the first two",
    previousScope: { gender: "women", category: "sneakers" },
  });
  assert.equal(intent.label, L.META);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// 9. "actually sneakers instead" pivots category fully.
// ---------------------------------------------------------------------------
await test("T9 — 'actually sneakers instead' is category pivot; drops category-bound", () => {
  const intent = resolveTurnIntent({
    latestUserText: "actually sneakers instead",
    previousScope: { gender: "women", category: "sandals", color: "red", size: "9" },
  });
  // PIVOT_FULL fires on the "actually"-followed-by-search or
  // "instead" path; either label is acceptable here, but the
  // category-bound keys MUST be dropped.
  assert.ok(
    intent.label === L.PIVOT_FULL || intent.label === L.PIVOT_CATEGORY,
    `expected pivot label, got ${intent.label}`,
  );
  assert.ok(intent.staleKeysToDrop.includes("color"));
  assert.ok(intent.staleKeysToDrop.includes("size"));
});

// ---------------------------------------------------------------------------
// 10. Orthotic chip-flow style: explicit chip-bound facts persist across
//     ambiguous-looking text turns; the existing orthotic-gate behavior
//     is not disturbed by this scorer (chip click is durable).
// ---------------------------------------------------------------------------
await test("T10 — orthotic chip flow: ambiguous text after chip click is CONTINUE", () => {
  // Customer just clicked the "Women" chip on the gender question;
  // their next turn is a short answer to a clinical follow-up. The
  // intent resolver should treat this as CONTINUE — not wipe gender.
  const intent = resolveTurnIntent({
    latestUserText: "yes",
    previousScope: { gender: "women", condition: "plantar_fasciitis" },
    choiceEvents: [
      { type: "chip_answer", userTurnIndex: 5, fact: { key: "gender", value: "women" } },
    ],
    turnIndex: 5,
  });
  assert.equal(intent.label, L.CONTINUE);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// Additional sanity tests — confidence demotion via catalogProbe.
// ---------------------------------------------------------------------------
await test("T11 — category pivot to a category the catalog doesn't carry → demoted confidence", () => {
  const intent = resolveTurnIntent({
    latestUserText: "show me clogs",
    previousScope: { gender: "men", category: "sandals", color: "tan" },
    catalogProbe: (scope) => scope.category !== "clogs",
  });
  assert.equal(intent.label, L.PIVOT_CATEGORY);
  assert.ok(intent.confidence < 0.7, `expected demoted confidence, got ${intent.confidence}`);
  assert.equal(intent.reason, "category_pivot_unverified");
});

await test("T12 — ambiguous with no prior scope → continue (don't ask on first turn)", () => {
  const intent = resolveTurnIntent({
    latestUserText: "hmm",
    previousScope: {},
  });
  assert.equal(intent.label, L.CONTINUE);
});

await test("T13 — broad reset 'show me everything' drops category-bound, keeps gender", () => {
  const intent = resolveTurnIntent({
    latestUserText: "show me everything you have",
    previousScope: { gender: "women", category: "sandals", color: "red" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  assert.ok(!intent.staleKeysToDrop.includes("gender"));
});

await test("T14 — 'all of them' is pronoun back-ref (continue), not broad reset", () => {
  const intent = resolveTurnIntent({
    latestUserText: "show me all of them",
    previousScope: { gender: "women", category: "sandals", color: "red" },
  });
  assert.notEqual(intent.label, L.PIVOT_FULL);
});

await test("T15 — meta detection still fires when previous scope has color (no false pivot)", () => {
  // Production trace: prev scope had white, current text asks meta
  // question about a specific product. Must not treat as color pivot.
  const intent = resolveTurnIntent({
    latestUserText: "do you even understand what i'm saying?",
    previousScope: { gender: "women", category: "wedges-heels", color: "white" },
  });
  assert.equal(intent.label, L.META);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`FAILURE: ${f.name}\n  ${f.err.stack || f.err.message}`);
  process.exit(1);
}
