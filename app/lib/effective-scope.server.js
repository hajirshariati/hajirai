// EFFECTIVE SEARCH SCOPE — the ONE scope object every search/relevance path
// must consume after TurnPlan + resolveTurnIntent.
//
// Boundary problem this fixes: TurnScope correctly wiped stale attrs from
// session memory, but the downstream search-query builder, relevance floor, and
// category guard kept reading the (stale) classifier/session/history/LLM-query
// text — so "Wait, show me shoes instead, not orthotics." still produced
// query="women's sneakers walking". The cure is a single source of truth:
//   - on a RESET/PIVOT turn the scope is CURRENT-MESSAGE-ONLY (plus a stable
//     gender fallback);
//   - on a follow-up it inherits the prior scope as before.
// Every builder reads THIS, never the raw stale sources.

import { extractUserConstraints } from "./catalog-resolver.server.js";
import { parseCategoryConstraints } from "./chat-postprocessing.js";
import { parseAvailabilityConstraints } from "./availability-truth.js";

// A RESET / PIVOT this turn — the customer is changing direction, so prior
// use-case / condition / family / variant constraints no longer apply unless
// the current message restates them.
const PIVOT_RESET_RE =
  /\b(?:instead|actually|wait\b|never\s*mind|changed?\s+my\s+mind|now\s+(?:show|i\s+want|let'?s|give)|only\s+show|just\s+show|forget\s+(?:the|that|it|about)|scratch\s+that|start\s+over|different\s+(?:thing|idea)|on\s+second\s+thought)\b/i;
export function isPivotResetTurn(message) {
  return PIVOT_RESET_RE.test(String(message || ""));
}

// Scope words that must only ride along when the CURRENT message states them.
// (Specific footwear categories, active use-cases, conditions, widths.) Generic
// "shoes"/"footwear" are NOT here — they're a legitimate current positive.
const SCOPE_LEAK_WORD_RE = new RegExp(
  [
    "walking", "running", "runner", "jogging", "hiking", "trail", "gym", "training", "workout", "athletic", "outdoor",
    "sneakers?", "trainers?", "sandals?", "boots?", "wedges?", "heels?", "loafers?", "clogs?", "flats", "mules?", "slippers?", "oxfords?",
    "wide", "narrow", "extra[\\s-]?wide",
    "heel\\s+pain", "plantar", "fasciitis", "flat\\s+(?:feet|foot)", "fallen\\s+arch(?:es)?", "low\\s+arch(?:es)?", "high\\s+arch(?:es)?",
    "bunions?", "neuroma", "metatarsalgia", "overpronation", "supination", "diabetic", "orthotics?", "insoles?",
  ].join("|"),
  "gi",
);

function msgMentions(msgLower, token) {
  const t = String(token || "").toLowerCase().trim();
  if (!t) return false;
  if (/\s/.test(t)) return msgLower.includes(t); // multi-word phrase
  const stem = t.endsWith("s") ? t.slice(0, -1) : t;
  return msgLower.includes(stem);
}

// THE effective scope. `ctx.turnScope` ("new_independent" | "follow_up") and
// `ctx.inheritedScope` (the prior currentCatalogScopeFromContext result) are
// supplied by the chat route; everything else is parsed from the current
// message. Pure + testable.
export function effectiveScopeForSearch(ctx = {}) {
  const message = String(ctx.latestUserMessage || "");
  const cur = extractUserConstraints(message);
  const cats = parseCategoryConstraints(message);
  const avail = parseAvailabilityConstraints(message, Array.isArray(ctx.catalogColorList) ? ctx.catalogColorList : []);
  const pivot = ctx.turnScope === "new_independent" || isPivotResetTurn(message);
  const stableGender = cur.gender || ctx.sessionGender || null;
  const rejectedCategories = [...cats.rejected];

  if (pivot) {
    // CURRENT-MESSAGE-ONLY. Stale walking / sneakers / heel pain / wide /
    // families never survive a pivot — only what the customer just said (plus a
    // stable gender, which is allowed).
    return {
      pivot: true,
      gender: stableGender,
      category: cur.category || null,
      rejectedCategories,
      color: cur.color || avail.color || null,
      size: avail.size || null,
      width: avail.width || null,
      condition: cur.condition || null,
      useCase: cur.useCase || null,
      families: [],
    };
  }

  // Follow-up: inherit the prior scope, with the current message taking
  // precedence where it speaks. (Mirrors the legacy currentCatalogScopeFromContext
  // behavior; size/width still current-only per memory-hygiene rules.)
  const inh = ctx.inheritedScope || {};
  return {
    pivot: false,
    gender: inh.gender || stableGender,
    category: inh.category || cur.category || null,
    rejectedCategories,
    color: inh.color || cur.color || avail.color || null,
    size: avail.size || null,
    width: avail.width || null,
    condition: inh.condition || cur.condition || null,
    useCase: cur.useCase || inh.useCase || null,
    families: Array.isArray(inh.families) ? inh.families : [],
  };
}

// INVARIANT detector (pivot_search_scope_leak): on a RESET/PIVOT turn, the
// FINAL generated search request (query + filters + relevance-floor category +
// category guard) must contain no scope constraint that the current message did
// not state. Returns the array of leaked tokens (empty when clean). This catches
// the exact bad case — message "Wait, show me shoes instead, not orthotics.",
// query "women's sneakers walking" → ["sneakers","walking"].
export function pivotSearchScopeLeak({ message = "", query = "", filters = {}, relevanceFloorCategory = "", knownColors = [] } = {}) {
  const msg = String(message || "").toLowerCase();
  const f = filters || {};
  const haystack = [query, relevanceFloorCategory, f.category, f.condition, f.width, f.useCase]
    .filter(Boolean).join(" ").toLowerCase();
  const leaks = new Set();
  SCOPE_LEAK_WORD_RE.lastIndex = 0;
  for (let m; (m = SCOPE_LEAK_WORD_RE.exec(haystack)) !== null; ) {
    const tok = m[0].toLowerCase();
    if (!msgMentions(msg, tok)) leaks.add(tok);
  }
  // a color filter the message never named
  if (f.color) {
    const c = String(f.color).toLowerCase();
    if (!msg.includes(c)) {
      const known = (knownColors || []).map((x) => String(x).toLowerCase());
      if (known.length === 0 || known.includes(c)) leaks.add(c);
    }
  }
  return [...leaks];
}
