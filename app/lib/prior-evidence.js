// Prior-evidence availability — pure helpers for the
// workflow=prior_evidence_availability owner (a color/size/width follow-up
// applied to the SET of products the customer was just shown). Kept pure (no
// DB / Anthropic) so the answer text and the card-ownership invariants are
// unit-tested directly. chat.jsx does the per-family variant resolution and
// card remap; this module owns the deterministic phrasing + the contract checks.

export function titleCaseWord(s) {
  const w = String(s || "").trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

export function numberWordOf(n) {
  return ["zero", "one", "two", "three", "four", "five", "six"][n] || String(n);
}

export function joinNames(names) {
  const a = (names || []).filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
}

// Deterministic answer for a prior_evidence_availability turn: which of the
// previously-shown products are available under the new constraint, which are
// not. Matches the carousel (only the available prior products are pinned).
//   items: [{ name, ok }]  askedLabel: "in black" | "in size 8" | "in wide"
//   isColor: true when the asked constraint is a color (verb conjugation)
export function buildPriorEvidenceAvailabilityText(items, askedLabel, isColor) {
  const ok = (items || []).filter((i) => i.ok).map((i) => i.name);
  const no = (items || []).filter((i) => !i.ok).map((i) => i.name);
  const total = (items || []).length;
  const vS = isColor ? "comes" : "is available";
  const vP = isColor ? "come" : "are available";
  if (ok.length === 0) {
    return `I'm not seeing any of those ${askedLabel} right now — want me to look for similar alternatives?`;
  }
  if (no.length === 0) {
    if (total === 1) return `Yes — ${ok[0]} ${vS} ${askedLabel}.`;
    const allPhrase = total === 2 ? "both" : `all ${numberWordOf(total)}`;
    return `Yes — ${allPhrase} ${vP} ${askedLabel}.`;
  }
  const okVerb = ok.length === 1 ? vS : vP;
  return `Yes — ${joinNames(ok)} ${okVerb} ${askedLabel}. I'm not seeing ${joinNames(no)} ${askedLabel} in the current catalog.`;
}

// Join colors with "and" (available list) or "or" (missing list), title-cased.
function joinColors(colors, conj) {
  const a = (colors || []).map(titleCaseWord).filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, ${conj} ${a[a.length - 1]}`;
}

// Deterministic answer for a MULTI-COLOR prior_evidence follow-up ("do either of
// those come in champagne or rose?"). For each prior family we know which of the
// requested colors it has and which it doesn't. Names every requested color
// honestly per family. perFamily: [{ name, available: [colors], missing: [colors] }]
export function buildPriorEvidenceMultiColorText(perFamily) {
  const sentences = (perFamily || []).map(({ name, available, missing }) => {
    const has = available || [];
    const lacks = missing || [];
    if (has.length > 0 && lacks.length === 0) {
      return `${name} comes in ${joinColors(has, "and")}.`;
    }
    if (has.length > 0 && lacks.length > 0) {
      return `${name} comes in ${joinColors(has, "and")}, but I'm not seeing ${joinColors(lacks, "or")}.`;
    }
    return `${name} does not come in ${joinColors(lacks, "or")}.`;
  });
  return sentences.join(" ");
}

// The constraint label for the asked dimension ("in Black" / "in size 8" /
// "in wide"). reqColor wins, then the asked size/width on THIS message, then an
// inherited size/width.
export function askedConstraintLabel({ reqColor, askedSize, askedWidth, inheritedSize, inheritedWidth } = {}) {
  if (reqColor) return `in ${titleCaseWord(reqColor)}`;
  if (askedSize) return `in size ${askedSize}`;
  if (askedWidth) return `in ${askedWidth}`;
  if (inheritedSize) return `in size ${inheritedSize}`;
  if (inheritedWidth) return `in ${inheritedWidth}`;
  return "in that";
}

// When a width/size availability follow-up ("what about wide widths?") matches
// NONE of the prior styles, we don't dead-end with zero cards — we search for
// alternatives that DO offer it. This is the honest framing line for that
// fallback. `label` is the asked width/size phrasing (e.g. "wide", "size 9");
// returns null when there are no alternatives to show (keep the plain "I'm not
// seeing those" text). Live trace 2026-06-30.
export function buildWidthSizeFallbackText(label, count) {
  if (!count || count < 1) return null;
  const what = String(label || "that width").trim();
  return count === 1
    ? `I don't see those exact styles in ${what}, but here's a ${what} option you might like.`
    : `I don't see those exact styles in ${what}, but here are ${what} options you might like.`;
}

// INVARIANT: on a prior_evidence_availability turn with cards shown, the owner
// must be the prior-evidence remap (or Availability Truth), never the scorer.
export function priorEvidenceCardOwnerViolation({ workflow, finalCards, cardOwner } = {}) {
  return (
    workflow === "prior_evidence_availability" &&
    finalCards > 0 &&
    cardOwner !== "prior-evidence" &&
    cardOwner !== "availability-truth"
  );
}

// INVARIANT: every final card must belong to a previously-shown family — no
// random alternate products. `familyOf` maps a card title → family token.
// Returns the stray cards (empty array = clean).
export function priorEvidenceStrayCards(finalCards, priorFamilies, familyOf) {
  const prior = new Set((priorFamilies || []).filter(Boolean));
  if (prior.size === 0) return [];
  return (finalCards || []).filter((c) => {
    const f = familyOf(c?.title || "");
    return f && !prior.has(f);
  });
}
