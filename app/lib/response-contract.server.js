import {
  canonicalizeCatalogConstraints,
  deriveCatalogMatchContract,
  readAttributeCI,
} from "./catalog-matcher.server.js";
import { normalizeCategory, normalizeColor, normalizeGender } from "./catalog-facts.server.js";
import {
  detectAiNoMatchPhrasing,
  stripAvailabilityDenialSentences,
} from "./chat-postprocessing.js";

function flattenValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenValues);
  if (typeof value === "object") return Object.values(value).flatMap(flattenValues);
  return [String(value)];
}

function cardAttr(card, aliases) {
  return readAttributeCI(card?._attributes || card?.attributes || {}, aliases);
}

function cardMatchesColor(card, requestedColor) {
  const color = normalizeColor(requestedColor);
  if (!color) return true;
  const rawValues = [
    cardAttr(card, ["color", "colour", "color_family", "Color Family", "color_fallback"]),
    card?.title,
  ];
  return flattenValues(rawValues).some((value) => normalizeColor(value) === color);
}

export function currentCatalogScopeFromContext(ctx = {}) {
  const explicit = ctx.sessionMemory?.explicit || {};
  const classified = ctx.classifiedIntent?.attributes || {};
  const resolverMatched = ctx.resolverState?.matched_constraints || {};
  const resolverInferred = ctx.resolverState?.inferred_constraints || {};

  return canonicalizeCatalogConstraints({
    gender:
      explicit.gender ||
      classified.gender ||
      resolverMatched.gender ||
      resolverInferred.gender?.value ||
      ctx.sessionGender,
    category:
      explicit.category ||
      classified.category ||
      resolverMatched.category ||
      resolverInferred.category?.value,
    color:
      explicit.color ||
      classified.color ||
      resolverMatched.color ||
      resolverInferred.color?.value,
  });
}

export function productPoolSatisfiesCatalogScope(pool, scope = {}) {
  if (!Array.isArray(pool) || pool.length === 0) return false;
  const canonical = canonicalizeCatalogConstraints(scope);
  const gender = normalizeGender(canonical.gender);
  const category = normalizeCategory(canonical.category);
  const color = normalizeColor(canonical.color);
  if (!gender && !category && !color) return false;

  return pool.some((card) => {
    const cardGender =
      normalizeGender(card?._gender) ||
      normalizeGender(cardAttr(card, ["gender", "gender_fallback", "genders"]));
    const cardCategory =
      normalizeCategory(card?._category) ||
      normalizeCategory(card?.productType) ||
      normalizeCategory(cardAttr(card, ["category", "category_for_filter", "subcategory", "product_type"]));

    if (gender && cardGender && cardGender !== gender && cardGender !== "unisex") return false;
    if (category && cardCategory && cardCategory !== category) return false;
    if (color && !cardMatchesColor(card, color)) return false;
    return true;
  });
}

export function deriveProductResponseContract({ pool = [], ctx = {}, relaxedFilters = null } = {}) {
  const scope = currentCatalogScopeFromContext(ctx);
  const exactScopeSatisfied = productPoolSatisfiesCatalogScope(pool, scope);
  const resolver = ctx.resolverState;
  const impossibleConstraints =
    resolver?.type === "resolver_state" && Array.isArray(resolver.impossible_constraints)
      ? resolver.impossible_constraints
      : [];

  return {
    ...deriveCatalogMatchContract({
      products: pool,
      constraints: scope,
      relaxedFilters,
      impossibleConstraints,
    }),
    exactScopeSatisfied,
  };
}

export function repairProductResponseText({ text, pool = [], ctx = {}, relaxedFilters = null } = {}) {
  const contract = deriveProductResponseContract({ pool, ctx, relaxedFilters });
  if (!text || !contract.exactScopeSatisfied || !detectAiNoMatchPhrasing(text)) {
    return { text, changed: false, contract };
  }

  const stripped = stripAvailabilityDenialSentences(text);
  return {
    text: detectAiNoMatchPhrasing(stripped)
      ? "Here are the matching styles I found."
      : stripped,
    changed: true,
    contract,
  };
}

export function extractTurnChips(text) {
  const chips = [];
  const re = /<<\s*([^<>]+?)\s*>>/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const label = String(m[1] || "").trim();
    if (label) chips.push(label);
  }
  return chips;
}

export function createTurnResult({
  text = "",
  products = [],
  links = [],
  flags = {},
  ctx = {},
  diagnostics = {},
} = {}) {
  const normalizedText = String(text || "").trim();
  const normalizedProducts = Array.isArray(products) ? products.filter(Boolean) : [];
  const normalizedLinks = Array.isArray(links)
    ? links
        .filter((link) => link && typeof link === "object" && link.url)
        .map((link) => ({
          url: String(link.url || ""),
          label: String(link.label || ""),
        }))
    : [];

  return {
    type: "turn_result",
    version: 1,
    text: normalizedText,
    products: normalizedProducts,
    chips: extractTurnChips(normalizedText),
    links: normalizedLinks,
    scope: currentCatalogScopeFromContext(ctx),
    flags: {
      productSearchAttempted: !!flags.productSearchAttempted,
      recommenderInvoked: !!flags.recommenderInvoked,
      hasSupportCTA: !!flags.hasSupportCTA,
      hasGenericCTA: !!flags.hasGenericCTA,
      hasKlaviyoForm: !!flags.hasKlaviyoForm,
    },
    diagnostics,
  };
}

export function validateTurnResult(result = {}) {
  const warnings = [];
  const text = String(result.text || "");
  const products = Array.isArray(result.products) ? result.products : [];
  const chips = Array.isArray(result.chips) ? result.chips : [];

  if (text.length < 3) {
    warnings.push({
      code: "empty_text",
      message: "TurnResult text is empty or too short.",
    });
  }

  if (products.length > 0 && chips.length > 0) {
    const beforeFirstChip = text.slice(0, text.indexOf("<<")).trim();
    if (/\b(?:what|which)\s+(?:type|kind|style|category)\b|\b(?:men'?s?|women'?s?|male|female)\s+or\s+(?:men'?s?|women'?s?|male|female)\b/i.test(beforeFirstChip)) {
      warnings.push({
        code: "cards_with_gating_chips",
        message: "Product cards are present while text still asks a gating chip question.",
      });
    }
  }

  if (products.length === 0 && /\b(?:here are|take a look|check out|these are|i found|closest matches)\b/i.test(text)) {
    warnings.push({
      code: "pitch_without_products",
      message: "Text presents product options but no product cards are attached.",
    });
  }

  if (products.length > 0 && detectAiNoMatchPhrasing(text)) {
    warnings.push({
      code: "denial_with_products",
      message: "Text contains no-match wording while product cards are attached.",
    });
  }

  return warnings;
}
