// Pure heuristic functions for chat post-processing. Extracted from
// chat.jsx so they can be unit-tested without spinning up the full
// agentic loop / Anthropic / Prisma stack.
//
// These functions are the rules that decide:
//   - whether the customer expressed singular vs plural shopping intent
//     (drives the singular-narrow card-pool collapse)
//   - whether the customer is asking to compare items
//     (overrides singular intent — comparison wants both cards)
//   - whether the assistant's response uses pivot phrasing
//     ('we don't have X, but here are Y') — overrides denial logic
//   - whether the assistant's response uses near-match phrasing
//     ('here are our closest options') — overrides denial logic
//
// Production bugs caught by exercising these in isolation:
//   - Bare 'how about' was matching SINGULAR_INTENT_RE, collapsing
//     6-card pools to 1 sandal on category pivots ('how about for
//     women?'). Fix: require a singular reference after 'how about'.

// =====================================================================
// Customer-side intent detection
// =====================================================================

// Singular intent — customer is asking about ONE specific item.
// Triggers the singular-narrow rule (collapse pool to 1 card).
//
// IMPORTANT — known footguns:
//   - 'how about' / 'what about' BARE used to match — this caught
//     category pivots like 'how about for women?' as singular intent.
//     The prior pool collapsed to 1 card. Fixed by requiring a
//     singular reference ('this one', 'the [adj] one') after those
//     phrases.
//   - 'best' / 'cheapest' / 'most X' alone DO match (clear singular
//     superlative — "what's the best" wants ONE answer).
export const SINGULAR_INTENT_RE = /\btell me (?:more |a (?:bit|little) more )?about\b|\bmore (?:info|information|details) (?:on|about)\b|\b(?:what|how) about\s+(?:this|that|the\s+\w+\s+one\b)|\bhow is\b|\bis the\b|\bdoes (?:the|this|that)\b|\b(?:this|that) one\b|\bthe (?:first|second|third|last|cheapest|cheaper|priciest|most expensive|best|top|finest|red|blue|black|white|same)\s+(?:one\b|[a-z'-]+s?\b)|\bwhich\s+[a-z'-]+\s+(?:is|are)\s+(?:best|most|finest|top|the\s+(?:best|most))\b|\bwhat\s*'?s\s+(?:the\s+)?(?:best|cheapest|priciest|most expensive|finest|top|most\s+[a-z'-]+)\b/i;

// Comparison intent — customer wants to see two things side-by-side.
// Overrides singular intent (we want both cards even if phrasing is
// otherwise singular-shaped).
export const COMPARISON_INTENT_RE = /\b(?:compare|comparison|vs\.?|versus|difference between|better between|between [a-z0-9'-]+ (?:and|or) [a-z0-9'-]+|which (?:is|one is) (?:better|worse)|side[- ]by[- ]side)\b/i;

export function detectSingularIntent(text) {
  if (typeof text !== "string" || !text) return false;
  if (!SINGULAR_INTENT_RE.test(text)) return false;
  // Comparison overrides singular: 'which is better, X or Y' is plural
  // even though it matches singular phrasing.
  if (COMPARISON_INTENT_RE.test(text)) return false;
  return true;
}

export function detectComparisonIntent(text) {
  if (typeof text !== "string" || !text) return false;
  return COMPARISON_INTENT_RE.test(text);
}

// =====================================================================
// Assistant-side phrasing detection
// =====================================================================
// These look at the LLM's own reply text to decide whether to apply
// downstream guardrails (saysNoMatch denial, etc.).

// Pivot phrasing: "we don't have X, but [...] here/these/those/our/all
// of these/etc.". Allow up to ~30 chars of filler between 'but' and
// the presentational pronoun so phrases like 'but all of these sandals
// are tagged for bunions' or 'but I do have a few options' count as a
// pivot.
//
// Production trace that motivated this: customer asked for a yellow
// sandal; AI replied 'We don't have an exact yellow option right now,
// but all of these sandals are specifically tagged for bunions...'.
// Without this match, saysNoMatch stayed true, the card pool was
// suppressed, and the customer saw the 'we don't have' apology with
// no products beneath.
const AI_PIVOT_BUT_RE = /\bbut\b[\s\S]{0,30}?\b(?:here|these|those|our|all\s+of\s+(?:these|those|the|them)|every\s+(?:one|single)|each\s+(?:one|of\s+these)|i\s+do(?:\s+have)?|i'?ve\s+got|we\s+do(?:\s+have)?|we'?ve\s+got)\b/i;

