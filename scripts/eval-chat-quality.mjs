import assert from "node:assert/strict";
import {
  detectGenderFromHistory,
  stripBannedNarration,
  stripMetaNarration,
  looksLikeProductPitch,
  looksLikeDefinitionalHallucination,
  normalizeGenderChipAnswer,
  hasChoiceButtons,
  dedupeConsecutiveSentences,
  isSingularPrescriptive,
} from "../app/lib/chat-helpers.server.js";
import { filterContradictingGenderChips } from "../app/lib/chip-filter.server.js";
import {
  forceComparisonLookup,
  stripStaleCategoriesOnScopeReset,
  injectStructuredColorFilter,
  injectLockedGender,
  rewriteToolCall,
  isPrecededByNegation,
} from "../app/lib/chat-tool-rewrite.server.js";
import {
  withAnthropicRetry,
  classifyAnthropicError,
} from "../app/lib/anthropic-resilience.server.js";

const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

const cases = [];

// ── detectGenderFromHistory ─────────────────────────────────
cases.push({
  name: "user pivot 'wife' beats earlier assistant 'men's'",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("men's running shoes"),
      a("Here are some men's running shoes!"),
      u("actually for my wife"),
    ]),
    "women",
  ),
});

cases.push({
  name: "single user 'men's' returns men",
  run: () => assert.equal(
    detectGenderFromHistory([u("show me men's sneakers")]),
    "men",
  ),
});

cases.push({
  name: "no user gender → null (assistant text is never a gender source)",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("foot pain"),
      a("Here are some men's options."),
    ]),
    null,
  ),
});

cases.push({
  name: "assistant 'men's or women's?' question never sets gender",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("foot pain"),
      a("Are these for men's or women's?"),
    ]),
    null,
  ),
});

cases.push({
  name: "post-pivot: assistant echoes old gender, latest user is new — new wins",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("show me men's sneakers"),
      a("Here are some men's sneakers!"),
      u("Actually I need this for me, I'm a woman"),
      a("Got it, switching to women's."),
      u("yes please"),
    ]),
    "women",
  ),
});

cases.push({
  name: "long pivot chain: 5 turns of assistant echo can't override user pivot",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("men's running shoes"),
      a("Great choice — here are some men's options."),
      u("show me more"),
      a("More men's running shoes coming up."),
      u("actually for my wife"),
      a("Switching to women's options."),
      u("show me more"),
      a("Here are more women's options."),
      u("any in pink?"),
    ]),
    "women",
  ),
});

cases.push({
  name: "user 'dad' → men, even if next assistant says 'women's'",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("for my dad"),
      a("Got it, women's options coming up."),
    ]),
    "men",
  ),
});

cases.push({
  name: "empty history returns null",
  run: () => assert.equal(detectGenderFromHistory([]), null),
});

// ── stripBannedNarration ────────────────────────────────────
cases.push({
  name: "strips 'let me look that up now'",
  run: () => assert.equal(
    stripBannedNarration("Got it. Let me look that up now."),
    "Got it.",
  ),
});

cases.push({
  name: "strips 'one moment' and 'I'll find'",
  run: () => assert.match(
    stripBannedNarration("One moment! I'll find some great options."),
    /^(some great options\.?|)$/i,
  ),
});

cases.push({
  name: "leaves clean text untouched",
  run: () => assert.equal(
    stripBannedNarration("Here are some great picks for arch support."),
    "Here are some great picks for arch support.",
  ),
});

cases.push({
  name: "strips multiple narration phrases in same reply",
  run: () => {
    const out = stripBannedNarration("Hold on. Let me search the catalog.");
    assert.ok(!/let me|hold on/i.test(out), `still narration in: "${out}"`);
  },
});

// ── looksLikeProductPitch ───────────────────────────────────
cases.push({
  name: "'the perfect match is X' is a pitch",
  run: () => assert.equal(
    looksLikeProductPitch("the perfect match is an Aetrex Orthotic"),
    true,
  ),
});

cases.push({
  name: "'here are some great picks' is a pitch",
  run: () => assert.equal(
    looksLikeProductPitch("Here are some great picks for arch support."),
    true,
  ),
});

cases.push({
  name: "'let me look that up' counts as pitch (placeholder for cards)",
  run: () => assert.equal(
    looksLikeProductPitch("Let me look that up now."),
    true,
  ),
});

cases.push({
  name: "clarifying question is NOT a pitch",
  run: () => assert.equal(
    looksLikeProductPitch("Where is your dad's foot pain located?"),
    false,
  ),
});

cases.push({
  name: "'thanks for waiting' is NOT a pitch",
  run: () => assert.equal(
    looksLikeProductPitch("Thanks! Glad I could help."),
    false,
  ),
});

// ── normalizeGenderChipAnswer ────────────────────────────────
cases.push({
  name: "'Men's & Boys'' → men",
  run: () => assert.equal(normalizeGenderChipAnswer("Men's & Boys'"), "men"),
});

