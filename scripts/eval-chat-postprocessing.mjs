// Unit eval for chat post-processing heuristics.
//
// Tests the pure functions extracted from chat.jsx into
// chat-postprocessing.js, plus selected exports from
// chat-helpers.server.js. Catches the chat.jsx-side bugs that don't
// live in the gate or classifier — singular-narrow misfires,
// follow-up suggestion validation, pivot-phrasing detection, etc.
//
// Run:
//   node scripts/eval-chat-postprocessing.mjs
//
// Why these matter: the chat.jsx LLM-path has heuristic rules that
// ride on top of the LLM's output. When these rules misfire, the
// customer sees broken UX even though the classifier and gate worked
// correctly. Examples:
//   - Singular-narrow collapses 6 cards → 1 (one specific bug)
//   - Follow-up suggestion promises something the catalog doesn't have
//   - "We don't have X" denial despite the LLM clearly pivoting

import assert from "node:assert/strict";
import {
  detectSingularIntent,
  detectComparisonIntent,
  detectAiPivotPhrasing,
  validateFollowUpSuggestion,
} from "../app/lib/chat-postprocessing.js";
import {
  isSingularPrescriptive,
  hasPluralIntroFraming,
  looksLikeProductPitch,
  looksLikeDefinitionalHallucination,
  hasChoiceButtons,
  normalizeGenderChipAnswer,
  detectConditionOrOccasion,
} from "../app/lib/chat-helpers.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err?.message?.split("\n")[0] || err}`);
  }
}

function section(label) {
  console.log(`\n${label}`);
}

// =====================================================================
section("detectSingularIntent");
// =====================================================================

// SHOULD detect as singular
test("'tell me about this'", () => assert(detectSingularIntent("tell me about this")));
test("'tell me more about it'", () => assert(detectSingularIntent("tell me more about it")));
test("'this one'", () => assert(detectSingularIntent("I'll take this one")));
test("'that one'", () => assert(detectSingularIntent("that one looks good")));
test("'what's the best'", () => assert(detectSingularIntent("what's the best for plantar fasciitis")));
test("'which is best'", () => assert(detectSingularIntent("which orthotic is best for athletes")));
test("'the cheapest one'", () => assert(detectSingularIntent("show me the cheapest one")));
test("'the red one'", () => assert(detectSingularIntent("the red one please")));
test("'how about this one' (singular qualifier)", () => assert(detectSingularIntent("how about this one")));
test("'what about that one'", () => assert(detectSingularIntent("what about that one")));

// SHOULD NOT detect as singular
test("'how about for women' (category pivot, NOT singular)", () => assert(!detectSingularIntent("how about for women")));
test("'how about womens' (the production bug)", () => assert(!detectSingularIntent("how about for womens")));
test("'what about kids' (pivot, NOT singular)", () => assert(!detectSingularIntent("what about kids")));
test("'show me sneakers' (plural browse)", () => assert(!detectSingularIntent("show me sneakers under $100")));
test("'find me sandals' (plural browse)", () => assert(!detectSingularIntent("find me sandals")));
test("'do you have boots' (plural browse)", () => assert(!detectSingularIntent("do you have boots in size 10")));

// Comparison overrides singular even if singular phrasing matches
test("'compare X and Y' → not singular", () => assert(!detectSingularIntent("compare the L1 and the L2")));
test("'which is better, X or Y' → not singular", () => assert(!detectSingularIntent("which is better, the L1 or the L2")));
test("'difference between X and Y' → not singular", () => assert(!detectSingularIntent("what's the difference between L1 and L2")));
test("'X vs Y' → not singular", () => assert(!detectSingularIntent("L1 vs L2")));

// =====================================================================
section("detectComparisonIntent");
// =====================================================================

test("'compare X and Y'", () => assert(detectComparisonIntent("compare the L1 and the L2")));
test("'X vs Y'", () => assert(detectComparisonIntent("L1 vs L2")));
test("'X versus Y'", () => assert(detectComparisonIntent("L1 versus L2")));
test("'difference between X and Y'", () => assert(detectComparisonIntent("what's the difference between L1 and L2")));
test("'side-by-side'", () => assert(detectComparisonIntent("show me a side-by-side comparison")));
test("'which is better, X or Y'", () => assert(detectComparisonIntent("which is better, X or Y")));
test("'tell me about X' → NOT comparison", () => assert(!detectComparisonIntent("tell me about the L1")));
test("'show me sandals' → NOT comparison", () => assert(!detectComparisonIntent("show me sandals")));

// =====================================================================
section("detectAiPivotPhrasing");
// =====================================================================

