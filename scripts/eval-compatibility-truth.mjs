// COMPATIBILITY PRODUCT-TRUTH regression suite.
//
// PRD trace 6c4a79d: "Can I wear orthotics inside sandals, or do I need closed
// shoes?" → the LLM invented a removable-footbed sandal (catalog had none; the
// follow-up "Show me Aetrex sandals with removable footbeds" was later dropped as
// catalog_intersection_empty). Guards added:
//   - deterministic Aetrex-safe answer for the orthotic↔sandal question,
//   - a blocking grounding error (unsupported_compatibility_claim) + contract warning,
//   - safe follow-up suggestions (no removable-footbed sandal),
//   - claim allowed ONLY when a specific product carries explicit evidence.
// Plus the prior-evidence wording fix: cards-shown broaden uses positive
// closest-match language, never denial wording.
//
// Run: node scripts/eval-compatibility-truth.mjs

import assert from "node:assert/strict";
import { planTurn } from "../app/lib/turn-plan.server.js";
import {
  isOrthoticSandalCompatibilityQuestion,
  buildOrthoticCompatibilityAnswer,
  containsUnsupportedCompatibilityClaim,
  hasExplicitOrthoticCompatibleEvidence,
  cardAssertsOrthoticCompatibility,
  isUnsafeCompatibilitySuggestion,
  SAFE_COMPATIBILITY_SUGGESTIONS,
} from "../app/lib/compatibility-truth.server.js";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";
import { validateTurnResult } from "../app/lib/response-contract.server.js";
import { buildWidthSizeFallbackText } from "../app/lib/prior-evidence.js";
import { detectAiNoMatchPhrasing } from "../app/lib/chat-postprocessing.js";

let pass = 0, fail = 0;
const fails = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}

const FORBIDDEN = [/\bremovable\s+foot\s?bed/i, /\bdrops?\s+in\b/i, /\blifts?\s+out\b/i, /\bmake[s]?\s+room\b/i, /\borthotics?\s+(?:in|inside|into)\s+(?:open\s+)?sandals?/i];

console.log("\ncompatibility product-truth\n");

// 1 ── the deterministic Aetrex-safe answer ────────────────────────────────────
test("1. Q1 'orthotics inside sandals' → detected; safe answer is Aetrex-correct", () => {
  const q = "Can I wear orthotics inside sandals, or do I need closed shoes?";
  assert.equal(planTurn({ message: q }).workflow, "compatibility");
  assert.ok(isOrthoticSandalCompatibilityQuestion(q));
  const a = buildOrthoticCompatibilityAnswer();
  // Must say the Aetrex-safe thing.
  assert.match(a, /closed shoes/i);
  assert.match(a, /removable insoles/i);
  assert.match(a, /enough depth/i);
  assert.match(a, /built-in arch support/i);
  // Must NOT say yes / removable footbed / drops in / lifts out / make room /
  // orthotics in sandals.
  for (const re of FORBIDDEN) assert.ok(!re.test(a), `safe answer must not match ${re}`);
  // Must offer the supportive-sandal alternative.
  assert.ok(SAFE_COMPATIBILITY_SUGGESTIONS.includes("Show me supportive sandals"));
});

// 2 ── catch-phrase detection ──────────────────────────────────────────────────
test("2. unsupported-claim phrases caught; safe answer is clean", () => {
  const bad = [
    "Yes, many Aetrex sandals have a removable footbed for your orthotic.",
    "The orthotic drops right in once you lift out the insole.",
    "These sandals make room for the orthotic.",
    "Just pop the orthotic into the sandal.",
    "We have orthotic-compatible sandals.",
    "You can wear orthotics inside sandals.",
  ];
  for (const t of bad) assert.ok(containsUnsupportedCompatibilityClaim(t), `should catch: ${t}`);
  assert.ok(!containsUnsupportedCompatibilityClaim(buildOrthoticCompatibilityAnswer()), "safe answer must be clean");
});

// 3 ── explicit per-product evidence unlocks the claim ─────────────────────────
test("3. explicit removable-footbed evidence is recognized per product", () => {
  const evidenceCard = { title: "Maui Slide", description: "Features a removable footbed that accommodates an orthotic." };
  const plainCard = { title: "Plain Sandal", description: "A comfortable everyday sandal." };
  assert.ok(cardAssertsOrthoticCompatibility(evidenceCard));
  assert.ok(!cardAssertsOrthoticCompatibility(plainCard));
  assert.ok(hasExplicitOrthoticCompatibleEvidence([plainCard, evidenceCard]));
  assert.ok(!hasExplicitOrthoticCompatibleEvidence([plainCard]));
});

