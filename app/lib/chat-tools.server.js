import prisma from "../db.server";
import { logMentions } from "../models/ChatProductMention.server";

// Tool definitions sent to Anthropic. Keep descriptions action-oriented so the
// model knows when to call each one.
export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search the merchant's product catalog by keyword. Returns products matching the query across title, vendor, product type, tags, and description. Use filters to narrow by attributes the merchant has configured (e.g. gender, color, material).",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for (e.g. 'running shoes', 'wool sweater', 'waterproof').",
        },
        limit: {
          type: "integer",
          description: "Maximum number of products to return (default 6, max 10).",
          minimum: 1,
          maximum: 10,
        },
        filters: {
          type: "object",
          description: "Optional attribute filters. Keys are attribute names (e.g. 'gender', 'color', 'material'), values are the desired value. Only attributes the merchant has mapped will be usable.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product_details",
    description:
      "Fetch full details for a single product, including all variants, prices, options, and any CSV-enriched data (materials, care, fit notes, etc.). Use this when the customer asks about a specific product or you want to answer a detail question authoritatively.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle (slug), e.g. 'cotton-crew-tee'.",
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "lookup_sku",
    description:
      "Look up one or more SKUs and return the matching variant, its parent product, and any CSV enrichment data. Use this when the customer mentions a SKU or when you need to verify enrichment data for specific items.",
    input_schema: {
      type: "object",
      properties: {
        skus: {
          type: "array",
          items: { type: "string" },
          description: "List of SKUs to look up. Max 10.",
          maxItems: 10,
        },
      },
      required: ["skus"],
    },
  },
  {
    name: "get_product_reviews",
    description:
      "Fetch customer reviews from Yotpo for a specific product, including an aggregated fit/sizing summary. Use this whenever the customer asks about fit, sizing (true to size, runs small, runs large), comfort, quality, or wants to know what other buyers think. Returns review count, average rating, fit breakdown, and a sample of the most recent review snippets.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle (slug), e.g. 'jillian-sandal'.",
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "get_return_insights",
    description:
      "Fetch return/exchange insights from Aftership for a specific product, including how often it gets returned for sizing reasons (too small, too big) and common return reasons. Use this when the customer asks about sizing, fit, whether to size up or down, or return/exchange policy for a specific product.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle (slug), e.g. 'jillian-sandal'.",
        },
      },
      required: ["handle"],
    },
  },
];

function productUrl(shop, handle) {
  return `https://${shop}/products/${handle}?utm_source=shopagent&utm_medium=chat&utm_campaign=ai_recommendation`;
}

function safeParseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function priceRange(variants) {
  const prices = variants
    .map((v) => parseFloat(v.price))
    .filter((n) => !Number.isNaN(n));
  if (prices.length === 0) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const fmt = (n) => `$${n.toFixed(2)}`;
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

async function enrichmentMap(shop, skus) {
  const rows = skus.length
    ? await prisma.productEnrichment.findMany({
        where: { shop, sku: { in: skus } },
        select: { sku: true, data: true },
      })
    : [];
  const map = new Map();
  for (const r of rows) map.set(r.sku, r.data);
  return map;
}

function deduplicateByColor(products) {
  const seen = new Map();
  for (const p of products) {
    const base = p.title.replace(/\s*-\s*[^-]+$/, "").toLowerCase();
    if (!seen.has(base)) {
      seen.set(base, p);
    }
  }
  return Array.from(seen.values());
}

const STOP_WORDS = new Set(["the", "a", "an", "for", "and", "or", "in", "on", "to", "of", "with", "is", "are", "i", "my", "me", "some", "any", "can", "do", "show", "find", "get", "want", "need", "looking", "search"]);

const POSSESSIVE_STRIP = { mens: "men", womens: "women", childrens: "children", kids: "kid", girls: "girl", boys: "boy" };

const GENDERED_SEARCH = {
  men: ["men's", "mens"],
  women: ["women's", "womens"],
  boy: ["boy's", "boys"],
  girl: ["girl's", "girls"],
  children: ["children's", "childrens", "kids"],
  kid: ["kid's", "kids"],
};

function extractKeywords(q) {
  return q
    .toLowerCase()
    .replace(/['']/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => POSSESSIVE_STRIP[w] || w);
}

// Merchant-configured via Rules & Knowledge → Query Synonyms.
// Shape: [{ term: "shoe", expandsTo: ["sneaker", "sandal"] }, ...]
function buildSynonymMap(querySynonyms) {
  const map = {};
  if (!Array.isArray(querySynonyms)) return map;
  for (const entry of querySynonyms) {
    const term = String(entry?.term || "").trim().toLowerCase();
    const expands = Array.isArray(entry?.expandsTo)
      ? entry.expandsTo.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [];
    if (!term || expands.length === 0) continue;
    map[term] = expands;
  }
  return map;
}

// Basic English plural/singular pair. Catalogs mix "Sandal" (singular title)
// with "sandals" (plural category/tag), so every keyword is searched in both
// forms to avoid 0-result queries on trivial inflection mismatches.
function inflectVariants(term) {
  const t = String(term || "").trim();
  if (!t) return [];
  const out = new Set([t]);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) {
    out.add(t.slice(0, -1));
  } else if (t.length > 2 && !t.endsWith("s")) {
    out.add(t + "s");
  }
  return Array.from(out);
}