// SHOULD detect as pivot (override saysNoMatch)
test("'we don't have X but here are Y'", () => assert(detectAiPivotPhrasing("We don't have an exact red, but here are our closest")));
test("'but all of these sandals'", () => assert(detectAiPivotPhrasing("We don't have a yellow option, but all of these sandals are tagged for bunions")));
test("'closest options'", () => assert(detectAiPivotPhrasing("Here are our closest options to what you asked for")));
test("'next best alternatives'", () => assert(detectAiPivotPhrasing("These are the next best alternatives we have")));
test("'similar matches'", () => assert(detectAiPivotPhrasing("Here are similar matches we found")));
test("'but I do have'", () => assert(detectAiPivotPhrasing("We don't carry that exact one, but I do have a few options")));
test("'but we've got'", () => assert(detectAiPivotPhrasing("No exact match, but we've got these")));

// SHOULD NOT detect as pivot
test("plain text no pivot", () => assert(!detectAiPivotPhrasing("Here are some sneakers for you")));
test("denial without pivot ('we don't have')", () => assert(!detectAiPivotPhrasing("We don't have any in your size")));
test("'but it's expensive' (not a product pivot)", () => assert(!detectAiPivotPhrasing("That's a great option but it's expensive")));

// =====================================================================
section("validateFollowUpSuggestion");
// =====================================================================

test("plain question allowed", () => {
  const r = validateFollowUpSuggestion("Do you have wider widths?", "Here are some sneakers.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("'do you have these in another color' allowed (no tech term)", () => {
  const r = validateFollowUpSuggestion("Do you have these in another color?", "Here are some sneakers.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("'tell me about UltraSKY' BLOCKED if not in reply", () => {
  const r = validateFollowUpSuggestion("Tell me more about UltraSKY foam", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

test("'tell me about UltraSKY' ALLOWED if in reply", () => {
  const r = validateFollowUpSuggestion("Tell me more about UltraSKY foam", "These have UltraSKY cushioning for shock absorption.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("spec measurement BLOCKED if not in reply", () => {
  const r = validateFollowUpSuggestion("What's the heel height?", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

test("spec measurement ALLOWED if in reply", () => {
  const r = validateFollowUpSuggestion("What's the heel height?", "These have a 12mm heel height drop.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("'how does the technology work' BLOCKED (deepdive)", () => {
  const r = validateFollowUpSuggestion("How does the foam technology work", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

test("'explain the system' BLOCKED (deepdive)", () => {
  const r = validateFollowUpSuggestion("Explain the support system", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

// =====================================================================
section("isSingularPrescriptive (chat-helpers)");
// =====================================================================

test("'X is your perfect match' → prescriptive", () => assert(isSingularPrescriptive("L1320 is your perfect match")));
test("'X is the best fit' → prescriptive", () => assert(isSingularPrescriptive("This sandal is the best fit for you")));
test("'here are some options' → NOT prescriptive", () => assert(!isSingularPrescriptive("here are some options for you")));

// =====================================================================
section("hasPluralIntroFraming (chat-helpers)");
// =====================================================================

test("'here are some sneakers'", () => assert(hasPluralIntroFraming("here are some sneakers for you")));
test("'check out these options'", () => assert(hasPluralIntroFraming("check out these options")));
test("'X is your perfect match' → NOT plural-intro", () => assert(!hasPluralIntroFraming("L1320 is your perfect match")));

// =====================================================================
section("hasChoiceButtons (chat-helpers)");
// =====================================================================

test("'<<Men>><<Women>>' → has buttons", () => assert(hasChoiceButtons("Pick one: <<Men>><<Women>>")));
test("plain text → no buttons", () => assert(!hasChoiceButtons("Here are some sneakers.")));
test("escaped chars → no buttons", () => assert(!hasChoiceButtons("size <S, M, L>")));

// =====================================================================
section("normalizeGenderChipAnswer (chat-helpers)");
// =====================================================================

test("'Men' → 'men'", () => assert.equal(normalizeGenderChipAnswer("Men"), "men"));
test("\"Men's\" → 'men'", () => assert.equal(normalizeGenderChipAnswer("Men's"), "men"));
test("'Women' → 'women'", () => assert.equal(normalizeGenderChipAnswer("Women"), "women"));
test("\"Men's & Boys'\" → 'men' (compound)", () => assert.equal(normalizeGenderChipAnswer("Men's & Boys'"), "men"));

// =====================================================================
section("detectConditionOrOccasion (chat-helpers)");
// =====================================================================

test("'plantar fasciitis' detected", () => {
  const r = detectConditionOrOccasion("I have plantar fasciitis");
  assert(r, `expected truthy, got ${JSON.stringify(r)}`);
});

test("'flat feet' detected", () => {
  const r = detectConditionOrOccasion("my flat feet hurt");
  assert(r, `expected truthy, got ${JSON.stringify(r)}`);
});

test("'wedding' detected", () => {
  const r = detectConditionOrOccasion("I'm going to a wedding");
  assert(r, `expected truthy, got ${JSON.stringify(r)}`);
});

test("greeting → not detected", () => {
  const r = detectConditionOrOccasion("hi how are you");
  assert(!r, `expected falsy, got ${JSON.stringify(r)}`);
});

// =====================================================================
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.err?.message || f.err}`);
  }
  process.exit(1);
}
