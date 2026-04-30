function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function phraseMatches(text, phrase) {
  const raw = String(phrase || "").trim();
  if (!raw) return false;
  const escaped = escapeRegex(raw);
  const withS = /s$/i.test(raw)
    ? `(?:${escaped}|${escapeRegex(raw.slice(0, -1))})`
    : `${escaped}(?:s|es)?`;
  return new RegExp(`\\b${withS}\\b`, "i").test(String(text || ""));
}

export function compactGroup(group) {
  if (!group) return null;
  return {
    name: String(group.name || "").trim(),
    categories: Array.isArray(group.categories)
      ? group.categories.map((c) => String(c || "").trim()).filter(Boolean)
      : [],
    triggers: Array.isArray(group.triggers)
      ? group.triggers.map((t) => String(t || "").trim()).filter(Boolean)
      : [],
    // Optional containment relationship: name of another group that
    // products in this group go INSIDE of. Lets the AI infer intent
    // from phrases like "for heel pain that goes inside my shoes" —
    // active = group with goesInsideOf=Footwear. Per-merchant data,
    // not hardcoded vocabulary.
    goesInsideOf: String(group.goesInsideOf || "").trim() || null,
  };
}

export function groupTerms(group, { includeTriggers = true } = {}) {
  if (!group) return [];
  const terms = [
    group.name,
    ...(Array.isArray(group.categories) ? group.categories : []),
    ...(includeTriggers && Array.isArray(group.triggers) ? group.triggers : []),
  ];
  return terms.map((t) => String(t || "").trim()).filter(Boolean);
}

export function matchingGroupsForText(text, groups, opts = {}) {
  const source = String(text || "");
  if (!source || !Array.isArray(groups)) return [];
  return groups.filter((group) =>
    groupTerms(group, opts).some((term) => phraseMatches(source, term)),
  );
}

export function sameGroup(a, b) {
  if (!a || !b) return false;
  const an = String(a.name || "").trim().toLowerCase();
  const bn = String(b.name || "").trim().toLowerCase();
  if (an && bn) return an === bn;
  const ac = new Set((a.categories || []).map((c) => String(c).toLowerCase()));
  return (b.categories || []).some((c) => ac.has(String(c).toLowerCase()));
}

function isShortChoice(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5;
}

function hasExplicitPivotIntent(text) {
  return /\b(show|find|search|shop|buy|get|need|want|looking for|recommend|suggest)\b/i.test(String(text || ""));
}

// "X inside/into/with Y" containment intent — both X and Y resolve to
// distinct merchant-configured groups via their name/categories/triggers.
// Generalizes from "orthotics inside shoes" to any vertical:
// "phone case for iPhone" → active=Cases, context=Phones.
// "lens for camera" → active=Lenses, context=Cameras.
//
// Pure data-driven: there is no hardcoded list of "insert-like" or
// "footwear-like" terms — the merchant's category groups define the
// vocabulary.
const CONTAINMENT_RE = /\b(inside|into|put in|wear inside|fit inside|fits? in|goes? in|underfoot|to go in|to fit in|to put in)\b/;

function groupHitInRange(text, group, fromIdx, toIdx) {
  const source = String(text || "").toLowerCase();
  let best = -1;
  for (const term of groupTerms(group, { includeTriggers: true })) {
    const needle = String(term || "").toLowerCase();
    if (!needle) continue;
    let from = fromIdx ?? 0;
    while (from <= (toIdx ?? source.length)) {
      const idx = source.indexOf(needle, from);
      if (idx < 0 || idx >= (toIdx ?? source.length)) break;
      if (best < 0 || idx < best) best = idx;
      from = idx + 1;
    }
  }
  return best;
}

