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
} from "../app/lib/chat-helpers.server.js";
import { filterContradictingGenderChips } from "../app/lib/chip-filter.server.js";

const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

const cases = [];

// ── detectGenderFromHistory ───────────────────────────────────────────
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
  name: "no user gender, assistant 'men's' fallback fires",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("foot pain"),
      a("Here are some men's options."),
    ]),
    "men",
  ),
});

cases.push({
  name: "assistant mentions both genders → fallback ignores it",
  run: () => assert.equal(
    detectGenderFromHistory([
      u("foot pain"),
      a("Are these for men's or women's?"),
    ]),
    null,
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

// ── stripBannedNarration ──────────────────────────────────────────────
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

// ── looksLikeProductPitch ─────────────────────────────────────────────
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

// ── normalizeGenderChipAnswer ─────────────────────────────────────────
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

// ── synthetic gender-answered injection ───────────────────────────────
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

// ── hasChoiceButtons ──────────────────────────────────────────────────
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

// ── stripMetaNarration ────────────────────────────────────────────────
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

// ── looksLikeDefinitionalHallucination ────────────────────────────────
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

// ── dedupeConsecutiveSentences ────────────────────────────────────────
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

// ── filterContradictingGenderChips ────────────────────────────────────
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

// ── run all ───────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
for (const c of cases) {
  try {
    c.run();
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
