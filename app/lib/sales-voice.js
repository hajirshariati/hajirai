// ── Sales voice / no-process-narration guard ──────────────────────────
//
// A customer-facing reply must read like a professional store associate, NOT a
// retrieval log. The bot must never narrate its process: searches, tools, the
// system/catalog/database, filters, "results", "what I'm seeing/getting", or why
// products appeared. This module is the ONE place that defines what process
// narration looks like, so the grounding validator (block + retry) and the final
// emit scrub (remove the offending sentence) agree.
//
// Pure (no DB / no streaming) → unit-testable with fixtures.

// Workflows where a real, sales-voiced answer is owed — process narration here
// is BLOCKING (retry/rewrite before emit), not a warning. multi_recommendation
// is included only when cards are shown (handled by the caller passing hasCards).
export const SALES_VOICE_BLOCKING_WORKFLOWS = new Set([
  "condition_recommendation",
  "named_product_advisory",
  "comparison",
  "availability",
  "prior_evidence_availability",
  "multi_recommendation",
]);

// Sales-judgment workflows that should run on the stronger model first (these
// require taste/voice, where the fast model tends to narrate process).
export const SALES_JUDGMENT_WORKFLOWS = new Set([
  "condition_recommendation",
  "named_product_advisory",
  "comparison",
  "multi_recommendation",
]);

// Process-narration patterns. Each is matched per SENTENCE so the emit scrub can
// remove exactly the offending sentence. Tuned to catch retrieval narration
// while NOT touching normal shopper language (style, size, available, in stock,
// product page, colors, fit, …).
const NARRATION_PATTERNS = [
  // first-person retrieval narration ("I see I'm getting…", "I'm seeing mostly…")
  /\bi\s*(?:'m|’m|\s+am)\s+(?:seeing|getting|finding|pulling(?:\s+up)?|coming\s+up\s+with)\b/i,
  /\bwhat\s+i'?m\s+(?:seeing|getting|finding|pulling)\b/i,
  /\bi\s+see\s+(?:that\s+)?i\s*(?:'m|’m|\s+am)\b/i,
  /\bi\s+(?:see|found|got|am\s+seeing|am\s+getting|notice|noticed)\s+(?:mostly|mainly|only|primarily|a\s+lot\s+of|lots\s+of|a\s+bunch\s+of|a\s+few)\b/i,
  // the act of searching ("let me try one more search", "I'll search", "the search returned/didn't…")
  /\bthe\s+search\b/i,
  /\b(?:let\s+me|let'?s|i'?ll|i\s+can|i\s+will|i\s+could|i\s+should|i'?d|i\s+would|i\s+need\s+to|i\s+want\s+to|i'?m\s+going\s+to|i\s+have\s+to)\s+(?:try\s+(?:another|one\s+more|a\s+(?:different|new|broader|quick|fresh)|again)\s+)?(?:search|re-?search|look\s+that\s+up)\b/i,
  /\b(?:try|run|do|perform|give\s+(?:it|that))\s+(?:another|one\s+more|a(?:nother)?(?:\s+(?:different|new|quick|broader|fresh))?)\s+search\b/i,
  /\bsearch(?:ed|ing)?\s+(?:again|for|the\s+catalog|our\s+catalog|didn|did\s+not|return|returned|came\s+back|pulled|gave|found|turned\s+up)\b/i,
  /\bre-?search(?:ing|ed)?\b/i,
  // system / catalog / data references
  /\bin\s+(?:our|the|my)\s+(?:system|catalog|inventory|database|data|records)\b/i,
  /\bour\s+(?:catalog|system|database|inventory)\b/i,
  /\bthe\s+catalog\b/i,
  /\bcatalog\s+(?:may|might|seems|doesn'?t|does\s+not|is\s+(?:limited|missing)|only\s+has)\b/i,
  /\bfrom\s+the\s+data\s+(?:i|we)\s+(?:have|see|got|can)\b/i,
  /\bbased\s+on\s+(?:the|my|our|what)\s+(?:data|results|search|i'?m\s+seeing)\b/i,
  // meta nouns (guarded so legit shopper words aren't caught)
  /\bsearch\s+results?\b/i,
  /\bthe\s+results?\b/i,
  /\bquer(?:y|ies)\b/i,
  /\b(?:after\s+)?filter(?:ed|ing)\b/i,
  /\b(?:card|product|search|result|candidate)\s+pool\b/i,
  /\b(?:the\s+)?(?:tool|database)s?\b/i,
  // "cards" = our internal term for product tiles — flag unless it's clearly a
  // real product (gift/credit/loyalty/etc. card).
  /\b(?<!gift\s)(?<!credit\s)(?<!debit\s)(?<!loyalty\s)(?<!membership\s)(?<!greeting\s)(?<!business\s)(?<!playing\s)(?<!score\s)(?<!report\s)(?:product\s+|these\s+|those\s+|the\s+|several\s+)?cards?\b(?!\s+(?:accepted|on\s+file|payment))/i,
];

// Split into sentences, keeping it simple (terminal punctuation or newline).
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNarrationSentence(sentence) {
  return NARRATION_PATTERNS.some((re) => re.test(sentence));
}

// Detect process narration. Returns { hit, sentences } where `sentences` are the
// exact offending sentences (so the scrub can remove only those).
export function detectProcessNarration(text) {
  const sentences = splitSentences(text);
  const offending = sentences.filter(isNarrationSentence);
  return { hit: offending.length > 0, sentences: offending };
}

// Remove only the process-narration sentences, preserving the rest verbatim.
export function stripProcessNarration(text) {
  const raw = String(text || "");
  if (!raw.trim()) return raw;
  const sentences = splitSentences(raw);
  const kept = sentences.filter((s) => !isNarrationSentence(s));
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

// Whether process narration should BLOCK on this turn (force a retry).
// multi_recommendation only blocks when cards are actually shown.
export function shouldBlockProcessNarration(workflow, hasCards = false) {
  if (!SALES_VOICE_BLOCKING_WORKFLOWS.has(workflow)) return false;
  if (workflow === "multi_recommendation") return Boolean(hasCards);
  return true;
}

// The retry instruction handed back to the model when process narration blocks.
export const PROCESS_NARRATION_RETRY_INSTRUCTION =
  "Rewrite this as a customer-facing retail answer. Do not mention searches, " +
  "tools, system, catalog, data, filters, results, or what you tried. Start " +
  "with the recommendation. Keep it concise and sales-oriented.";

// Sales-safe fallback when the scrub leaves a fragment (or nothing). Warm,
// recommendation-first, NEVER a process apology or "I'm not finding a clean
// match". Workflow-aware; uses the fact that cards are shown.
export function buildSalesVoiceFallback({ workflow = "", hasCards = false } = {}) {
  if (hasCards) {
    switch (workflow) {
      case "comparison":
        return "Here's how these compare for what you need — take a look at both, and I can go deeper on either one.";
      case "availability":
      case "prior_evidence_availability":
        return "Here's what I'd point you to — take a look, and tell me the size or color you want and I'll confirm it.";
      default:
        // condition_recommendation / named_product_advisory / multi / browse
        return "Here are a few strong options I'd start with for what you described — they're a great fit. Want me to go more polished or more casual?";
    }
  }
  return "Tell me a bit more about what you're after — the occasion, your size, or the look you want — and I'll point you to the best options.";
}
