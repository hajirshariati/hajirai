// Deterministic evidence-card selection for advisory/condition recommendations.
// A condition_recommendation turn must show 2-3 well-chosen cards (not 6 from a
// broad scorer pass), and the cards must be the products the model actually
// named in its text. Pure so it can be unit-tested directly.

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
function escapeRe(s) {
  return String(s).replace(RE_ESCAPE, "\\$&");
}

// Pick up to `cap` distinct-family cards from the current-turn evidence `pool`,
// preferring the families/titles the answer `text` actually names. Returns the
// chosen card objects in priority order (named-first, then backfill).
//   familyOf(title) → the style-family token for a card title.
export function selectEvidenceCards(pool, text, { cap = 3, familyOf } = {}) {
  const cards = Array.isArray(pool) ? pool : [];
  const fam = typeof familyOf === "function" ? familyOf : () => "";
  const textLower = String(text || "").toLowerCase();
  const named = [];
  const rest = [];
  const seenFam = new Set();
  for (const c of cards) {
    const f = String(fam(c?.title || "") || "").toLowerCase();
    if (!f || seenFam.has(f)) continue;
    seenFam.add(f);
    const title = String(c?.title || "").toLowerCase();
    const isNamed =
      (title.length >= 5 && textLower.includes(title)) ||
      (f.length >= 4 && new RegExp(`\\b${escapeRe(f)}\\b`).test(textLower));
    (isNamed ? named : rest).push(c);
  }
  return [...named, ...rest].slice(0, Math.max(0, cap));
}