function keywordMatchClause(kw, synonymMap) {
  const gendered = GENDERED_SEARCH[kw];
  const baseTerms = gendered || [kw];
  const synonymTerms = synonymMap?.[kw] || [];
  const seen = new Set();
  const allTerms = [];
  for (const t of [...baseTerms, ...synonymTerms]) {
    for (const v of inflectVariants(t)) {
      const lower = v.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      allTerms.push(v);
    }
  }

  const clauses = [];
  for (const t of allTerms) {
    clauses.push(
      { title: { contains: t, mode: "insensitive" } },
      { vendor: { contains: t, mode: "insensitive" } },
      { productType: { contains: t, mode: "insensitive" } },
      { description: { contains: t, mode: "insensitive" } },
    );
    // Also check category-like metafield attributes. Merchants often tag products
    // by category in metafields (e.g. Category="Sandals") rather than in the title.
    const lower = t.toLowerCase();
    const titleCase = lower.charAt(0).toUpperCase() + lower.slice(1);
    const termCases = Array.from(new Set([t, lower, titleCase]));
    const attrKeys = ["category", "Category", "category_for_filter", "Category For Filter", "product_type", "productType"];
    for (const key of attrKeys) {
      for (const v of termCases) {
        clauses.push({ attributesJson: { path: [key], equals: v } });
        clauses.push({ attributesJson: { path: [key], array_contains: [v] } });
        clauses.push({ attributesJson: { path: [key], string_contains: v } });
      }
    }
  }
  clauses.push({ tags: { hasSome: allTerms } });
  return { OR: clauses };
}

function buildExclusionClause(excludeTerms) {
  const terms = excludeTerms.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (terms.length === 0) return null;
  return {
    AND: terms.flatMap((t) => [
      { NOT: { title: { contains: t, mode: "insensitive" } } },
      { NOT: { productType: { contains: t, mode: "insensitive" } } },
    ]),
  };
}

function splitCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// Merchant-configured via Rules & Knowledge → Search Rules.
// Each rule: { whenQuery, excludeTerms, overrideTriggers? }
// - whenQuery: comma-separated keywords; if any appears in the conversation, the rule fires
// - excludeTerms: comma-separated terms; matching products are hidden from results
// - overrideTriggers (optional): comma-separated keywords; if any appears in the user's
//   latest message, the rule is skipped for this turn
function matchesCategoryRule(text, rules, userText = "") {
  if (!rules || !Array.isArray(rules)) return null;
  const lower = text.toLowerCase();
  const userLower = (userText || "").toLowerCase();
  for (const rule of rules) {
    const triggers = splitCsv(rule.whenQuery);
    if (!triggers.some((t) => lower.includes(t))) continue;
    const overrides = splitCsv(rule.overrideTriggers);
    if (overrides.length > 0 && overrides.some((o) => userLower.includes(o))) continue;
    return rule.excludeTerms;
  }
  return null;
}