cases.push({
  name: "'Women's, Girls' → women",
  run: () => assert.equal(normalizeGenderChipAnswer("Women's, Girls"), "women"),
});

cases.push({
  name: "'Men's' singular → men",
  run: () => assert.equal(normalizeGenderChipAnswer("Men's"), "men"),
});

cases.push({
  name: "'Boys' alone → men",
  run: () => assert.equal(normalizeGenderChipAnswer("Boys"), "men"),
});

cases.push({
  name: "'Girls' alone → women",
  run: () => assert.equal(normalizeGenderChipAnswer("Girls"), "women"),
});

cases.push({
  name: "'unisex' → null (no gender filter)",
  run: () => assert.equal(normalizeGenderChipAnswer("Unisex"), null),
});

cases.push({
  name: "empty string → null",
  run: () => assert.equal(normalizeGenderChipAnswer(""), null),
});

cases.push({
  name: "'men + boys' (plus separator) → men",
  run: () => assert.equal(normalizeGenderChipAnswer("men + boys"), "men"),
});

// ── synthetic gender-answered injection ────────────────────────────
// Mirror the logic from chat.jsx — given a detected gender and a list
// of answered choices, the prompt should end up with a gender entry.
function injectSyntheticGender(detectedGender, answeredChoices) {
  const out = [...(answeredChoices || [])];
  if (!detectedGender) return out;
  const alreadyHasGender = out.some((c) =>
    /\b(men|women|gender|him|her|man|woman)\b/i.test(c.question || "") ||
    /\b(men|women|men's|women's)\b/i.test(c.answer || "")
  );
  if (alreadyHasGender) return out;
  out.unshift({
    question: "Are these for men's or women's?",
    answer: detectedGender === "men" ? "Men's" : "Women's",
    rawAnswer: detectedGender === "men" ? "Men's" : "Women's",
    options: ["Men's", "Women's"],
  });
  return out;
}

cases.push({
  name: "gender from 'dad' synthesizes Men's answered-choice",
  run: () => {
    const detected = detectGenderFromHistory([u("for my dad")]);
    const out = injectSyntheticGender(detected, []);
    assert.equal(out.length, 1);
    assert.equal(out[0].answer, "Men's");
  },
});

cases.push({
  name: "gender from 'wife' synthesizes Women's answered-choice",
  run: () => {
    const detected = detectGenderFromHistory([u("for my wife")]);
    const out = injectSyntheticGender(detected, []);
    assert.equal(out[0].answer, "Women's");
  },
});

cases.push({
  name: "doesn't double-add when chip already answered gender",
  run: () => {
    const existing = [{
      question: "Which styles? <<Men's>><<Women's>>",
      answer: "Men's",
      rawAnswer: "Men's",
      options: ["Men's", "Women's"],
    }];
    const detected = detectGenderFromHistory([u("for my dad")]);
    const out = injectSyntheticGender(detected, existing);
    assert.equal(out.length, 1, "should not duplicate");
  },
});

cases.push({
  name: "no gender detected → answeredChoices unchanged",
  run: () => {
    const out = injectSyntheticGender(null, []);
    assert.equal(out.length, 0);
  },
});

// ── hasChoiceButtons ─────────────────────────────────────────
cases.push({
  name: "detects choice buttons in text",
  run: () => assert.equal(
    hasChoiceButtons("Pick one: <<Red>><<Blue>>"),
    true,
  ),
});

cases.push({
  name: "no buttons → false",
  run: () => assert.equal(hasChoiceButtons("Here are some sneakers!"), false),
});

cases.push({
  name: "empty text → false",
  run: () => assert.equal(hasChoiceButtons(""), false),
});

// ── stripMetaNarration ───────────────────────────────────────
cases.push({
  name: "strips full meta-preamble + we-know dump from screenshot bug",
  run: () => {
    const input = "Since the customer already established Men's via the choice button at the top, and we know: orthotic insert, ball of foot pain, cleats — The Unisex Cleats with Metatarsal Support is the go-to pick for ball-of-foot pain in soccer, football, or baseball cleats.";
    const out = stripMetaNarration(input);
    assert.match(out, /^The Unisex Cleats with Metatarsal Support/);
    assert.ok(!/the customer/i.test(out), `still has "the customer": ${out}`);
    assert.ok(!/we know:?/i.test(out), `still has "we know": ${out}`);
  },
});

cases.push({
  name: "strips 'Given that the user has chosen X' preamble",
  run: () => {
    const input = "Given that the user has chosen running shoes, the Speed line is the recommendation.";
    const out = stripMetaNarration(input);
    assert.match(out, /^the Speed line is the recommendation/i);
  },
});

cases.push({
  name: "replaces 'the customer' mid-sentence with 'you'",
  run: () => {
    const out = stripMetaNarration("The customer has foot pain so this orthotic helps.");
    assert.match(out, /^you/i);
    assert.ok(!/the customer/i.test(out));
  },
});

