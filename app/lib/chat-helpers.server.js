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
// Covers:
//   "let me X" / "i'll X" with a wide verb list (look, find, search,
//     check, see, pull up, grab, get, look up, look at)
//   "i need to X" / "let me get the details" — softer but still
//     narrative announcements the AI ships before tool calls
//   "one moment" / "hold on" / "right away" / "give me a second"
const BANNED_NARRATION = /(?<=^|\s)(?:let me (?:look (?:that |it )?up|find|search|check|see|pull (?:up|that up|that)|grab|get|look at|get the details|broaden|widen|expand|try (?:a |again|another)|narrow|refine|search again|do (?:a|another) search)(?:[^.!?\n]*)?[.!?]?|i['‘’]?ll (?:look|find|search|check|see|pull|grab|get|need to|try|broaden|widen)(?:[^.!?\n]*)?[.!?]?|i need to (?:pull up|look up|look at|find|search|check|see|grab|get|broaden|widen|try)(?:[^.!?\n]*)?[.!?]?|one moment[!.]?|hold on[!.]?|right away[!.]?|give me a (?:second|sec|moment)[!.]?|that (?:result|search|one) (?:is|was|isn['‘’]?t|doesn['‘’]?t)(?:[^.!?\n]*)?[.!?]?|the (?:search (?:above|results?)|results? (?:above|so far|i found)|previous (?:result|search))(?:[^.!?\n]*)?[.!?]?|searching (?:for|the catalog|now)(?:[^.!?\n]*)?[.!?]?|here['‘’]?s what (?:i|we) (?:found|got)(?:[^.!?\n]*)?[.!?]?)/gi;

// Self-correction strip. The model sometimes streams a follow-up
// question, then realizes mid-stream that the customer already
// answered it: "Do you have arch pain? Wait — you already told me:
// arch pain." Both halves are dead weight to the customer.
//
// The leading `(?:[^.!?\n]*\?\s+)?` optionally consumes the preceding
// question sentence so we don't leave a stale question behind. The
// strip only fires when the self-correction phrase is present, so we
// never accidentally eat a real question.
//
// Triggers: wait / actually / oh / sorry / hmm / nevermind / hold on
// followed by "you (already|just) told|said|mentioned|noted me/us…"
const SELF_CORRECTION_RE = /(?:[^.!?\n]*\?\s+)?\b(?:wait|actually|oh|sorry|hmm|never\s*mind|nevermind|hold\s+on)[\s,—–-]+you\s+(?:already\s+|just\s+)?(?:told|said|mentioned|noted)\s+(?:me|us)?\b[^.!?\n]*[.!?]?\s*/gi;

// Reasoning-leak strip — AI sometimes narrates its internal decision
// process to the customer ("Based on the merchant's flow, I need to
// identify discomfort and gender before searching", "Following the
// rules, I should ask…", "Per the guide…", "X is already
// established"). Direct-address rule forbids this but the model
// intermittently leaks. Strip the offending sentence; the next
// sentence (usually the actual question to the customer) survives.
//
// Patterns covered:
//   - "based on / according to / per / following / given (the
//     merchant's flow|guide|rules|knowledge|sequence|context|
//     prompt|system|instructions|guidelines)..."
//   - "i need to / i still need to / i have to / i must / before i
//     can (identify|determine|establish|figure out|find out|
//     check|verify|confirm|know|search)..."
//   - "(the |your )(pain|gender|category|shoe type|product type|
//     activity|condition|use case|line|...) is (already )?
//     (established|set|locked|known|determined|confirmed|identified|
//     covered)..."
//   - "(per|in line with|consistent with) (the )?(merchant|store|
//     guide|flow|rules|guidelines|instructions)..."
const REASONING_LEAK_RE = new RegExp(
  [
    // "based on / according to / per / following / given the X"
    String.raw`\b(?:based on|according to|per|following|given|in line with|consistent with)\s+(?:the\s+|my\s+|our\s+|this\s+|your\s+)?(?:merchant['‘’]?s?|store['‘’]?s?|seller['‘’]?s?|knowledge|guide(?:lines?)?|rules?|flow|sequence|prompt|system|context|instructions?|decision\s+(?:tree|process)|process)\b[^.!?\n]*[.!?]?\s*`,
    // "i (still |also )?need to / have to / must / will need to / should X" + reasoning verb + "before|first|then"
    String.raw`\bi\s+(?:still\s+|also\s+|just\s+)?(?:need\s+to|have\s+to|must|should|will\s+need\s+to)\s+(?:identify|determine|establish|figure\s+out|find\s+out|verify|confirm)\b[^.!?\n]*[.!?]?\s*`,
    // "before i (can )?recommend|suggest|search|show|help"
    String.raw`\bbefore\s+i\s+(?:can\s+)?(?:recommend|suggest|search|show|help|narrow|pick|choose)\b[^.!?\n]*[.!?]?\s*`,
    // "the X is (already)? (established|set|known|locked|determined|confirmed|identified|covered)"
    String.raw`\b(?:the|your)\s+(?:pain|gender|category|shoe(?:\s+type)?|product(?:\s+type)?|activity|condition|use\s*case|line|brand|fit|style|topic|context|scope)\s+(?:is|are)\s+(?:already\s+|now\s+)?(?:established|set|locked|known|determined|confirmed|identified|covered|in\s+place)\b[^.!?\n]*[.!?]?\s*`,
  ].join("|"),
  "gi",
);