const GENDER_DETECT = [
  { pattern: /\b(men[''']?s|male|guy|dude|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|him|his)\b/i, gender: "men", strip: /\b(men[''']?s|mens|male|guy|dude|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew)\b/gi },
  { pattern: /\b(women[''']?s|female|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|her|hers)\b/i, gender: "women", strip: /\b(women[''']?s|womens|female|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece)\b/gi },
  { pattern: /\b(boy[''']?s|boys)\b/i, gender: "boy", strip: /\b(boy[''']?s|boys)\b/gi },
  { pattern: /\b(girl[''']?s|girls)\b/i, gender: "girl", strip: /\b(girl[''']?s|girls)\b/gi },
  { pattern: /\b(kid[''']?s|kids|children[''']?s)\b/i, gender: "kid", strip: /\b(kid[''']?s|kids|children[''']?s|childrens)\b/gi },
];

function detectAndStripGender(query) {
  for (const g of GENDER_DETECT) {
    if (g.pattern.test(query)) {
      const stripped = query.replace(g.strip, "").replace(/\s+/g, " ").trim();
      return { gender: g.gender, query: stripped || query };
    }
  }
  return { gender: null, query };
}

function genderFilterClause(gender) {
  const want = gender.toLowerCase();
  const opposite = want === "men" ? "women" : want === "women" ? "men" : null;
  const clause = {
    OR: [
      { attributesJson: { path: ["gender"], equals: want } },
      { attributesJson: { path: ["gender"], array_contains: [want] } },
      { attributesJson: { path: ["gender_fallback"], equals: want } },
      { attributesJson: { path: ["gender_fallback"], array_contains: [want] } },
      { attributesJson: { path: ["gender"], equals: `${want}'s` } },
      { attributesJson: { path: ["gender_fallback"], equals: `${want}'s` } },
      { attributesJson: { path: ["gender"], equals: "unisex" } },
      { attributesJson: { path: ["gender_fallback"], equals: "unisex" } },
    ],
  };
  if (opposite) {
    clause.OR.push({
      AND: [
        { title: { contains: `${want}'s`, mode: "insensitive" } },
        { NOT: { title: { contains: `${opposite}'s`, mode: "insensitive" } } },
      ],
    });
  }
  return clause;
}