// 4 ── grounding validator blocks the claim, allows it only with evidence ──────
test("4. validateGrounding: compatibility claim blocks w/o evidence, allowed w/ evidence", () => {
  const bad = validateGrounding({
    text: "Yes — our sandals have a removable footbed so the orthotic drops right in.",
    pool: [], workflow: "compatibility",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.kind === "unsupported_compatibility_claim"));

  // The SAME claim is allowed when a specific product carries the evidence.
  const evidenceCard = { title: "Maui", description: "removable footbed for orthotics" };
  const ok = validateGrounding({
    text: "The Maui has a removable footbed that fits an orthotic.",
    pool: [evidenceCard], workflow: "compatibility",
  });
  assert.equal(ok.ok, true, "claim allowed when product evidence exists");

  // The Aetrex-safe answer always validates.
  const safe = validateGrounding({ text: buildOrthoticCompatibilityAnswer(), pool: [], workflow: "compatibility" });
  assert.equal(safe.ok, true);

  // Outside compatibility, the rule does not fire (scoped).
  const browse = validateGrounding({ text: "Yes, removable footbed.", pool: [], workflow: "browse" });
  assert.ok(!browse.errors.some((e) => e.kind === "unsupported_compatibility_claim"));
});

// 5 ── follow-up suggestions: never the removable-footbed sandal ───────────────
test("5. unsafe 'removable footbed sandals' suggestion dropped; safe set is clean", () => {
  assert.ok(isUnsafeCompatibilitySuggestion("Show me sandals with removable footbeds"));
  assert.ok(isUnsafeCompatibilitySuggestion("Show me orthotic-compatible sandals"));
  assert.ok(isUnsafeCompatibilitySuggestion("Can I fit orthotics in sandals"));
  for (const s of SAFE_COMPATIBILITY_SUGGESTIONS) assert.ok(!isUnsafeCompatibilitySuggestion(s), `safe suggestion flagged: ${s}`);
  assert.deepEqual(SAFE_COMPATIBILITY_SUGGESTIONS, [
    "Show me supportive sandals",
    "Show me orthotics for closed shoes",
    "Help me choose shoes vs orthotics",
  ]);
});

// 6 ── Q2 'do any sandals have removable footbeds' also owned (workflow-agnostic) ─
test("6. Q2 removable-footbed-sandals question is detected (owner is workflow-agnostic)", () => {
  const q2 = "Do any Aetrex sandals have removable footbeds for orthotics?";
  // It does NOT route to compatibility, but the product-truth owner keys off the
  // question shape, not the workflow label — so it is still caught.
  assert.ok(isOrthoticSandalCompatibilityQuestion(q2), "Q2 must be detected regardless of workflow");
  // And an invented "yes" would be flagged by the contract.
  const warn = validateTurnResult({
    text: "Yes, several Aetrex sandals have a removable footbed for orthotics.",
    products: [], workflow: "compatibility",
  });
  assert.ok(warn.some((w) => w.code === "unsupported_compatibility_claim"));
});

// 7 ── prior-evidence cards-shown uses POSITIVE wording, no denial flag ─────────
test("7. prior-evidence broaden text is positive closest-match (no denial_with_products)", () => {
  const one = buildWidthSizeFallbackText("wide width", 1);
  const many = buildWidthSizeFallbackText("wide width", 3);
  for (const t of [one, many]) {
    assert.match(t, /closest match/i);
    assert.ok(!/i\s+don'?t\s+see|not\s+seeing/i.test(t), `must not be a denial: ${t}`);
    assert.ok(!detectAiNoMatchPhrasing(t), `must not read as no-match: ${t}`);
  }
  // The contract must NOT flag denial_with_products on a prior-evidence turn that
  // shows cards — even if the text somehow read as a denial.
  const cards = [{ title: "Reagan Boot", handle: "reagan" }, { title: "Maui Sandal", handle: "maui" }];
  const warns = validateTurnResult({ text: many, products: cards, cardOwner: "prior-evidence", workflow: "prior_evidence_availability" });
  assert.ok(!warns.some((w) => w.code === "denial_with_products"), "prior-evidence cards-shown must not flag denial");
  // Belt-and-suspenders: even denial-shaped text is exempt when prior-evidence owns cards.
  const denialWarns = validateTurnResult({ text: "I'm not seeing those exact styles.", products: cards, cardOwner: "prior-evidence" });
  assert.ok(!denialWarns.some((w) => w.code === "denial_with_products"), "prior-evidence exemption holds");
});

console.log("");
if (fail === 0) {
  console.log(`✅  ${pass} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${pass} passed, ${fail} failed\n`);
  for (const f of fails) console.log(`  ${f.name}\n    ${f.err.message}`);
  process.exit(1);
}
