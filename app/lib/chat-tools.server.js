import prisma from "../db.server";
import { logMentions } from "../models/ChatProductMention.server";
import { fetchCustomerContext } from "./customer-context.server";
import { embedText, vectorLiteral, resolveShopEmbedding } from "./embeddings.server";
import { normalizeGenderChipAnswer } from "./chat-helpers.server";
import { textIntentDivergesFromGroup } from "./category-intent.server";


const flattenValues = (obj) => {
  if (!obj || typeof obj !== "object") return "";

  return Object.values(obj)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .join(" ");
};

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
    name: "find_similar_products",
    description:
      "Find products similar to a specific reference product the customer named. Use this WHENEVER the customer asks for styles 'like', 'similar to', 'comparable to', 'supports like', 'feels like', or 'what else is like the <product name>' a specific product they named. Matches on the merchant's configured similarity attributes PLUS category PLUS gender of the reference product. Automatically excludes the reference product itself from results. Supports optional priceMax (when customer asks for 'cheaper', 'under $50', 'less expensive') and query (additional keyword filter, e.g. 'leather' to narrow to leather-only). Do NOT use search_products for this — search_products cannot exclude the reference and cannot guarantee the similarity-attribute match. If the customer names a product but you don't know its handle, call search_products first to get the handle, then call this tool.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The reference product's handle (slug). This is the product the customer named and wants similar styles to.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of similar products to return (default 6, max 10).",
          minimum: 1,
          maximum: 10,
        },
        priceMax: {
          type: "number",
          description: "Optional maximum price ceiling. Use when the customer says 'cheaper', 'under $X', 'less expensive', 'budget'.",
        },
        query: {
          type: "string",
          description: "Optional keyword filter applied on top of similarity matching. Use for narrowing modifiers: 'leather', 'waterproof', 'wide width', 'memory foam', etc.",
        },
      },
      required: ["handle"],
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
  // utm_content (not utm_source) so the chat doesn't overwrite the
  // attribution from Facebook/email/etc. utm_content is a sub-dimension
  // — Shopify and GA4 still report on it but it doesn't trigger
  // session re-attribution. Order-level "this came from the chat"
  // signal lives in the cart attribute set by the widget on click,
  // which orders/create webhook converts to a SEoS order tag.
  return `https://${shop}/products/${handle}?utm_content=SEoS`;
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

// Returns a short description excerpt. If the query term appears in the description,
// returns a window around the first match (so the AI sees why it matched). Otherwise
// returns the leading snippet. Keeps tool-result payloads small while giving the AI
// enough context to answer terminology/ingredient questions.
function descriptionSnippet(desc, query, maxLen) {
  if (!desc) return undefined;
  const text = String(desc).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const n = maxLen || 240;
  const q = String(query || "").trim().toLowerCase();
  if (q) {
    const idx = text.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, start + n);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < text.length ? "…" : "";
      return prefix + text.slice(start, end) + suffix;
    }
  }
  return truncate(text, n);
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
  // Look up synonyms under the keyword as-typed AND under each singular/plural
  // variant — so a single "sandal → slide, flip" entry catches both "sandal"
  // and "sandals" queries without the merchant having to add two rows.
  let synonymTerms = [];
  if (synonymMap) {
    const seenSyn = new Set();
    for (const variant of inflectVariants(kw)) {
      for (const s of synonymMap[variant.toLowerCase()] || []) {
        if (!seenSyn.has(s)) { seenSyn.add(s); synonymTerms.push(s); }
      }
    }
  }
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

  const lower = t.toLowerCase();
  const titleCase = lower.charAt(0).toUpperCase() + lower.slice(1);
  const termCases = Array.from(new Set([t, lower, titleCase]));

  for (const v of termCases) {
    clauses.push({ attributesJson: { path: ["category"], equals: v } });
    clauses.push({ attributesJson: { path: ["category_for_filter"], equals: v } });
    clauses.push({ attributesJson: { path: ["category"], string_contains: v } });
    clauses.push({ attributesJson: { path: ["category_for_filter"], string_contains: v } });
  }
}
  clauses.push({ tags: { hasSome: allTerms } });
  return { OR: clauses };
}

function buildExclusionClause(excludeTerms) {
  const terms = excludeTerms.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (terms.length === 0) return null;
  // Exclude based on the CATEGORY metafield, not free-text title matching.
  // A product titled "Milos Orthotic Men's Slides" has category="sandals";
  // title-based exclusion would wrongly hide it when the rule excludes
  // "orthotic" during a sandal search. Shopify's native productType column
  // is kept as a narrow fallback for products that lack a category metafield.
  const categoryKeys = ["category", "Category", "category_for_filter", "Category For Filter", "subcategory", "Subcategory"];
  return {
    AND: terms.flatMap((t) => {
      const titleCase = t.charAt(0).toUpperCase() + t.slice(1);
      const cases = Array.from(new Set([t, titleCase, t.toUpperCase()]));
      const matchClauses = [];
      for (const key of categoryKeys) {
        for (const v of cases) {
          matchClauses.push({ attributesJson: { path: [key], equals: v } });
          matchClauses.push({ attributesJson: { path: [key], array_contains: [v] } });
          matchClauses.push({ attributesJson: { path: [key], string_contains: v } });
        }
      }
      matchClauses.push({ productType: { equals: t, mode: "insensitive" } });
      matchClauses.push({ productType: { equals: titleCase, mode: "insensitive" } });
      return [{ NOT: { OR: matchClauses } }];
    }),
  };
}

function splitCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// Word-boundary + singular/plural match for a single override phrase.
// "shoe" matches "shoe" and "shoes"; "shoes" matches "shoes" and "shoe".
// "new shoes" matches "new shoes" / "new shoe" but not "newshoes".
function overrideMatches(userLower, phrase) {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withS = /s$/.test(phrase)
    ? `(?:${escaped}|${escaped.slice(0, -1)})`
    : `${escaped}(?:s|es)?`;
  return new RegExp(`\\b${withS}\\b`).test(userLower);
}

function activeGroupTerms(activeGroup) {
  if (!activeGroup || typeof activeGroup !== "object") return [];
  return [
    activeGroup.name,
    ...(Array.isArray(activeGroup.categories) ? activeGroup.categories : []),
    ...(Array.isArray(activeGroup.triggers) ? activeGroup.triggers : []),
  ]
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);
}

function excludesActiveGroup(excludes, activeGroup) {
  const terms = activeGroupTerms(activeGroup);
  if (terms.length === 0 || excludes.length === 0) return false;
  return excludes.some((exclude) =>
    terms.some((term) => overrideMatches(term, exclude) || overrideMatches(exclude, term) || term.includes(exclude) || exclude.includes(term)),
  );
}