// Near-match phrasing: 'closest options', 'nearest match', etc. Same
// override semantics — the AI is presenting alternatives, not denying.
const AI_NEAR_MATCH_RE = /\b(?:closest|nearest|next\s+best|similar)\s+(?:option|options|match|matches|pick|picks|alternative|alternatives)\b/i;

export function detectAiPivotPhrasing(text) {
  if (typeof text !== "string" || !text) return false;
  return AI_PIVOT_BUT_RE.test(text) || AI_NEAR_MATCH_RE.test(text);
}

// =====================================================================
// Suggestion validators (follow-up question filtering)
// =====================================================================
// The LLM occasionally suggests follow-up questions that promise things
// the catalog doesn't have. These filters drop those suggestions before
// they reach the customer.

// Branded tech terms (UltraSKY, OrthoLite, etc.) — the AI's catalog
// data has marketing descriptions but not engineering specs, so a
// follow-up like 'tell me more about UltraSKY' triggers hallucination.
const TECH_NAME_RE = /(?:[™®]|\b[A-Z][A-Za-z]*(?:[A-Z][A-Za-z]+){1,}\b)/;

// "Tell me more about" / "explain how X works" / "what is the [tech]"
// — same hallucination risk.
const SPEC_DEEPDIVE_RE = /\b(?:tell me more about|explain|how does .* work|what (?:is|are) the (?:[a-z]+\s+)?(?:technology|system|fabric|foam|material|tech)|details?\s+(?:on|about)\s+the)\b/i;

// Specific spec/measurement asks — same hallucination risk unless
// those numbers actually appear in the assistant's previous reply.
const SPEC_MEASURE_RE = /\b(?:heel\s+height|stack\s+height|toe\s+drop|heel-to-toe\s+drop|stack|gradient|density|grade|weight\s+in\s+(?:oz|grams|g)|dimensions|cm\b|mm\b)\b/i;

/**
 * Decide whether a follow-up suggestion question is safe to show.
 * Returns { allowed: boolean, reason: string|null }.
 *
 * @param {string} suggestion  candidate follow-up question
 * @param {string} replyText   assistant's last reply (for context match)
 */
export function validateFollowUpSuggestion(suggestion, replyText) {
  const q = String(suggestion || "");
  const reply = String(replyText || "");
  const replyLower = reply.toLowerCase();

  // Tech-name deepdive — only allow if the exact tech term appeared in
  // the reply.
  if (SPEC_DEEPDIVE_RE.test(q)) {
    const techMatches = q.match(TECH_NAME_RE);
    if (!techMatches) {
      // A deepdive question without a specific tech term anchor — drop.
      return { allowed: false, reason: "spec deepdive without tech anchor" };
    }
    const techTerm = techMatches[0];
    if (!replyLower.includes(techTerm.toLowerCase())) {
      return { allowed: false, reason: `tech term "${techTerm}" not in reply` };
    }
  }

  // Branded tech term anywhere in the suggestion (e.g. "Do you have
  // UltraSKY foam in red?") — drop unless that exact term appears in
  // the reply.
  if (TECH_NAME_RE.test(q)) {
    const techMatches = q.match(TECH_NAME_RE);
    for (const term of techMatches || []) {
      if (term.length < 4) continue; // skip ™/® alone
      if (!replyLower.includes(term.toLowerCase())) {
        return { allowed: false, reason: `branded tech term "${term}" not in reply` };
      }
    }
  }

  // Spec measurement — drop unless the same measurement appears in the
  // reply (we can't fact-check arbitrary numbers).
  if (SPEC_MEASURE_RE.test(q) && !SPEC_MEASURE_RE.test(reply)) {
    return { allowed: false, reason: "spec measurement not in reply" };
  }

  return { allowed: true, reason: null };
}
