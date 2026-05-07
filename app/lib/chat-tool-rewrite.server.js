// Pre-dispatch tool-call rewrite pipeline.
//
// "Trust but verify" pattern: production AI agents shouldn't trust the
// LLM with structural signals. The customer's literal latest message is
// the high-confidence input; the AI's tool-call construction is a low-
// confidence intermediate. When the two disagree, the customer wins.
//
// Each rewrite below is a pure function:
//   (toolCall, ctx) → toolCall
// Falls through (returns input unchanged) when the rewrite doesn't
// apply. Composable in a chain.
//
// Vocabulary is data-driven from merchant config — no hardcoded
// category lists, color lists, or SKU patterns specific to any
// merchant. Color enumeration (loadMerchantColors) reads Prisma so it
// stays in chat.jsx; this module receives ctx._merchantColors as
// input. That keeps this module dependency-free and unit-testable.

// Negation detection lives in chat-helpers.server.js so gender detection
// and color injection share the same logic. Re-exported here so existing
// imports (eval harness, future modules) keep working from this module.
import { isPrecededByNegation } from "./chat-helpers.server.js";
export { isPrecededByNegation };

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
export function escapeRe(s) {
  return String(s).replace(RE_ESCAPE, "\\$&");
}

// Structural — works for any merchant whose SKUs have 1-2 letters then
// 3-5 digits with an optional trailing letter. Examples: L700, L700M,
// AB1234, T9999W. Not catalog-specific.
export const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

// ── stripStaleCategoriesOnScopeReset ─────────────────────────────────
// When the customer's latest message is open-ended ("anything",
// "everything", "any X", "show me whatever"), the AI sometimes carries
// a category from the prior turn into its search query. Strip category
// words that ARE in the AI's query but NOT in the customer's literal
// latest message. Vocabulary comes from the merchant's own
// categoryGroups.
const SCOPE_RESET_RE = /\b(anything|everything|any\s+\w+|all\s+(?:of\s+)?your|whatever|all\s+styles|every\s+\w+)\b/i;