function inferContainmentIntent(text, groups) {
  const source = String(text || "").toLowerCase();
  const m = source.match(CONTAINMENT_RE);
  if (!m) return null;
  const insideIdx = source.indexOf(m[0]);

  // Per group, check separately whether any term hits BEFORE or AFTER
  // the containment word. A single group can hit on both sides (e.g.
  // Footwear via "heel pain ... inside my shoes") — we need both, not
  // just earliest-overall.
  const sided = (groups || []).map((g) => ({
    group: g,
    beforeIdx: groupHitInRange(source, g, 0, insideIdx),
    afterIdx: groupHitInRange(source, g, insideIdx, source.length),
  }));

  // Container preference: a group named directly AFTER the containment
  // word ("inside my shoes") wins. If none, fall back to a group
  // mentioned anywhere in the text that has at least one declared
  // insert (goesInsideOf=this group). That handles "support inside
  // them" where "them" is a pronoun referring to a Footwear term in a
  // prior sentence.
  let containerGroup = null;
  const afterHits = sided.filter((s) => s.afterIdx >= 0).sort((a, b) => a.afterIdx - b.afterIdx);
  if (afterHits.length > 0) {
    containerGroup = afterHits[0].group;
  } else {
    const candidates = sided.filter((s) => {
      const mentioned = s.beforeIdx >= 0 || s.afterIdx >= 0;
      if (!mentioned) return false;
      const candidateName = String(s.group?.name || "").toLowerCase();
      return (groups || []).some(
        (g) =>
          String(g?.goesInsideOf || "").toLowerCase() === candidateName &&
          !sameGroup(g, s.group),
      );
    });
    if (candidates.length === 1) containerGroup = candidates[0].group;
  }
  if (!containerGroup) return null;

  // Explicit case: a DIFFERENT group is named BEFORE the containment
  // word — that's the active product. "Insoles for loafers" /
  // "orthotics inside shoes".
  const beforeOther = sided
    .filter((s) => s.beforeIdx >= 0 && !sameGroup(s.group, containerGroup))
    .sort((a, b) => a.beforeIdx - b.beforeIdx);
  if (beforeOther.length > 0) {
    return { activeGroup: beforeOther[0].group, contextGroup: containerGroup };
  }

  // Implicit case: user only named the container ("for heel pain that
  // goes inside my shoes"). The container has the answer encoded in
  // admin data: a group declaring goesInsideOf=<containerName> is the
  // implied active product. Pure data — merchant configures the
  // containment relationship in Rules & Knowledge.
  const containerName = String(containerGroup.name || "").toLowerCase();
  const insertCandidates = (groups || []).filter((g) => {
    const inside = String(g?.goesInsideOf || "").toLowerCase();
    return inside && inside === containerName && !sameGroup(g, containerGroup);
  });
  if (insertCandidates.length === 1) {
    return { activeGroup: insertCandidates[0], contextGroup: containerGroup };
  }
  return null;
}

function earliestGroupHit(text, group) {
  const source = String(text || "").toLowerCase();
  let best = -1;
  for (const term of groupTerms(group, { includeTriggers: true })) {
    const needle = String(term || "").toLowerCase();
    if (!needle) continue;
    const idx = source.indexOf(needle);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

function inferForContextIntent(text, matchedGroups) {
  const source = String(text || "").toLowerCase();
  if (!source || !Array.isArray(matchedGroups) || matchedGroups.length !== 2) return null;
  if (/\b(or|versus|vs\.?|instead|rather than|not sure)\b/.test(source)) return null;
  const forIdx = source.search(/\bfor\b/);
  if (forIdx < 0) return null;

  const hits = matchedGroups
    .map((group) => ({ group, idx: earliestGroupHit(source, group) }))
    .filter((hit) => hit.idx >= 0)
    .sort((a, b) => a.idx - b.idx);
  if (hits.length !== 2) return null;
  if (hits[0].idx < forIdx && hits[1].idx > forIdx) {
    return { activeGroup: hits[0].group, contextGroup: hits[1].group };
  }
  return null;
}

function previousAssistantFor(messages, userIndex) {
  for (let i = userIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && typeof msg.content === "string") return msg.content;
    if (msg?.role === "user") break;
  }
  return "";
}

function assistantFramesGroupAsContext(assistantText, contextGroup, activeGroup) {
  const text = String(assistantText || "");
  if (!text || !contextGroup || !activeGroup) return false;

  const mentionsContextGroup = matchingGroupsForText(text, [contextGroup], { includeTriggers: true }).length === 1;
  const mentionsActiveGroup = matchingGroupsForText(text, [activeGroup], { includeTriggers: false }).length === 1;
  const refersToActiveByPronoun = /\b(them|it|those|that|fit|fits|inside)\b/i.test(text);

  // Question-shape "what <contextGroup-term> do you wear/use/fit...".
  // Derive the term alternation from the contextGroup itself instead of
  // hardcoding domain words — so jewelry merchants ("which finger size do
  // you wear...") work the same as footwear ones.
  let asksContextQuestion = false;
  const contextTerms = groupTerms(contextGroup, { includeTriggers: true })
    .map((t) => escapeRegex(String(t || "").trim().toLowerCase()))
    .filter(Boolean);
  if (contextTerms.length > 0) {
    const re = new RegExp(
      `\\b(what|which|type|kind).{0,40}\\b(${contextTerms.join("|")}).{0,60}\\b(wear|wears|worn|use|uses|fit|fits|inside|match|matches|for)\\b`,
      "i",
    );
    asksContextQuestion = re.test(text);
  }

  return mentionsContextGroup && (mentionsActiveGroup || refersToActiveByPronoun || asksContextQuestion);
}

function inferUserIntentFromText(text, groups) {
  const insideIntent = inferContainmentIntent(text, groups);
  if (insideIntent) return { ...insideIntent, ambiguous: false };

  const matches = matchingGroupsForText(text, groups, { includeTriggers: true });
  const forIntent = inferForContextIntent(text, matches);
  if (forIntent) return { ...forIntent, ambiguous: false };

  if (matches.length === 1) return { activeGroup: matches[0], contextGroup: null, ambiguous: false };
  if (matches.length > 1) return { activeGroup: null, contextGroup: null, ambiguous: true };
  return { activeGroup: null, contextGroup: null, ambiguous: false };
}

function priorIntentBefore(messages, groups, beforeIndex) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user" || typeof msg.content !== "string") continue;

    const intent = inferUserIntentFromText(msg.content, groups);
    if (!intent.activeGroup && !intent.ambiguous) continue;
    if (intent.ambiguous) return intent;

    const earlier = priorIntentBefore(messages, groups, i);
    const assistantText = previousAssistantFor(messages, i);
    if (
      earlier.activeGroup &&
      !sameGroup(intent.activeGroup, earlier.activeGroup) &&
      isShortChoice(msg.content) &&
      !hasExplicitPivotIntent(msg.content) &&
      assistantFramesGroupAsContext(assistantText, intent.activeGroup, earlier.activeGroup)
    ) {
      return {
        activeGroup: earlier.activeGroup,
        contextGroup: intent.activeGroup,
        ambiguous: false,
      };
    }

    return intent;
  }
  return { activeGroup: null, contextGroup: null, ambiguous: false };
}