cases.push({
  name: "leaves 'since you have foot pain' alone (legit second-person)",
  run: () => {
    const input = "Since you have foot pain, the Speed orthotic is a great match.";
    const out = stripMetaNarration(input);
    assert.equal(out, input);
  },
});

cases.push({
  name: "leaves a clean reply unchanged",
  run: () => {
    const input = "Here's the L1205 — built for cleats with metatarsal support.";
    const out = stripMetaNarration(input);
    assert.equal(out, input);
  },
});

// ── looksLikeDefinitionalHallucination ────────────────────────────
cases.push({
  name: "'Lynco is our premium orthotic line' is definitional hallucination",
  run: () => assert.equal(
    looksLikeDefinitionalHallucination("Lynco is our premium orthotic line that uses memory foam."),
    true,
  ),
});

cases.push({
  name: "'UltraSKY is our advanced technology' is definitional hallucination",
  run: () => assert.equal(
    looksLikeDefinitionalHallucination("UltraSKY is our advanced technology used in select shoes."),
    true,
  ),
});

cases.push({
  name: "regular product description is NOT definitional hallucination",
  run: () => assert.equal(
    looksLikeDefinitionalHallucination("Speed Orthotics offer support for runners."),
    false,
  ),
});

cases.push({
  name: "clarifying question is NOT definitional hallucination",
  run: () => assert.equal(
    looksLikeDefinitionalHallucination("Could you tell me more about what you're looking for?"),
    false,
  ),
});

// ── dedupeConsecutiveSentences ─────────────────────────────────
cases.push({
  name: "dedupes back-to-back 'Here are some great' echo openers",
  run: () => {
    const input = "Here are some great men's casual orthotics designed for everyday support and comfort. Here are some great men's casual orthotics built for everyday support and all-day comfort.";
    const out = dedupeConsecutiveSentences(input);
    const matches = out.match(/Here are some great/g);
    assert.equal(matches?.length, 1, `expected one occurrence of opener, got ${matches?.length}: ${out}`);
  },
});

cases.push({
  name: "leaves distinct sentences alone",
  run: () => {
    const input = "Here are some great picks for arch support. Each is built for all-day comfort.";
    const out = dedupeConsecutiveSentences(input);
    assert.equal(out, input);
  },
});

cases.push({
  name: "doesn't drop a sentence that just shares a single word",
  run: () => {
    const input = "I recommend the L700. The L720 also works well.";
    const out = dedupeConsecutiveSentences(input);
    assert.equal(out, input);
  },
});

cases.push({
  name: "empty / single-sentence input untouched",
  run: () => {
    assert.equal(dedupeConsecutiveSentences(""), "");
    assert.equal(dedupeConsecutiveSentences("Just one sentence."), "Just one sentence.");
  },
});

cases.push({
  name: "dedupes paraphrased sentences (semantic repetition)",
  run: () => {
    const input = "The standard version provides general cushioning and arch support for kids with no specific discomfort, while the posted version adds extra reinforcement at the heel and arch — best when a child has arch or heel pain. The standard Kids Orthotics offer cushioning and arch support for everyday active kids with no specific discomfort, while the Posted version adds extra heel and arch reinforcement — ideal if your child experiences arch or heel pain.";
    const out = dedupeConsecutiveSentences(input);
    // Should drop the second sentence — they share too many significant words.
    const occurrences = out.match(/standard/gi) || [];
    assert.ok(occurrences.length <= 1, `expected at most 1 'standard', got ${occurrences.length}: ${out}`);
  },
});

cases.push({
  name: "keeps two sentences with low content overlap",
  run: () => {
    const input = "The Speed Orthotic targets running shoes specifically. Pricing starts at $69.95.";
    const out = dedupeConsecutiveSentences(input);
    assert.equal(out, input, `should preserve unrelated sentences: ${out}`);
  },
});

cases.push({
  name: "keeps short sentences even if they share generic words",
  run: () => {
    const input = "Got it. Got the size.";
    const out = dedupeConsecutiveSentences(input);
    // Both very short — content-overlap rule shouldn't fire (size threshold)
    assert.equal(out, input);
  },
});

cases.push({
  name: "strips 'i need to pull up' narration",
  run: () => assert.match(
    stripBannedNarration("I need to pull up the Carly first to match you."),
    /^(?:to match you\.?|)$/i,
  ),
});

cases.push({
  name: "strips 'let me get the details' narration",
  run: () => {
    const out = stripBannedNarration("Let me get the details for the Jillian.");
    assert.ok(!/let me get the details/i.test(out), `still has narration: ${out}`);
  },
});

// ── filterContradictingGenderChips ───────────────────────────────
const aetrexMap = {
  boots: { display: "Boots", genders: ["women"] },
  "mary janes": { display: "Mary Janes", genders: ["women"] },
  loafers: { display: "Loafers", genders: ["women"] },
  oxfords: { display: "Oxfords", genders: ["women"] },
  slippers: { display: "Slippers", genders: ["women"] },
  "wedges heels": { display: "Wedges Heels", genders: ["women"] },
  sneakers: { display: "Sneakers", genders: ["men", "women"] },
  sandals: { display: "Sandals", genders: ["men", "women"] },
  clogs: { display: "Clogs", genders: ["men", "women"] },
  cleats: { display: "Cleats", genders: ["unisex"] },
};

