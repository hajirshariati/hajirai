import assert from "node:assert/strict";
import {
  detectGenderFromHistory,
  stripBannedNarration,
  looksLikeProductPitch,
  normalizeGenderChipAnswer,
  hasChoiceButtons,
} from "../app/lib/chat-helpers.server.js";

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
