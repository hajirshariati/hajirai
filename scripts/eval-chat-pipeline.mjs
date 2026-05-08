// Golden-scenario eval for chat.jsx's post-LLM finalize pipeline.
//
// What this is: a SIMULATOR of the cascade chat.jsx applies between
// "LLM finished streaming" and "SSE chunks emitted to widget". It
// imports the same postprocessing modules chat.jsx uses, runs them
// in the same order, and asserts on the final state.
//
// What this catches:
//   - Order-of-operations bugs (e.g. role-marker scrub after
//     stock-claim strip leaves wrong whitespace)
//   - Regressions when ANY module's behavior changes (e.g. a tweak
//     to detectAiPivotPhrasing inadvertently breaks card retention
//     on "we don't have X but here are Y" scenarios)
//   - Cross-module interactions (e.g. yes/no suppression must run
//     AFTER card-pool population, not before)
//
// What this does NOT catch:
//   - Bugs in the LLM streaming/parsing layer (mocked out)
//   - Bugs in the actual SSE write (we just collect intended emits)
//   - Bugs in tool dispatch (mocked out)
//
// Mitigation for drift: this simulator is a REFERENCE implementation
// of chat.jsx's pipeline. If chat.jsx adds a new step, add it here
// too. The scenarios will continue to pass against stale logic, but
// any regression in module-level behavior will surface as a failure.
//
// Run:
//   node scripts/eval-chat-pipeline.mjs

import assert from "node:assert/strict";
import {
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
  detectSingularIntent,
  detectComparisonIntent,
  detectAiPivotPhrasing,
  validateFollowUpSuggestion,
  detectAiNoMatchPhrasing,
  looksLikeClarifyingQuestion,
} from "../app/lib/chat-postprocessing.js";

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
// Pipeline simulator
// =====================================================================
//
// Mirrors the post-LLM portion of chat.jsx::runAgenticLoop. Reads:
//   - `text`             the assistant text (already streamed)
//   - `pool`             card pool (post-search, pre-finalize)
//   - `userMessage`      latest user message
//   - `toolsCalledThisTurn` Set of tool names invoked this turn
//   - `suggestions`      candidate follow-up questions
//
// Returns:
//   - `text`             text after all strips
//   - `pool`             pool after all suppression rules
//   - `suggestions`      kept suggestions
//   - `emitKlaviyoForm`  whether SSE klaviyo_form would emit
//
// Steps applied (mirrors chat.jsx order):
//   1. strip rejected-category chips (customer said "no boots")
//   2. strip tool-call syntax (if any leaked)
//   3. strip stock-claim hallucination (if get_product_details
//      wasn't called)
//   4. scrub role markers ("Human:" / "Assistant:" leaks)
//   5. apply pivot/no-match logic to determine effective denial
//   6. yes/no suppression (collapse pool when both Q and A are
//      yes/no-shaped)
//   7. singular-narrow (when customer asked about ONE item, narrow
//      to 1 card unless comparison intent)
//   8. validate suggestions against reply text
//   9. compute klaviyo signup flag
function runPipeline(input) {
  let text = String(input.text || "");
  const pool = Array.isArray(input.pool) ? [...input.pool] : [];
  const userMessage = String(input.userMessage || "");
  const toolsCalledThisTurn = input.toolsCalledThisTurn || new Set();
  const suggestionsIn = Array.isArray(input.suggestions) ? input.suggestions : [];

  // 1. Customer-rejected category chip strip
  const rejected = detectRejectedCategories(userMessage);
  if (rejected.size > 0) {
    text = stripRejectedCategoryChips(text, rejected).text;
  }

  // 2. Tool-call syntax strip
  text = stripToolCallSyntax(text);

  // 3. Stock-claim hallucination
  if (text && !toolsCalledThisTurn.has("get_product_details") && detectStockClaim(text)) {
    text = stripStockClaim(text);
  }

  // 4. Role-marker scrub
  if (text) {
    const r = scrubRoleMarkers(text);
    if (r.changed) text = r.text;
  }

  // 5. Pivot vs no-match — caller decides whether to suppress pool.
  const saysNoMatch = detectAiNoMatchPhrasing(text);
  const aiPivotsOrPresents = detectAiPivotPhrasing(text);
  const effectiveSaysNoMatch = saysNoMatch && !aiPivotsOrPresents;

  // 6. Yes/no suppression
  if (pool.length > 0 && text && isYesNoQuestion(userMessage) && isYesNoAnswer(text)) {
    pool.length = 0;
  }

  // 7. Singular-narrow
  // Comparison overrides singular (handled inside detectSingularIntent).
  // When singular is detected and pool > 1, narrow to first card.
  if (pool.length > 1 && detectSingularIntent(userMessage)) {
    pool.splice(1);
  }

  // 8. Suggestion validation
  const suggestions = suggestionsIn.filter((s) => {
    const r = validateFollowUpSuggestion(s, text);
    return r.allowed;
  });

  // 9. Klaviyo signup flag
  const emitKlaviyoForm = detectUserSignupIntent(userMessage) || detectAiSignupMention(text);

  return {
    text,
    pool,
    suggestions,
    emitKlaviyoForm,
    flags: {
      saysNoMatch,
      aiPivotsOrPresents,
      effectiveSaysNoMatch,
      isYesNoExchange: isYesNoQuestion(userMessage) && isYesNoAnswer(text),
      isSingularIntent: detectSingularIntent(userMessage),
      isComparison: detectComparisonIntent(userMessage),
      isClarifyingQuestion: looksLikeClarifyingQuestion(text),
    },
  };
}