cases.push({
  name: "strips Men's chip when user mentioned boots (women-only)",
  run: () => {
    const out = filterContradictingGenderChips(
      "Which styles? <<Men's>><<Women's>>",
      "Can you show me your boots with memory foam?",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, ["Men's"]);
    assert.match(out.text, /<<Women's>>/);
    assert.ok(!/<<Men's>>/.test(out.text), `Men's should be gone: ${out.text}`);
  },
});

cases.push({
  name: "strips Men's chip when user mentioned wedges (women-only)",
  run: () => {
    const out = filterContradictingGenderChips(
      "Pick one: <<Men's>><<Women's>>",
      "I want some wedges",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, ["Men's"]);
  },
});

cases.push({
  name: "keeps both chips when user mentioned sneakers (multi-gender)",
  run: () => {
    const out = filterContradictingGenderChips(
      "Which styles? <<Men's>><<Women's>>",
      "I want sneakers",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, []);
    assert.match(out.text, /<<Men's>>/);
    assert.match(out.text, /<<Women's>>/);
  },
});

cases.push({
  name: "keeps both chips when user mentioned no category",
  run: () => {
    const out = filterContradictingGenderChips(
      "Which styles? <<Men's>><<Women's>>",
      "I have foot pain",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, []);
    assert.match(out.text, /<<Men's>>/);
    assert.match(out.text, /<<Women's>>/);
  },
});

cases.push({
  name: "keeps both chips for cleats (unisex satisfies both)",
  run: () => {
    const out = filterContradictingGenderChips(
      "Which styles? <<Men's>><<Women's>>",
      "I need cleats orthotics",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, []);
  },
});

cases.push({
  name: "keeps both chips when user mentioned BOTH boots AND sandals",
  run: () => {
    // Sandals supports men's, so Men's chip stays even though boots doesn't.
    const out = filterContradictingGenderChips(
      "Pick: <<Men's>><<Women's>>",
      "I want boots or sandals",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, []);
  },
});

cases.push({
  name: "strips 'Boys' chip on women-only category",
  run: () => {
    const out = filterContradictingGenderChips(
      "Pick: <<Boys>><<Girls>>",
      "I want loafers",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, ["Boys"]);
  },
});

cases.push({
  name: "leaves non-gender chips alone (e.g. <<Running>><<Casual>>)",
  run: () => {
    const out = filterContradictingGenderChips(
      "Which use case? <<Running>><<Casual>><<Dress>>",
      "I want boots",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, []);
    assert.match(out.text, /<<Running>>/);
    assert.match(out.text, /<<Casual>>/);
    assert.match(out.text, /<<Dress>>/);
  },
});

cases.push({
  name: "noop when categoryGenderMap empty",
  run: () => {
    const out = filterContradictingGenderChips(
      "Pick: <<Men's>><<Women's>>",
      "I want boots",
      {},
    );
    assert.deepEqual(out.stripped, []);
  },
});

cases.push({
  name: "noop when conversationText empty",
  run: () => {
    const out = filterContradictingGenderChips(
      "Pick: <<Men's>><<Women's>>",
      "",
      aetrexMap,
    );
    assert.deepEqual(out.stripped, []);
  },
});

// ── isSingularPrescriptive ────────────────────────────────────
cases.push({
  name: "'is the right pick' is singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("the standard Kids Orthotics is the right pick"),
    true,
  ),
});

cases.push({
  name: "'is the go-to pick' is singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("The Unisex Cleats with Metatarsal Support is the go-to pick"),
    true,
  ),
});

cases.push({
  name: "'is a great choice' is singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("The Speed Orthotic is a great choice for runners"),
    true,
  ),
});

cases.push({
  name: "'I'd recommend' is singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("I'd recommend the Conform line for diabetic feet"),
    true,
  ),
});

cases.push({
  name: "'is the best match' (existing pattern) still works",
  run: () => assert.equal(
    isSingularPrescriptive("the L700 is your best match"),
    true,
  ),
});

cases.push({
  name: "'is the perfect option' is singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("This insole is the perfect option for your needs"),
    true,
  ),
});

cases.push({
  name: "'would be a great pick' is singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("The Speed Orthotic would be a great pick for marathon training"),
    true,
  ),
});

cases.push({
  name: "'here are some options' is NOT singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("Here are some great men's casual orthotics."),
    false,
  ),
});

cases.push({
  name: "clarifying question is NOT singular-prescriptive",
  run: () => assert.equal(
    isSingularPrescriptive("Are these for men's or women's?"),
    false,
  ),
});

cases.push({
  name: "empty/null input safe",
  run: () => {
    assert.equal(isSingularPrescriptive(""), false);
    assert.equal(isSingularPrescriptive(null), false);
    assert.equal(isSingularPrescriptive(undefined), false);
  },
});

// ── tool-call rewrite pipeline ──────────────────────────────────
// These are the production safety net — they run between the AI's tool
// emission and dispatch. AI compliance becomes irrelevant when the
// rewrite catches the mismatch.

const search = (input) => ({ name: "search_products", input });
const lookup = (input) => ({ name: "lookup_sku", input });
const findSimilar = (input) => ({ name: "find_similar_products", input });

// injectLockedGender ──────────────────────────────────────
cases.push({
  name: "gender-lock: injects gender when AI omitted it",
  run: () => {
    const out = injectLockedGender(
      search({ query: "running shoes", filters: {} }),
      { sessionGender: "women" },
    );
    assert.equal(out.input.filters.gender, "women");
  },
});

cases.push({
  name: "gender-lock: overrides AI's stale gender on pivot",
  run: () => {
    // Customer pivoted to women but AI's tool call still says men.
    const out = injectLockedGender(
      search({ query: "sneakers", filters: { gender: "men" } }),
      { sessionGender: "women" },
    );
    assert.equal(out.input.filters.gender, "women");
  },
});

cases.push({
  name: "gender-lock: leaves matching filter alone",
  run: () => {
    const input = search({ query: "x", filters: { gender: "women" } });
    const out = injectLockedGender(input, { sessionGender: "women" });
    assert.equal(out, input); // identity = no rewrite
  },
});

cases.push({
  name: "gender-lock: no-op when no session gender",
  run: () => {
    const input = search({ query: "x", filters: {} });
    const out = injectLockedGender(input, { sessionGender: null });
    assert.equal(out, input);
  },
});

cases.push({
  name: "gender-lock: applies to find_similar_products",
  run: () => {
    const out = injectLockedGender(
      findSimilar({ handle: "x", filters: {} }),
      { sessionGender: "men" },
    );
    assert.equal(out.input.filters.gender, "men");
  },
});

cases.push({
  name: "gender-lock: skips lookup_sku (handle-specific tools)",
  run: () => {
    const input = lookup({ skus: ["L700"] });
    const out = injectLockedGender(input, { sessionGender: "women" });
    assert.equal(out, input);
  },
});

// forceComparisonLookup ─────────────────────────────────────
cases.push({
  name: "comparison-routing: 2 SKUs + 'compare' → lookup_sku",
  run: () => {
    const out = forceComparisonLookup(
      search({ query: "L700 vs L701" }),
      { latestUserMessage: "compare L700 and L701 for me" },
    );
    assert.equal(out.name, "lookup_sku");
    assert.deepEqual(out.input.skus, ["L700", "L701"]);
  },
});

cases.push({
  name: "comparison-routing: 'between X and Y' triggers",
  run: () => {
    const out = forceComparisonLookup(
      search({ query: "x" }),
      { latestUserMessage: "what's the difference between L700M and L701W" },
    );
    assert.equal(out.name, "lookup_sku");
    assert.equal(out.input.skus.length, 2);
  },
});

cases.push({
  name: "comparison-routing: only 1 SKU → no rewrite",
  run: () => {
    const input = search({ query: "x" });
    const out = forceComparisonLookup(input, {
      latestUserMessage: "is L700 better than the others?",
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "comparison-routing: 2 SKUs without comparison verb → no rewrite",
  run: () => {
    const input = search({ query: "x" });
    const out = forceComparisonLookup(input, {
      latestUserMessage: "show me L700 and L701",
    });
    assert.equal(out, input);
  },
});

// injectStructuredColorFilter ──────────────────────────────────
cases.push({
  name: "color-inject: detects merchant-tagged color in user text",
  run: () => {
    const out = injectStructuredColorFilter(
      search({ query: "sneakers" }),
      {
        latestUserMessage: "do you have these in red?",
        _merchantColors: ["red", "blue", "black"],
      },
    );
    assert.equal(out.input.filters.color, "red");
  },
});

cases.push({
  name: "color-inject: longest-match wins (hunter green > green)",
  run: () => {
    const out = injectStructuredColorFilter(
      search({ query: "shoes" }),
      {
        latestUserMessage: "any in hunter green?",
        _merchantColors: ["green", "hunter green", "blue"],
      },
    );
    assert.equal(out.input.filters.color, "hunter green");
  },
});

cases.push({
  name: "color-inject: skips when AI already passed a color",
  run: () => {
    const input = search({ query: "x", filters: { color: "blue" } });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "any in red?",
      _merchantColors: ["red", "blue"],
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "color-inject: skips when color not in merchant catalog",
  run: () => {
    const input = search({ query: "x" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "any in chartreuse?",
      _merchantColors: ["red", "blue", "black"],
    });
    assert.equal(out, input);
  },
});

// stripStaleCategoriesOnScopeReset ───────────────────────────────
cases.push({
  name: "scope-reset: strips stale 'sneakers' on 'any pink ones'",
  run: () => {
    const out = stripStaleCategoriesOnScopeReset(
      search({ query: "women's sneakers pink" }),
      {
        latestUserMessage: "any pink ones?",
        merchantGroups: [
          { name: "Footwear", categories: ["Sneakers", "Boots"] },
        ],
      },
    );
    assert.equal(out.input.query, "women's pink");
  },
});

cases.push({
  name: "scope-reset: keeps category if customer mentions it",
  run: () => {
    const input = search({ query: "women's sneakers pink" });
    const out = stripStaleCategoriesOnScopeReset(input, {
      latestUserMessage: "any pink sneakers?",
      merchantGroups: [
        { name: "Footwear", categories: ["Sneakers", "Boots"] },
      ],
    });
    assert.equal(out, input); // 'sneakers' in user msg → keep
  },
});

cases.push({
  name: "scope-reset: no-op without scope-reset trigger word",
  run: () => {
    const input = search({ query: "women's sneakers pink" });
    const out = stripStaleCategoriesOnScopeReset(input, {
      latestUserMessage: "show me one in pink",
      merchantGroups: [
        { name: "Footwear", categories: ["Sneakers"] },
      ],
    });
    assert.equal(out, input);
  },
});

// rewriteToolCall composition ──────────────────────────────────
cases.push({
  name: "pipeline: gender + color stack on a single search",
  run: () => {
    const out = rewriteToolCall(
      search({ query: "running" }),
      {
        sessionGender: "women",
        latestUserMessage: "any red running shoes?",
        _merchantColors: ["red", "blue"],
        merchantGroups: [],
      },
    );
    assert.equal(out.input.filters.gender, "women");
    assert.equal(out.input.filters.color, "red");
  },
});

cases.push({
  name: "pipeline: 20-turn gender pivot — late turn searches with woman gender",
  run: () => {
    // Simulates the bug: AI on turn 20 fires search with men's filter
    // because of context drift; sessionGender (from latest user pivot
    // 5 turns ago) is "women". Rewrite must override.
    const out = rewriteToolCall(
      search({ query: "waterproof shoes", filters: { gender: "men" } }),
      {
        sessionGender: "women",
        latestUserMessage: "any waterproof options?",
        _merchantColors: [],
        merchantGroups: [],
      },
    );
    assert.equal(out.input.filters.gender, "women");
  },
});

// ── negation guard for color injection ─────────────────────────────
// Customer says "no red" — the rewrite pipeline must NOT inject
// filters.color = "red". Same for "forget red", "anything but red",
// "without red", "skip red", "don't want red".

cases.push({
  name: "color-inject: negation 'no red' skips injection",
  run: () => {
    const input = search({ query: "shoes" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "no red, anything else?",
      _merchantColors: ["red", "blue", "black"],
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "color-inject: negation 'forget red' skips injection",
  run: () => {
    const input = search({ query: "shoes" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "ok forget red — show me everything",
      _merchantColors: ["red"],
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "color-inject: negation 'anything but black' skips injection",
  run: () => {
    const input = search({ query: "shoes" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "anything but black",
      _merchantColors: ["black", "blue"],
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "color-inject: negation 'don't want pink' skips injection",
  run: () => {
    const input = search({ query: "shoes" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "I don't want pink, prefer something else",
      _merchantColors: ["pink"],
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "color-inject: 'any red?' (affirmed) still injects",
  run: () => {
    const out = injectStructuredColorFilter(
      search({ query: "shoes" }),
      {
        latestUserMessage: "any red?",
        _merchantColors: ["red"],
      },
    );
    assert.equal(out.input.filters.color, "red");
  },
});

cases.push({
  name: "color-inject: 'red please' (affirmed) still injects",
  run: () => {
    const out = injectStructuredColorFilter(
      search({ query: "shoes" }),
      {
        latestUserMessage: "red please",
        _merchantColors: ["red"],
      },
    );
    assert.equal(out.input.filters.color, "red");
  },
});

cases.push({
  name: "color-inject: 'without red, in blue' picks blue (skips red)",
  run: () => {
    const out = injectStructuredColorFilter(
      search({ query: "shoes" }),
      {
        latestUserMessage: "without red, in blue please",
        _merchantColors: ["red", "blue"],
      },
    );
    // longest-first sort puts both at len 3-4; test that whichever
    // wins, it's NOT red.
    assert.notEqual(out.input.filters.color, "red");
  },
});

// ── isPrecededByNegation primitive ────────────────────────────────
cases.push({
  name: "isPrecededByNegation: 'no red' at index of 'red' → true",
  run: () => {
    const t = "no red";
    const idx = t.indexOf("red");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

cases.push({
  name: "isPrecededByNegation: 'any red' → false (no negation)",
  run: () => {
    const t = "any red";
    const idx = t.indexOf("red");
    assert.equal(isPrecededByNegation(t, idx), false);
  },
});

cases.push({
  name: "isPrecededByNegation: 'forget red' → true",
  run: () => {
    const t = "ok forget red please";
    const idx = t.indexOf("red");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

cases.push({
  name: "isPrecededByNegation: 'never red' → true",
  run: () => {
    const t = "never red";
    const idx = t.indexOf("red");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

// ── long-form negation (multiple words between negation and term) ─────
cases.push({
  name: "isPrecededByNegation: 'do not want anything black' → true (3 words gap)",
  run: () => {
    const t = "I really do not want anything black or boring";
    const idx = t.indexOf("black");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

cases.push({
  name: "isPrecededByNegation: 'absolutely no red' → true",
  run: () => {
    const t = "absolutely no red — looks tacky";
    const idx = t.indexOf("red");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

cases.push({
  name: "isPrecededByNegation: don't want X (3 words gap) → true",
  run: () => {
    const t = "I don't want any pink in this";
    const idx = t.indexOf("pink");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

// ── 'but X' reaffirmation cancels prior negation ──────────────────────
cases.push({
  name: "isPrecededByNegation: 'not red but green' → green is NOT negated",
  run: () => {
    const t = "not red but green";
    const idx = t.indexOf("green");
    assert.equal(isPrecededByNegation(t, idx), false);
  },
});

cases.push({
  name: "isPrecededByNegation: 'no red, but I'd love blue' → blue is NOT negated",
  run: () => {
    const t = "no red, but I'd love blue";
    const idx = t.indexOf("blue");
    assert.equal(isPrecededByNegation(t, idx), false);
  },
});

cases.push({
  name: "isPrecededByNegation: 'anything but pink' → pink IS negated",
  run: () => {
    const t = "anything but pink";
    const idx = t.indexOf("pink");
    assert.equal(isPrecededByNegation(t, idx), true);
  },
});

// ── distance check — far-away negation does NOT propagate ─────────────
cases.push({
  name: "isPrecededByNegation: negation far away (>4 tokens) → false",
  run: () => {
    const t = "not for hiking, just casual walking on weekends in red";
    const idx = t.indexOf("red");
    assert.equal(isPrecededByNegation(t, idx), false);
  },
});

// ── color-inject end-to-end with long-form negation ───────────────────
cases.push({
  name: "color-inject: 'do not want anything black' skips injection",
  run: () => {
    const input = search({ query: "shoes" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "I really do not want anything black or boring",
      _merchantColors: ["black", "blue", "red"],
    });
    assert.equal(out, input);
  },
});

cases.push({
  name: "color-inject: 'no red but love blue' picks blue",
  run: () => {
    const out = injectStructuredColorFilter(
      search({ query: "shoes" }),
      {
        latestUserMessage: "no red but I'd love blue",
        _merchantColors: ["red", "blue"],
      },
    );
    assert.equal(out.input.filters.color, "blue");
  },
});

cases.push({
  name: "color-inject: 'absolutely no red' skips injection",
  run: () => {
    const input = search({ query: "shoes" });
    const out = injectStructuredColorFilter(input, {
      latestUserMessage: "absolutely no red — red just looks tacky on me",
      _merchantColors: ["red"],
    });
    assert.equal(out, input);
  },
});

// ── gender detection with long-form negation ────────────────────────
cases.push({
  name: "gender: 'do not want men's, want women's' → women",
  run: () => assert.equal(
    detectGenderFromHistory([u("I do not want men's, I want women's please")]),
    "women",
  ),
});

cases.push({
  name: "gender: 'not for men but for women' → women (reaffirmation)",
  run: () => assert.equal(
    detectGenderFromHistory([u("not for men but for women")]),
    "women",
  ),
});

// ── negation-aware gender detection ──────────────────────────────
cases.push({
  name: "gender: 'not for men, for women' → women (negation skips men)",
  run: () => assert.equal(
    detectGenderFromHistory([u("not for men, for women please")]),
    "women",
  ),
});

cases.push({
  name: "gender: 'I don't want men's, show me women's' → women",
  run: () => assert.equal(
    detectGenderFromHistory([u("I don't want men's, show me women's")]),
    "women",
  ),
});

cases.push({
  name: "gender: 'for my husband' (no negation) → men",
  run: () => assert.equal(
    detectGenderFromHistory([u("for my husband")]),
    "men",
  ),
});

cases.push({
  name: "gender: 'I'm a woman' (no negation) → women",
  run: () => assert.equal(
    detectGenderFromHistory([u("actually this is for me — I'm a woman")]),
    "women",
  ),
});

cases.push({
  name: "gender: 'no men, no women' → null (both negated)",
  run: () => assert.equal(
    detectGenderFromHistory([u("no men, no women, just unisex")]),
    null,
  ),
});

cases.push({
  name: "gender: 'men's, actually women's' (later wins same msg)",
  run: () => assert.equal(
    detectGenderFromHistory([u("men's, actually women's")]),
    "women",
  ),
});

// ── anthropic-resilience ────────────────────────────────────
// Tests that the retry helper retries on transient errors and bails
// out cleanly on non-retryable errors. Uses async functions that
// throw scripted errors — no real Anthropic calls.

cases.push({
  name: "withAnthropicRetry: succeeds first try (no retry)",
  run: async () => {
    let calls = 0;
    const out = await withAnthropicRetry(async () => {
      calls++;
      return "ok";
    });
    assert.equal(out, "ok");
    assert.equal(calls, 1);
  },
});

cases.push({
  name: "withAnthropicRetry: retries on 503 then succeeds",
  run: async () => {
    let calls = 0;
    const out = await withAnthropicRetry(
      async () => {
        calls++;
        if (calls === 1) {
          const err = new Error("upstream blip");
          err.status = 503;
          throw err;
        }
        return "recovered";
      },
      { baseDelayMs: 1, maxRetries: 2 },
    );
    assert.equal(out, "recovered");
    assert.equal(calls, 2);
  },
});

cases.push({
  name: "withAnthropicRetry: retries on 429 rate limit",
  run: async () => {
    let calls = 0;
    const out = await withAnthropicRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("rate limited");
          err.status = 429;
          throw err;
        }
        return "ok";
      },
      { baseDelayMs: 1, maxRetries: 2 },
    );
    assert.equal(out, "ok");
    assert.equal(calls, 3);
  },
});

cases.push({
  name: "withAnthropicRetry: does NOT retry on 401 (auth)",
  run: async () => {
    let calls = 0;
    let caught;
    try {
      await withAnthropicRetry(
        async () => {
          calls++;
          const err = new Error("unauthorized");
          err.status = 401;
          throw err;
        },
        { baseDelayMs: 1, maxRetries: 2 },
      );
    } catch (e) {
      caught = e;
    }
    assert.equal(calls, 1);
    assert.equal(caught?.status, 401);
  },
});

cases.push({
  name: "withAnthropicRetry: does NOT retry on 400 (validation)",
  run: async () => {
    let calls = 0;
    try {
      await withAnthropicRetry(
        async () => {
          calls++;
          const err = new Error("bad request");
          err.status = 400;
          throw err;
        },
        { baseDelayMs: 1, maxRetries: 2 },
      );
    } catch { /* expected */ }
    assert.equal(calls, 1);
  },
});

cases.push({
  name: "withAnthropicRetry: retries on ECONNRESET network error",
  run: async () => {
    let calls = 0;
    const out = await withAnthropicRetry(
      async () => {
        calls++;
        if (calls === 1) {
          const err = new Error("connection reset");
          err.code = "ECONNRESET";
          throw err;
        }
        return "ok";
      },
      { baseDelayMs: 1, maxRetries: 2 },
    );
    assert.equal(out, "ok");
    assert.equal(calls, 2);
  },
});

cases.push({
  name: "withAnthropicRetry: gives up after maxRetries",
  run: async () => {
    let calls = 0;
    let caught;
    try {
      await withAnthropicRetry(
        async () => {
          calls++;
          const err = new Error("upstream down");
          err.status = 503;
          throw err;
        },
        { baseDelayMs: 1, maxRetries: 2 },
      );
    } catch (e) {
      caught = e;
    }
    assert.equal(calls, 3); // initial + 2 retries
    assert.equal(caught?.status, 503);
  },
});

cases.push({
  name: "classifyAnthropicError: billing → not retryable",
  run: () => {
    const c = classifyAnthropicError(new Error("Your credit balance is too low"));
    assert.equal(c.kind, "billing");
    assert.equal(c.retryable, false);
  },
});

cases.push({
  name: "classifyAnthropicError: 429 → rate_limit retryable",
  run: () => {
    const err = new Error("rate limit");
    err.status = 429;
    const c = classifyAnthropicError(err);
    assert.equal(c.kind, "rate_limit");
    assert.equal(c.retryable, true);
  },
});

cases.push({
  name: "classifyAnthropicError: 503 → upstream retryable",
  run: () => {
    const err = new Error("service unavailable");
    err.status = 503;
    const c = classifyAnthropicError(err);
    assert.equal(c.kind, "upstream");
    assert.equal(c.retryable, true);
  },
});

cases.push({
  name: "classifyAnthropicError: ECONNRESET → network retryable",
  run: () => {
    const err = new Error("reset");
    err.code = "ECONNRESET";
    const c = classifyAnthropicError(err);
    assert.equal(c.kind, "network");
    assert.equal(c.retryable, true);
  },
});

// ── run all ───────────────────────────────────────────────
let pass = 0;
const failures = [];
for (const c of cases) {
  try {
    // Await every run — covers both sync (returns undefined) and async
    // (returns a Promise) cases. Without `await`, async failures get
    // silently swallowed as unhandled rejections.
    await c.run();
    pass++;
  } catch (err) {
    failures.push({ name: c.name, msg: err?.message || String(err) });
  }
}

if (failures.length > 0) {
  console.error(`chat-quality eval FAILED: ${pass}/${cases.length} passed`);
  for (const f of failures) console.error(`  ✗ ${f.name}: ${f.msg}`);
  process.exit(1);
}

console.log(`chat-quality eval passed: ${pass}/${cases.length}`);