export function stripStaleCategoriesOnScopeReset(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const latest = String(ctx.latestUserMessage || "").trim();
  if (!latest) return toolCall;
  if (!SCOPE_RESET_RE.test(latest)) return toolCall;

  const groups = Array.isArray(ctx.merchantGroups) ? ctx.merchantGroups : [];
  const categoryTokens = new Set();
  for (const g of groups) {
    for (const c of (g?.categories || [])) {
      const norm = String(c || "").trim().toLowerCase();
      if (!norm) continue;
      categoryTokens.add(norm);
      for (const tok of norm.split(/\s+/)) {
        if (tok.length >= 4) categoryTokens.add(tok);
      }
    }
  }
  if (categoryTokens.size === 0) return toolCall;

  const query = String(toolCall.input?.query || "");
  const userLower = latest.toLowerCase();
  let cleaned = query;

  for (const token of categoryTokens) {
    const tokenInUser = new RegExp(`\\b${escapeRe(token)}s?\\b`, "i").test(userLower);
    if (tokenInUser) continue;
    const stripRe = new RegExp(`\\b${escapeRe(token)}s?\\b`, "gi");
    cleaned = cleaned.replace(stripRe, " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (cleaned !== query.trim() && cleaned.length > 0) {
    console.log(`[chat] scope-reset: stripped stale categories — "${query}" → "${cleaned}"`);
    return { ...toolCall, input: { ...toolCall.input, query: cleaned } };
  }
  return toolCall;
}

// ── forceComparisonLookup ───────────────────────────────────────────
// When the customer's latest message contains 2+ SKU-like tokens AND a
// comparison verb, the AI sometimes combines them into a single
// search_products query and gets 0 results. Rewrite to lookup_sku per
// SKU.
const COMPARISON_VERB_RE = /\b(better|worse|which|compare|vs\.?|versus|difference|between)\b/i;

export function forceComparisonLookup(toolCall, ctx) {
  const latest = String(ctx.latestUserMessage || "");
  if (!latest) return toolCall;
  if (!COMPARISON_VERB_RE.test(latest)) return toolCall;

  const skus = (latest.match(SKU_PATTERN) || []).map((s) => s.toUpperCase());
  if (skus.length < 2) return toolCall;
  const uniqueSkus = Array.from(new Set(skus));
  if (uniqueSkus.length < 2) return toolCall;

  if (toolCall.name === "search_products") {
    console.log(`[chat] comparison-routing: detected ${uniqueSkus.length} SKUs + comparison verb → rewriting search_products to lookup_sku`);
    return { ...toolCall, name: "lookup_sku", input: { skus: uniqueSkus } };
  }
  if (toolCall.name === "lookup_sku") {
    const existing = Array.isArray(toolCall.input?.skus) ? toolCall.input.skus : [];
    const merged = Array.from(new Set([...existing.map((s) => String(s).toUpperCase()), ...uniqueSkus]));
    if (merged.length !== existing.length) {
      console.log(`[chat] comparison-routing: expanded lookup_sku from ${existing.length} → ${merged.length} SKUs`);
      return { ...toolCall, input: { ...toolCall.input, skus: merged } };
    }
  }
  return toolCall;
}

// ── injectStructuredColorFilter ────────────────────────────────────
// When the customer mentions a color value the merchant has actually
// tagged, inject as filters.color so the search runs the structured
// filter (and our existing relaxedFilters mechanism kicks in if no
// exact match exists). Color values come from the merchant's own
// attributesJson (loaded in chat.jsx via loadMerchantColors and
// cached on ctx._merchantColors). No hardcoded color list.
export function injectStructuredColorFilter(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const colors = ctx._merchantColors;
  if (!Array.isArray(colors) || colors.length === 0) return toolCall;
  const existingFilter = toolCall.input?.filters || {};
  if (existingFilter.color || existingFilter.Color) return toolCall;

  const latest = String(ctx.latestUserMessage || "").toLowerCase();
  if (!latest) return toolCall;

  // Longest-match-first so "hunter green" beats "green".
  const sorted = [...colors].sort((a, b) => b.length - a.length);
  for (const color of sorted) {
    const re = new RegExp(`\\b${escapeRe(color)}\\b`, "i");
    const m = re.exec(latest);
    if (!m) continue;
    if (isPrecededByNegation(latest, m.index)) {
      // Customer said "no red" / "forget red" / "anything but red".
      // Skip injection — the affirmative answer is somewhere else
      // in the message OR the customer is explicitly excluding this
      // color. Either way, don't filter ON the negated value.
      console.log(`[chat] color-inject: SKIP — "${color}" appears in negation context`);
      continue;
    }
    console.log(`[chat] color-inject: "${color}" detected in user text → filters.color`);
    return {
      ...toolCall,
      input: {
        ...toolCall.input,
        filters: { ...existingFilter, color },
      },
    };
  }
  return toolCall;
}

// ── injectLockedGender ──────────────────────────────────────────────
// The "ABSOLUTE GENDER LOCK" prompt rule asks the AI to pass
// filters.gender on every search once a gender is established. The AI
// complies most of the time but drifts on long conversations — by turn
// 15+ it sometimes drops the filter or flips it to the other gender.
// Customer then sees men's products after telling us "I'm a woman".
//
// Code-level enforcement: when ctx.sessionGender is set (latest USER
// message has a gender token, or the customer answered the gender
// chip), force-overlay it onto every product-touching tool call. AI
// compliance becomes irrelevant.
//
// We override even when the AI passed a value — the customer's latest
// stated gender always wins over the AI's recollection. The user-only
// detection in detectGenderFromHistory ensures sessionGender already
// reflects the customer's actual latest pivot.
export function injectLockedGender(toolCall, ctx) {
  const locked = ctx.sessionGender;
  if (!locked) return toolCall;

  if (toolCall.name !== "search_products" && toolCall.name !== "find_similar_products") {
    return toolCall;
  }

  const existingFilters = toolCall.input?.filters || {};
  const aiGender = String(existingFilters.gender || "").toLowerCase().trim();
  const lockedNorm = String(locked).toLowerCase().trim();
  if (aiGender === lockedNorm) return toolCall;

  // If the AI explicitly passed a kids gender, trust it. The session
  // gender detector only knows "men" / "women" and triggers on words
  // like "son" / "daughter" — but those are kids signals, not adult
  // ones. Overriding the AI's "kids" with the stale adult lock from
  // an earlier "for my husband" turn ships men's products to a child.
  const KIDS_TOKENS = new Set(["kids", "kid", "boys", "boy", "girls", "girl", "child", "children"]);
  if (KIDS_TOKENS.has(aiGender)) {
    console.log(`[chat] gender-lock: AI passed kids gender="${aiGender}"; respecting (locked="${lockedNorm}")`);
    return toolCall;
  }

  if (aiGender && aiGender !== lockedNorm) {
    console.log(`[chat] gender-lock: AI passed gender="${aiGender}" but customer is "${lockedNorm}" — overriding`);
  } else {
    console.log(`[chat] gender-lock: injecting gender="${lockedNorm}" into ${toolCall.name}`);
  }

  return {
    ...toolCall,
    input: {
      ...toolCall.input,
      filters: { ...existingFilters, gender: lockedNorm },
    },
  };
}

// ── injectOccasionCategory ──────────────────────────────────────────
// Semantic search returns embedding-similar products regardless of
// physical fit — slippers and walking shoes both score high on
// "comfort" / "support" / "cushioning". A slipper is the wrong product
// for an Italy walking trip even if descriptively similar.
//
// When the customer mentions an occasion that physically constrains
// footwear type (extended walking, marathon, wedding, beach, etc.) AND
// the AI didn't pick a category in its tool call, inject a category
// from the merchant's actual catalog using generic occasion-to-
// category-name patterns.
//
// Generic on both sides:
//   - Occasion regex: standard English phrases (trip/vacation/walking/
//     marathon/wedding/etc.). Works for any vertical.
//   - Category regex: standard fashion taxonomy keywords (sneaker/
//     athletic/heel/sandal/loafer/slipper). Matches against the
//     merchant's catalogCategories — never injects a category the
//     merchant doesn't have.
//
// Skip injection if:
//   - AI already chose a category
//   - Customer's message names a catalog category explicitly
//     ("walking sandals" → customer wants sandals; don't override
//     to sneakers)
const OCCASION_TO_CATEGORY_PATTERNS = [
  {
    name: "walking-active",
    occasionRe: /\b(trip|vacation|sightseeing|walking|on (?:my|your|our) feet|all day|hiking|exploring|tourist|tourism|disney|europe|italy|france|spain|cobblestone|cruise|amusement|standing all day|long walks?|busy day|on the go)\b/i,
    categoryRe: /sneaker|walking|athletic|sport|running|trainer/i,
  },
  {
    name: "running",
    occasionRe: /\b(running|jog|jogging|marathon|sprint|track|gym|workout|crossfit|hiit|fitness|treadmill)\b/i,
    categoryRe: /running|athletic|sneaker|trainer|sport/i,
  },
  {
    name: "indoor",
    occasionRe: /\b(bedtime|lounging|around the house|at home|cozy|nap|bedroom|relaxing|pajamas|movie night|indoors)\b/i,
    categoryRe: /slipper/i,
  },
  {
    name: "beach-pool",
    occasionRe: /\b(beach|pool|swimming|swim|water park|lake|ocean|sand|tropical|cabana)\b/i,
    categoryRe: /sandal|slide|flip[- ]?flop/i,
  },
  {
    name: "formal-dressy",
    occasionRe: /\b(wedding|formal|dressy|gala|prom|black[- ]tie|cocktail|reception|special occasion|fancy|evening event)\b/i,
    categoryRe: /heel|oxford|loafer|dress|wedge|pump|stiletto|mary[- ]?jane/i,
  },
  {
    name: "work-office",
    occasionRe: /\b(office|professional|business casual|business meeting|corporate|conference|board meeting|nine[- ]to[- ]five|9[- ]to[- ]5)\b/i,
    categoryRe: /loafer|oxford|dress|flat|heel|pump/i,
  },
];

export function injectOccasionCategory(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const filters = toolCall.input?.filters || {};
  if (filters.category || filters.Category) return toolCall;

  const latest = String(ctx.latestUserMessage || "");
  if (!latest) return toolCall;

  const cats = Array.isArray(ctx.catalogCategories) ? ctx.catalogCategories : [];
  if (cats.length === 0) return toolCall;

  // If customer explicitly named a catalog category, the AI should
  // honor that — don't override.
  const lower = latest.toLowerCase();
  const customerNamedCategory = cats.some((c) => {
    const norm = String(c || "").toLowerCase().trim();
    if (!norm || norm.length < 3) return false;
    try {
      return new RegExp(`\\b${escapeRe(norm)}s?\\b`, "i").test(lower);
    } catch {
      return false;
    }
  });
  if (customerNamedCategory) return toolCall;

  for (const { name, occasionRe, categoryRe } of OCCASION_TO_CATEGORY_PATTERNS) {
    if (!occasionRe.test(latest)) continue;
    const match = cats.find((c) => categoryRe.test(String(c)));
    if (match) {
      console.log(`[chat] occasion-category: "${name}" detected → filters.category="${match}"`);
      return {
        ...toolCall,
        input: { ...toolCall.input, filters: { ...filters, category: match } },
      };
    }
  }
  return toolCall;
}

// Compose the pipeline. Order matters slightly:
//   1. Comparison routing (might change tool name from search→lookup)
//   2. Scope reset (strips stale category from search query)
//   3. Color injection (adds structured color filter to search)
//   4. Gender lock (force-overlay customer-stated gender)
//   5. Occasion category (constrain to walking/dressy/etc. when AI
//      didn't pick a category and the occasion implies one)
// ── redirectOrthoticSearchToRecommender ────────────────────────────
// When the LLM calls search_products with an orthotic-shaped query
// AND a recommend_<intent> tool is registered for the shop,
// redirect to the recommender. Customer questions like "can I get
// orthotics separately", "do you have orthotics for sneakers",
// "what insole works for plantar fasciitis" parse as availability
// search to the LLM but should enter the guided recommender flow
// (gate fires, asks shoe type / condition / arch, resolver picks
// one deterministic SKU) rather than dump 6 lookalikes via
// semantic similarity.
//
// Strict matching to avoid false positives:
//   - Customer's latest message OR the LLM's query must contain a
//     standalone orthotic-domain word ("orthotic"/"orthotics"/
//     "insole"/"insoles"/"footbed").
//   - A recommender tree with intent matching one of those words
//     must be enabled on this shop (ctx.recommenderTrees has the
//     loaded list — same source the prompt uses).
// On match: rewrite { name: "recommend_<intent>", input: {} } so
// the gate runs from a clean slate. Original input is discarded;
// the gate's needMoreInfo response will tell the LLM what to
// actually ask.
const ORTHOTIC_DOMAIN_RE = /\b(orthotic|orthotics|insole|insoles|footbed|footbeds)\b/i;

export function redirectOrthoticSearchToRecommender(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const trees = Array.isArray(ctx?.recommenderTrees) ? ctx.recommenderTrees : [];
  if (trees.length === 0) return toolCall;

  // Find a tree whose intent matches the orthotic domain. Aetrex's
  // intent is literally "orthotic" — match the intent name against
  // the orthotic-domain regex so any future merchant with a similar
  // intent (e.g. "insole") still routes correctly.
  const orthoticTree = trees.find((t) =>
    typeof t?.intent === "string" && ORTHOTIC_DOMAIN_RE.test(t.intent),
  );
  if (!orthoticTree) return toolCall;

  // Customer's text OR the LLM's query string must mention an
  // orthotic-domain word. The query is what the LLM thinks the
  // customer wants; the latest message is ground truth. Either
  // hitting the regex is sufficient.
  const latest = String(ctx?.latestUserMessage || "");
  const queryStr = String(toolCall?.input?.query || "");
  const matchesDomain = ORTHOTIC_DOMAIN_RE.test(latest) || ORTHOTIC_DOMAIN_RE.test(queryStr);
  if (!matchesDomain) return toolCall;

  // Negation escape hatch: customer said "doesn't like orthotics",
  // "not orthotics", "no orthotics", "without orthotics", "besides
  // orthotics", "other than orthotics". The orthotic-domain word
  // appears, but the customer is REJECTING that domain. Redirecting
  // to recommend_orthotic in this case is the opposite of what the
  // customer wants — they're asking for something OTHER THAN an
  // orthotic. Let search_products run with the AI's actual query
  // (e.g. "accessories gift") so the search finds non-orthotic
  // alternatives.
  const NEGATION_RE = /\b(?:no|not|don'?t|doesn'?t|didn'?t|don't[\s-]?like|doesn't[\s-]?like|without|besides|other[\s-]?than|except|aside[\s-]?from|instead[\s-]?of|rather[\s-]?than|hate|hates|dislike|dislikes|avoid|avoids|skip)\b[^.!?\n]{0,40}\b(?:orthotic|orthotics|insole|insoles|footbed|footbeds|shoes?|footwear|sandals?|sneakers?|boots?|clogs?|loafers?|slippers?|oxfords?|wedges?|heels?|flats?|mules?|mary[\s-]?jane|slip[\s-]?ons?)\b/i;
  if (NEGATION_RE.test(latest)) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — customer's message contains a negation ` +
        `("doesn't like / not / no / without orthotics-or-shoes"). Letting search_products run ` +
        `with the AI's actual query so non-orthotic alternatives surface.`,
    );
    return toolCall;
  }

  // Sandal escape hatch: if the customer is asking for an orthotic
  // FOR sandals, don't redirect — orthotic inserts don't fit open
  // sandals, and the recommender would resolve to a wrong product.
  // Let search_products run instead so the AI can show arch-
  // supportive sandals (the actual answer) or honestly say
  // "orthotics don't fit sandals."
  if (/\bsandals?\b/i.test(latest) || /\bsandals?\b/i.test(queryStr)) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — customer mentioned sandals + orthotic ` +
        `(orthotic inserts don't fit sandals; letting search_products run for honest framing)`,
    );
    return toolCall;
  }

  console.log(
    `[chat] orthotic-routing: search_products(query="${queryStr.slice(0, 60)}") on orthotic-domain ` +
      `query → rewriting to recommend_${orthoticTree.intent} (gate will collect attributes)`,
  );
  return { name: `recommend_${orthoticTree.intent}`, input: {}, id: toolCall.id };
}

export function rewriteToolCall(toolCall, ctx) {
  let rewritten = toolCall;
  rewritten = forceComparisonLookup(rewritten, ctx);
  rewritten = redirectOrthoticSearchToRecommender(rewritten, ctx);
  rewritten = stripStaleCategoriesOnScopeReset(rewritten, ctx);
  rewritten = injectStructuredColorFilter(rewritten, ctx);
  rewritten = injectLockedGender(rewritten, ctx);
  rewritten = injectOccasionCategory(rewritten, ctx);
  return rewritten;
}
