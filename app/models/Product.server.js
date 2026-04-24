import prisma from "../db.server";
import {
  getAttributeMappings,
  buildMetafieldFragment,
  resolveProductAttributes,
  resolveVariantAttributes,
} from "./AttributeMapping.server";

const PRODUCTS_PAGE = 50;

function productsQuery(productMfFragment = "", variantMfFragment = "") {
  return `#graphql
  query SyncProducts($cursor: String) {
    products(first: ${PRODUCTS_PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        vendor
        productType
        tags
        descriptionHtml
        status
        featuredImage { url }
        ${productMfFragment}
        variants(first: 100) {
          nodes {
            id
            sku
            title
            price
            compareAtPrice
            inventoryQuantity
            selectedOptions { name value }
            ${variantMfFragment}
          }
        }
      }
    }
  }
`;
}

function productByIdQuery(productMfFragment = "", variantMfFragment = "") {
  return `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      vendor
      productType
      tags
      descriptionHtml
      status
      featuredImage { url }
      ${productMfFragment}
      variants(first: 100) {
        nodes {
          id
          sku
          title
          price
          compareAtPrice
          inventoryQuantity
          selectedOptions { name value }
          ${variantMfFragment}
        }
      }
    }
  }
`;
}

function stripHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function mapProductFields(node, mappings) {
  const fields = {
    shopifyId: node.id,
    handle: node.handle,
    title: node.title,
    vendor: node.vendor || null,
    productType: node.productType || null,
    tags: node.tags || [],
    description: stripHtml(node.descriptionHtml),
    status: node.status || null,
    featuredImageUrl: node.featuredImage?.url || null,
  };
  if (mappings && mappings.length > 0) {
    fields.attributesJson = resolveProductAttributes(node, mappings) || undefined;
  }
  return fields;
}

function mapVariantFields(v, mappings) {
  const fields = {
    shopifyId: v.id,
    sku: v.sku || null,
    title: v.title || null,
    price: v.price || null,
    compareAtPrice: v.compareAtPrice || null,
    inventoryQty: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
    optionsJson: v.selectedOptions ? JSON.stringify(v.selectedOptions) : null,
  };
  if (mappings && mappings.length > 0) {
    fields.attributesJson = resolveVariantAttributes(v, mappings) || undefined;
  }
  return fields;
}

async function upsertProduct(shop, node, mappings = null) {
  const fields = mapProductFields(node, mappings);
  const product = await prisma.product.upsert({
    where: { shop_shopifyId: { shop, shopifyId: fields.shopifyId } },
    update: { ...fields, updatedAt: new Date() },
    create: { shop, ...fields },
  });

  const variants = (node.variants?.nodes || []).map((v) => mapVariantFields(v, mappings));
  const incomingIds = new Set(variants.map((v) => v.shopifyId));

  await prisma.productVariant.deleteMany({
    where: { productId: product.id, NOT: { shopifyId: { in: Array.from(incomingIds) } } },
  });

  for (const v of variants) {
    await prisma.productVariant.upsert({
      where: { productId_shopifyId: { productId: product.id, shopifyId: v.shopifyId } },
      update: { ...v, updatedAt: new Date() },
      create: { productId: product.id, ...v },
    });
  }

  return product;
}

export async function upsertProductFromWebhook(shop, webhookPayload, admin) {
  const numericId = webhookPayload.id || webhookPayload.admin_graphql_api_id;
  if (!numericId || !admin) return null;

  const gid =
    typeof numericId === "string" && numericId.startsWith("gid://")
      ? numericId
      : `gid://shopify/Product/${numericId}`;

  return fetchAndUpsertProduct(admin, shop, gid);
}

export async function fetchAndUpsertProduct(admin, shop, shopifyGid) {
  const mappings = await getAttributeMappings(shop);
  const productMf = buildMetafieldFragment(mappings, "product");
  const variantMf = buildMetafieldFragment(mappings, "variant");
  const query = productByIdQuery(productMf, variantMf);
  const resp = await admin.graphql(query, { variables: { id: shopifyGid } });
  const json = await resp.json();
  const node = json?.data?.product;
  if (!node) return null;
  return upsertProduct(shop, node, mappings);
}

