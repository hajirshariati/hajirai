// Pure helpers extracted from app/routes/chat.jsx so they can be
// exercised in evals without booting the route handler.
//
// Keep these dependency-free (no Prisma, no Anthropic, no env access).
// The route imports the same functions.

const MALE_PATTERN = /\b(men['‘’]?s|mens|men|male|males|guy|guys|dude|dudes|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|man|boy|boys)\b/i;
const FEMALE_PATTERN = /\b(women['‘’]?s|womens|women|female|females|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|woman|girl|girls)\b/i;

// Latest user gender wins over assistant echoes. Without this, an
// assistant turn that re-mentions "men's" between the user's original
// "men's running" and a later pivot like "actually for my wife"
// silently overrides the pivot.
export function detectGenderFromHistory(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const text = typeof messages[i].content === "string" ? messages[i].content : "";
    if (MALE_PATTERN.test(text)) return "men";
    if (FEMALE_PATTERN.test(text)) return "women";
  }
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    const text = typeof messages[i].content === "string" ? messages[i].content : "";
    if (/\bmen['‘’]?s\b/i.test(text) && !/\bwomen['‘’]?s\b/i.test(text)) return "men";
    if (/\bwomen['‘’]?s\b/i.test(text) && !/\bmen['‘’]?s\b/i.test(text)) return "women";
  }
  return null;
}

// Strip "let me look that up", "i'll find", "one moment" etc. from the
// AI's response. Compliance backstop for the BANNED NARRATION prompt
// rule the model intermittently violates. Returns the cleaned string;
// when nothing matched, returns input.
// Lookbehind so back-to-back phrases ("Hold on. Let me search.") both
// match — `(?:^|\s)` would consume the boundary and miss the second.
const BANNED_NARRATION = /(?<=^|\s)(?:let me (?:look (?:that )?up|find|search|check|see|pull up|grab)(?:[^.!?\n]*)?[.!?]?|one moment[!.]?|hold on[!.]?|right away[!.]?|i['‘’]?ll (?:look|find|search|check|see|pull up|grab)(?:[^.!?\n]*)?[.!?]?)/gi;

export function stripBannedNarration(text) {
  if (!text) return text;
  return text.replace(BANNED_NARRATION, " ").replace(/\s{2,}/g, " ").trim();
}

// Pitch-shaped text: AI claiming a recommendation is being made (with
// or without an actual product card). Used to detect incoherent turns
// where the AI announces a match but no product was returned.
const PRODUCT_PITCH_RE = /\b(here are|check out|check these|some great|great options|top picks|picks for you|styles for you|perfect (?:for|match|pick|choice)|the (?:best|ideal|right) (?:match|choice|pick|option)|i (?:recommend|suggest)|points to|cleat-?compatible|look that up)\b/i;

export function looksLikeProductPitch(text) {
  return Boolean(text) && PRODUCT_PITCH_RE.test(text);
}

// Multi-gender chip answer parsing. "Men's & Boys'" → "men". "Women's,
// Girls'" → "women". Single-gender values return as-is.
export function normalizeGenderChipAnswer(raw) {
  const tokens = String(raw || "")
    .toLowerCase()
    .split(/\s*(?:&|,|\band\b|\+|\/)\s*/)
    .map((t) => t.replace(/['‘’]/g, "").trim())
    .filter(Boolean);
  for (const t of tokens) {
    if (["men", "mens", "male", "boy", "boys"].includes(t)) return "men";
    if (["women", "womens", "female", "girl", "girls"].includes(t)) return "women";
  }
  return null;
}

export function hasChoiceButtons(text) {
  return /<<[^<>]+>>/.test(text || "");
}