async function searchProducts({ query, limit, filters }, { shop, deduplicateColors, sessionGender, categoryExclusions, querySynonyms, conversationText, userText }) {
  const q = String(query || "").trim();
  if (!q) return { products: [] };
  const max = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);
  const attrFilters = filters && typeof filters === "object" ? filters : {};

  const detected = detectAndStripGender(q);
  const filterGenderRaw = (attrFilters.gender || attrFilters.Gender || attrFilters.gender_fallback || "").toString().toLowerCase().trim();
  const filterGender = filterGenderRaw === "men" || filterGenderRaw === "mens" || filterGenderRaw === "men's" || filterGenderRaw === "male"
    ? "men"
    : filterGenderRaw === "women" || filterGenderRaw === "womens" || filterGenderRaw === "women's" || filterGenderRaw === "female"
    ? "women"
    : null;
  const effectiveGender = detected.gender || sessionGender || filterGender || null;
  const searchQuery = detected.gender ? detected.query : q;

  const keywords = extractKeywords(searchQuery);
  if (keywords.length === 0 && !effectiveGender) return { products: [] };

  const synonymMap = buildSynonymMap(querySynonyms);
  const userIntentText = `${q} ${userText || ""}`;
  const merchantExclude = matchesCategoryRule(userIntentText, categoryExclusions, userText);
  const exclusionClause = merchantExclude ? buildExclusionClause(merchantExclude) : null;
  const GENDER_KEYS_FOR_LOG = new Set(["gender", "gender_fallback", "genders"]);
  const extraFilterKeys = Object.keys(attrFilters).filter((k) => !GENDER_KEYS_FOR_LOG.has(k.toLowerCase()));
  const extraFiltersLog = extraFilterKeys.length > 0
    ? extraFilterKeys.map((k) => `${k}=${attrFilters[k]}`).join(",")
    : "-";
  console.log(`[search] query="${q}" gender=${effectiveGender || "-"} filters=${extraFiltersLog} rule=${merchantExclude || "-"}`);

  const where = {
    shop,
    NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
    AND: keywords.length > 0 ? keywords.map((kw) => keywordMatchClause(kw, synonymMap)) : [],
  };

  if (effectiveGender) {
    where.AND.push(genderFilterClause(effectiveGender));
  }

  if (exclusionClause) {
    where.AND.push(exclusionClause);
  }

  const GENDER_KEYS = new Set(["gender", "gender_fallback", "genders"]);
  const attrKeys = Object.keys(attrFilters).filter((k) => !GENDER_KEYS.has(k.toLowerCase()));
  if (attrKeys.length > 0) {
    where.AND.push(
      ...attrKeys.map((key) => {
        const raw = String(attrFilters[key] || "").trim();
        const lower = raw.toLowerCase();
        const title = lower.charAt(0).toUpperCase() + lower.slice(1);
        const cases = Array.from(new Set([raw, lower, title, lower.toUpperCase()].filter(Boolean)));
        return {
          OR: cases.flatMap((v) => [
            { attributesJson: { path: [key], equals: v } },
            { attributesJson: { path: [key], array_contains: [v] } },
            { attributesJson: { path: [key], string_contains: v } },
            { variants: { some: { attributesJson: { path: [key], equals: v } } } },
            { variants: { some: { attributesJson: { path: [key], array_contains: [v] } } } },
            { variants: { some: { attributesJson: { path: [key], string_contains: v } } } },
          ]),
        };
      }),
    );
  }

  const fetchLimit = deduplicateColors ? max * 5 : max * 3;

  let products = await prisma.product.findMany({
    where,
    include: {
      variants: { select: { sku: true, price: true, compareAtPrice: true, attributesJson: true } },
    },
    take: fetchLimit,
    orderBy: { updatedAt: "desc" },
  });

  if (products.length === 0 && keywords.length > 1) {
    const fallbackWhere = {
      shop,
      NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
      OR: keywords.map((kw) => keywordMatchClause(kw, synonymMap)),
    };
    const fallbackAnd = [];
    if (effectiveGender) fallbackAnd.push(genderFilterClause(effectiveGender));
    if (exclusionClause) fallbackAnd.push(exclusionClause);
    if (fallbackAnd.length > 0) fallbackWhere.AND = fallbackAnd;
    products = await prisma.product.findMany({
      where: fallbackWhere,
      include: {
        variants: { select: { sku: true, price: true, compareAtPrice: true, attributesJson: true } },
      },
      take: fetchLimit,
      orderBy: { updatedAt: "desc" },
    });
  }

  const matchesAttr = (val, want) => {
    if (Array.isArray(val)) return val.some((v) => typeof v === "string" && v.toLowerCase().includes(want));
    return typeof val === "string" && val.toLowerCase().includes(want);
  };
  let filtered = attrKeys.length > 0
    ? products.filter((p) => {
        const productAttrs = p.attributesJson || {};
        return attrKeys.every((key) => {
          const want = attrFilters[key].toLowerCase();
          if (matchesAttr(productAttrs[key], want)) return true;
          return p.variants.some((v) => matchesAttr((v.attributesJson || {})[key], want));
        });
      })
    : products;

  if (effectiveGender) {
    const want = effectiveGender.toLowerCase();
    const opposite = want === "men" ? "women" : want === "women" ? "men" : null;
    const wantRe = new RegExp(`(^|[^a-z])${want}('?s)?([^a-z]|$)`, "i");
    const oppositeRe = opposite ? new RegExp(`(^|[^a-z])${opposite}('?s)?([^a-z]|$)`, "i") : null;
    const unisexRe = /(^|[^a-z])unisex([^a-z]|$)/i;

    const before = filtered.length;
    filtered = filtered.filter((p) => {
      const attrs = p.attributesJson || {};
      const gVal = attrs.gender || attrs.gender_fallback || "";
      const gStr = Array.isArray(gVal) ? gVal.join(" ") : String(gVal);
      const titleStr = p.title || "";

      if (unisexRe.test(gStr)) return true;

      const gHasOpposite = oppositeRe && oppositeRe.test(gStr);
      const gHasWant = wantRe.test(gStr);
      if (gHasOpposite && !gHasWant) return false;
      if (gHasWant) return true;

      const tHasOpposite = oppositeRe && oppositeRe.test(titleStr);
      const tHasWant = wantRe.test(titleStr);
      if (tHasOpposite && !tHasWant) return false;
      if (tHasWant) return true;

      console.warn(`[gender-filter] dropped product=${p.handle} want=${want} gender=${JSON.stringify(gVal)} title="${titleStr}"`);
      return false;
    });
    if (before !== filtered.length) {
      console.log(`[gender-filter] want=${want} ${before} -> ${filtered.length} products`);
    }
  }

  if (deduplicateColors) {
    filtered = deduplicateByColor(filtered);
  }

  filtered = filtered.slice(0, max);

  console.log(`[search]   → db=${products.length} filtered=${filtered.length}`);

  const firstPrice = (variants) => {
    const v = variants.find((v) => v.price);
    return v ? v.price : null;
  };

  const firstCompareAt = (variants) => {
    const v = variants.find((v) => v.compareAtPrice);
    return v ? v.compareAtPrice : null;
  };

  return {
    query: q,
    count: filtered.length,
    filters: attrKeys.length > 0 ? attrFilters : undefined,
    products: filtered.map((p) => ({
      handle: p.handle,
      title: p.title,
      vendor: p.vendor || undefined,
      productType: p.productType || undefined,
      tags: p.tags?.length ? p.tags : undefined,
      attributes: p.attributesJson || undefined,
      priceRange: priceRange(p.variants),
      variantCount: p.variants.length,
      url: productUrl(shop, p.handle),
      image: p.featuredImageUrl || undefined,
      price: firstPrice(p.variants) || undefined,
      compareAtPrice: firstCompareAt(p.variants) || undefined,
    })),
  };
}