function productMatchesGroupCategory(product, activeGroup) {
  const categories = Array.isArray(activeGroup?.categories)
    ? activeGroup.categories.map((c) => String(c || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (categories.length === 0) return true;
  const attrs = product.attributesJson || {};
  const parts = [
    attrs.category,
    attrs.category_for_filter,
    attrs.subcategory,
    product.productType,
  ];
  const haystack = parts
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .join(" ");
  // Don't fail closed when a product lacks all category metadata
  // (older imports, missing metafields, productType empty). The UI guard
  // in cardMatchesActiveGroup already passes such cards through; do the
  // same here so a freshly installed catalog without tags doesn't return
  // zero results forever. Loses some specificity but avoids dead-ending.
  if (!haystack) return true;
  return categories.some((cat) => haystack.includes(cat) || cat.includes(haystack));
}

// Merchant-configured via Rules & Knowledge → Search Rules.
// Each rule: { whenQuery, excludeTerms, overrideTriggers? }
// - whenQuery: comma-separated keywords; the rule fires when any appears in the
//   user's latest message (or the AI's current search query)
// - excludeTerms: comma-separated terms; matching products are hidden from results
// - overrideTriggers (optional): comma-separated keywords that skip the rule
//   for this turn (word-boundary, plural-aware match against the latest message)
//
// Auto-bypass: even without a configured override, if the user's latest message
// explicitly mentions any excludeTerm, the rule is skipped for this turn — the
// customer is asking for the very thing the rule would hide.
function matchesCategoryRule(triggerText, rules, latestUserText = "", activeGroup = null) {
  if (!rules || !Array.isArray(rules)) return null;
  const lower = triggerText.toLowerCase();
  const userLower = (latestUserText || "").toLowerCase();
  const overrideLower = `${userLower} ${lower}`.trim();
  for (const rule of rules) {
    const triggers = splitCsv(rule.whenQuery);
    if (!triggers.some((t) => lower.includes(t))) continue;
    const excludes = splitCsv(rule.excludeTerms);
    if (excludesActiveGroup(excludes, activeGroup)) {
      console.log(`[search]   rule skipped: would exclude active group=${activeGroup?.name || "-"}`);
      continue;
    }
    if (excludes.length > 0 && excludes.some((e) => overrideMatches(overrideLower, e))) continue;
    const overrides = splitCsv(rule.overrideTriggers);
    if (overrides.length > 0 && overrides.some((o) => overrideMatches(overrideLower, o))) continue;
    return rule.excludeTerms;
  }
  return null;
}

const GENDER_DETECT = [
  {
    pattern: /\b(men|mens|men['’]?s|male|guy|dude|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|him|his)\b/i,
    gender: "men",
    strip: /\b(men|mens|men['’]?s|male|guy|dude|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew)\b/gi,
  },
  {
    pattern: /\b(women|womens|women['’]?s|female|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|her|hers)\b/i,
    gender: "women",
    strip: /\b(women|womens|women['’]?s|female|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece)\b/gi,
  },
  {
    pattern: /\b(boy|boys|boy['’]?s)\b/i,
    gender: "boy",
    strip: /\b(boy|boys|boy['’]?s)\b/gi,
  },
  {
    pattern: /\b(girl|girls|girl['’]?s)\b/i,
    gender: "girl",
    strip: /\b(girl|girls|girl['’]?s)\b/gi,
  },
  {
    pattern: /\b(kid|kids|kid['’]?s|children|children['’]?s|childrens)\b/i,
    gender: "kid",
    strip: /\b(kid|kids|kid['’]?s|children|children['’]?s|childrens)\b/gi,
  },
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

// For concatenated conversation history: return the gender mentioned LAST
// (most recent), not first. Avoids "Men's" from turn 1 sticking forever after
// the customer pivots to "women's wedges" later.
function detectLatestGender(text) {
  if (!text) return null;
  let bestIdx = -1;
  let bestGender = null;
  for (const g of GENDER_DETECT) {
    const globalPattern = new RegExp(g.pattern.source, "gi");
    const matches = [...text.matchAll(globalPattern)];
    if (matches.length === 0) continue;
    const lastIdx = matches[matches.length - 1].index;
    if (lastIdx > bestIdx) {
      bestIdx = lastIdx;
      bestGender = g.gender;
    }
  }
  return bestGender;
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

async function searchProducts(
  { query, limit, filters },
  { shop, deduplicateColors, sessionGender, categoryExclusions, querySynonyms, conversationText, userText, latestUserMessage, shopConfig, activeCategoryGroup, merchantGroups }
) {
  const q = String(query || "").trim();
  if (!q) return { products: [] };

  const max = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);
  const attrFilters = filters && typeof filters === "object" ? filters : {};

const detected = detectAndStripGender(q);
const detectedFromLatest = detectAndStripGender(latestUserMessage || "");
const latestUserGender = detectLatestGender(userText || "");
const latestConvoGender = detectLatestGender(conversationText || "");

// Tolerate compound chip answers like "Men's & Boys'" or "Women's, Girls'"
// by splitting on &/and/comma and matching the first recognized token.
const filterGenderRaw = (attrFilters.gender || attrFilters.Gender || attrFilters.gender_fallback || "");
const filterGender = normalizeGenderChipAnswer(filterGenderRaw);

// Priority: AI's current search query > customer's latest message > most recent
// gender mention anywhere in history > session/filter fallbacks. Scanning history
// right-to-left avoids the first gender word from turn 1 sticking forever.
const effectiveGender =
  detected.gender ||
  detectedFromLatest.gender ||
  latestUserGender ||
  latestConvoGender ||
  sessionGender ||
  filterGender ||
  null;

const searchQuery = detected.gender ? detected.query : q;

  const rawKeywords = extractKeywords(searchQuery);
  const keywords = rawKeywords.filter(
    (kw) => !["men", "women", "boy", "girl", "kid", "children"].includes(kw)
  );

  if (keywords.length === 0 && !effectiveGender) {
    return { products: [] };
  }

  const synonymMap = buildSynonymMap(querySynonyms);
  // Evaluate exclusion rules against the user's CURRENT message only — not the
  // full history — so a topic-shift mid-conversation isn't blocked by a trigger
  // that fired several turns ago.
  const latestText = latestUserMessage || "";
  const userIntentText = `${q} ${latestText}`;
  const merchantExclude = matchesCategoryRule(userIntentText, categoryExclusions, latestText, activeCategoryGroup);

  const GENDER_KEYS_FOR_LOG = new Set(["gender", "gender_fallback", "genders"]);
  const extraFilterKeys = Object.keys(attrFilters).filter(
    (k) => !GENDER_KEYS_FOR_LOG.has(k.toLowerCase())
  );
  const extraFiltersLog =
    extraFilterKeys.length > 0
      ? extraFilterKeys.map((k) => `${k}=${attrFilters[k]}`).join(",")
      : "-";

  console.log(
    `[search] query="${q}" gender=${effectiveGender || "-"} filters=${extraFiltersLog} rule=${merchantExclude || "-"}`
  );

  // Pull the synced catalog for this shop and do matching in memory.
  // This avoids the brittle Prisma JSON search behavior that has been returning db=0.
  let products = await prisma.product.findMany({
    where: {
      shop,
      NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
    },
    include: {
      variants: {
        select: {
          sku: true,
          price: true,
          compareAtPrice: true,
          attributesJson: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 1200,
  });

  if (activeCategoryGroup) {
    // Data-driven divergence override: when the AI's search query clearly
    // matches a DIFFERENT merchant-configured group than the active one,
    // the group lock is stale (from earlier in the conversation). Trust
    // the explicit query and skip the group filter.
    //
    // Works for any vertical: orthotic-store ("orthotic insole" vs locked
    // Footwear), jewelry ("ring" vs locked Necklaces), apparel, etc. The
    // merchant's own categoryGroups data defines the divergence vocabulary —
    // there are no hardcoded domain keywords here.
    const queryDiverges = textIntentDivergesFromGroup(q, activeCategoryGroup, merchantGroups);

    if (queryDiverges) {
      console.log(`[search]   active-group skip: query matches a different group than locked group=${activeCategoryGroup.name || "-"} — trusting query`);
    } else {
      const beforeGroup = products.length;
      const filtered = products.filter((p) => productMatchesGroupCategory(p, activeCategoryGroup));
      if (filtered.length === 0 && beforeGroup > 0) {
        // Fail-open: the group filter wiped every candidate. The
        // group lock is stale or wrong; better to return broader
        // results than nothing.
        console.log(`[search]   active-group filter ${activeCategoryGroup.name || "-"}: WIPED ALL ${beforeGroup} → falling back to unfiltered`);
      } else {
        products = filtered;
        if (products.length !== beforeGroup) {
          console.log(`[search]   active-group filter ${activeCategoryGroup.name || "-"}: ${products.length}/${beforeGroup}`);
        }
      }
    }
  }

  const expandKeywordTerms = (kw) => {
    const out = new Set();

    for (const v of inflectVariants(kw)) {
      out.add(v.toLowerCase());
    }

    for (const v of inflectVariants(kw)) {
      for (const s of synonymMap[v.toLowerCase()] || []) {
        for (const sv of inflectVariants(s)) {
          out.add(String(sv).toLowerCase());
        }
      }
    }

    return Array.from(out);
  };

  const keywordGroups = keywords.map((kw) => expandKeywordTerms(kw));

const flattenAttributeValues = (obj) => {
  if (!obj || typeof obj !== "object") return "";
  return Object.values(obj)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => String(v))
    .join(" ");
};

const getProductHaystack = (p) => {
  const base = [
    p.title,
    p.vendor,
    p.productType,
    p.description,
    Array.isArray(p.tags) ? p.tags.join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const productAttrs = flattenValues(p.attributesJson);
  const variantAttrs = (p.variants || [])
    .map((v) => flattenValues(v.attributesJson))
    .join(" ");

  return `${base} ${productAttrs} ${variantAttrs}`;
};

  const excludeTerms = merchantExclude ? splitCsv(merchantExclude) : [];

const isExcludedByRule = (p) => {
  if (excludeTerms.length === 0) return false;

  const attrs = p.attributesJson || {};
  const categoryText = [
    attrs.category || "",
    attrs.category_for_filter || "",
    attrs.subcategory || "",
  ]
    .join(" ")
    .toLowerCase();

  const productTypeText = (p.productType || "").toLowerCase();

  // Only exclude by category/filter fields and productType.
  // Do NOT exclude by title, because titles like
  // "Milos Orthotic Men's Slides" would wrongly get removed.
  return excludeTerms.some(
    (term) => categoryText.includes(term) || productTypeText.includes(term)
  );
};

  const matchesAttr = (val, want) => {
    if (Array.isArray(val)) {
      return val.some((v) => typeof v === "string" && v.toLowerCase().includes(want));
    }
    return typeof val === "string" && val.toLowerCase().includes(want);
  };

  const attrKeys = Object.keys(attrFilters).filter(
    (k) => !new Set(["gender", "gender_fallback", "genders"]).has(k.toLowerCase())
  );

  const matchesGender = (p, want) => {
    if (!want) return true;

    const attrs = p.attributesJson || {};
    const gVal = attrs.gender || attrs.gender_fallback || "";
    const gStr = Array.isArray(gVal) ? gVal.join(" ") : String(gVal);
    const titleStr = p.title || "";

    const opposite = want === "men" ? "women" : want === "women" ? "men" : null;
    const wantRe = new RegExp(`(^|[^a-z])${want}('?s)?([^a-z]|$)`, "i");
    const oppositeRe = opposite ? new RegExp(`(^|[^a-z])${opposite}('?s)?([^a-z]|$)`, "i") : null;
    const unisexRe = /(^|[^a-z])unisex([^a-z]|$)/i;

    if (unisexRe.test(gStr)) return true;

    const gHasWant = wantRe.test(gStr);
    const gHasOpposite = oppositeRe ? oppositeRe.test(gStr) : false;
    if (gHasWant) return true;
    if (gHasOpposite) return false;

    const tHasWant = wantRe.test(titleStr);
    const tHasOpposite = oppositeRe ? oppositeRe.test(titleStr) : false;
    if (tHasWant) return true;
    if (tHasOpposite) return false;

    // Strict mode: when a specific gender was requested but the product has
    // no gender signal anywhere (attrs.gender is empty AND title has neither
    // gender word), DROP it. Showing untagged products under a specific
    // gender risks leaking the wrong gender (e.g. men's products with empty
    // gender attributes appearing in women's queries). Catalog data should
    // tag every product; missing tags should fail closed, not open.
    return false;
  };

  // Weighted scoring. A match in title / productType / category attributes
  // is a much stronger signal than the same word mentioned somewhere in a
  // description (e.g. a sandal that mentions "heel cushion" shouldn't tie a
  // wedge whose productType is "Wedges" — on the old binary score ties were
  // broken by updatedAt, which is volatile, so actual-category products got
  // buried). Weights are generic — no product terminology baked in.
  const FIELD_WEIGHTS = {
    title: 3,
    productType: 3,
    categoryAttrs: 3,
    tags: 2,
    otherAttrs: 2,
    vendor: 1,
    description: 1,
  };

  const getScoredFields = (p) => {
    const attrs = p.attributesJson || {};
    const categoryAttrs = [attrs.category, attrs.category_for_filter, attrs.subcategory]
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .filter(Boolean)
      .map((v) => String(v).toLowerCase())
      .join(" ");
    const otherAttrValues = Object.entries(attrs)
      .filter(([k]) => k !== "category" && k !== "category_for_filter" && k !== "subcategory")
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map((v) => String(v).toLowerCase())
      .join(" ");
    const variantAttrs = (p.variants || [])
      .map((v) => flattenValues(v.attributesJson))
      .join(" ");
    return {
      title: (p.title || "").toLowerCase(),
      productType: (p.productType || "").toLowerCase(),
      categoryAttrs,
      tags: Array.isArray(p.tags) ? p.tags.join(" ").toLowerCase() : "",
      otherAttrs: `${otherAttrValues} ${variantAttrs}`.trim(),
      vendor: (p.vendor || "").toLowerCase(),
      description: (p.description || "").toLowerCase(),
    };
  };

  // Semantic search runs IN PARALLEL with keyword scoring, not as a fallback.
  // Pre-compute similarity for top-N products so it can boost the scoring
  // loop. Semantic-only candidates (no keyword match but high similarity) can
  // surface alongside keyword matches.
  let semanticMap = new Map();
  const shopEmbedding = resolveShopEmbedding(shopConfig);
  if (shopEmbedding && q) {
    try {
      const queryVec = await embedText(shopEmbedding.provider, shopEmbedding.apiKey, q, { inputType: "query" });
      const lit = vectorLiteral(queryVec);
      const semRows = await prisma.$queryRawUnsafe(
        `SELECT id, 1 - (embedding <=> $1::vector) AS sim
         FROM "Product"
         WHERE shop = $2
           AND embedding IS NOT NULL
           AND NOT (status IN ('DRAFT', 'draft', 'ARCHIVED', 'archived'))
         ORDER BY embedding <=> $1::vector
         LIMIT 30`,
        lit,
        shop,
      );
      const SIMILARITY_THRESHOLD = 0.45;
      for (const r of semRows) {
        const sim = Number(r.sim);
        if (sim >= SIMILARITY_THRESHOLD) {
          semanticMap.set(r.id, sim);
        }
      }
    } catch (err) {
      console.error(`[search] semantic embedding failed:`, err?.message || err);
    }
  }
  // Weight tuning: semantic score 0-1 multiplied by 10 → max +10 contribution.
  // A perfect keyword match across multiple fields can score 20-30, so
  // keyword still dominates exact matches; semantic helps when keyword is
  // weak or missing (e.g. "red" → "Burgundy" via embedding).
  const SEMANTIC_WEIGHT = 10;

  const scored = products
    .map((p) => {
      const fields = getScoredFields(p);
      let score = 0;
      let groupsMatched = 0;
      for (const group of keywordGroups) {
        let groupHit = false;
        for (const [key, weight] of Object.entries(FIELD_WEIGHTS)) {
          if (group.some((term) => fields[key].includes(term))) {
            score += weight;
            groupHit = true;
          }
        }
        if (groupHit) groupsMatched++;
      }
      const semSim = semanticMap.get(p.id) || 0;
      if (semSim > 0) {
        score += semSim * SEMANTIC_WEIGHT;
        // Treat semantic as one virtual matched group so a semantic-only
        // candidate (no keyword overlap) still passes the tier filter
        // alongside products that matched at least one keyword group.
        if (groupsMatched < 1) groupsMatched = 1;
      }
      return { product: p, score, groupsMatched, semSim };
    })
    .filter(({ product, score }) => {
      if (isExcludedByRule(product)) return false;
      if (keywordGroups.length === 0) return true;
      return score > 0;
    })
    .sort((a, b) => {
      if (a.groupsMatched !== b.groupsMatched) return b.groupsMatched - a.groupsMatched;
      return b.score - a.score;
    });

  // Only return products at the highest match-tier. If 3 products matched
  // all keywords ("women", "ultrasky", "sneaker") and 5 matched only some,
  // return the 3 — never pad the result set with weaker matches that drop
  // a qualifier (e.g. a regular sneaker shown for a "UltraSky sneaker"
  // query). When NO product matches all keywords, max-tier degrades
  // gracefully so the AI still gets results to show.
  const topGroupsMatched = scored.length > 0
    ? scored[0].groupsMatched
    : 0;
  const tieredScored = scored.filter((x) => x.groupsMatched >= topGroupsMatched);

  let filtered = tieredScored.map((x) => x.product);

  if (attrKeys.length > 0) {
    const beforeAttrFilter = filtered;

    // Category-style filters often come in as umbrella words ("footwear")
    // that don't appear verbatim in the merchant's `category` value (which
    // is usually narrower, like "sneaker"). Expand the filter value through
    // the merchant's configured Query Synonyms and match against every
    // field the merchant uses for category classification plus Shopify's
    // productType. Keeps behavior data-driven — no product terminology in
    // code. If the merchant configured no synonyms, this degrades to an
    // exact match against those fields — same behavior as before.
    const expandFilterValue = (want) => {
      const out = new Set();
      const base = String(want || "").toLowerCase().trim();
      if (!base) return out;
      out.add(base);
      for (const s of synonymMap[base] || []) out.add(String(s).toLowerCase());
      return out;
    };

    const matchesCategoryWant = (p, want) => {
      const wants = expandFilterValue(want);
      if (wants.size === 0) return true;
      const attrs = p.attributesJson || {};
      const parts = [
        attrs.category,
        attrs.category_for_filter,
        attrs.subcategory,
        p.productType,
      ];
      const haystack = parts
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter(Boolean)
        .map((v) => String(v).toLowerCase())
        .join(" ");
      for (const w of wants) {
        if (haystack.includes(w)) return true;
      }
      return false;
    };

    // For non-category attribute filters (e.g. color_family=blue), expand
    // the filter value through the merchant's Query Synonyms too. Lets a
    // "blue" filter also match products whose color_family is "navy" or
    // "denim" if the merchant configured "blue also searches navy, denim".
    // No synonym? Degrades to the original exact-contains behavior.
    const matchesAttrExpanded = (val, wants) => {
      if (wants.size === 0) return true;
      if (Array.isArray(val)) {
        return val.some(
          (v) => typeof v === "string" && [...wants].some((w) => v.toLowerCase().includes(w)),
        );
      }
      return typeof val === "string" && [...wants].some((w) => val.toLowerCase().includes(w));
    };

    filtered = filtered.filter((p) => {
      const productAttrs = p.attributesJson || {};
      return attrKeys.every((key) => {
        const want = String(attrFilters[key] || "").toLowerCase();
        if (!want) return true;
        if (key.toLowerCase() === "category") {
          return matchesCategoryWant(p, want);
        }
        const wants = expandFilterValue(want);
        if (matchesAttrExpanded(productAttrs[key], wants)) return true;
        return (p.variants || []).some((v) => matchesAttrExpanded((v.attributesJson || {})[key], wants));
      });
    });


    // Safety net: if the attribute filters wiped out every keyword match,
    // the LLM's filter value doesn't match this merchant's data verbatim.
    // Two recovery strategies, in order of preference:
    //
    //  1. Semantic-first: if the shop has semantic search and this query
    //     has any high-similarity products, prefer those over showing
    //     filter-irrelevant items. Example: filter color_family=red
    //     wiped out everything; semantic search has Burgundy/Crimson
    //     products at 0.6+ similarity to "red" → return those.
    //
    //  2. Drop filter entirely: fall back to all keyword matches without
    //     the LLM's filter. Less precise but better than dead-ending.
    if (filtered.length === 0 && beforeAttrFilter.length > 0) {
      const semanticFallback = beforeAttrFilter
        .filter((p) => semanticMap.has(p.id))
        .sort((a, b) => (semanticMap.get(b.id) || 0) - (semanticMap.get(a.id) || 0));
      if (semanticFallback.length > 0) {
        console.log(`[search]   filter-wipeout: using ${semanticFallback.length} semantic matches instead of dropping attrFilters=${JSON.stringify(attrFilters)}`);
        filtered = semanticFallback;
      } else {
        console.log(`[search]   filter-wipeout: dropping attrFilters=${JSON.stringify(attrFilters)}`);
        filtered = beforeAttrFilter;
      }
    }
  }


  if (effectiveGender) {
    const beforeGenderFilter = filtered.length;
    const afterGender = filtered.filter((p) => matchesGender(p, effectiveGender.toLowerCase()));
    const eg = effectiveGender.toLowerCase();
    const isKidLike = eg === "kid" || eg === "kids" || eg === "boy" || eg === "boys" || eg === "girl" || eg === "girls" || eg === "child" || eg === "children" || eg === "youth";

    if (afterGender.length === 0 && beforeGenderFilter > 0 && isKidLike) {
      // Catalog rarely tags products with kid/boy/girl gender. matchesGender
      // fails closed for adult-tagged products under a kids query, which
      // wipes everything to zero. Customers wait through 3 retries then
      // get a generic 'no match' message. Better UX: drop the gender
      // filter for kid-like queries so adult products surface — the AI
      // can frame them honestly ('we don't carry kids' sandals
      // specifically, but here are unisex/women's sandals that…').
      console.log(`[search]   gender filter ${eg}: WIPED ALL ${beforeGenderFilter} → falling back to unfiltered (no kids products in this category)`);
    } else {
      filtered = afterGender;
    }
  }

  if (deduplicateColors) {
    filtered = deduplicateByColor(filtered);
  }

  filtered = filtered.slice(0, max);

  // Count how many of the final results got a semantic boost (for log
  // visibility). Semantic was already merged into the scoring loop above.
  const semanticBoosted = filtered.filter((p) => semanticMap.has(p.id)).length;
  console.log(`[search]   → db=${products.length} filtered=${filtered.length}${semanticBoosted > 0 ? ` (semantic-boosted=${semanticBoosted})` : ""}`);

  const firstPrice = (variants) => {
    const v = (variants || []).find((vv) => vv.price);
    return v ? v.price : null;
  };

  const firstCompareAt = (variants) => {
    const v = (variants || []).find((vv) => vv.compareAtPrice);
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
      descriptionSnippet: descriptionSnippet(p.description, q, 280),
      priceRange: priceRange(p.variants || []),
      variantCount: (p.variants || []).length,
      url: productUrl(shop, p.handle),
      image: p.featuredImageUrl || undefined,
      price: firstPrice(p.variants || []) || undefined,
      compareAtPrice: firstCompareAt(p.variants || []) || undefined,
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

  // Pre-derive in-stock sizes so the AI doesn't have to scan variants[]
  // and risk claiming "size 9 is available" when inventoryQty is 0.
  // The prompt rule for size answers can cite this list directly.
  const availableSizes = [];
  for (const v of product.variants) {
    const qty = v.inventoryQty;
    const inStock = qty == null ? true : Number(qty) > 0;
    if (!inStock) continue;
    const opts = safeParseJson(v.optionsJson) || {};
    const size = opts.Size || opts.size || opts.SIZE;
    if (size && !availableSizes.includes(size)) availableSizes.push(size);
  }

  return {
    handle: product.handle,
    title: product.title,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    tags: product.tags?.length ? product.tags : undefined,
    attributes: product.attributesJson || undefined,
    status: product.status || undefined,
    description: truncate(product.description || "", 600),
    priceRange: priceRange(product.variants),
    url: productUrl(shop, product.handle),
    image: product.featuredImageUrl || undefined,
    price: product.variants[0]?.price || undefined,
    compareAtPrice: product.variants[0]?.compareAtPrice || undefined,
    availableSizes: availableSizes.length > 0 ? availableSizes : undefined,
    variants: product.variants.map((v) => ({
      sku: v.sku || undefined,
      title: v.title || undefined,
      price: v.price || undefined,
      compareAtPrice: v.compareAtPrice || undefined,
      inventoryQty: v.inventoryQty ?? undefined,
      inStock: v.inventoryQty == null ? undefined : Number(v.inventoryQty) > 0,
      options: safeParseJson(v.optionsJson) || undefined,
      attributes: v.attributesJson || undefined,
      enrichment: v.sku ? enrich.get(v.sku) || undefined : undefined,
    })),
  };
}

async function findSimilarProducts({ handle, limit, priceMax, query }, { shop, deduplicateColors, similarMatchAttributes }) {
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const matchAttrs = Array.isArray(similarMatchAttributes)
    ? similarMatchAttributes.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  if (matchAttrs.length === 0) {
    return {
      error:
        "Similar-product matching is not configured for this store. The merchant needs to add at least one similarity attribute in the app admin under Rules & Knowledge → Similar-product matching.",
      products: [],
    };
  }

  const reference = await prisma.product.findFirst({
    where: { shop, handle: h, NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } } },
    include: {
      variants: {
        select: { sku: true, price: true, compareAtPrice: true, attributesJson: true },
      },
    },
  });
  if (!reference) return { error: `No product found with handle '${h}'.` };

  const refAttrs = reference.attributesJson || {};

  // Read a configured attribute case-insensitively — merchants spell metafield
  // keys inconsistently. Returns all non-empty values as a lowercase string array.
  const readAttrLowerList = (attrs, keyVariants) => {
    const seen = new Set();
    const out = [];
    for (const k of keyVariants) {
      const v = attrs?.[k];
      if (v == null || v === "") continue;
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) {
        if (x == null || x === "") continue;
        const s = String(x).toLowerCase().trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  };

  const variantKeys = (name) => {
    const trimmed = String(name).trim();
    const lower = trimmed.toLowerCase();
    const upper = trimmed.toUpperCase();
    const titleCase = lower.charAt(0).toUpperCase() + lower.slice(1);
    return Array.from(new Set([trimmed, lower, upper, titleCase]));
  };

  // For each configured similarity attribute, collect the reference's values.
  // If the reference is missing a value for every attribute the merchant set,
  // we cannot find "similar" products meaningfully — surface it.
  const requiredMatches = [];
  const missingOnReference = [];
  for (const attrName of matchAttrs) {
    const keys = variantKeys(attrName);
    const values = readAttrLowerList(refAttrs, keys);
    if (values.length === 0) {
      missingOnReference.push(attrName);
    } else {
      requiredMatches.push({ name: attrName, keys, values });
    }
  }

  if (requiredMatches.length === 0) {
    return {
      error: `The reference product '${reference.title}' has no value for the configured similarity attribute(s): ${missingOnReference.join(", ")}. Cannot find similar products.`,
      reference: { handle: reference.handle, title: reference.title },
      products: [],
    };
  }

  const refCategory = readAttrLowerList(refAttrs, ["category", "Category", "category_for_filter", "subcategory"]);
  const refGender = readAttrLowerList(refAttrs, ["gender", "Gender", "gender_fallback"]);
  const max = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);

  // Style-family exclusion: catalogs frequently list multiple products under
  // one style name (e.g. "Jillian Sport Sandal", "Jillian Braided Slide") with
  // different handles. Handle-only exclusion leaves those variants in the
  // results, which the customer reads as "you recommended the same thing back
  // to me." Compute a style-family key from the first meaningful word of the
  // reference's title, then filter out any candidate whose title starts with
  // the same key. Pure title-token math — no product terminology in code.
  const FAMILY_STOP = new Set(["the", "a", "an", "my", "our", "new"]);
  const extractStyleFamily = (title) => {
    if (!title) return "";
    const beforeDash = String(title).split(/\s[-–—]\s/)[0];
    const words = beforeDash
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    for (const w of words) {
      if (w.length > 2 && !FAMILY_STOP.has(w)) return w;
    }
    return "";
  };
  const refFamily = extractStyleFamily(reference.title);

  const candidates = await prisma.product.findMany({
    where: {
      shop,
      handle: { not: h },
      NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
    },
    include: {
      variants: {
        select: { sku: true, price: true, compareAtPrice: true, attributesJson: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 1200,
  });

  const valuesOverlap = (candidateVals, refVals) => {
    if (candidateVals.length === 0) return false;
    for (const c of candidateVals) {
      for (const r of refVals) {
        if (c === r) return true;
        if (c.includes(r) || r.includes(c)) return true;
      }
    }
    return false;
  };

  const matched = candidates.filter((p) => {
    const a = p.attributesJson || {};

    if (refFamily) {
      const candFamily = extractStyleFamily(p.title);
      if (candFamily === refFamily) return false;
    }

    for (const { keys, values } of requiredMatches) {
      const candidateVals = readAttrLowerList(a, keys);
      if (!valuesOverlap(candidateVals, values)) return false;
    }

    if (refCategory.length > 0) {
      const candCategory = readAttrLowerList(a, ["category", "Category", "category_for_filter", "subcategory"]);
      const pt = (p.productType || "").toLowerCase().trim();
      const candCategoryWithPt = pt ? [...candCategory, pt] : candCategory;
      if (!valuesOverlap(candCategoryWithPt, refCategory)) return false;
    }

    if (refGender.length > 0) {
      const candGender = readAttrLowerList(a, ["gender", "Gender", "gender_fallback"]);
      if (candGender.length > 0) {
        const eitherUnisex = candGender.includes("unisex") || refGender.includes("unisex");
        if (!eitherUnisex && !valuesOverlap(candGender, refGender)) return false;
      }
    }

    return true;
  });

  let final = matched;

  // Optional price ceiling — applied AFTER similarity matching so the
  // primary signal stays similarity, not price.
  if (priceMax != null && Number.isFinite(Number(priceMax))) {
    const cap = Number(priceMax);
    final = final.filter((p) => {
      const min = (p.variants || []).reduce(
        (m, v) => (v.price != null && Number(v.price) < m ? Number(v.price) : m),
        Infinity,
      );
      return Number.isFinite(min) && min <= cap;
    });
  }

  // Optional keyword filter ("leather", "waterproof", "memory foam"
  // etc). Applied as a permissive substring check across title, tags,
  // and description.
  if (query && typeof query === "string" && query.trim()) {
    const needle = query.trim().toLowerCase();
    final = final.filter((p) => {
      const haystack = [
        p.title,
        p.description,
        Array.isArray(p.tags) ? p.tags.join(" ") : "",
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }

  if (deduplicateColors) final = deduplicateByColor(final);
  final = final.slice(0, max);

  const firstPrice = (variants) => {
    const v = (variants || []).find((vv) => vv.price);
    return v ? v.price : null;
  };
  const firstCompareAt = (variants) => {
    const v = (variants || []).find((vv) => vv.compareAtPrice);
    return v ? v.compareAtPrice : null;
  };

  console.log(
    `[similar] ref=${h} family=${refFamily || "-"} attrs=[${requiredMatches.map((r) => `${r.name}=${r.values.join("/")}`).join(", ")}] category=${refCategory.join("/") || "-"} gender=${refGender.join("/") || "-"} → ${final.length}`,
  );

  return {
    reference: {
      handle: reference.handle,
      title: reference.title,
      matchedOn: requiredMatches.map((r) => ({ attribute: r.name, values: r.values })),
      category: refCategory.length ? refCategory.join(", ") : undefined,
      gender: refGender.length ? refGender.join(", ") : undefined,
    },
    count: final.length,
    products: final.map((p) => ({
      handle: p.handle,
      title: p.title,
      vendor: p.vendor || undefined,
      productType: p.productType || undefined,
      tags: p.tags?.length ? p.tags : undefined,
      attributes: p.attributesJson || undefined,
      priceRange: priceRange(p.variants || []),
      variantCount: (p.variants || []).length,
      url: productUrl(shop, p.handle),
      image: p.featuredImageUrl || undefined,
      price: firstPrice(p.variants || []) || undefined,
      compareAtPrice: firstCompareAt(p.variants || []) || undefined,
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
      productType: v.product.productType || undefined,
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

// Merchant-gated tool. Only added to the tools list when the shop has
// fitPredictorEnabled=true. Aggregates review fit data, return sizing reasons,
// customer order history, and an optional merchant-configured external fit
// API into a single size recommendation with a confidence score.
export const FIT_PREDICTOR_TOOL = {
  name: "get_fit_recommendation",
  description:
    "Recommend a specific size with a confidence score for a single product, aggregating review fit signals, return sizing data, customer order history, and any merchant-configured external fit API. Use this INSTEAD of get_product_reviews + get_return_insights whenever the customer asks 'what size should I get', 'do these run small', 'should I size up/down', 'fit for [product]', or anything where the answer is a specific size. Returns a structured report that the widget renders as a visual fit-confidence card.",
  input_schema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "The product handle to recommend a size for.",
      },
      customerSizeHint: {
        type: "string",
        description: "Optional. If the customer mentioned their usual size (e.g. '9', '8.5', 'W9', 'M10.5'), pass it so the predictor can anchor the recommendation.",
      },
    },
    required: ["handle"],
  },
};

function roundToHalf(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 2) / 2;
}

function parseSize(raw) {
  if (raw == null) return null;
  const str = String(raw);
  // Prefer explicit "Size: 9.5" or "size 9" phrasings if present.
  const labeled = str.match(/\bsize[^0-9]{0,6}(\d+(?:\.\d+)?)/i);
  if (labeled) {
    const n = parseFloat(labeled[1]);
    if (Number.isFinite(n) && n >= 3 && n <= 18) return n;
  }
  // Otherwise scan all numbers and pick the first one that falls in the
  // plausible US shoe-size range (3–18). Keeps SKUs like "L1305" from
  // being read as size 1305.
  const matches = str.match(/\d+(?:\.\d+)?/g) || [];
  for (const m of matches) {
    const n = parseFloat(m);
    if (Number.isFinite(n) && n >= 3 && n <= 18) return n;
  }
  return null;
}

function formatSize(n) {
  if (n == null) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

async function getFitRecommendation({ handle, customerSizeHint }, ctx) {
  const h = String(handle || "").trim();
  if (!h) return { error: "handle is required" };

  const cfg = (ctx && typeof ctx.fitPredictorConfig === "object" && ctx.fitPredictorConfig) || {};
  const weights = {
    reviews: Number.isFinite(cfg.reviewsWeight) ? cfg.reviewsWeight : 0.4,
    returns: Number.isFinite(cfg.returnsWeight) ? cfg.returnsWeight : 0.2,
    history: Number.isFinite(cfg.historyWeight) ? cfg.historyWeight : 0.3,
    external: Number.isFinite(cfg.externalWeight) ? cfg.externalWeight : 0.1,
  };
  const minConfidence = Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : 50;
  const externalUrl = typeof cfg.externalUrl === "string" ? cfg.externalUrl.trim() : "";
  const externalAuthHeader = typeof cfg.externalAuthHeader === "string" ? cfg.externalAuthHeader.trim() : "";

  const product = await prisma.product.findFirst({
    where: { shop: ctx.shop, handle: h },
    include: { variants: { select: { sku: true, title: true, optionsJson: true, attributesJson: true } } },
  });
  if (!product) return { error: `No product found with handle '${h}'.` };

  const sizesAvailable = Array.from(
    new Set(
      (product.variants || [])
        .flatMap((v) => {
          const opts = safeParseJson(v.optionsJson);
          if (opts && typeof opts === "object") {
            return Object.values(opts).map(String);
          }
          return [v.title || ""];
        })
        .map((s) => String(s || "").trim())
        .filter((s) => /\d/.test(s)),
    ),
  );

  // Parallel-fetch every signal. Every call is guarded so a failure in one
  // source never takes down the recommendation.
  const [reviewRes, returnRes] = await Promise.all([
    ctx.yotpoApiKey
      ? getProductReviews({ handle: h }, { shop: ctx.shop, yotpoApiKey: ctx.yotpoApiKey }).catch(() => null)
      : Promise.resolve(null),
    ctx.aftershipApiKey
      ? getReturnInsights({ handle: h }, { shop: ctx.shop, aftershipApiKey: ctx.aftershipApiKey }).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Optional external fit API.
  let externalRes = null;
  if (externalUrl) {
    try {
      const body = {
        shop: ctx.shop,
        productHandle: h,
        customerId: ctx.loggedInCustomerId || null,
      };
      const headers = { "Content-Type": "application/json", accept: "application/json" };
      if (externalAuthHeader) {
        const idx = externalAuthHeader.indexOf(":");
        if (idx > 0) {
          headers[externalAuthHeader.slice(0, idx).trim()] = externalAuthHeader.slice(idx + 1).trim();
        }
      }
      const r = await fetch(externalUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) externalRes = await r.json();
    } catch {
      externalRes = null;
    }
  }

  // Customer history: if VIP + logged in, look at recent orders for sizes
  // worn in the same category. Never expose PII.
  let historyRes = null;
  if (ctx.loggedInCustomerId && ctx.vipModeEnabled && ctx.accessToken) {
    try {
      const ctxData = await fetchCustomerContext({
        shop: ctx.shop,
        accessToken: ctx.accessToken,
        customerId: ctx.loggedInCustomerId,
        orderLimit: 10,
      });
      if (ctxData?.recentOrders?.length) {
        const sizes = [];
        for (const o of ctxData.recentOrders) {
          for (const item of o.items || []) {
            const s = parseSize(typeof item === "string" ? item : item?.title || item?.variantTitle || "");
            if (s != null) sizes.push(s);
          }
        }
        if (sizes.length > 0) {
          const freq = new Map();
          for (const s of sizes) freq.set(s, (freq.get(s) || 0) + 1);
          const modal = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
          historyRes = { modalSize: modal[0], orders: sizes.length };
        }
      }
    } catch {
      historyRes = null;
    }
  }

  // Anchor size: customer hint > history > null.
  const hinted = parseSize(customerSizeHint);
  const baseSize = hinted != null ? hinted : (historyRes?.modalSize ?? null);

  // Score directional fit signals. Positive = size up, negative = size down.
  const signals = [];
  let directionalNumerator = 0;
  let directionalDenominator = 0;

  // Always surface where the base size came from, so the card has at least
  // one explanatory line even when no review/return/external data exists.
  if (hinted != null) {
    signals.push({
      source: "customer_hint",
      weight: 0,
      direction: "base",
      summary: `Based on the size you mentioned (${formatSize(hinted)}).`,
    });
  }

  if (reviewRes && !reviewRes.error) {
    const fc = reviewRes.fitCounts || {};
    const total = (fc.runs_small || 0) + (fc.runs_large || 0) + (fc.true_to_size || 0);
    if (total >= 3) {
      const raw = ((fc.runs_small || 0) - (fc.runs_large || 0)) / total;
      directionalNumerator += raw * weights.reviews;
      directionalDenominator += weights.reviews;
      const direction = raw > 0.15 ? "up" : raw < -0.15 ? "down" : "base";
      signals.push({
        source: "reviews",
        weight: weights.reviews,
        direction,
        summary:
          direction === "up"
            ? `Reviewers say it runs small (${fc.runs_small}/${total} fit mentions).`
            : direction === "down"
            ? `Reviewers say it runs large (${fc.runs_large}/${total} fit mentions).`
            : `Reviewers say it's true to size (${fc.true_to_size}/${total} fit mentions).`,
      });
    }
  }

  if (returnRes && !returnRes.error && returnRes.sizingReasons) {
    const sr = returnRes.sizingReasons;
    const total = (sr.too_small || 0) + (sr.too_big || 0);
    if (total >= 2) {
      const raw = ((sr.too_small || 0) - (sr.too_big || 0)) / total;
      directionalNumerator += raw * weights.returns;
      directionalDenominator += weights.returns;
      const direction = raw > 0.2 ? "up" : raw < -0.2 ? "down" : "base";
      signals.push({
        source: "returns",
        weight: weights.returns,
        direction,
        summary:
          direction === "up"
            ? `Returns skew "too small" (${sr.too_small} vs ${sr.too_big}).`
            : direction === "down"
            ? `Returns skew "too big" (${sr.too_big} vs ${sr.too_small}).`
            : `Return data is balanced on sizing.`,
      });
    }
  }

  if (historyRes?.modalSize != null) {
    signals.push({
      source: "history",
      weight: weights.history,
      direction: "base",
      summary: `Your usual size across ${historyRes.orders} past item(s) is ${formatSize(historyRes.modalSize)}.`,
    });
  }

  if (externalRes && externalRes.size != null) {
    const sizeNum = parseSize(externalRes.size);
    if (sizeNum != null) {
      signals.push({
        source: "external",
        weight: weights.external,
        direction: "base",
        summary: String(externalRes.summary || `Scan/fit data suggests size ${formatSize(sizeNum)}.`),
      });
    }
  }

  // Aggregate.
  const directional = directionalDenominator > 0 ? directionalNumerator / directionalDenominator : 0;
  const adjustment = directional > 0.4 ? 0.5 : directional < -0.4 ? -0.5 : 0;

  let recommendedSizeNum = null;
  // Prefer external absolute recommendation if confident.
  if (externalRes?.size != null && parseSize(externalRes.size) != null) {
    recommendedSizeNum = parseSize(externalRes.size);
  } else if (baseSize != null) {
    recommendedSizeNum = roundToHalf(baseSize + adjustment);
  }

  // Confidence scoring.
  let confidence = 30;
  if (reviewRes && !reviewRes.error && reviewRes.fitCounts) {
    const totalFit = (reviewRes.fitCounts.runs_small || 0) + (reviewRes.fitCounts.runs_large || 0) + (reviewRes.fitCounts.true_to_size || 0);
    if (totalFit >= 10) confidence += 20;
    else if (totalFit >= 3) confidence += 10;
  }
  if (returnRes && !returnRes.error && returnRes.sizingReasons) {
    const totalRet = (returnRes.sizingReasons.too_small || 0) + (returnRes.sizingReasons.too_big || 0);
    if (totalRet >= 5) confidence += 15;
    else if (totalRet >= 2) confidence += 8;
  }
  if (historyRes?.orders >= 3) confidence += 20;
  else if (historyRes?.orders >= 1) confidence += 10;
  if (externalRes?.confidence != null && Number.isFinite(externalRes.confidence)) {
    confidence = Math.max(confidence, Math.min(100, Math.round(externalRes.confidence)));
  }
  // Agreement bonus.
  if (signals.length >= 2) {
    const nonBase = signals.filter((s) => s.direction === "up" || s.direction === "down");
    if (nonBase.length >= 2) {
      const allSame = nonBase.every((s) => s.direction === nonBase[0].direction);
      if (allSame) confidence += 10;
    }
  }
  confidence = Math.max(0, Math.min(95, confidence));

  const shouldDisplay = recommendedSizeNum != null && confidence >= minConfidence;

  const reasons = signals.map((s) => s.summary);
  if (adjustment !== 0 && baseSize != null) {
    reasons.push(adjustment > 0
      ? `Applied +0.5 adjustment from your usual size.`
      : `Applied -0.5 adjustment from your usual size.`);
  }

  console.log(
    `[fit] handle=${h} base=${baseSize ?? "-"} adj=${adjustment} rec=${recommendedSizeNum ?? "-"} conf=${confidence} signals=${signals.map((s) => s.source).join(",") || "-"}`,
  );

  return {
    handle: h,
    productTitle: product.title,
    recommendation: {
      recommendedSize: recommendedSizeNum != null ? formatSize(recommendedSizeNum) : null,
      baseSize: baseSize != null ? formatSize(baseSize) : null,
      adjustment,
      confidence,
      signals,
      reasons,
      sizesAvailable,
      shouldDisplay,
    },
  };
}

// VIP-only tool. Only added to the tools list when the customer is logged in
// and the shop has vipModeEnabled. Operates strictly on the HMAC-verified
// loggedInCustomerId from the request context — never accepts a customer id
// from the AI's arguments.
export const CUSTOMER_ORDERS_TOOL = {
  name: "get_customer_orders",
  description:
    "Fetch the logged-in customer's order history, including tracking info and delivery status. Call this when the customer asks about their orders, shipping, tracking, delivery, a specific order number, past purchases, or reorder. Returns order number, date, status, line items, total, tracking numbers with carrier and URL, and estimated/actual delivery date. Never exposes email, street addresses, or payment info. If the customer mentions a specific order number, pass it as orderNumber to filter.",
  input_schema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Number of recent orders to fetch. Default 5, max 10.",
        minimum: 1,
        maximum: 10,
      },
      orderNumber: {
        type: "string",
        description: "Optional. A specific order number the customer mentioned (e.g. '1023' or '#1023'). If provided, only matching orders are returned. If the match is empty, the tool returns an empty orders array (order may be too old or doesn't belong to this customer).",
      },
    },
  },
};

function normalizeOrderNumber(raw) {
  return String(raw || "").replace(/[^0-9a-z]/gi, "").toLowerCase();
}

async function getCustomerOrders({ limit, orderNumber }, ctx) {
  if (!ctx?.loggedInCustomerId || !ctx?.accessToken || !ctx?.shop) {
    return { error: "Customer is not logged in." };
  }
  if (ctx.vipModeEnabled !== true) {
    return { error: "VIP mode is not enabled for this store." };
  }
  // If filtering by order number, fetch the max so we can match older orders.
  const needle = orderNumber ? normalizeOrderNumber(orderNumber) : "";
  const orderLimit = needle ? 10 : Math.max(1, Math.min(parseInt(limit, 10) || 5, 10));
  const ctxData = await fetchCustomerContext({
    shop: ctx.shop,
    accessToken: ctx.accessToken,
    customerId: ctx.loggedInCustomerId,
    orderLimit,
  });
  if (!ctxData) return { error: "Could not fetch order history." };

  let orders = ctxData.recentOrders || [];
  if (needle) {
    orders = orders.filter((o) => normalizeOrderNumber(o.name) === needle || normalizeOrderNumber(o.name).endsWith(needle));
  }

  // Branded tracking + returns page URLs (AfterShip, Parcel Panel, etc).
  // When set, override carrier URLs and attach a returns link per order so
  // the AI can guide self-serve returns instead of routing to support.
  const trackingBase = (ctx.trackingPageUrl || "").replace(/\/+$/, "");
  const returnsBase = (ctx.returnsPageUrl || "").replace(/\/+$/, "");
  const email = ctxData._email || "";
  for (const order of orders) {
    const orderNum = String(order.name || "").replace(/^#/, "");
    if (trackingBase) {
      for (const f of order.fulfillments || []) {
        for (const t of f.tracking || []) {
          if (t.number) t.url = `${trackingBase}/tracking/${encodeURIComponent(t.number)}`;
        }
      }
      if (orderNum && email) {
        order.trackingPageUrl = `${trackingBase}?order-number=${encodeURIComponent(orderNum)}&email=${encodeURIComponent(email)}`;
      }
    }
    if (returnsBase && orderNum && email) {
      order.returnsPageUrl = `${returnsBase}?order-number=${encodeURIComponent(orderNum)}&email=${encodeURIComponent(email)}`;
    }
  }

  return {
    firstName: ctxData.firstName,
    numberOfOrders: ctxData.numberOfOrders,
    amountSpent: ctxData.amountSpent,
    orders,
  };
}

const HANDLERS = {
  search_products: searchProducts,
  get_product_details: getProductDetails,
  lookup_sku: lookupSku,
  find_similar_products: findSimilarProducts,
  get_product_reviews: getProductReviews,
  get_return_insights: getReturnInsights,
  get_customer_orders: getCustomerOrders,
  get_fit_recommendation: getFitRecommendation,
};

function mentionsFromResult(name, result) {
  if (!result || result.error) return [];
  if (name === "search_products" && Array.isArray(result.products)) {
    return result.products.map((p) => ({ handle: p.handle, title: p.title, tool: name }));
  }
  if (name === "find_similar_products" && Array.isArray(result.products)) {
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
  const categoryFromAttrs = (p) => {
    const a = p.attributes || {};
    const v = a.category || a.Category || a.category_for_filter || a.subcategory || p.productType || "";
    if (Array.isArray(v)) return String(v[0] || "").toLowerCase().trim();
    return String(v || "").toLowerCase().trim();
  };

  const genderFromAttrs = (p) => {
    const a = p.attributes || {};
    const v = a.gender || a.Gender || a.gender_fallback || "";
    if (Array.isArray(v)) return String(v[0] || "").toLowerCase().trim();
    return String(v || "").toLowerCase().trim();
  };

  if (name === "search_products" && Array.isArray(result.products)) {
    const query = result.query || "";
    return result.products.slice(0, MAX_PRODUCT_CARDS).map((p) => ({
      title: p.title,
      url: p.url,
      handle: p.handle,
      image: p.image || "",
      price_formatted: p.priceRange || (p.price ? `$${parseFloat(p.price).toFixed(2)}` : ""),
      compare_at_price: p.compareAtPrice ? Math.round(parseFloat(p.compareAtPrice) * 100) : undefined,
      _descriptionSnippet: p.descriptionSnippet || "",
      _searchQuery: query,
      _category: categoryFromAttrs(p),
      _gender: genderFromAttrs(p),
    }));
  }
  if (name === "find_similar_products" && Array.isArray(result.products)) {
    const refTitle = result.reference?.title || "";
    return result.products.slice(0, MAX_PRODUCT_CARDS).map((p) => ({
      title: p.title,
      url: p.url,
      handle: p.handle,
      image: p.image || "",
      price_formatted: p.priceRange || (p.price ? `$${parseFloat(p.price).toFixed(2)}` : ""),
      compare_at_price: p.compareAtPrice ? Math.round(parseFloat(p.compareAtPrice) * 100) : undefined,
      _descriptionSnippet: "",
      _searchQuery: refTitle,
      _category: categoryFromAttrs(p),
      _gender: genderFromAttrs(p),
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
      _category: categoryFromAttrs(result),
      _gender: genderFromAttrs(result),
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
        _category: categoryFromAttrs({ attributes: f.productAttributes, productType: f.productType }),
        _gender: genderFromAttrs({ attributes: f.productAttributes }),
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
