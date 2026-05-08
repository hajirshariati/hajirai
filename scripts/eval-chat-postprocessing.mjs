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
  detectRejectedCategories,
  stripRejectedCategoryChips,
  stripToolCallSyntax,
  detectStockClaim,
  stripStockClaim,
  isYesNoQuestion,
  isYesNoAnswer,
  detectUserSignupIntent,
  detectAiSignupMention,
  scrubRoleMarkers,
  detectBroadNeed,
  detectAiNoMatchPhrasing,
  looksLikeClarifyingQuestion,
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
section("detectRejectedCategories");
// =====================================================================

test("'I don't like sandals' → {sandals}", () => {
  const r = detectRejectedCategories("I don't like sandals");
  assert(r.has("sandals"), `expected sandals, got ${[...r].join(",")}`);
});

test("'no boots please' → {boots}", () => {
  const r = detectRejectedCategories("no boots please");
  assert(r.has("boots"));
});

test("'doesn't like shoes' → expands to all footwear members", () => {
  const r = detectRejectedCategories("she doesn't like shoes");
  assert(r.has("sandals") && r.has("sneakers") && r.has("boots") && r.has("loafers"),
    `expected umbrella expansion, got ${[...r].join(",")}`);
});

test("'something other than sneakers' → {sneakers}", () => {
  const r = detectRejectedCategories("something other than sneakers");
  assert(r.has("sneakers"));
});

test("'avoid heels' → {heels}", () => {
  const r = detectRejectedCategories("avoid heels");
  assert(r.has("heels"));
});

test("'I love sandals' → no rejection", () => {
  const r = detectRejectedCategories("I love sandals");
  assert.equal(r.size, 0, `expected empty, got ${[...r].join(",")}`);
});

test("empty / null → empty Set", () => {
  assert.equal(detectRejectedCategories("").size, 0);
  assert.equal(detectRejectedCategories(null).size, 0);
});

// =====================================================================
section("stripRejectedCategoryChips");
// =====================================================================

test("strips matching chip", () => {
  const r = stripRejectedCategoryChips("Try these: <<Sandals>><<Sneakers>>", new Set(["sandals"]));
  assert(!r.text.includes("<<Sandals>>"), `expected sandals stripped, got ${r.text}`);
  assert(r.text.includes("<<Sneakers>>"));
  assert.deepEqual(r.stripped, ["Sandals"]);
});

test("plural/singular stem matching", () => {
  const r = stripRejectedCategoryChips("<<Boot>><<Boots>>", new Set(["boots"]));
  assert.equal(r.stripped.length, 2, `expected both stripped, got ${r.stripped.length}`);
});

test("case-insensitive match", () => {
  const r = stripRejectedCategoryChips("<<SANDALS>>", new Set(["sandals"]));
  assert.equal(r.stripped.length, 1);
});

test("no rejection → text unchanged", () => {
  const original = "<<Sandals>><<Sneakers>>";
  const r = stripRejectedCategoryChips(original, new Set());
  assert.equal(r.text, original);
  assert.equal(r.stripped.length, 0);
});

test("empty text → empty result", () => {
  const r = stripRejectedCategoryChips("", new Set(["sandals"]));
  assert.equal(r.text, "");
});

// =====================================================================
section("stripToolCallSyntax");
// =====================================================================

test("strips <function_calls> tag", () => {
  const r = stripToolCallSyntax("<function_calls>foo</function_calls>Hello.");
  assert(!r.includes("<function_calls>"), `got: ${r}`);
  assert(r.includes("Hello."));
});

test("strips <invoke> tag", () => {
  const r = stripToolCallSyntax(`<invoke name="search">x</invoke> Result.`);
  assert(!r.includes("<invoke"), `got: ${r}`);
});

test("strips antml:* tags", () => {
  const r = stripToolCallSyntax("<tool>x</tool> ok");
  assert(!r.includes("<antml"), `got: ${r}`);
});

test("strips 'search_products {...}' fragment", () => {
  const r = stripToolCallSyntax(`search_products {"q":"sandals"} Here are options.`);
  assert(!r.includes("search_products"), `got: ${r}`);
  assert(r.includes("options"));
});

test("strips 'recommend_orthotic {...}' fragment", () => {
  const r = stripToolCallSyntax(`recommend_orthotic {"gender":"Men"} Here it is.`);
  assert(!r.includes("recommend_orthotic"));
});

test("strips bare 'search_products Foo...' leader", () => {
  const r = stripToolCallSyntax("search_products The Casual line is great.");
  assert(!r.startsWith("search_products"), `got: ${r}`);
});

test("clean text passes through", () => {
  const r = stripToolCallSyntax("Just regular reply.");
  assert.equal(r, "Just regular reply.");
});

test("null/undefined safe", () => {
  assert.equal(stripToolCallSyntax(null), null);
  assert.equal(stripToolCallSyntax(""), "");
});

// =====================================================================
section("detectStockClaim / stripStockClaim");
// =====================================================================

test("'currently available in size 9' → claim detected", () => {
  assert(detectStockClaim("Yes, currently available in size 9 wide."));
});

test("'in stock in size 10' → claim detected", () => {
  assert(detectStockClaim("These are in stock in size 10."));
});

test("'we have it in size 8' → claim detected", () => {
  assert(detectStockClaim("Good news — we have it in size 8."));
});

test("'available in wide' → claim detected", () => {
  assert(detectStockClaim("Available in wide width."));
});