async function getProductDetails({ handle }, { shop }) {
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const product = await prisma.product.findFirst({
    where: { shop, handle: h, NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } } },
    include: { variants: true },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const skus = product.variants.map((v) => v.sku).filter(Boolean);
  const enrich = await enrichmentMap(shop, skus);

  return {
    handle: product.handle,
    title: product.title,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    tags: product.tags?.length ? product.tags : undefined,
    status: product.status || undefined,
    description: truncate(product.description || "", 600),
    priceRange: priceRange(product.variants),
    url: productUrl(shop, product.handle),
    image: product.featuredImageUrl || undefined,
    price: product.variants[0]?.price || undefined,
    compareAtPrice: product.variants[0]?.compareAtPrice || undefined,
    variants: product.variants.map((v) => ({
      sku: v.sku || undefined,
      title: v.title || undefined,
      price: v.price || undefined,
      compareAtPrice: v.compareAtPrice || undefined,
      inventoryQty: v.inventoryQty ?? undefined,
      options: safeParseJson(v.optionsJson) || undefined,
      attributes: v.attributesJson || undefined,
      enrichment: v.sku ? enrich.get(v.sku) || undefined : undefined,
    })),
  };
}

async function lookupSku({ skus }, { shop }) {
  const list = Array.from(
    new Set((Array.isArray(skus) ? skus : []).map((s) => String(s).trim()).filter(Boolean)),
  ).slice(0, 10);
  if (list.length === 0) return { found: [], missing: [] };

  const variants = await prisma.productVariant.findMany({
    where: { sku: { in: list }, product: { shop, NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } } } },
    include: { product: true },
  });
  const enrich = await enrichmentMap(shop, list);

  const foundSet = new Set(variants.map((v) => v.sku));
  const missing = list.filter((s) => !foundSet.has(s));

  return {
    found: variants.map((v) => ({
      sku: v.sku,
      productHandle: v.product.handle,
      productTitle: v.product.title,
      variantTitle: v.title || undefined,
      price: v.price || undefined,
      compareAtPrice: v.compareAtPrice || undefined,
      inventoryQty: v.inventoryQty ?? undefined,
      options: safeParseJson(v.optionsJson) || undefined,
      attributes: v.attributesJson || undefined,
      productAttributes: v.product.attributesJson || undefined,
      url: productUrl(shop, v.product.handle),
      image: v.product.featuredImageUrl || undefined,
      enrichment: enrich.get(v.sku) || undefined,
    })),
    missing,
  };
}

function numericShopifyId(gid) {
  if (!gid) return null;
  const match = String(gid).match(/(\d+)$/);
  return match ? match[1] : null;
}

const FIT_PATTERNS = [
  { key: "runs_small", regex: /\b(runs? small|too small|tight|size up|order.{0,6}size up|half size up|one size up)\b/i },
  { key: "runs_large", regex: /\b(runs? (?:big|large)|too (?:big|large)|loose|size down|order.{0,6}size down|half size down|one size down)\b/i },
  { key: "true_to_size", regex: /\b(true to size|fits (?:well|perfectly|great)|perfect fit|right size|accurate sizing)\b/i },
  { key: "narrow", regex: /\b(too narrow|narrow fit|feels? narrow)\b/i },
  { key: "wide", regex: /\b(too wide|wide fit|feels? wide|roomy)\b/i },
];

