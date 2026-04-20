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

async function searchProducts({ query, limit, filters }, { shop, deduplicateColors }) {
  const q = String(query || "").trim();
  if (!q) return { products: [] };
  const max = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);
  const attrFilters = filters && typeof filters === "object" ? filters : {};

  const where = {
    shop,
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { vendor: { contains: q, mode: "insensitive" } },
      { productType: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
      { tags: { has: q } },
    ],
  };

  const attrKeys = Object.keys(attrFilters);
  if (attrKeys.length > 0) {
    where.AND = attrKeys.map((key) => {
      const want = attrFilters[key].toLowerCase();
      return {
        OR: [
          { attributesJson: { path: [key], string_contains: want } },
          { variants: { some: { attributesJson: { path: [key], string_contains: want } } } },
        ],
      };
    });
  }

  const fetchLimit = deduplicateColors ? max * 5 : (attrKeys.length > 0 ? max * 3 : max);

  const products = await prisma.product.findMany({
    where,
    include: {
      variants: { select: { sku: true, price: true, compareAtPrice: true, attributesJson: true } },
    },
    take: fetchLimit,
    orderBy: { updatedAt: "desc" },
  });

  const matchesAttr = (val, want) => {
    if (Array.isArray(val)) return val.some((v) => typeof v === "string" && v.includes(want));
    return typeof val === "string" && val.includes(want);
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

  if (deduplicateColors) {
    filtered = deduplicateByColor(filtered);
  }

  filtered = filtered.slice(0, max);

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
    where: { shop, handle: h },
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
    where: { sku: { in: list }, product: { shop } },
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

const HANDLERS = {
  search_products: searchProducts,
  get_product_details: getProductDetails,
  lookup_sku: lookupSku,
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

const MAX_PRODUCT_CARDS = 3;

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
