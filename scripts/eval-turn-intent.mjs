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
  detectConversationGoal,
  detectTurnGoal,
  isBroadGenderRequest,
  broadGenderRequestGender,
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
// P2 — a BROAD gender request ("show me men's options") widens to the whole
// gender line and DROPS stale category/color/width/condition, so it doesn't
// search stale women's wedges/wide/black and falsely deny "we don't carry
// men's footwear" (live trace 2026-06-30). A SPECIFIC "men's sandals" does NOT.
// ---------------------------------------------------------------------------
await test("P2 — 'Show me men's options' drops stale category/color/width/condition", () => {
  const intent = resolveTurnIntent({
    latestUserText: "Show me men's options",
    previousScope: { gender: "women", category: "wedges-heels", color: "black", width: "wide", condition: "heel_pain" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  for (const k of ["category", "color", "width", "condition"]) {
    assert.ok(intent.staleKeysToDrop.includes(k), `must drop ${k}; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  }
});
await test("P2 — broad gender request resets even with no prior gender on record", () => {
  const intent = resolveTurnIntent({
    latestUserText: "what do you have for men",
    previousScope: { category: "wedges-heels", width: "wide" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  assert.ok(intent.staleKeysToDrop.includes("category"));
});
await test("P2 — a SPECIFIC 'men's sandals' is a category pivot, not a broad reset", () => {
  const intent = resolveTurnIntent({
    latestUserText: "men's sandals",
    previousScope: { gender: "women", category: "wedges-heels", width: "wide" },
  });
  assert.notEqual(intent.reason, "broad_gender_request");
});

// P2 RUNTIME — the shared detector the live execution path uses to force a
// deterministic gender-only search (not just the classifier).
await test("P2 runtime — isBroadGenderRequest / broadGenderRequestGender", () => {
  for (const s of ["Show me men's options", "men's options", "what do you have for men", "show me women's stuff", "men's footwear"]) {
    assert.equal(isBroadGenderRequest(s), true, `broad: ${s}`);
  }
  for (const s of ["men's sandals", "show me sandals", "do you have wedges?", "I like the Drew"]) {
    assert.equal(isBroadGenderRequest(s), false, `not broad: ${s}`);
  }
  assert.equal(broadGenderRequestGender("Show me men's options"), "men");
  assert.equal(broadGenderRequestGender("what do you have for women"), "women");
  assert.equal(broadGenderRequestGender("show me men's sandals"), null, "specific category is not a broad request");
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
// Resolver bug #1 — category pivot must drop `condition` too. Orthotic
// shopping established condition=plantar_fasciitis; pivoting to sneakers
// must not leave the clinical condition tied to the new category.
// ---------------------------------------------------------------------------
await test("T16 — category pivot drops condition (orthotics+PF → sneakers must not carry PF)", () => {
  const intent = resolveTurnIntent({
    latestUserText: "show me sneakers instead",
    previousScope: {
      gender: "women",
      category: "orthotics",
      condition: "plantar_fasciitis",
      arch: "low",
    },
  });
  // 'instead' triggers the hard-pivot path (also acceptable);
  // EITHER way, condition must end up in staleKeysToDrop.
  assert.ok(intent.label === L.PIVOT_FULL || intent.label === L.PIVOT_CATEGORY);
  assert.ok(
    intent.staleKeysToDrop.includes("condition"),
    `expected staleKeysToDrop to include 'condition'; got ${JSON.stringify(intent.staleKeysToDrop)}`,
  );
});

await test("T16b — plain category pivot (no 'instead') still drops condition", () => {
  // No HARD_PIVOT_RE / INSTEAD_PIVOT_RE keywords here — must take the
  // category_pivot branch (rule 9), which now drops condition too.
  const intent = resolveTurnIntent({
    latestUserText: "what about clogs",
    previousScope: {
      gender: "women",
      category: "orthotics",
      condition: "plantar_fasciitis",
    },
  });
  assert.equal(intent.label, L.PIVOT_CATEGORY);
  assert.ok(intent.staleKeysToDrop.includes("condition"));
});

// ---------------------------------------------------------------------------
// Resolver bug #2 — prior scope has only gender, customer names a new
// category. This is a normal category request (REFINE / first mention),
// NOT ambiguous, and there's nothing stale to drop.
// ---------------------------------------------------------------------------
await test("T17 — gender-only prior + new category mention is REFINE with no drops", () => {
  const intent = resolveTurnIntent({
    latestUserText: "show me clogs",
    previousScope: { gender: "women" },
  });
  assert.notEqual(intent.label, L.AMBIGUOUS);
  // Acceptable labels: REFINE (no prior category to invalidate) or
  // PIVOT_CATEGORY (if the function chose to call it a pivot). Both
  // must have empty staleKeysToDrop.
  assert.ok(
    intent.label === L.REFINE || intent.label === L.PIVOT_CATEGORY,
    `expected REFINE or PIVOT_CATEGORY, got ${intent.label}`,
  );
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// Use-case / category conflict (preserves the prior session-memory rule).
// ---------------------------------------------------------------------------
await test("T18 — 'hiking shoes' after 'pink sandals' drops sandals+color (usecase conflict)", () => {
  const intent = resolveTurnIntent({
    latestUserText: "I need hiking shoes for italy",
    previousScope: { gender: "women", category: "sandals", color: "pink" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  assert.equal(intent.reason, "usecase_category_conflict");
  assert.ok(intent.staleKeysToDrop.includes("category"));
  assert.ok(intent.staleKeysToDrop.includes("color"));
});

// Live trace 2026-06-03 16:26:18 — prior turn established
// gender=kid/category=orthotics/condition=flat_feet from a "kids
// orthotics for flat feet" session. Customer pivots to "i'm going
// to italy and i need a comfortable shoe for hiking" — engine MUST
// drop orthotics + flat_feet (orthotics aren't shoes; hiking is a
// shoe use-case). Without this drop, the engine returned a unisex
// cleats orthotic instead of women's hiking sneakers.
await test("T18b — 'hiking shoe' after carried orthotics drops orthotics+condition", () => {
  const intent = resolveTurnIntent({
    latestUserText: "i'm going to italy and i need a comfortable shoe for hiking",
    previousScope: {
      gender: "kid",
      category: "orthotics",
      condition: "flat_feet",
    },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  assert.equal(intent.reason, "usecase_category_conflict");
  assert.ok(intent.staleKeysToDrop.includes("category"),
    `expected category drop; got ${intent.staleKeysToDrop.join(",")}`);
  assert.ok(intent.staleKeysToDrop.includes("condition"),
    `expected condition drop; got ${intent.staleKeysToDrop.join(",")}`);
});

await test("T18c — 'dress shoes' after carried orthotics also pivots", () => {
  const intent = resolveTurnIntent({
    latestUserText: "I'm looking for dress shoes for a wedding",
    previousScope: { gender: "women", category: "orthotics" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  assert.equal(intent.reason, "usecase_category_conflict");
});

// ---------------------------------------------------------------------------
// Gender pivot (not gender-only continuation) drops subject-bound scope.
// ---------------------------------------------------------------------------
await test("T19 — 'actually for my husband' is gender pivot; drops category/color", () => {
  // Note: this test exercises the direct gender-extraction case;
  // recipient handling stays in session-memory but the gender pivot
  // detection here is the deeper signal.
  const intent = resolveTurnIntent({
    latestUserText: "actually men's please",
    previousScope: { gender: "women", category: "sandals", color: "black" },
    extractedUserConstraints: { gender: "men" },
  });
  assert.equal(intent.label, L.PIVOT_FULL);
  assert.ok(intent.staleKeysToDrop.includes("category"));
  assert.ok(intent.staleKeysToDrop.includes("color"));
  assert.ok(!intent.staleKeysToDrop.includes("gender"));
});

// ---------------------------------------------------------------------------
// Compare vocabulary — turn-intent's COMPARE_RE is the single shared
// rule (chat-postprocessing's detectComparisonIntent + detectSingularIntent
// negation both delegate to it). Verify the consolidated vocabulary covers
// what the old per-file regexes covered.
// ---------------------------------------------------------------------------
const compareInputs = [
  "compare the L1 and the L2",
  "L1 vs L2",
  "L1 versus L2",
  "what's the difference between L1 and L2",
  "show me a side-by-side comparison",
  "which is better, X or Y",
  "compare the first two",
  "the top two",
];
for (const msg of compareInputs) {
  await test(`T20-compare — "${msg}" → reason=compare_request`, () => {
    const intent = resolveTurnIntent({
      latestUserText: msg,
      previousScope: { gender: "women", category: "sandals" },
    });
    assert.equal(intent.label, L.META, `expected META label; got ${intent.label}`);
    assert.equal(intent.reason, "compare_request", `expected compare_request; got ${intent.reason}`);
  });
}

await test("T20-compare — 'tell me about the L1' is NOT compare", () => {
  const intent = resolveTurnIntent({
    latestUserText: "tell me about the L1",
    previousScope: { gender: "women", category: "sandals" },
  });
  assert.notEqual(intent.reason, "compare_request");
});

await test("T20-compare — 'show me sandals' is NOT compare", () => {
  const intent = resolveTurnIntent({
    latestUserText: "show me sandals",
    previousScope: { gender: "women" },
  });
  assert.notEqual(intent.reason, "compare_request");
});

await test("T20-compare — 'which one had the removable insole' is product-finding, NOT compare", () => {
  const intent = resolveTurnIntent({
    latestUserText: "which one had the removable insole — it was a white women's sneaker around $140",
    previousScope: { gender: "women", category: "sneakers" },
  });
  assert.notEqual(intent.reason, "compare_request");
});

await test("T20-compare — 'which one is better' remains compare", () => {
  const intent = resolveTurnIntent({
    latestUserText: "which one is better?",
    previousScope: { gender: "women", category: "sneakers" },
  });
  assert.equal(intent.reason, "compare_request");
});

// ---------------------------------------------------------------------------
// 2026-06-02 Railway live failure: turn 1 = "pink sandals for bunions",
// turn 2 = "best dress shoes for men". Memory carried sandals/pink/bunions
// over and the search ran "dress sandals bunions arch support". The
// gender-pivot rule didn't fire because prev.gender was INFERRED on
// turn 1 (not explicit) so previousScope.gender was null when turn 2
// arrived. session-memory now injects inferred.gender into previousScope
// — and the dress-conflict set now includes "sandals".
// ---------------------------------------------------------------------------

await test("T21 — dress + carried sandals → usecase_category_conflict drops scope", () => {
  const intent = resolveTurnIntent({
    latestUserText: "best dress shoes for men",
    previousScope: { gender: "women", category: "sandals", color: "pink", condition: "bunions" },
  });
  // Either the gender pivot OR the dress conflict must fire — both
  // are valid drops; both lead to scope being cleaned. The gender
  // pivot fires first (rule 7 before rule 8) so reason should be
  // gender_pivot. Either way, category/color/condition must be
  // dropped.
  assert.notEqual(intent.staleKeysToDrop.length, 0,
    `expected scope drops on "dress shoes for men" with carried sandals/pink/bunions; got staleKeysToDrop=${JSON.stringify(intent.staleKeysToDrop)}`);
  for (const key of ["category", "color", "condition"]) {
    assert.ok(intent.staleKeysToDrop.includes(key),
      `expected ${key} to be dropped; got staleKeysToDrop=${JSON.stringify(intent.staleKeysToDrop)}`);
  }
});

await test("T22 — dress useCase alone (no new gender) + carried sandals → dress conflict pivots", () => {
  const intent = resolveTurnIntent({
    latestUserText: "what about something dressy",
    previousScope: { gender: "women", category: "sandals", color: "pink" },
    extractedUserConstraints: { useCase: "dress" },
  });
  assert.equal(intent.reason, "usecase_category_conflict");
  for (const key of ["category", "color"]) {
    assert.ok(intent.staleKeysToDrop.includes(key),
      `expected ${key} dropped on dress+sandals conflict`);
  }
});

// ---------------------------------------------------------------------------
// 2026-06-03 live failure: stale color carried into a fresh claim-driven
// query. New rule 9c — "claim refresh" — drops the stale color when a
// new condition or use-case arrives without an explicit color mention
// AND without "same color" phrasing.
// ---------------------------------------------------------------------------

await test("T23 — Turn1 pink+sandals+bunions → Turn2 plantar fasciitis sandals: color drops", () => {
  // The exact live shape from the user's failure report.
  const intent = resolveTurnIntent({
    latestUserText: "I have plantar fasciitis, what women's sandals do you recommend?",
    previousScope: { gender: "women", category: "sandals", color: "pink", condition: "bunions" },
  });
  assert.equal(intent.reason, "claim_refresh_condition",
    `expected claim_refresh_condition; got reason=${intent.reason} drops=${JSON.stringify(intent.staleKeysToDrop)}`);
  assert.ok(intent.staleKeysToDrop.includes("color"),
    `expected color in staleKeysToDrop; got ${JSON.stringify(intent.staleKeysToDrop)}`);
});

await test("T24 — Turn1 pink sandals → Turn2 'do you have those for plantar fasciitis?': color drops, category may stay", () => {
  const intent = resolveTurnIntent({
    latestUserText: "do you have those for plantar fasciitis?",
    previousScope: { category: "sandals", color: "pink" },
  });
  assert.ok(intent.staleKeysToDrop.includes("color"),
    `expected color drop on fresh-claim turn without color mention; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  // Category is NOT explicitly dropped — the customer is asking about
  // the same shopping subject, just with a fresh claim. Memory
  // continues to carry category=sandals via the standard refine
  // path.
  assert.equal(intent.staleKeysToDrop.includes("category"), false,
    `category should NOT drop; got ${JSON.stringify(intent.staleKeysToDrop)}`);
});

await test("T25 — Turn1 women's sandals → Turn2 'in pink': color is set, category stays (no drop rule fires)", () => {
  const intent = resolveTurnIntent({
    latestUserText: "in pink",
    previousScope: { gender: "women", category: "sandals" },
  });
  // Standard refine path — no drops. extracted.color="pink" applies on
  // top of category=sandals via SCALAR_KEYS in session-memory.
  assert.equal(intent.staleKeysToDrop.length, 0,
    `expected no drops on color-refine; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  // Reason isn't claim_refresh — the color was explicitly named.
  assert.notEqual(intent.reason, "claim_refresh_condition");
  assert.notEqual(intent.reason, "claim_refresh_usecase");
});

await test("T26 — Turn1 pink sandals → Turn2 'same color but for plantar fasciitis': color stays", () => {
  // "same color" without naming a specific color → SAME_COLOR_RE
  // matches → claim_refresh does NOT fire → color stays.
  const intent = resolveTurnIntent({
    latestUserText: "same color but for plantar fasciitis",
    previousScope: { category: "sandals", color: "pink" },
  });
  assert.equal(intent.staleKeysToDrop.includes("color"), false,
    `same-color phrasing must keep color; got ${JSON.stringify(intent.staleKeysToDrop)}`);
});

await test("T27 — useCase change without color mention also triggers claim_refresh", () => {
  // Turn1 athletic sneakers in red → Turn2 "for hiking"
  // useCase changes (athletic → hiking via usecase-category-conflict),
  // but here we cover the simpler case where no category conflict
  // exists. e.g. Turn1: red boots for walking. Turn2: for hiking.
  const intent = resolveTurnIntent({
    latestUserText: "for hiking",
    previousScope: { category: "boots", color: "red", useCase: "walking" },
    extractedUserConstraints: { useCase: "hiking" },
  });
  // hiking + boots isn't a conflict (boots are fine for hiking), so
  // rule 8 doesn't fire. Rule 9c should drop the stale color.
  assert.equal(intent.reason, "claim_refresh_usecase",
    `expected claim_refresh_usecase; got reason=${intent.reason}`);
  assert.ok(intent.staleKeysToDrop.includes("color"));
});

await test("T28 — kids scope → first-person hiking shoe turn drops kids subject", () => {
  const intent = resolveTurnIntent({
    latestUserText: "i'm going to mountain and i need a comfortable shoe for hiking",
    previousScope: { gender: "kids", category: "orthotics", condition: "flat_feet" },
    extractedUserConstraints: { useCase: "hiking" },
  });
  assert.equal(intent.reason, "self_directed_after_kids",
    `expected self_directed_after_kids; got reason=${intent.reason}`);
  for (const key of ["gender", "category", "condition"]) {
    assert.ok(intent.staleKeysToDrop.includes(key),
      `expected ${key} dropped; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  }
});

await test("T29 — 'cancel my last order' is account-action pivot; drops product scope", () => {
  const intent = resolveTurnIntent({
    latestUserText: "cancel my last order",
    previousScope: { gender: "men", category: "sneakers", useCase: "athletic" },
  });
  assert.equal(intent.reason, "account_action_pivot",
    `expected account_action_pivot; got reason=${intent.reason}`);
  for (const key of ["category", "useCase"]) {
    assert.ok(intent.staleKeysToDrop.includes(key),
      `expected ${key} dropped; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  }
});

await test("T30 — 'which products have the worst reviews?' is negative-meta; drops product scope", () => {
  const intent = resolveTurnIntent({
    latestUserText: "which products have the worst reviews?",
    previousScope: { gender: "men", category: "sneakers", useCase: "athletic" },
  });
  assert.equal(intent.reason, "negative_meta_question",
    `expected negative_meta_question; got reason=${intent.reason}`);
  assert.ok(intent.staleKeysToDrop.includes("category"));
});

await test("T31 — 'which is better, Vicki or Jillian?' drops stale category", () => {
  const intent = resolveTurnIntent({
    latestUserText: "which is better, Vicki or Jillian?",
    previousScope: { gender: "women", category: "footwear", useCase: "athletic" },
  });
  assert.equal(intent.reason, "compare_request");
  assert.ok(intent.staleKeysToDrop.includes("category"),
    `expected category dropped on fresh-subject compare; got ${JSON.stringify(intent.staleKeysToDrop)}`);
});

await test("T33 — 'what's the cheapest one?' drops stale bestseller modifier", () => {
  const intent = resolveTurnIntent({
    latestUserText: "what's the cheapest one?",
    previousScope: { gender: "women", category: "sandals", modifier: "bestseller", badge: "best" },
  });
  assert.equal(intent.reason, "refine_price");
  assert.ok(intent.staleKeysToDrop.includes("modifier"),
    `modifier must be dropped on cheapest refine; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  assert.ok(intent.staleKeysToDrop.includes("badge"));
});

await test("T32 — 'compare the first two' (back-ref) preserves scope", () => {
  const intent = resolveTurnIntent({
    latestUserText: "compare the first two",
    previousScope: { gender: "women", category: "sneakers" },
  });
  assert.equal(intent.label, L.META);
  assert.deepEqual(intent.staleKeysToDrop, []);
});

// ---------------------------------------------------------------------------
// Conversation GOAL detection (prod regression 2026-06-15: a sizing
// question got hijacked into the orthotic finder).
// ---------------------------------------------------------------------------
const convGoal = (arr) => detectConversationGoal(arr.map((c) => ({ role: "user", content: c })));

await test("GOAL — sizing question + one-word scoping answers stays 'sizing'", () => {
  // The reported bug: "what size should I choose" then "Men's",
  // "Orthotics" must NOT become a recommendation goal.
  assert.deepEqual(convGoal(["What size should I choose?", "Men's", "Orthotics", "Memory foam — everyday wear", "Flat / Low"]), { type: "sizing", turnIndex: 0 });
});

await test("GOAL — explicit shopping AFTER an info question overrides it", () => {
  assert.equal(convGoal(["what's your return policy", "ok cool. I need orthotics", "Men"]).type, "recommendation");
});

await test("GOAL — info question BEFORE the only shopping action does not flip prematurely", () => {
  // recommendation stated first, then a size follow-up → the immediate
  // goal is sizing (answer about the shown product), not re-recommend.
  assert.equal(convGoal(["recommend an orthotic", "what size should I choose?"]).type, "sizing");
});

await test("GOAL — bare condition/category answers carry no goal (won't flip mid-flow)", () => {
  assert.equal(detectTurnGoal("Memory foam — everyday wear"), null);
  assert.equal(detectTurnGoal("Orthotics"), null);
  assert.equal(detectTurnGoal("Men's"), null);
});

await test("GOAL — 'I need to return this' is policy, not a recommendation", () => {
  assert.equal(detectTurnGoal("I need to return this"), "policy");
  assert.equal(detectTurnGoal("I need orthotics"), "recommendation");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`FAILURE: ${f.name}\n  ${f.err.stack || f.err.message}`);
  process.exit(1);
}
