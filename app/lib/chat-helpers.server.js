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

// Detect a "definitional hallucination" — sentences like "X is our
// premium orthotic line that..." where the model made up information
// about a brand/product/term that isn't in the catalog (and didn't
// turn up in search). Used after a search returned 0 results to catch
// the AI confidently describing something we didn't validate.
//
// Returns true if the text contains a likely definitional sentence
// pattern. Heuristic — false positives are acceptable since the
// fallback is "I'd love to help — can you give me more detail?"
const DEFINITIONAL_RE = /\b(?:[A-Z][\w-]{2,}\s+(?:is|are)\s+(?:our|an?|the)\s+(?:premium|signature|exclusive|new|advanced|patented|proprietary|flagship|line|technology|orthotic|insole|footbed|brand|collection|series))\b/;

export function looksLikeDefinitionalHallucination(text) {
  return Boolean(text) && DEFINITIONAL_RE.test(text);
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

// AI sometimes ships near-duplicate sentences ("Here are some great
// men's casual orthotics designed for everyday support. Here are some
// great men's casual orthotics built for everyday support and all-day
// comfort..."). The NO REPETITION prompt rule says don't, but
// compliance fails. Strip the second of any pair of consecutive
// sentences that share 4+ leading words.
export function dedupeConsecutiveSentences(text) {
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return text;
  const kept = [];
  let lastKey = null;
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    const norm = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const key = norm.slice(0, 4).join(" ");
    if (key && key === lastKey) {
      // Same opener as previous sentence — drop this one.
      continue;
    }
    kept.push(trimmed);
    lastKey = key;
  }
  return kept.join(" ");
}

// Strip meta-narration where the AI talks ABOUT the customer ("the
// customer already established Men's via the choice button…") or
// dumps its reasoning chain ("we know: orthotic insert, ball of foot
// pain, cleats —"). Customer-facing text should address them in
// second person and just answer.
//
// Three patterns:
//   1. Leading meta-clauses: "Since the customer…", "Given that we
//      know…" up to the first sentence-end or em-dash.
//   2. Mid-text "we know: X, Y, Z —" inventory dumps.
//   3. Third-person references "the customer" / "the user" — replace
//      with "you" so the rest of the sentence stays grammatical.
const META_PREAMBLE_RE = /(?:^|(?<=[.!?]\s+))(?:since|given|considering|because|based on)[^.!?\n,]{0,120}?(?:the\s+customer|the\s+user|via\s+the\s+choice\s+button|already\s+established|already\s+chose|already\s+selected|already\s+picked|already\s+told\s+me)[^.!?\n—,]*[.!?—,]\s*/gi;
const INVENTORY_DUMP_RE = /(?:^|\s|—\s*)(?:and\s+)?we\s+know\s*:?\s*[^.!?—\n]*[—.!?]\s*/gi;
const THIRD_PERSON_CUSTOMER_RE = /\bthe\s+(?:customer|user)\s+(?:has|is|already|wants|needs|said|told|chose|picked|selected|established|mentioned|asked)/gi;
const THIRD_PERSON_BARE_RE = /\bthe\s+(customer|user)\b/gi;

export function stripMetaNarration(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(META_PREAMBLE_RE, " ");
  out = out.replace(INVENTORY_DUMP_RE, " ");
  out = out.replace(THIRD_PERSON_CUSTOMER_RE, (m) =>
    m.replace(/\bthe\s+(?:customer|user)\s+/i, "you "),
  );
  out = out.replace(THIRD_PERSON_BARE_RE, "you");
  return out.replace(/\s{2,}/g, " ").replace(/^\s*[—–-]\s*/, "").trim();
}