export async function deleteProductByShopifyId(shop, shopifyId) {
  const gid = typeof shopifyId === "string" && shopifyId.startsWith("gid://")
    ? shopifyId
    : `gid://shopify/Product/${shopifyId}`;
  await prisma.product.deleteMany({ where: { shop, shopifyId: gid } });
}

export async function getCatalogSyncState(shop) {
  let state = await prisma.catalogSyncState.findUnique({ where: { shop } });
  if (!state) {
    state = await prisma.catalogSyncState.create({ data: { shop } });
  }
  return state;
}

async function setSyncState(shop, patch) {
  return prisma.catalogSyncState.upsert({
    where: { shop },
    update: { ...patch, updatedAt: new Date() },
    create: { shop, ...patch },
  });
}

export async function syncCatalog(admin, shop) {
  await setSyncState(shop, { status: "running", lastError: null, syncedSoFar: 0 });
  try {
    const mappings = await getAttributeMappings(shop);
    const productMf = buildMetafieldFragment(mappings, "product");
    const variantMf = buildMetafieldFragment(mappings, "variant");
    const query = productsQuery(productMf, variantMf);
    if (mappings.length > 0) {
      const prodCount = mappings.filter((m) => (m.target || "product") === "product").length;
      const varCount = mappings.filter((m) => m.target === "variant").length;
      console.log(
        `[syncCatalog] ${shop}: syncing with ${mappings.length} mappings (${prodCount} product, ${varCount} variant)`,
      );
    }

    let cursor = null;
    let totalSeen = 0;
    while (true) {
      const current = await prisma.catalogSyncState.findUnique({ where: { shop } });
      if (current?.status === "stopping") {
        console.log(`[syncCatalog] ${shop}: stopped by user at ${totalSeen} products`);
        await setSyncState(shop, { status: "idle", syncedSoFar: totalSeen });
        return { ok: true, count: totalSeen, stopped: true };
      }

      const resp = await admin.graphql(query, { variables: { cursor } });
      const json = await resp.json();
      const page = json?.data?.products;
      if (!page) throw new Error("No products data in GraphQL response");
      console.log("[syncCatalog] page size:", page.nodes?.length || 0);

  for (const node of page.nodes) {
  console.log("[syncCatalog] upserting:", node.handle);
  await upsertProduct(shop, node, mappings);
  totalSeen += 1;

  const countNow = await prisma.product.count({ where: { shop } });
  console.log("[syncCatalog] count now:", countNow);
}

      await setSyncState(shop, { syncedSoFar: totalSeen });

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    await setSyncState(shop, {
      status: "idle",
      lastSyncedAt: new Date(),
      productsCount: totalSeen,
      syncedSoFar: totalSeen,
    });
    return { ok: true, count: totalSeen };
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[syncCatalog] ${shop}:`, message);
    await setSyncState(shop, { status: "error", lastError: message });
    return { ok: false, error: message };
  }
}

export async function stopCatalogSync(shop) {
  return setSyncState(shop, { status: "stopping" });
}

export function syncCatalogAsync(admin, shop) {
  syncCatalog(admin, shop).catch((err) => {
    console.error(`[syncCatalogAsync] ${shop} unhandled:`, err);
  });
}

export async function getProductCount(shop) {
  return prisma.product.count({ where: { shop } });
}

export async function getDistinctProductTypes(shop) {
  const rows = await prisma.product.findMany({
    where: { shop, productType: { not: null } },
    select: { productType: true },
    distinct: ["productType"],
  });
  return rows
    .map((r) => (r.productType || "").trim())
    .filter((t) => t.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

const MEN_RE = /\b(m|male|men|mens|man|boys?|guys?)\b/i;
const WOMEN_RE = /\b(f|female|women|womens|woman|girls?|ladies|ladys?)\b/i;

function getAttrCaseInsensitive(attrs, name) {
  if (!attrs || typeof attrs !== "object") return undefined;
  const target = String(name).toLowerCase();
  for (const key of Object.keys(attrs)) {
    if (String(key).toLowerCase() === target) return attrs[key];
  }
  return undefined;
}

function hasExplicitGender(productGender) {
  if (productGender == null) return false;
  if (Array.isArray(productGender)) return productGender.some((v) => typeof v === "string" && v.trim().length > 0);
  return typeof productGender === "string" && productGender.trim().length > 0;
}

function genderMatches(productGender, want, { strict }) {
  if (!want) return true;
  if (!hasExplicitGender(productGender)) return !strict;

  const values = Array.isArray(productGender) ? productGender : [productGender];
  for (const raw of values) {
    const g = String(raw || "").toLowerCase().trim();
    if (!g) continue;
    if (g === "unisex" || g === "all" || g === "both") return true;
    if (want === "men" && (MEN_RE.test(g) || g.startsWith("men") || g.startsWith("male") || g.startsWith("boy"))) return true;
    if (want === "women" && (WOMEN_RE.test(g) || g.startsWith("women") || g.startsWith("female") || g.startsWith("girl") || g.startsWith("lad"))) return true;
    if (g === want.toLowerCase()) return true;
  }
  return false;
}

function extractCategoryValues(attrs) {
  if (!attrs || typeof attrs !== "object") return [];
  const out = [];
  const cat = getAttrCaseInsensitive(attrs, "category");
  if (typeof cat === "string" && cat.trim()) out.push(cat.trim());
  else if (Array.isArray(cat)) {
    for (const v of cat) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

export async function getAllCatalogCategories(shop) {
  return getCatalogCategories(shop, {});
}

export async function getCatalogCategories(shop, { gender } = {}) {
  const rows = await prisma.product.findMany({
    where: { shop },
    select: { handle: true, productType: true, attributesJson: true },
  });

  let taggedCount = 0;
  for (const r of rows) {
    const g = getAttrCaseInsensitive(r.attributesJson, "gender");
    if (hasExplicitGender(g)) taggedCount++;
  }
  const strict = !!gender && taggedCount > 0;

  const set = new Set();
  const sourceByCategory = new Map();
  let included = 0;
  for (const r of rows) {
    const attrs = r.attributesJson;
    const g = getAttrCaseInsensitive(attrs, "gender");
    if (!genderMatches(g, gender, { strict })) continue;
    included++;

    const pt = (r.productType || "").trim();
    if (pt) {
      set.add(pt);
      if (!sourceByCategory.has(pt)) sourceByCategory.set(pt, []);
      if (sourceByCategory.get(pt).length < 3) sourceByCategory.get(pt).push(`${r.handle}(productType, gender=${JSON.stringify(g)})`);
    }
    for (const v of extractCategoryValues(attrs)) {
      set.add(v);
      if (!sourceByCategory.has(v)) sourceByCategory.set(v, []);
      if (sourceByCategory.get(v).length < 3) sourceByCategory.get(v).push(`${r.handle}(category, gender=${JSON.stringify(g)})`);
    }
  }

  const categories = Array.from(set).sort((a, b) => a.localeCompare(b));
  console.log(`[catalog-categories] shop=${shop} gender=${gender || "any"} strict=${strict} taggedProducts=${taggedCount}/${rows.length} included=${included} categories=${categories.join("|") || "(none)"}`);
  if (!strict && gender) {
    console.warn(`[catalog-categories] WARNING: strict=false means no products in shop "${shop}" have a "gender" attribute set. All categories will leak into every gendered query. Fix: map a "gender" attribute (metafield or tag_prefix) in the admin Rules & Knowledge page.`);
  }
  for (const [cat, sources] of sourceByCategory) {
    console.log(`[catalog-categories]   "${cat}" <- ${sources.join(", ")}`);
  }

  return categories;
}
