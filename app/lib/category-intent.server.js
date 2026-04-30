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

function isInsertLikeGroup(group) {
  const terms = groupTerms(group, { includeTriggers: true }).join(" ").toLowerCase();
  return /\b(orthotic|orthotics|insole|insoles|insert|inserts|footbed|arch support)\b/.test(terms);
}

function isFootwearLikeGroup(group) {
  const terms = groupTerms(group, { includeTriggers: true }).join(" ").toLowerCase();
  return /\b(shoe|shoes|footwear|sneaker|sneakers|boot|boots|sandal|sandals|loafer|loafers|slipper|slippers|clog|clogs|oxford|oxfords|slide|slides|mule|mules|wedge|wedges)\b/.test(terms);
}

function mentionsInsideFootwear(text) {
  const source = String(text || "").toLowerCase();
  const insideIntent = /\b(inside|into|put in|goes? in|wear inside|fit inside|fits? in|underfoot)\b/.test(source);
  const footwearObject = /\b(shoe|shoes|sneaker|sneakers|boot|boots|sandal|sandals|loafer|loafers|slipper|slippers|clog|clogs|oxford|oxfords|slide|slides|mule|mules|wedge|wedges|footwear)\b/.test(source);
  return insideIntent && footwearObject;
}

function inferInsideFootwearIntent(text, groups) {
  if (!mentionsInsideFootwear(text)) return null;
  const insertGroups = groups.filter(isInsertLikeGroup);
  const footwearGroups = groups.filter(isFootwearLikeGroup);
  if (insertGroups.length !== 1 || footwearGroups.length !== 1) return null;
  return { activeGroup: insertGroups[0], contextGroup: footwearGroups[0] };
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

export function analyzeCategoryIntent(messages, merchantGroups) {
  const groups = Array.isArray(merchantGroups)
    ? merchantGroups.map(compactGroup).filter((g) => g && (g.name || g.categories.length || g.triggers.length))
    : [];
  if (groups.length === 0) return { activeGroup: null, contextGroup: null, ambiguous: false };

  const latestUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  const previousMessages = messages.slice(0, Math.max(0, messages.lastIndexOf(latestUser)));
  const previousAssistant = [...previousMessages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");

  const latestMatches = matchingGroupsForText(latestUser?.content || "", groups, { includeTriggers: true });
  const latestUnambiguous = latestMatches.length === 1 ? latestMatches[0] : null;
  const latestAmbiguous = latestMatches.length > 1;
  const insideFootwearIntent = inferInsideFootwearIntent(latestUser?.content || "", groups);
  const forContextIntent = inferForContextIntent(latestUser?.content || "", latestMatches);

  if (insideFootwearIntent) {
    return { ...insideFootwearIntent, ambiguous: false };
  }
  if (forContextIntent) {
    return { ...forContextIntent, ambiguous: false };
  }

  let priorActive = null;
  let priorAmbiguous = false;
  for (let i = previousMessages.length - 1; i >= 0; i--) {
    const msg = previousMessages[i];
    if (!msg || msg.role !== "user" || typeof msg.content !== "string") continue;
    const insideIntent = inferInsideFootwearIntent(msg.content, groups);
    if (insideIntent) {
      priorActive = insideIntent.activeGroup;
      break;
    }
    const matches = matchingGroupsForText(msg.content, groups, { includeTriggers: true });
    const forIntent = inferForContextIntent(msg.content, matches);
    if (forIntent) {
      priorActive = forIntent.activeGroup;
      break;
    }
    if (matches.length > 1) {
      priorAmbiguous = true;
      break;
    }
    if (matches.length === 1) {
      priorActive = matches[0];
      break;
    }
  }

  if (latestUnambiguous && priorActive && !sameGroup(latestUnambiguous, priorActive)) {
    const previousAssistantText = previousAssistant?.content || "";
    const previousAssistantMentionsPrior = matchingGroupsForText(
      previousAssistantText,
      [priorActive],
      { includeTriggers: false },
    ).length === 1;
    const previousAssistantRefersToPrior = /\b(them|it|those|that|fit|fits|inside)\b/i.test(previousAssistantText);
    const previousAssistantFramesLatestAsContext = matchingGroupsForText(
      previousAssistantText,
      [latestUnambiguous],
      { includeTriggers: true },
    ).length === 1;
    if (
      isShortChoice(latestUser?.content || "") &&
      !hasExplicitPivotIntent(latestUser?.content || "") &&
      (previousAssistantMentionsPrior || previousAssistantRefersToPrior) &&
      previousAssistantFramesLatestAsContext
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
  if (priorActive && !priorAmbiguous) return { activeGroup: priorActive, contextGroup: null, ambiguous: false };
  return { activeGroup: null, contextGroup: null, ambiguous: priorAmbiguous };
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
