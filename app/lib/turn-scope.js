// ── Latest-turn scope ──────────────────────────────────────────────────
//
// Is the newest user message a FOLLOW_UP to the prior turn, or a
// NEW_INDEPENDENT_ASK that must NOT inherit prior context?
//
// A FOLLOW_UP explicitly refers back — deictic language ("those/that/it") or a
// direct prior-card reference ("the first one", "do any of those", "either",
// "both", "same", "what about…"). A NEW_INDEPENDENT_ASK introduces a fresh
// need/category/use-case and must drop stale category / color / condition /
// family / use-case so the engine answers THIS question, not the last one.
//
// Pure (no DB / no LLM) → unit-testable. The chat route runs it right after the
// classifier so planTurn, the over-elicitation guard, the recommender gate, and
// search all read the same scoped facts.

import { detectCategoryNouns } from "./constraint-plan.js";

// Deictic / prior-reference language. Matching ANY of these (with prior context
// present) makes the turn a follow-up.
const FOLLOW_UP_RE = new RegExp(
  [
    "\\b(?:those|these|them|that|this|it)\\b",
    "\\beither\\b", "\\bboth\\b", "\\bsame\\b",
    "\\bthe\\s+other\\s+one\\b", "\\bother\\s+ones?\\b",
    "\\bwhat\\s+about\\b", "\\bhow\\s+about\\b", "\\band\\s+in\\b",
    "\\bdo\\s+any\\s+of\\s+(?:those|them|these)\\b",
    "\\b(?:the\\s+)?(?:first|second|third|fourth|last|1st|2nd|3rd)\\s+one\\b",
    "\\b(?:the\\s+)?(?:first|second|third|fourth|last)\\s+(?:option|product|pair|style)\\b",
    "\\bones?\\s+you\\s+(?:showed|shared|mentioned|listed|just)\\b",
    "\\byou\\s+(?:showed|shared|just\\s+showed)\\b",
  ].join("|"),
  "i",
);

// Whether there is prior context worth following up on (prior cards shown or
// prior classifier facts). With none, every turn is independent.
export function hasPriorContext({ priorCardCount = 0, priorAttributes = null } = {}) {
  if (priorCardCount > 0) return true;
  if (priorAttributes && typeof priorAttributes === "object") {
    return Object.values(priorAttributes).some((v) => v != null && v !== "");
  }
  return false;
}

// Classify the latest message. Returns { scope, reason }.
export function classifyTurnScope(message, opts = {}) {
  const m = String(message || "").trim();
  if (!m) return { scope: "new_independent", reason: "empty" };
  if (!hasPriorContext(opts)) return { scope: "new_independent", reason: "no_prior_context" };
  if (FOLLOW_UP_RE.test(m)) return { scope: "follow_up", reason: "deictic_or_prior_reference" };
  return { scope: "new_independent", reason: "fresh_ask" };
}

export function isFollowUpTurn(message, opts = {}) {
  return classifyTurnScope(message, opts).scope === "follow_up";
}

// ── Per-attribute "stated in the latest message" detectors ──
// Used to decide which (if any) inherited classifier attributes survive into a
// NEW_INDEPENDENT_ASK: an attribute is kept only when the latest message itself
// supports it. On a follow-up everything is kept.

const CONDITION_WORD_RE =
  /\b(?:plantar|fasciitis|bunions?|neuroma|metatars(?:al|algia)?|met[\s-]?pad|heel[\s-]?(?:pain|spur)|flat[\s-]?(?:feet|foot)|fallen[\s-]?arch|high[\s-]?arch|low[\s-]?arch|arch[\s-]?(?:pain|support)|over[\s-]?pronat|supinat|diabet(?:ic|es)|neuropath|achilles|sesamoid|hammer[\s-]?toe|ball[\s-]?of[\s-]?(?:the[\s-]?)?foot|foot[\s-]?(?:pain|ache)|sore[\s-]?feet|achy[\s-]?feet)\b/i;

const USECASE_WORD_RE =
  /\b(?:vacation|trip|travel(?:ing|ling)?|holiday|cruise|walk(?:ing)?|run(?:ning)?|jog(?:ging)?|hik(?:e|ing)|gym|workout|exercis|standing|on[\s-]?my[\s-]?feet|all[\s-]?day|10[\s-]?hour|shifts?|work|office|wedding|formal|dressy|party|gala|casual|everyday|beach|pool|garden(?:ing)?|concrete|nurse|nursing|teacher|retail)\b/i;

const COLOR_WORD_RE =
  /\b(?:black|white|ivory|cream|navy|blue|red|burgundy|wine|pink|blush|rose|fuchsia|coral|green|olive|sage|tan|beige|nude|taupe|khaki|brown|chocolate|cognac|camel|bronze|copper|gold|silver|pewter|grey|gray|charcoal|champagne|mauve|lavender|purple|plum|yellow|mustard|orange)\b/i;

export function messageStatesCondition(message) {
  return CONDITION_WORD_RE.test(String(message || ""));
}
export function messageStatesUseCase(message) {
  return USECASE_WORD_RE.test(String(message || ""));
}
export function messageStatesColor(message) {
  return COLOR_WORD_RE.test(String(message || ""));
}
export function messageStatesCategory(message, category) {
  const cats = detectCategoryNouns(message);
  if (!category) return cats.length > 0;
  const want = String(category || "").toLowerCase();
  return cats.some((c) => c === want || c.includes(want) || want.includes(c));
}

// Scope the classifier's attributes to THIS turn. On a follow-up, keep them all.
// On a new independent ask, keep ONLY the attributes the latest message itself
// supports — stale category/color/condition/use-case from a prior turn are
// dropped so they can't filter or misdirect the new search. (Gender is left
// alone — it's reconciled separately and is sticky by design.)
export function scopeAttributesToTurn(attrs = {}, message = "", { isFollowUp = false } = {}) {
  const out = { ...(attrs || {}) };
  if (isFollowUp) return out;
  const m = String(message || "");
  if (out.condition && !messageStatesCondition(m)) out.condition = null;
  if (out.useCase && !messageStatesUseCase(m)) out.useCase = null;
  if (out.color && !messageStatesColor(m)) out.color = null;
  if (out.category && !messageStatesCategory(m, out.category)) out.category = null;
  return out;
}

// ── Short / ambiguous replies ──
// Content-free replies that only make sense as the answer to an ACTIVE pending
// question — never enough to infer a condition or product path on their own.
const SHORT_AMBIGUOUS_RE =
  /^(?:not\s*sure|i'?m\s*not\s*sure|maybe|i\s*(?:don'?t|do\s*not)\s*know|i\s*dunno|dunno|idk|no\s*idea|unsure|i\s*guess|i'?m\s*not\s*certain|perhaps|hmm+|umm*|whatever|no\s*preference|either(?:\s*one)?|both|any|anything|doesn'?t\s*matter|n\/?a)\.?\??$/i;

export function isShortAmbiguousReply(message) {
  const m = String(message || "").trim();
  if (!m) return false;
  if (m.split(/\s+/).filter(Boolean).length > 4) return false;
  return SHORT_AMBIGUOUS_RE.test(m);
}