export function analyzeCategoryIntent(messages, merchantGroups) {
  const groups = Array.isArray(merchantGroups)
    ? merchantGroups.map(compactGroup).filter((g) => g && (g.name || g.categories.length || g.triggers.length))
    : [];
  if (groups.length === 0) return { activeGroup: null, contextGroup: null, ambiguous: false };

  const latestUserIndex = messages.map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "user" && typeof m.content === "string")?.i ?? -1;
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : null;
  const previousAssistantText = previousAssistantFor(messages, latestUserIndex);

  const latestMatches = matchingGroupsForText(latestUser?.content || "", groups, { includeTriggers: true });
  const latestUnambiguous = latestMatches.length === 1 ? latestMatches[0] : null;
  const latestAmbiguous = latestMatches.length > 1;
  const containmentIntent = inferContainmentIntent(latestUser?.content || "", groups);
  const forContextIntent = inferForContextIntent(latestUser?.content || "", latestMatches);

  if (containmentIntent) {
    return { ...containmentIntent, ambiguous: false };
  }
  if (forContextIntent) {
    return { ...forContextIntent, ambiguous: false };
  }

  const priorIntent = priorIntentBefore(messages, groups, latestUserIndex);
  const priorActive = priorIntent.activeGroup;
  const priorAmbiguous = priorIntent.ambiguous;

  if (latestUnambiguous && priorActive && !sameGroup(latestUnambiguous, priorActive)) {
    if (
      isShortChoice(latestUser?.content || "") &&
      !hasExplicitPivotIntent(latestUser?.content || "") &&
      assistantFramesGroupAsContext(previousAssistantText, latestUnambiguous, priorActive)
    ) {
      return {
        activeGroup: priorActive,
        contextGroup: latestUnambiguous,
        ambiguous: false,
      };
    }
  }

  if (latestUnambiguous) return { activeGroup: latestUnambiguous, contextGroup: null, ambiguous: false };
  if (latestAmbiguous) return { activeGroup: null, contextGroup: null, ambiguous: true };
  if (priorActive && !priorAmbiguous) {
    return { activeGroup: priorActive, contextGroup: priorIntent.contextGroup || null, ambiguous: false };
  }
  return { activeGroup: null, contextGroup: null, ambiguous: priorAmbiguous };
}

// Returns true when `text` clearly belongs to a different merchant group
// than `lockedGroup` — i.e. the text matches at least one OTHER group's
// terms and does NOT match the locked group's terms.
//
// Used by the search and render layers to decide whether to skip a stale
// active-group filter. Pure data-driven: no hardcoded vertical vocabulary.
// For Aetrex: search query "orthotic insole" while activeGroup=Footwear
//   diverges → caller skips the Footwear filter.
// For a jewelry merchant: "ring for my wife" while activeGroup=Necklaces
//   diverges → caller skips the Necklaces filter.
//
// `groups` should be the full merchant-configured group list (compacted
// or raw — both work because matchingGroupsForText is tolerant).
export function textIntentDivergesFromGroup(text, lockedGroup, groups) {
  if (!lockedGroup || !Array.isArray(groups) || groups.length === 0) return false;
  const matched = matchingGroupsForText(text, groups, { includeTriggers: true });
  if (matched.length === 0) return false;
  if (matched.some((g) => sameGroup(g, lockedGroup))) return false;
  return true;
}

export function cardMatchesActiveGroup(card, activeGroup) {
  if (!activeGroup || !Array.isArray(activeGroup.categories) || activeGroup.categories.length === 0) return true;
  const cardCategory = String(card?._category || "").toLowerCase().trim();
  if (!cardCategory) return true;
  return activeGroup.categories.some((cat) => {
    const c = String(cat || "").toLowerCase().trim();
    return c && (cardCategory === c || cardCategory.includes(c) || c.includes(cardCategory));
  });
}