function classifyFit(text) {
  const hits = [];
  for (const { key, regex } of FIT_PATTERNS) {
    if (regex.test(text)) hits.push(key);
  }
  return hits;
}

async function getProductReviews({ handle }, { shop, yotpoApiKey }) {
  if (!yotpoApiKey) {
    return { error: "Yotpo reviews are not configured for this store." };
  }
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const product = await prisma.product.findFirst({
    where: { shop, handle: h },
    select: { shopifyId: true, title: true },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const productId = numericShopifyId(product.shopifyId);
  if (!productId) return { error: "Could not resolve Shopify product id." };

  const url = `https://api.yotpo.com/v1/widget/${encodeURIComponent(yotpoApiKey)}/products/${encodeURIComponent(productId)}/reviews.json?per_page=30&page=1&sort=date&direction=desc`;
  let data;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: `Yotpo request failed (${res.status}).` };
    data = await res.json();
  } catch (err) {
    return { error: `Yotpo fetch error: ${err?.message || "unknown"}` };
  }

  const reviews = data?.response?.reviews || [];
  const bottomline = data?.response?.bottomline || {};

  const fitCounts = { runs_small: 0, runs_large: 0, true_to_size: 0, narrow: 0, wide: 0 };
  const snippets = [];
  for (const r of reviews) {
    const content = `${r.title || ""} ${r.content || ""}`.trim();
    const hits = classifyFit(content);
    for (const k of hits) fitCounts[k] = (fitCounts[k] || 0) + 1;
    if (snippets.length < 8 && content.length > 20) {
      snippets.push({
        rating: r.score,
        text: truncate(content.replace(/\s+/g, " "), 220),
      });
    }
  }

  let fitSummary = "Not enough reviews mention fit.";
  const totalFit = fitCounts.runs_small + fitCounts.runs_large + fitCounts.true_to_size;
  if (totalFit >= 3) {
    if (fitCounts.true_to_size >= fitCounts.runs_small && fitCounts.true_to_size >= fitCounts.runs_large) {
      fitSummary = `Most reviewers say it fits true to size (${fitCounts.true_to_size} of ${totalFit} fit mentions).`;
    } else if (fitCounts.runs_small > fitCounts.runs_large && fitCounts.runs_small > fitCounts.true_to_size) {
      fitSummary = `Tends to run small — reviewers suggest sizing up (${fitCounts.runs_small} of ${totalFit} fit mentions).`;
    } else if (fitCounts.runs_large > fitCounts.runs_small && fitCounts.runs_large > fitCounts.true_to_size) {
      fitSummary = `Tends to run large — reviewers suggest sizing down (${fitCounts.runs_large} of ${totalFit} fit mentions).`;
    } else {
      fitSummary = `Fit reviews are mixed — consider trying your usual size (${totalFit} fit mentions).`;
    }
  }

  return {
    handle: h,
    title: product.title,
    totalReviews: bottomline.total_review ?? reviews.length,
    averageScore: bottomline.average_score ?? undefined,
    fitSummary,
    fitCounts,
    sampleReviews: snippets,
  };
}

