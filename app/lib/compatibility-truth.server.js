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
    "\\bdrops?\\s+(?:right\\s+)?in(?:to)?\\b",
    "\\blift[s]?\\s+out\\b",
    "\\bmake[s]?\\s+room\\s+for\\s+(?:the\\s+|an?\\s+|your\\s+)?orthotics?",
    "\\borthotic[-\\s]compatible\\s+sandals?",
    "\\bpop\\s+(?:the\\s+)?orthotics?\\s+in(?:to)?\\b",
    // VERB phrasings: orthotic … {drop/slide/slip/fit/go/put/insert/place/tuck/set}
    //   … {in/into/inside} … sandal/open footwear. The literal "orthotics in
    //   sandals" rule above misses these because a verb sits between the noun and
    //   the preposition (live miss: "the orthotic drops into the sandal", "slip
    //   your orthotic into these sandals").
    "\\borthotics?\\b[^.?!]{0,40}\\b(?:drops?|slides?|slips?|fits?|go(?:es)?|put|inserts?|places?|tucks?|sets?)\\b[^.?!]{0,20}\\b(?:in|into|inside)\\b[^.?!]{0,30}\\b(?:sandals?|slides?|flip[-\\s]?flops?|open[-\\s]?toe[ds]?)\\b",
    // Same shape, verb BEFORE the noun ("slip your orthotic into these sandals").
    "\\b(?:drops?|slides?|slips?|fits?|put|inserts?|places?|tucks?|sets?|pops?|wear)\\b[^.?!]{0,20}\\borthotics?\\b[^.?!]{0,20}\\b(?:in|into|inside)\\b[^.?!]{0,30}\\b(?:sandals?|slides?|flip[-\\s]?flops?|open[-\\s]?toe[ds]?)\\b",
    // Reverse: sandal/open footwear … {take/hold/fit/accommodate/has room for} … orthotic.
    "\\b(?:sandals?|slides?|flip[-\\s]?flops?|open[-\\s]?toe[ds]?)\\b[^.?!]{0,40}\\b(?:takes?|holds?|fits?|accommodates?|has\\s+room\\s+for|make[s]?\\s+room\\s+for)\\b[^.?!]{0,20}\\borthotics?\\b",
  ].join("|"),
  "i",
);

// Negators that flip an otherwise-positive compatibility claim into the CORRECT
// Aetrex statement ("I would NOT put orthotics in sandals", "these sandals do
// NOT have a removable footbed"). Such clauses must never be flagged.
const COMPAT_NEGATOR_RE =
  /\b(?:not|n['’]t|never|avoid|without|cannot|can['’]?t|won['’]?t|don['’]?t|doesn['’]?t|shouldn['’]?t|wouldn['’]?t|isn['’]?t|aren['’]?t)\b/i;

// True when the reply ASSERTS an unsupported compatibility claim. Evaluated per
// clause so a negated clause doesn't license a positive-claim rule living in a
// different clause of the same reply, and so a correctly-negated answer ("I
// wouldn't put orthotics in sandals") is never blocked.
export function containsUnsupportedCompatibilityClaim(text) {
  const clauses = String(text || "").split(/[.?!;\n]+|\bbut\b|\bhowever\b|\binstead\b/i);
  for (const clause of clauses) {
    if (!clause.trim()) continue;
    if (COMPAT_NEGATOR_RE.test(clause)) continue; // negated → correct statement, not a violation
    if (UNSUPPORTED_COMPAT_CLAIM_RE.test(clause)) return true;
  }
  return false;
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

// ── SHOES-vs-ORTHOTICS open decision ──────────────────────────────────────────
// "I have plantar fasciitis. What Aetrex shoes or orthotics would you recommend?"
// The customer hasn't decided between a supportive SHOE and a removable ORTHOTIC.
// Dumping a random shoe + a random orthotic (often the unisex ESD anti-static one,
// the only orthotic that survives the gender filter in a women-heavy catalog) is a
// poor answer. Explain the difference and let them pick the flow with chips.
const FOOTWEAR_TERM_RE = /\b(?:shoes?|sneakers?|footwear|sandals?|boots?|loafers?|flats?|heels?|slippers?|clogs?)\b/i;
const ORTHOTIC_TERM_RE = /\b(?:orthotics?|insoles?|inserts?|footbeds?|arch\s+supports?)\b/i;
// Open-choice framing: a connector between the two, or a recommend/decision verb.
const DECISION_FRAME_RE = /\b(?:or|recommend|should\s+i|which|what\s+(?:should|do|would|kind|type)|help\s+me|better|vs\.?|versus|difference\s+between)\b/i;

// True when THIS message asks to choose between supportive shoes and orthotics.
// Excludes the orthotic↔sandal COMPATIBILITY question ("can I wear orthotics
// inside sandals, or closed shoes?"), which compatibility-truth owns — that is a
// product-truth question, not a which-should-I-buy decision.
export function isShoesVsOrthoticsDecision(text) {
  const t = String(text || "");
  if (isOrthoticSandalCompatibilityQuestion(t)) return false;
  return FOOTWEAR_TERM_RE.test(t) && ORTHOTIC_TERM_RE.test(t) && DECISION_FRAME_RE.test(t);
}

// The deterministic explain-the-difference answer with choose-your-flow chips.
// The chip LABELS are self-routing: "supportive shoes" → condition_recommendation,
// "choose an orthotic" → the guided orthotic finder (which asks gender once).
export function buildShoesVsOrthoticsAnswer() {
  return (
    "Good question! Here's the difference: Aetrex shoes come with built-in arch " +
    "support — the simplest choice if you want comfort right out of the box. Aetrex " +
    "orthotics are removable insoles you add to shoes you already own (or new ones) " +
    "for customized support. Which would you like to explore?\n\n" +
    "<<Help me find supportive shoes>><<Help me choose an orthotic>>"
  );
}

// True when the customer EXPLICITLY wants the guided orthotic finder ("help me
// choose the right orthotic", "which orthotic should I get") — and is NOT also
// asking about shoes (that is the shoes-vs-orthotics decision above). Lets the
// orthotic gate ask the gender chips directly in ONE step instead of the LLM
// first asking a vague "for you or someone else?".
export function isGuidedOrthoticFinderRequest(text) {
  const t = String(text || "");
  if (!ORTHOTIC_TERM_RE.test(t)) return false;
  if (FOOTWEAR_TERM_RE.test(t)) return false; // shoes mentioned → decision, not pure finder
  return /\b(?:help\s+me\s+(?:choose|find|pick|select)|choose|find|pick|recommend|which|what)\b[^.?!]*\borthotics?\b|\borthotics?\b[^.?!]*\b(?:recommend|help|choose|right\s+one|for\s+me)\b/i.test(t);
}