test("plain text → no claim", () => {
  assert(!detectStockClaim("These are great for plantar fasciitis."));
});

test("size mention without availability → no claim", () => {
  assert(!detectStockClaim("They run small — go up half a size."));
});

test("stripStockClaim removes phrase + appends deferral", () => {
  const r = stripStockClaim("Great pick — currently available in size 9 wide.");
  assert(!/available in size/.test(r), `still has claim: ${r}`);
  assert(/can't check live stock/.test(r), `missing deferral: ${r}`);
});

// =====================================================================
section("isYesNoQuestion / isYesNoAnswer");
// =====================================================================

test("'do these come in red?' → yes/no question", () => {
  assert(isYesNoQuestion("do these come in red?"));
});

test("'is it good for plantar fasciitis?' → yes/no question", () => {
  assert(isYesNoQuestion("is it good for plantar fasciitis?"));
});

test("'will it work for me?' → yes/no question", () => {
  assert(isYesNoQuestion("will it work for me?"));
});

test("'show me more' → not a yes/no question", () => {
  assert(!isYesNoQuestion("show me more"));
});

test("'what should I get?' → not a yes/no question (wh-)", () => {
  assert(!isYesNoQuestion("what should I get?"));
});

test("statement → not a yes/no question", () => {
  assert(!isYesNoQuestion("I have plantar fasciitis"));
});

test("'Yes — these have...' → yes/no answer", () => {
  assert(isYesNoAnswer("Yes — these have arch support."));
});

test("'No, unfortunately...' → yes/no answer", () => {
  assert(isYesNoAnswer("No, unfortunately we don't carry those."));
});

test("'Absolutely!' → yes/no answer", () => {
  assert(isYesNoAnswer("Absolutely! These work great."));
});

test("'Here are some options' → not a yes/no answer", () => {
  assert(!isYesNoAnswer("Here are some options for you"));
});

// =====================================================================
section("detectUserSignupIntent / detectAiSignupMention");
// =====================================================================

test("'sign up for newsletter' → user signup intent", () => {
  assert(detectUserSignupIntent("How do I sign up for your newsletter?"));
});

test("'subscribe to your email list' → user signup intent", () => {
  assert(detectUserSignupIntent("subscribe to your email list"));
});

test("'mailing list' → user signup intent", () => {
  assert(detectUserSignupIntent("add me to the mailing list"));
});

test("plain shopping question → no signup intent", () => {
  assert(!detectUserSignupIntent("show me sandals"));
});

test("AI 'subscribe to our newsletter' → mention detected", () => {
  assert(detectAiSignupMention("Subscribe to our newsletter for updates."));
});

test("AI 'join our list' → mention detected", () => {
  assert(detectAiSignupMention("Join our email list."));
});

test("AI plain reply → no signup mention", () => {
  assert(!detectAiSignupMention("Here are some sneakers."));
});

// =====================================================================
section("scrubRoleMarkers");
// =====================================================================

test("strips 'Human:' prefix", () => {
  const r = scrubRoleMarkers("Human: Here's some advice.");
  assert(r.changed, `expected changed`);
  assert(!r.text.includes("Human:"));
});

test("strips 'Assistant:' mid-text", () => {
  const r = scrubRoleMarkers("Hello there. Assistant: more text here.");
  assert(r.changed);
  assert(!r.text.includes("Assistant:"));
});

test("clean text → unchanged", () => {
  const r = scrubRoleMarkers("Plain reply with no leak.");
  assert(!r.changed);
  assert.equal(r.text, "Plain reply with no leak.");
});

test("almost-empty after strip → keeps original", () => {
  const r = scrubRoleMarkers("Human:");
  assert(!r.changed, `should keep original when strip leaves <5 chars`);
  assert.equal(r.text, "Human:");
});

// =====================================================================
section("detectBroadNeed");
// =====================================================================

test("'going on a trip' → broad need", () => assert(detectBroadNeed("going on a trip")));
test("'wedding' → broad need", () => assert(detectBroadNeed("attending a wedding next month")));
test("'gift for my dad' → broad need", () => assert(detectBroadNeed("gift for my dad")));
test("'on my feet all day' → broad need", () => assert(detectBroadNeed("on my feet all day at work")));
test("'help me find' → broad need", () => assert(detectBroadNeed("help me find something nice")));
test("'show me red sandals' → not broad need", () => assert(!detectBroadNeed("show me red sandals")));

// =====================================================================
section("detectAiNoMatchPhrasing");
// =====================================================================

test("'we don't have' → no-match", () => assert(detectAiNoMatchPhrasing("We don't have those in stock.")));
test("'don't carry' → no-match", () => assert(detectAiNoMatchPhrasing("We don't carry that brand.")));
test("'no exact match available' → no-match", () => assert(detectAiNoMatchPhrasing("no exact match available")));
test("plain reply → no no-match", () => assert(!detectAiNoMatchPhrasing("Here are great options for you.")));

// =====================================================================
section("looksLikeClarifyingQuestion");
// =====================================================================

test("ends with '?' → yes", () => assert(looksLikeClarifyingQuestion("What size do you wear?")));
test("question mid-text + last sentence → yes", () => assert(looksLikeClarifyingQuestion("Got it. So what's your arch type?")));
test("no '?' → no", () => assert(!looksLikeClarifyingQuestion("Here are some options.")));
test("empty → no", () => assert(!looksLikeClarifyingQuestion("")));

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