async function getReturnInsights({ handle }, { shop, aftershipApiKey }) {
  if (!aftershipApiKey) {
    return { error: "Aftership returns are not configured for this store." };
  }
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const product = await prisma.product.findFirst({
    where: { shop, handle: h },
    select: { title: true },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const url = `https://api.aftership.com/returns-center/v1/returns?search=${encodeURIComponent(product.title)}&limit=50`;
  let data;
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "aftership-api-key": aftershipApiKey,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `Aftership request failed (${res.status}).` };
    data = await res.json();
  } catch (err) {
    return { error: `Aftership fetch error: ${err?.message || "unknown"}` };
  }

  const returns = data?.data?.returns || data?.returns || [];
  if (!Array.isArray(returns) || returns.length === 0) {
    return {
      handle: h,
      title: product.title,
      totalReturns: 0,
      note: "No return data available for this product.",
    };
  }

  const reasonCounts = {};
  const sizingReasons = { too_small: 0, too_big: 0, other_fit: 0 };
  for (const r of returns) {
    const items = r?.items || r?.return_items || [];
    const matches = items.filter((it) => {
      const name = (it?.product_name || it?.name || "").toLowerCase();
      return name && name.includes(product.title.toLowerCase().slice(0, 20));
    });
    if (matches.length === 0 && items.length > 0) continue;
    for (const it of (matches.length ? matches : items)) {
      const reason = String(it?.return_reason || it?.reason || r?.reason || "unspecified").toLowerCase();
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      if (/too small|size up|smaller/i.test(reason)) sizingReasons.too_small++;
      else if (/too (?:big|large)|size down|larger/i.test(reason)) sizingReasons.too_big++;
      else if (/fit|size/i.test(reason)) sizingReasons.other_fit++;
    }
  }

  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  let sizingAdvice = null;
  const totalSizing = sizingReasons.too_small + sizingReasons.too_big;
  if (totalSizing >= 2) {
    if (sizingReasons.too_small > sizingReasons.too_big * 1.5) {
      sizingAdvice = "Returns skew toward 'too small' — recommend sizing up.";
    } else if (sizingReasons.too_big > sizingReasons.too_small * 1.5) {
      sizingAdvice = "Returns skew toward 'too big' — recommend sizing down.";
    } else {
      sizingAdvice = "Return data is mixed on sizing — likely true to size.";
    }
  }

  return {
    handle: h,
    title: product.title,
    totalReturns: returns.length,
    sizingReasons,
    topReasons,
    sizingAdvice,
  };
}

const HANDLERS = {
  search_products: searchProducts,
  get_product_details: getProductDetails,
  lookup_sku: lookupSku,
  get_product_reviews: getProductReviews,
  get_return_insights: getReturnInsights,
};

function mentionsFromResult(name, result) {
  if (!result || result.error) return [];
  if (name === "search_products" && Array.isArray(result.products)) {
    return result.products.map((p) => ({ handle: p.handle, title: p.title, tool: name }));
  }
  if (name === "get_product_details" && result.handle && result.title) {
    return [{ handle: result.handle, title: result.title, tool: name }];
  }
  if (name === "lookup_sku" && Array.isArray(result.found)) {
    return result.found.map((f) => ({ handle: f.productHandle, title: f.productTitle, tool: name }));
  }
  return [];
}

const MAX_PRODUCT_CARDS = 10;

export function extractProductCards(name, result) {
  if (!result || result.error) return [];
  if (name === "search_products" && Array.isArray(result.products)) {
    return result.products.slice(0, MAX_PRODUCT_CARDS).map((p) => ({
      title: p.title,
      url: p.url,
      handle: p.handle,
      image: p.image || "",
      price_formatted: p.priceRange || (p.price ? `$${parseFloat(p.price).toFixed(2)}` : ""),
      compare_at_price: p.compareAtPrice ? Math.round(parseFloat(p.compareAtPrice) * 100) : undefined,
    }));
  }
  if (name === "get_product_details" && result.handle) {
    return [{
      title: result.title,
      url: result.url,
      handle: result.handle,
      image: result.image || "",
      price_formatted: result.priceRange || (result.price ? `$${parseFloat(result.price).toFixed(2)}` : ""),
      compare_at_price: result.compareAtPrice ? Math.round(parseFloat(result.compareAtPrice) * 100) : undefined,
    }];
  }
  if (name === "lookup_sku" && Array.isArray(result.found)) {
    const seen = new Set();
    return result.found
      .filter((f) => !seen.has(f.productHandle) && seen.add(f.productHandle))
      .map((f) => ({
        title: f.productTitle,
        url: f.url,
        handle: f.productHandle,
        image: f.image || "",
        price_formatted: f.price ? `$${parseFloat(f.price).toFixed(2)}` : "",
        compare_at_price: f.compareAtPrice ? Math.round(parseFloat(f.compareAtPrice) * 100) : undefined,
      }));
  }
  return [];
}

export async function executeTool(name, input, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool '${name}'.` };
  try {
    const result = await handler(input || {}, ctx);
    if (ctx?.shop) {
      logMentions(ctx.shop, mentionsFromResult(name, result)).catch(() => {});
    }
    return result;
  } catch (err) {
    console.error(`[tool ${name}] error:`, err?.message || err);
    return { error: `Tool '${name}' failed: ${err?.message || "unknown error"}` };
  }
}
