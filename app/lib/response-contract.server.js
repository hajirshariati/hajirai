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
import { sanitizeCtaLabel } from "./cta-label.server.js";
import { buildStorefrontSearchCTA } from "./storefront-search-cta.server.js";

const SIBLING_GENERIC_WORDS = new Set([
  "the", "a", "an", "for", "and", "or", "in", "on", "with", "men", "mens",
  "women", "womens", "black", "white", "tan", "brown", "red", "blue", "grey",
  "gray", "pink", "dark", "light", "w", "s",
]);

function cardTitleTokens(title) {
  return new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !SIBLING_GENERIC_WORDS.has(w)),
  );
}

export function dropSiblingCards(scored, textLower) {
  const kept = [];
  for (const candidate of scored) {
    const candTokens = cardTitleTokens(candidate.card.title);
    let drop = false;
    for (const k of kept) {
      const keptTokens = cardTitleTokens(k.card.title);
      if (candTokens.size === 0 || keptTokens.size === 0) continue;
      let shared = 0;
      for (const w of candTokens) if (keptTokens.has(w)) shared++;
      const sharedRatio = shared / Math.min(candTokens.size, keptTokens.size);
      if (sharedRatio < 0.8) continue;
      let extraUnmentioned = 0;
      for (const w of candTokens) {
        if (!keptTokens.has(w) && !textLower.includes(w)) extraUnmentioned++;
      }
      if (extraUnmentioned >= 1) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push(candidate);
  }
  return kept;
}

export function scoreCardAgainstText(card, textLower, userTextLower) {
  const raw = card.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const generic = new Set(["the", "a", "an", "for", "and", "or", "in", "on", "with", "men", "mens", "women", "womens", "black", "white", "tan", "brown", "red", "blue", "grey", "gray", "pink", "dark", "light"]);
  const nameWords = raw.filter((w) => !generic.has(w));
  const titleScore = nameWords.length === 0 ? 0 : nameWords.filter((w) => textLower.includes(w)).length / nameWords.length;

  let queryScore = 0;
  const snippet = (card._descriptionSnippet || "").toLowerCase();
  const searchQ = (card._searchQuery || "").toLowerCase().trim();
  if (snippet && userTextLower) {
    const distinctive = userTextLower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !generic.has(w) && !["what", "does", "mean", "tell", "about", "show", "find"].includes(w));
    if (distinctive.length > 0) {
      const hits = distinctive.filter((w) => snippet.includes(w)).length;
      queryScore = hits / distinctive.length;
    }
  }
  if (snippet && searchQ && snippet.includes(searchQ)) {
    queryScore = Math.max(queryScore, 1);
  }

  return Math.max(titleScore, queryScore);
}

export const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

export function skusFromCardText(value) {
  if (!value) return [];
  return String(value).toUpperCase().match(SKU_PATTERN) || [];
}

export function extractOrphanSkus(text, pool) {
  const mentioned = text.match(SKU_PATTERN) || [];
  if (mentioned.length === 0) return [];
  const poolSkuSet = new Set();
  for (const card of pool) {
    for (const s of skusFromCardText(card.title)) poolSkuSet.add(s);
    for (const s of skusFromCardText(card.handle)) poolSkuSet.add(s);
  }
  const seen = new Set();
  const orphans = [];
  for (const raw of mentioned) {
    const sku = raw.toUpperCase();
    if (seen.has(sku)) continue;
    seen.add(sku);
    if (!poolSkuSet.has(sku)) orphans.push(sku);
  }
  return orphans;
}

