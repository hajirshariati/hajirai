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

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
export function escapeRe(s) {
  return String(s).replace(RE_ESCAPE, "\\$&");
}

// Negation context detector — checks whether a term that appeared at
// position `matchIndex` in `text` is preceded (within ~25 chars) by a
// negation word like "no", "not", "without", "skip", "forget",
// "anything but", "don't want", "other than". Used by color and other
// structured-filter injection to avoid false positives like
// "no red" → filters.color = "red".
const NEGATION_WINDOW_CHARS = 30;
const NEGATION_PRECEDING_RE = /\b(?:no|not|without|except|skip|forget|anything\s+but|don'?t\s+want|other\s+than|never)\s+\S*$/i;
export function isPrecededByNegation(text, matchIndex) {
  const window = String(text || "").slice(
    Math.max(0, Number(matchIndex) - NEGATION_WINDOW_CHARS),
    Number(matchIndex),
  );
  return NEGATION_PRECEDING_RE.test(window);
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

// Compose the pipeline. Order matters slightly:
//   1. Comparison routing (might change tool name from search→lookup)
//   2. Scope reset (strips stale category from search query)
//   3. Color injection (adds structured color filter to search)
//   4. Gender lock (force-overlay customer-stated gender)
export function rewriteToolCall(toolCall, ctx) {
  let rewritten = toolCall;
  rewritten = forceComparisonLookup(rewritten, ctx);
  rewritten = stripStaleCategoriesOnScopeReset(rewritten, ctx);
  rewritten = injectStructuredColorFilter(rewritten, ctx);
  rewritten = injectLockedGender(rewritten, ctx);
  return rewritten;
}