export function stripBannedNarration(text) {
  if (!text) return text;
  return text
    .replace(SELF_CORRECTION_RE, " ")
    .replace(REASONING_LEAK_RE, " ")
    .replace(BANNED_NARRATION, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
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

// Detect singular-prescriptive AI language — when the AI claims ONE
// specific product is "the right pick" / "the go-to choice" / "would
// be perfect" / etc. Used by chat.jsx to narrow card rendering to a
// single product so text and card agree. Patterns intentionally
// generous: a false positive (narrowing to 1 card on softer language)
// is better than a false negative (showing 3 cards under singular AI
// text, which feels incoherent to the customer).
const SINGULAR_PRESCRIPTIVE = /\b(?:is (?:your|the) (?:best|perfect|ideal|top|right|go-?to) (?:match|choice|pick|fit|one|option)|is (?:a |an )?(?:great|perfect|good|ideal|solid) (?:match|choice|pick|fit|option)|is the one for you|would be (?:a (?:great|good|perfect|solid))? ?(?:match|choice|pick|fit|option)|i'?d (?:recommend|suggest)|i (?:recommend|suggest) (?:the|trying|going with))\b/i;

export function isSingularPrescriptive(text) {
  return Boolean(text) && SINGULAR_PRESCRIPTIVE.test(text);
}

// Plural-intro framing — the AI is presenting MULTIPLE options at once
// instead of recommending one. When this framing is present, the
// downstream score-threshold filter (which checks how many of each
// card's distinctive title words appear in the AI text) under-counts:
// a generic intro like "Here are some great wedges" doesn't repeat
// each product name, so most cards fall below the threshold and the
// customer sees fewer cards than the text promises ("Both of these
// wedges…" rendering 1 card). Catch the framing here so chat.jsx can
// skip the threshold and render the full pool. Vocabulary-agnostic —
// works for any catalog vertical.
const PLURAL_INTRO_FRAMING = /\b(?:here are|here'?s a (?:few|couple|handful)|both of (?:these|them)|these (?:are|two|three|few|options)|some great|several (?:great )?(?:options|picks|choices)|a few (?:options|picks|choices)|check out (?:these|some)|take a look at (?:these|some))\b/i;

export function hasPluralIntroFraming(text) {
  return Boolean(text) && PLURAL_INTRO_FRAMING.test(text);
}

// AI ships repetitive sentences in two distinct shapes:
//   (a) Echo opener — two adjacent sentences starting with the same
//       4+ words ("Here are some great X. Here are some great X with…").
//   (b) Paraphrase — two adjacent sentences that say the same thing
//       in different words ("The standard version provides cushioning
//       and arch support... The standard Kids Orthotics offer
//       cushioning and arch support...").
//
// Both violate the NO REPETITION prompt rule but the AI keeps shipping
// them. Catch both: first by opener match (cheap, narrow), then by
// content overlap (Jaccard-style, broader).
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "as", "by", "is", "are", "be", "been", "being", "was", "were",
  "this", "that", "these", "those", "it", "its", "your", "you", "we", "our",
  "i", "me", "my", "if", "while", "when", "what", "which", "who", "whose",
  "than", "then", "so", "also", "just", "too", "very", "any", "some", "all",
  "more", "most", "less", "no", "not", "do", "does", "did", "have", "has",
  "had", "from", "into", "out", "up", "down", "over", "under", "between",
]);

function significantWords(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function overlapRatio(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

export function dedupeConsecutiveSentences(text) {
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return text;
  const kept = [];
  let lastTrimmed = null;
  let lastOpener = null;
  let lastWords = null;
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    const tokens = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const opener = tokens.slice(0, 4).join(" ");
    const words = significantWords(trimmed);

    if (lastTrimmed) {
      // (a) Echo-opener: same first 4 words.
      if (opener && opener === lastOpener) continue;
      // (b) Paraphrase: ≥70% of significant words shared with previous
      // sentence, AND each side has at least 5 significant words (so
      // we don't false-trigger on short sentences with overlapping
      // common words).
      if (words.size >= 5 && lastWords && lastWords.size >= 5) {
        const ratio = overlapRatio(words, lastWords);
        if (ratio >= 0.7) continue;
      }
    }
    kept.push(trimmed);
    lastTrimmed = trimmed;
    lastOpener = opener;
    lastWords = words;
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

// Detect a product-shopping condition (medical / fit problem) or
// occasion (situation the customer needs the product for) in free-
// text. Used by the chat route to recover from the failure mode
// where the AI generates pitch text without ever calling
// search_products — when the user mentioned something searchable
// like "plantar fasciitis" or "trip to Italy", we force a retry
// that searches with the matched phrase as the query.
//
// Vocabulary is footwear/wellness-leaning since that's the dominant
// merchant audience today. Generalize via admin config later if a
// non-footwear merchant needs different keywords.
const CONDITION_RE = /\b(plantar fasciitis|bunion(?:s)?|flat feet|fallen arches|heel pain|heel spur|metatarsal|neuropathy|diabet(?:es|ic)|high arches|arch pain|morton'?s neuroma|achilles|tendon(?:itis)?|supination|overpronation|knee pain|back pain|ankle pain|foot pain)\b/i;
const OCCASION_RE = /\b(vacation|trip|travel|traveling|cruise|wedding|standing all day|on my feet|running|walking|hiking|gym|workout|everyday|casual|dressy|formal|outdoor|work shoes|office)\b/i;

export function detectConditionOrOccasion(text) {
  if (!text) return null;
  const source = String(text);
  const cm = source.match(CONDITION_RE);
  if (cm) return { kind: "condition", phrase: cm[0].toLowerCase() };
  const om = source.match(OCCASION_RE);
  if (om) return { kind: "occasion", phrase: om[0].toLowerCase() };
  return null;
}