export function stripMissingSkus(text, missing) {
  if (!text || missing.length === 0) return text;
  let cleaned = text;
  for (const sku of missing) {
    const safe = sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\s*\\(\\s*${safe}\\s*\\)`, "gi"), "");
    cleaned = cleaned.replace(new RegExp(`\\b${safe}\\b`, "gi"), "");
  }
  return cleaned
    .replace(/\(\s*\)/g, "")
    .replace(/\b(and|or|,)\s*(?=(?:and|or|,|are|is|both)\b)/gi, " ")
    .replace(/\b(both|and)\s+(are|is)\b/gi, "$2")
    .replace(/\bare\s+(?:both\s+)?great\s+picks\b/gi, "is a great pick")
    .replace(/\bare\s+(?:both\s+)?(great|excellent|solid|nice)\b/gi, "is $1")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SUPPORT_ANCHOR_RE = /\b(contact|customer\s+(service|care|support)|support\s+(hub|team|center)|support|care\s+team|help\s+team|reach\s+(out|us)|our\s+team|speak.*(human|agent|rep|person))\b/i;

function normalizeUrl(u) {
  return String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

export function extractSupportCTA(text, supportUrl, supportLabel) {
  if (!text) return { text, cta: null };

  const defaultOldLabel = "Contact customer service";
  const label = supportLabel && supportLabel.trim() && supportLabel.trim() !== defaultOldLabel
    ? supportLabel.trim()
    : "Visit Support Hub";

  const normSupport = supportUrl ? normalizeUrl(supportUrl) : "";
  const mdLinkAny = /\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/g;

  const removals = [];
  let cta = null;
  let m;
  while ((m = mdLinkAny.exec(text)) !== null) {
    const anchor = m[1];
    const linkUrl = m[2];
    const normLink = normalizeUrl(linkUrl);
    const anchorMatch = SUPPORT_ANCHOR_RE.test(anchor);
    const urlMatch = normSupport && (normLink === normSupport || normLink.includes(normSupport) || normSupport.includes(normLink));
    if (anchorMatch || urlMatch) {
      removals.push({ start: m.index, end: m.index + m[0].length });
      if (!cta) cta = { url: supportUrl || linkUrl, label };
    }
  }

  let cleaned = text;
  for (let i = removals.length - 1; i >= 0; i--) {
    cleaned = cleaned.slice(0, removals[i].start) + cleaned.slice(removals[i].end);
  }

  if (supportUrl) {
    const safeUrl = supportUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bareUrl = new RegExp(`(?<![\\w(\\[])${safeUrl}/?(?![\\w)])`, "gi");
    if (bareUrl.test(cleaned)) {
      cleaned = cleaned.replace(bareUrl, "");
      if (!cta) cta = { url: supportUrl, label };
    }
  }

  if (!cta) return { text, cta: null };

  cleaned = cleaned
    .replace(/:\s*$/gm, ".")
    .replace(/\s+here\s*[.:!]?\s*$/gim, ".")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, cta };
}

export function extractCollectionCTA(text) {
  const match = text.match(/<<(.+?)\|(.+?)>>/);
  if (!match) return { text, cta: null };

  return {
    text: text.replace(match[0], "").trim(),
    cta: {
      label: sanitizeCtaLabel(match[1], match[2]),
      url: match[2],
    },
  };
}

export function extractGenericCTA(text) {
  const mdLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
  const rawLink = /(https?:\/\/[^\s]+)/;

  let match = text.match(mdLink);
  if (match) {
    return {
      text: text.replace(match[0], "").trim(),
      cta: { url: match[2], label: sanitizeCtaLabel(match[1], match[2]) },
    };
  }

  match = text.match(rawLink);
  if (match) {
    return {
      text: text.replace(match[0], "").trim(),
      cta: { url: match[1], label: sanitizeCtaLabel("", match[1]) },
    };
  }

  return { text, cta: null };
}

const FAMILY_STOP_WORDS_UI = new Set(["the", "a", "an", "my", "our", "new"]);

export function titleStyleFamily(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    if (w.length > 2 && !FAMILY_STOP_WORDS_UI.has(w)) return w;
  }
  return "";
}

const FOOTWEAR_HYPERNYMS = ["shoe", "shoes", "footwear"];
const FOOTWEAR_CATEGORY_SET = new Set([
  "footwear", "sneakers", "sneaker", "boots", "boot", "sandals", "sandal",
  "clogs", "clog", "loafers", "loafer", "oxfords", "oxford", "slip ons", "slip-ons",
  "wedges heels", "mary janes", "slippers", "slipper", "heels", "flats", "mules",
]);

export function detectFalseCategoryDenial(text, categories) {
  if (!text || !Array.isArray(categories) || categories.length === 0) return null;
  const t = String(text);
  const lower = t.toLowerCase();
  const hasFootwearFamily = categories.some((cat) => FOOTWEAR_CATEGORY_SET.has(String(cat || "").trim().toLowerCase()));
  const checks = categories.map((cat) => ({ cat, displayName: cat }));
  if (hasFootwearFamily) {
    for (const h of FOOTWEAR_HYPERNYMS) {
      checks.push({ cat: h, displayName: "Footwear" });
    }
  }

  for (const { cat, displayName } of checks) {
    const c = String(cat || "").trim().toLowerCase();
    if (!c || c.length < 3) continue;
    const stem = c.endsWith("s") ? c.slice(0, -1) : c;
    const variants = c === stem ? [c] : [c, stem];
    const alt = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const denialPatterns = [
      new RegExp(`\\(\\s*not\\s+(?:${alt})s?\\s*\\)`, "i"),
      new RegExp(`\\bwe (?:don'?t|do not|cannot|can'?t) (?:have|carry|sell|stock|offer)\\s+(?:any\\s+)?(?:${alt})s?\\b`, "i"),
      new RegExp(`\\b(?:this|the)\\s+(?:store|shop)\\s+(?:doesn'?t|does not)\\s+(?:have|carry|sell|stock|offer)\\s+(?:any\\s+)?(?:${alt})s?\\b`, "i"),
      new RegExp(`\\b(?:${alt})s?\\s+(?:are\\s+not|aren'?t|is\\s+not|isn'?t)\\s+(?:something|a category|a product|a line)\\s+(?:we|this store|the store)\\s+(?:carry|carries|sell|sells|stock|stocks|offer|offers)\\b`, "i"),
      new RegExp(`\\bno\\s+(?:${alt})s?\\s+(?:in|at|from)\\s+(?:this|the|our)\\s+(?:store|shop|catalog)\\b`, "i"),
    ];
    for (const re of denialPatterns) {
      if (re.test(t) || re.test(lower)) return displayName;
    }
  }
  return null;
}

export function detectFalseGenderCategoryAffirmation(text, categoryGenderMap) {
  if (!text || !categoryGenderMap || typeof categoryGenderMap !== "object") return null;
  const t = String(text);
  const lower = t.toLowerCase();
  const entries = Object.entries(categoryGenderMap);
  if (entries.length === 0) return null;

  const sorted = entries
    .filter(([k]) => k && k.length >= 3)
    .sort((a, b) => b[0].length - a[0].length);

  const genderToTokens = {
    men: ["men's", "men", "mens", "male", "guy", "guys", "gentleman", "gentlemen", "boys'", "boys"],
    women: ["women's", "women", "womens", "female", "lady", "ladies", "girls'", "girls"],
  };

  for (const [catKey, entry] of sorted) {
    if (!entry || !Array.isArray(entry.genders) || entry.genders.length === 0) continue;
    if (entry.genders.includes("unisex")) continue;
    const supported = new Set(entry.genders.map((g) => String(g).toLowerCase()));
    const missingGenders = ["men", "women"].filter((g) => !supported.has(g));
    if (missingGenders.length === 0) continue;

    const c = String(catKey).toLowerCase().trim();
    const stem = c.endsWith("s") ? c.slice(0, -1) : c;
    const variants = c === stem ? [c] : [c, stem];
    const escapedCats = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const catAlt = escapedCats.map((v) => `${v}s?`).join("|");

    for (const missingGender of missingGenders) {
      const tokens = genderToTokens[missingGender] || [];
      const escapedTokens = tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const tokenAlt = escapedTokens.join("|");
      const verbAlt = "have|carry|sell|stock|offer|got";
      const affirmPatterns = [
        new RegExp(`\\bwe (?:absolutely\\s+)?(?:do (?:${verbAlt})|${verbAlt})\\s+(?:some\\s+|a\\s+few\\s+)?(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
        new RegExp(`\\byes,?\\s+we (?:absolutely\\s+)?(?:do |${verbAlt})\\s+(?:some\\s+|a\\s+few\\s+)?(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
        new RegExp(`\\b(?:these|those|here are)\\s+(?:are\\s+)?(?:some\\s+|a\\s+few\\s+|our\\s+)?(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
        new RegExp(`\\bour\\s+(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
      ];
      for (const re of affirmPatterns) {
        if (re.test(t) || re.test(lower)) {
          return {
            category: entry.display || catKey,
            requestedGender: missingGender === "men" ? "men's" : "women's",
            availableGenders: entry.genders.slice(),
          };
        }
      }
    }
  }
  return null;
}

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
    size:
      explicit.size ||
      resolverMatched.size,
    width:
      explicit.width ||
      resolverMatched.width,
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

function cardMatchesCatalogScope(card, scope = {}, { enforceColor = true } = {}) {
  const canonical = canonicalizeCatalogConstraints(scope);
  const gender = normalizeGender(canonical.gender);
  const category = normalizeCategory(canonical.category);
  const color = normalizeColor(canonical.color);

  const cardGender =
    normalizeGender(card?._gender) ||
    normalizeGender(cardAttr(card, ["gender", "gender_fallback", "genders"]));
  const cardCategory =
    normalizeCategory(card?._category) ||
    normalizeCategory(card?.productType) ||
    normalizeCategory(cardAttr(card, ["category", "category_for_filter", "subcategory", "product_type"]));

  if (gender && cardGender && cardGender !== gender && cardGender !== "unisex") return false;
  if (category && cardCategory && cardCategory !== category) return false;
  if (color && enforceColor && !cardMatchesColor(card, color)) return false;
  return true;
}

export function filterProductCardsToCatalogScope(pool = [], ctx = {}) {
  const products = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (products.length === 0) {
    return { products: [], dropped: 0, scope: currentCatalogScopeFromContext(ctx), enforcedColor: false };
  }

  const scope = currentCatalogScopeFromContext(ctx);
  const canonical = canonicalizeCatalogConstraints(scope);
  const hasStructuralScope = Boolean(canonical.gender || canonical.category);
  if (!hasStructuralScope && !canonical.color) {
    return { products, dropped: 0, scope, enforcedColor: false };
  }

  const structuralMatches = products.filter((card) =>
    cardMatchesCatalogScope(card, canonical, { enforceColor: false }),
  );
  const base = hasStructuralScope ? structuralMatches : products;
  if (base.length === 0) {
    return { products: [], dropped: products.length, scope, enforcedColor: false };
  }

  // Color is a hard display constraint only when at least one product in the
  // structural scope truly has that color. If the resolver/search deliberately
  // relaxed color to show alternatives ("no exact red, here are burgundy"),
  // keep those alternatives and let wording say the exact color was unavailable.
  let enforcedColor = false;
  let filtered = base;
  if (canonical.color) {
    const exactColor = base.filter((card) =>
      cardMatchesCatalogScope(card, canonical, { enforceColor: true }),
    );
    if (exactColor.length > 0) {
      filtered = exactColor;
      enforcedColor = true;
    }
  }

  return {
    products: filtered,
    dropped: products.length - filtered.length,
    scope,
    enforcedColor,
  };
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

const PRODUCT_INTRO_RE = /\b(?:here (?:are|is)|take a look|check out|i found|we have|these are|this is|good news|great news|closest options|matching styles)\b/i;
const CLARIFYING_LEAD_RE = /^\s*(?:what|which)\s+(?:type|kind|style|category)\s+of\s+[^?]{1,160}\?\s*/i;
const GENDER_CLARIFYING_LEAD_RE = /^\s*(?:is this|are these|who (?:is|are) (?:this|these)|would this be)\s+[^?]{0,120}\?\s*/i;

function stripChoiceButtons(text) {
  return String(text || "")
    .replace(/\s*<<[^<>]+>>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function repairProductTurnAssembly({ text, pool = [], ctx = {}, relaxedFilters = null } = {}) {
  let nextText = String(text || "").trim();
  let changed = false;
  const logs = [];

  const denialRepair = repairProductResponseText({ text: nextText, pool, ctx, relaxedFilters });
  if (denialRepair.changed) {
    nextText = denialRepair.text;
    changed = true;
    logs.push("stripped_contradictory_denial");
  }

  if (Array.isArray(pool) && pool.length > 0 && extractTurnChips(nextText).length > 0) {
    const firstChipIdx = nextText.indexOf("<<");
    const beforeChips = firstChipIdx >= 0 ? nextText.slice(0, firstChipIdx).trim() : nextText;
    const chipFree = stripChoiceButtons(nextText);
    const namesPoolProduct = pool.some((card) => {
      const title = String(card?.title || "").trim().toLowerCase();
      return title.length >= 5 && chipFree.toLowerCase().includes(title);
    });
    const presentsProducts =
      PRODUCT_INTRO_RE.test(chipFree) ||
      PRODUCT_INTRO_RE.test(beforeChips) ||
      namesPoolProduct;

    if (presentsProducts) {
      const stripped = stripChoiceButtons(chipFree)
        .replace(CLARIFYING_LEAD_RE, "")
        .replace(GENDER_CLARIFYING_LEAD_RE, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (stripped !== nextText) {
        nextText = stripped || "Here are the matching styles I found.";
        changed = true;
        logs.push("removed_clarifying_chips_from_product_turn");
      }
    }
  }

  return { text: nextText, changed, logs, contract: denialRepair.contract };
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

export function prepareProductCardsForTurn(cards = []) {
  const seen = new Set();
  const products = [];
  const categoryCounts = new Map();
  const genderCounts = new Map();

  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card) continue;
    const key = card.handle || card.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (card._category) {
      categoryCounts.set(card._category, (categoryCounts.get(card._category) || 0) + 1);
    }
    if (card._gender) {
      genderCounts.set(card._gender, (genderCounts.get(card._gender) || 0) + 1);
    }

    const { _descriptionSnippet, _searchQuery, _category, _gender, _attributes, ...publicCard } = card;
    products.push(publicCard);
  }

  return { products, categoryCounts, genderCounts };
}

function dominantFromCounts(counts) {
  if (!(counts instanceof Map) || counts.size === 0) return "";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dominantRequestedColor(ctx = {}) {
  if (
    !Array.isArray(ctx._merchantColors) ||
    ctx._merchantColors.length === 0 ||
    typeof ctx.latestUserMessage !== "string"
  ) {
    return null;
  }
  const latest = ctx.latestUserMessage.toLowerCase();
  const sorted = [...ctx._merchantColors].sort((a, b) => b.length - a.length);
  for (const color of sorted) {
    if (new RegExp(`\\b${escapeRegex(color)}\\b`, "i").test(latest)) return color;
  }
  return null;
}

export function resolveProductTurnLink({ categoryCounts, genderCounts, ctx = {} } = {}) {
  const hasCategories = categoryCounts instanceof Map && categoryCounts.size > 0;
  const dominantCat = dominantFromCounts(categoryCounts);
  const dominantGender = dominantFromCounts(genderCounts) || ctx.sessionGender || "";

  if (
    (ctx.storefrontSearchUrlPattern || (Array.isArray(ctx.ctaOverrides) && ctx.ctaOverrides.length > 0)) &&
    hasCategories &&
    !ctx.categoryIntentAmbiguous
  ) {
    const latest = String(ctx.latestUserMessage || "").toLowerCase();
    const hasSpecificStyle = /\b(sneaker|sandal|boot|wedge|heel|loafer|flat|slip[- ]on|clog|mule|oxford|pump|trainer|moccasin|slipper|orthotic)/i.test(latest);
    const isGenericAsk = !hasSpecificStyle && /\b(shoes?|footwear|anything|something|options|recommend)/i.test(latest);
    const totalCards = [...categoryCounts.values()].reduce((a, b) => a + b, 0);
    const topShare = dominantCat && totalCards > 0 ? (categoryCounts.get(dominantCat) / totalCards) : 0;
    const mixedStyles = categoryCounts.size >= 3 || topShare < 0.6;
    const ctaCategory = (isGenericAsk || mixedStyles) ? "footwear" : dominantCat;
    const dominantColor = dominantRequestedColor(ctx);

    const auto = buildStorefrontSearchCTA({
      pattern: ctx.storefrontSearchUrlPattern,
      overrides: ctx.ctaOverrides,
      gender: dominantGender,
      category: ctaCategory,
      color: dominantColor,
      latestUserMessage: ctx.latestUserMessage || "",
    });

    return {
      link: auto ? { url: auto.url, label: auto.label } : null,
      kind: auto ? "auto" : "auto-miss",
      diagnostics: {
        gender: dominantGender || "",
        category: ctaCategory || "",
        color: dominantColor || "",
        patternSet: !!ctx.storefrontSearchUrlPattern,
        overrideCount: (ctx.ctaOverrides || []).length,
      },
    };
  }

  if (
    Array.isArray(ctx.collectionLinks) &&
    ctx.collectionLinks.length > 0 &&
    hasCategories &&
    !ctx.categoryIntentAmbiguous
  ) {
    const normalizedGender = String(dominantGender || "").toLowerCase().trim();
    const catMatches = (linkCat, cat) => {
      if (!linkCat) return false;
      return linkCat === cat || cat.includes(linkCat) || linkCat.includes(cat);
    };
    const exact = ctx.collectionLinks.find((link) => {
      const linkCat = String(link?.category || "").toLowerCase().trim();
      const linkGender = String(link?.gender || "").toLowerCase().trim();
      if (!linkCat || !link?.url || !linkGender) return false;
      return catMatches(linkCat, dominantCat) && linkGender === normalizedGender;
    });
    const fallback = !exact && ctx.collectionLinks.find((link) => {
      const linkCat = String(link?.category || "").toLowerCase().trim();
      const linkGender = String(link?.gender || "").toLowerCase().trim();
      if (!linkCat || !link?.url || linkGender) return false;
      return catMatches(linkCat, dominantCat);
    });
    const match = exact || fallback;
    if (match) {
      return {
        link: {
          url: match.url,
          label: `Shop all ${String(match.label || match.category).trim()}`,
        },
        kind: "legacy-collection",
        diagnostics: {
          gender: dominantGender || "",
          category: dominantCat || "",
          color: "",
          patternSet: false,
          overrideCount: 0,
        },
      };
    }
  }

  return { link: null, kind: "none", diagnostics: {} };
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