// =====================================================================
section("Tool-call syntax leak");
// =====================================================================

test("LLM leaks <function_calls> tag → stripped", () => {
  const r = runPipeline({
    text: "<function_calls>foo</function_calls>Here are some sneakers.",
    userMessage: "show me sneakers",
    pool: [{ id: 1, title: "Sneaker A" }],
  });
  assert(!r.text.includes("function_calls"), `got: ${r.text}`);
  assert(r.text.includes("Here are"));
});

test("LLM narrates 'search_products {...}' → stripped", () => {
  const r = runPipeline({
    text: `search_products {"q":"sandals"} Found great matches.`,
    userMessage: "sandals please",
    pool: [],
  });
  assert(!r.text.includes("search_products"), `got: ${r.text}`);
});

// =====================================================================
section("Stock-claim hallucination guard");
// =====================================================================

test("'available in size 9' WITHOUT get_product_details → stripped + deferral added", () => {
  const r = runPipeline({
    text: "Yes — currently available in size 9 wide.",
    userMessage: "do you have these in size 9 wide?",
    pool: [{ id: 1 }],
    toolsCalledThisTurn: new Set([]),
  });
  assert(!/available in size/.test(r.text), `claim still present: ${r.text}`);
  assert(/can't check live stock/.test(r.text), `deferral missing: ${r.text}`);
});

test("'available in size 9' WITH get_product_details → claim passes through", () => {
  const r = runPipeline({
    text: "Yes — currently available in size 9 wide.",
    userMessage: "do you have these in size 9?",
    pool: [{ id: 1 }],
    toolsCalledThisTurn: new Set(["get_product_details"]),
  });
  assert(r.text.includes("size 9 wide"), `claim was stripped: ${r.text}`);
});

// =====================================================================
section("Role-marker leak");
// =====================================================================

test("'Human:' prefix leak → stripped", () => {
  const r = runPipeline({
    text: "Human: Sure, here are some good options for plantar fasciitis.",
    userMessage: "options for plantar fasciitis",
    pool: [{ id: 1 }],
  });
  assert(!r.text.includes("Human:"), `got: ${r.text}`);
  assert(r.text.length > 5);
});

test("Just 'Human:' (no content) → keep original (defensive)", () => {
  const r = runPipeline({
    text: "Human:",
    userMessage: "hi",
    pool: [],
  });
  assert.equal(r.text, "Human:", `should keep original; got: ${r.text}`);
});

// =====================================================================
section("Yes/no suppression");
// =====================================================================

test("Yes/no Q + Yes/no A + pool > 0 → pool suppressed", () => {
  const r = runPipeline({
    text: "Yes — these have arch support.",
    userMessage: "do these have arch support?",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
  });
  assert.equal(r.pool.length, 0, `expected pool suppressed, got ${r.pool.length}`);
  assert(r.flags.isYesNoExchange);
});

test("Yes/no Q + non-Y/N A → pool kept", () => {
  const r = runPipeline({
    text: "Here are some options that should help with arch support.",
    userMessage: "do these have arch support?",
    pool: [{ id: 1 }, { id: 2 }],
  });
  assert.equal(r.pool.length, 2);
});

test("WH-question + Y/N A → pool kept", () => {
  const r = runPipeline({
    text: "Yes, those are great options.",
    userMessage: "what should I get for plantar fasciitis?",
    pool: [{ id: 1 }, { id: 2 }],
  });
  assert.equal(r.pool.length, 2, `WH-question should not trigger suppression`);
});

// =====================================================================
section("Singular-narrow");
// =====================================================================

test("'tell me about this one' + 6 cards → narrow to 1", () => {
  const r = runPipeline({
    text: "Sure, that one's a comfortable everyday sandal.",
    userMessage: "tell me about this one",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
  });
  assert.equal(r.pool.length, 1);
});

test("'compare X and Y' + 6 cards → keep all (comparison)", () => {
  const r = runPipeline({
    text: "Both are great picks. Side-by-side: X has more arch, Y is wider.",
    userMessage: "compare the L1 and L2",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
  });
  assert.equal(r.pool.length, 6, `comparison should not narrow; got ${r.pool.length}`);
});

test("'how about for women' (category pivot, NOT singular) → keep all", () => {
  const r = runPipeline({
    text: "Here are women's options.",
    userMessage: "how about for women",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
  });
  assert.equal(r.pool.length, 6, `'how about for women' is a pivot, not singular; got ${r.pool.length}`);
});

test("'show me sneakers' (plural browse) → keep all", () => {
  const r = runPipeline({
    text: "Here are some sneakers.",
    userMessage: "show me sneakers",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
  });
  assert.equal(r.pool.length, 6);
});

// =====================================================================
section("Pivot phrasing prevents false-denial card suppression");
// =====================================================================

test("'we don't have X, but all of these...' → pivot detected, NOT effective denial", () => {
  const r = runPipeline({
    text: "We don't have an exact yellow option, but all of these sandals are tagged for bunions.",
    userMessage: "yellow sandals for bunions",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  assert(r.flags.saysNoMatch, "should detect 'we don't have' phrasing");
  assert(r.flags.aiPivotsOrPresents, "should detect pivot");
  assert(!r.flags.effectiveSaysNoMatch, "pivot should override denial");
});

test("'we don't have any in your size' (denial, no pivot) → effective denial", () => {
  const r = runPipeline({
    text: "We don't have any in your size.",
    userMessage: "size 12 wide",
    pool: [],
  });
  assert(r.flags.saysNoMatch);
  assert(!r.flags.aiPivotsOrPresents);
  assert(r.flags.effectiveSaysNoMatch);
});

test("'closest options for you' → near-match phrasing, NOT effective denial", () => {
  const r = runPipeline({
    text: "Here are our closest options for you.",
    userMessage: "wide running sneakers",
    pool: [{ id: 1 }],
  });
  assert(r.flags.aiPivotsOrPresents, "near-match should count as pivot/present");
});

// =====================================================================
section("Customer-rejected categories");
// =====================================================================

test("'no boots' → <<Boots>> chip stripped from reply", () => {
  const r = runPipeline({
    text: "Sure! How about <<Boots>> or <<Sneakers>>?",
    userMessage: "I'm shopping for shoes but no boots",
    pool: [],
  });
  assert(!r.text.includes("<<Boots>>"), `boots should be stripped, got: ${r.text}`);
  assert(r.text.includes("<<Sneakers>>"));
});

test("'doesn't like shoes' → all footwear chips stripped", () => {
  const r = runPipeline({
    text: "Try these: <<Sandals>> <<Sneakers>> <<Loafers>>",
    userMessage: "she doesn't like shoes",
    pool: [],
  });
  assert(!r.text.includes("<<Sandals>>"));
  assert(!r.text.includes("<<Sneakers>>"));
  assert(!r.text.includes("<<Loafers>>"));
});

// =====================================================================
section("Klaviyo signup CTA");
// =====================================================================

test("user asks 'sign up for newsletter' → klaviyo flag emitted", () => {
  const r = runPipeline({
    text: "Sure, I can help with that.",
    userMessage: "How do I sign up for your newsletter?",
    pool: [],
  });
  assert(r.emitKlaviyoForm);
});

test("AI mentions 'subscribe to our newsletter' → klaviyo flag emitted", () => {
  const r = runPipeline({
    text: "Subscribe to our newsletter for updates.",
    userMessage: "any deals?",
    pool: [],
  });
  assert(r.emitKlaviyoForm);
});

test("plain shopping turn → no klaviyo flag", () => {
  const r = runPipeline({
    text: "Here are some sneakers for you.",
    userMessage: "show me sneakers",
    pool: [{ id: 1 }],
  });
  assert(!r.emitKlaviyoForm);
});

// =====================================================================
section("Suggestion validation");
// =====================================================================

test("plain follow-up → kept", () => {
  const r = runPipeline({
    text: "Here are sneakers.",
    userMessage: "sneakers",
    pool: [{ id: 1 }],
    suggestions: ["Do you have wider widths?", "Any other colors?"],
  });
  assert.equal(r.suggestions.length, 2);
});

test("'tell me about UltraSKY' (tech term not in reply) → blocked", () => {
  const r = runPipeline({
    text: "Here are sneakers.",
    userMessage: "sneakers",
    pool: [{ id: 1 }],
    suggestions: ["Tell me about UltraSKY foam", "Do you have wider widths?"],
  });
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0], "Do you have wider widths?");
});

test("'tell me about UltraSKY' (term IS in reply) → kept", () => {
  const r = runPipeline({
    text: "These sneakers feature UltraSKY cushioning for shock absorption.",
    userMessage: "sneakers",
    pool: [{ id: 1 }],
    suggestions: ["Tell me about UltraSKY foam"],
  });
  assert.equal(r.suggestions.length, 1);
});

test("'how does the technology work' → blocked (deepdive)", () => {
  const r = runPipeline({
    text: "Here are sneakers.",
    userMessage: "sneakers",
    pool: [{ id: 1 }],
    suggestions: ["How does the foam technology work?"],
  });
  assert.equal(r.suggestions.length, 0);
});

// =====================================================================
section("Composite scenarios (multiple steps interact)");
// =====================================================================

test("LLM leaks tool-call AND role-marker simultaneously", () => {
  const r = runPipeline({
    text: "Human: <function_calls>x</function_calls>Here are sandals.",
    userMessage: "sandals",
    pool: [{ id: 1 }],
  });
  assert(!r.text.includes("function_calls"));
  assert(!r.text.includes("Human:"));
  assert(r.text.includes("sandals"));
});

test("Pivot phrase + yes/no suppression doesn't double-trigger", () => {
  // Customer asked yes/no, AI said "we don't have but here are...", and
  // YES was the opener. Pivot phrasing keeps the cards usable, but the
  // yes/no rule still suppresses pool because the Q+A shape matches.
  // Neither should clobber the other unexpectedly.
  const r = runPipeline({
    text: "Yes — we don't have an exact yellow, but all of these sandals are bunion-friendly.",
    userMessage: "do you have yellow sandals?",
    pool: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  assert.equal(r.pool.length, 0, "yes/no Q+A still triggers — pool suppressed");
  assert(r.flags.aiPivotsOrPresents, "pivot still detected for downstream guards");
});

test("Singular intent + comparison doesn't narrow", () => {
  const r = runPipeline({
    text: "Side-by-side: L1 has more arch, L2 is wider.",
    userMessage: "what's the difference between the L1 and L2?",
    pool: [{ id: 1 }, { id: 2 }],
  });
  assert.equal(r.pool.length, 2);
});

test("Stock-claim AND role-marker leak together", () => {
  const r = runPipeline({
    text: "Human: Yes — currently available in size 9 wide.",
    userMessage: "do you have size 9 wide?",
    pool: [],
    toolsCalledThisTurn: new Set([]),
  });
  assert(!r.text.includes("Human:"));
  assert(!/available in size/.test(r.text));
  assert(/can't check live stock/.test(r.text));
});

test("Customer says 'no orthotics — do you have boots?' → pool kept (Y/N regex requires aux at START)", () => {
  // The message has yes/no shape SEMANTICALLY but doesn't START with a
  // yes/no auxiliary verb ("no orthotics —" comes first). Our regex is
  // conservative on purpose: requiring start-anchored auxiliary keeps
  // false-positive suppressions rare. Pool stays.
  const r = runPipeline({
    text: "Yes — <<Boots>> are a great option.",
    userMessage: "no orthotics — do you have boots?",
    pool: [{ id: 1 }, { id: 2 }],
  });
  assert.equal(r.pool.length, 2, "Y/N regex requires sentence-start aux, so suppression doesn't fire");
  assert(!r.flags.isYesNoExchange, "should not be flagged as Y/N exchange");
});

test("Empty text + no pool → all flags neutral", () => {
  const r = runPipeline({ text: "", userMessage: "hi", pool: [] });
  assert.equal(r.text, "");
  assert.equal(r.pool.length, 0);
  assert(!r.emitKlaviyoForm);
  assert(!r.flags.saysNoMatch);
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
