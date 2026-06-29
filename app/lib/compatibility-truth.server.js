// Aetrex product-truth guard for workflow=compatibility.
//
// The LLM, asked "Can I wear orthotics inside sandals, or do I need closed
// shoes?", happily invents a removable-footbed sandal that drops the orthotic
// in (live trace, PRD 6c4a79d). The catalog layer KNEW the claim was unsupported
// — the follow-up "Show me Aetrex sandals with removable footbeds" was later
// dropped as catalog_intersection_empty — but only after the false claim shipped.
//
// Aetrex product truth:
//   - Do NOT say Aetrex orthotics go inside open sandals.
//   - Do NOT claim an Aetrex sandal has a removable footbed / enough depth for
//     an orthotic unless catalog/product evidence EXPLICITLY says so.
//   - For orthotics, recommend closed shoes / footwear with removable insoles or
//     enough depth.
//   - For sandals, recommend an Aetrex sandal with BUILT-IN arch support instead
//     of inserting an orthotic.
//
// These are pure, testable helpers — the deterministic owner (chat.jsx) and the
// grounding validator both key off the same rules so the codebase has ONE source
// of truth for "is this an unsupported orthotic↔sandal claim?".

// The QUESTION shape: orthotics/insoles + sandals/open footwear, in either order.
const ORTHOTIC_SANDAL_Q_RE =
  /\b(?:orthotics?|insoles?|inserts?|footbeds?|arch\s+supports?)\b[^.?!]*\b(?:sandals?|open[-\s]?toe[ds]?|open\s+shoes?|flip[-\s]?flops?|slides?)\b|\b(?:sandals?|open[-\s]?toe[ds]?|flip[-\s]?flops?|slides?)\b[^.?!]*\b(?:orthotics?|insoles?|inserts?|footbeds?)\b/i;

// True when THIS message is an orthotic↔sandal/open-footwear compatibility ask.
export function isOrthoticSandalCompatibilityQuestion(text) {
  return ORTHOTIC_SANDAL_Q_RE.test(String(text || ""));
}

// The single Aetrex-safe deterministic answer for that question.
export function buildOrthoticCompatibilityAnswer() {
  return (
    "For Aetrex orthotics, use them in closed shoes or footwear with removable " +
    "insoles/enough depth. I would not put them inside open sandals. If you want a " +
    "sandal, choose an Aetrex sandal with built-in arch support instead."
  );
}

// Catch-phrases that ASSERT an unsupported orthotic↔sandal compatibility. These
// are the shapes the LLM invents; none of them appear in the safe answer above
// (it says "removable insoles" for CLOSED shoes — never "removable footbed", and
// it never says orthotics go "inside sandals").
const UNSUPPORTED_COMPAT_CLAIM_RE = new RegExp(
  [
    "\\borthotics?\\s+(?:in|inside|into|in\\s+to)\\s+(?:open\\s+|your\\s+)?sandals?",
    "\\bsandals?\\s+(?:with|that\\s+have|featuring)\\s+(?:a\\s+)?removable\\s+foot\\s?beds?",
    "\\bremovable\\s+foot\\s?beds?\\b",
    "\\bdrops?\\s+(?:right\\s+)?in\\b",
    "\\blift[s]?\\s+out\\b",
    "\\bmake[s]?\\s+room\\s+for\\s+(?:the\\s+|an?\\s+|your\\s+)?orthotics?",
    "\\borthotic[-\\s]compatible\\s+sandals?",
    "\\bpop\\s+(?:the\\s+)?orthotics?\\s+in(?:to)?\\b",
  ].join("|"),
  "i",
);

// True when the reply contains an unsupported compatibility claim phrase.
export function containsUnsupportedCompatibilityClaim(text) {
  return UNSUPPORTED_COMPAT_CLAIM_RE.test(String(text || ""));
}

// EXPLICIT catalog/product evidence that a SPECIFIC product really is
// orthotic-compatible (removable footbed / removable insole / accommodates an
// orthotic / deep heel cup). Only when this is present may the claim be made —
// and then only for that product. Future catalog data that tags a sandal this
// way unlocks the claim automatically.
const COMPAT_EVIDENCE_RE =
  /\b(?:removable\s+foot\s?bed|removable\s+insole|removable\s+cushion|orthotic[-\s]compatible|orthotic[-\s]friendly|accommodates?\s+(?:an?\s+)?orthotics?|fits?\s+(?:an?\s+)?orthotics?|deep(?:er)?\s+(?:heel\s+)?cup\s+for\s+orthotics?|room\s+for\s+orthotics?)\b/i;

// Sandal / open-footwear product shape — the claim is specifically about whether
// a SANDAL takes an orthotic, so only a SANDAL'S evidence is relevant.
const SANDAL_PRODUCT_RE = /\b(?:sandals?|slides?|flip[-\s]?flops?|open[-\s]?toe[ds]?|thongs?)\b/i;

// Does this single card explicitly assert orthotic compatibility ON A SANDAL?
// A removable insole on a CLOSED shoe is irrelevant — orthotics already belong in
// closed shoes; the open question is sandals. So both must hold: the product is a
// sandal/open shoe AND it carries explicit removable-footbed/orthotic-compatible
// language. (Live trace 2026-06-29: 6 closed-shoe cards with "removable insole"
// in their copy wrongly unlocked the LLM's sandal claim.)
export function cardAssertsOrthoticCompatibility(card) {
  if (!card || typeof card !== "object") return false;
  const tags = Array.isArray(card.tags) ? card.tags.join(" ") : String(card.tags || "");
  const category = String(card.category || card._category || card.productType || "");
  const hayShape = [card.title, category, tags].filter(Boolean).join(" ");
  if (!SANDAL_PRODUCT_RE.test(hayShape)) return false;
  let facts = "";
  try { facts = JSON.stringify(card._variantFacts || card.variantFacts || {}); } catch { facts = ""; }
  const hay = [card.title, card.description, card._description, card.body_html, tags, facts]
    .filter(Boolean).join(" ");
  return COMPAT_EVIDENCE_RE.test(hay);
}

// Does ANY card in the evidence pool explicitly assert orthotic compatibility?
export function hasExplicitOrthoticCompatibleEvidence(cards) {
  return (Array.isArray(cards) ? cards : []).some(cardAssertsOrthoticCompatibility);
}

// Deterministic Aetrex-safe follow-up suggestions for this class. None of these
// reference a removable-footbed sandal (which the catalog doesn't have).
export const SAFE_COMPATIBILITY_SUGGESTIONS = [
  "Show me supportive sandals",
  "Show me orthotics for closed shoes",
  "Help me choose shoes vs orthotics",
];

// A follow-up suggestion we must NEVER emit on this class — it implies a product
// (a removable-footbed / orthotic-compatible sandal) the catalog can't satisfy.
const UNSAFE_SUGGESTION_RE = new RegExp(
  [
    "\\bsandals?\\b[^.?!]*\\b(?:removable\\s+foot\\s?beds?|removable\\s+insoles?|orthotic[-\\s]compatible|for\\s+(?:my\\s+|an?\\s+)?orthotics?)\\b",
    "\\borthotic[-\\s]compatible\\s+sandals?\\b",
    "\\b(?:fit|put|wear)\\s+orthotics?\\s+(?:in|inside|into)\\s+sandals?\\b",
  ].join("|"),
  "i",
);

// True when a suggestion implies an orthotic-compatible sandal — drop it.
export function isUnsafeCompatibilitySuggestion(text) {
  return UNSAFE_SUGGESTION_RE.test(String(text || ""));
}
