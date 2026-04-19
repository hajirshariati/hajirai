import prisma from "../db.server";

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search the merchant's product catalog by keyword. Returns a list of products matching the query across title, vendor, product type, tags, and description. Use this when the customer is looking for something but hasn't named a specific product, or to surface options.",
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
  try { return JSON.parse(s); } catch { return null; }
}

function priceRange(variants) {
  const prices = variants.map((v) => parseFloat(v.price)).filter((n) => !Number.isNaN(n));
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

async function searchProducts({ query, limit }, { shop }) {
  const q = String(query || "").trim();
  if (!q) return { products: [] };
  const max = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);
  const products = await prisma.product.findMany({
    where: {
      shop,
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { vendor: { contains: q, mode: "insensitive" } },
        { productType: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { tags: { has: q } },
      ],
    },
    include: { variants: { select: { sku: true, price: true } } },
    take: max,
    orderBy: { updatedAt: "desc" },
  });
  return {
    query: q,
    count: products.length,
    products: products.map((p) => ({
      handle: p.handle,
      title: p.title,
      vendor: p.vendor || undefined,
      productType: p.productType || undefined,
      tags: p.tags?.length ? p.tags : undefined,
      priceRange: priceRange(p.variants),
      variantCount: p.variants.length,
      url: productUrl(shop, p.handle),
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
    variants: product.variants.map((v) => ({
      sku: v.sku || undefined,
      title: v.title || undefined,
      price: v.price || undefined,
      compareAtPrice: v.compareAtPrice || undefined,
      inventoryQty: v.inventoryQty ?? undefined,
      options: safeParseJson(v.optionsJson) || undefined,
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
      url: productUrl(shop, v.product.handle),
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

export async function executeTool(name, input, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool '${name}'.` };
  try {
    return await handler(input || {}, ctx);
  } catch (err) {
    console.error(`[tool ${name}] error:`, err?.message || err);
    return { error: `Tool '${name}' failed: ${err?.message || "unknown error"}` };
  }
}
