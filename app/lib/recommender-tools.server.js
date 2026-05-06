import { resolveTree } from "./decision-tree-resolver.server.js";
import { validateDecisionTree } from "./decision-tree-schema.server.js";

// Lazy-imported so this module can be loaded by tooling that
// doesn't have @prisma/client available (e.g. the eval harness
// running pure-function checks in CI). Cached after first await.
let _prisma = null;
async function getPrisma() {
  if (_prisma) return _prisma;
  const mod = await import("../db.server.js");
  _prisma = mod.default || mod;
  return _prisma;
}

// Smart Recommenders.
//
// Each merchant-defined recommender (stored as a DecisionTree row in
// Postgres) becomes a tool that the LLM can call when IT decides the
// customer needs a structured product recommendation. The tool takes
// typed attributes, runs them through the same deterministic
// resolver we already had (resolveTree), and returns a master SKU
// plus a product card.
//
// Architecture properties:
//   • LLM stays in charge of every turn — there is no funnel,
//     no chip pruning, no dispatcher hijack. The customer can
//     pivot ("actually I want shoes") and the LLM handles it
//     naturally because it never lost control.
//   • Multi-merchant by design — one DecisionTree row per intent
//     per shop. Aetrex has `orthotic`. A mattress merchant adds
//     `mattress` and `pillow`. Each becomes its own tool. The LLM
//     reads each tool's description and decides which one to call.
//   • Deterministic at the leaf — given the same attributes in,
//     the resolver returns the same master SKU out, every time.
//     No hallucinated SKUs. That's the "no maybe / no IF"
//     guarantee, just delivered as a tool the LLM uses instead
//     of as a dispatcher that takes over the turn.
//   • Backward compatible — the existing DecisionTree schema, the
//     existing admin UI, the existing seed file, and the existing
//     183-SKU Aetrex masterIndex all stay. We only stripped the
//     funnel orchestration; the data shape is unchanged.

// Inspect the masterIndex to discover which attribute keys exist
// and their observed value sets. Used to build tight tool schemas
// the LLM can reason about (typed enums when the value set is
// small, freeform string otherwise). The reserved keys we skip are
// the SKU/title/handle metadata.
const RESERVED_KEYS = new Set(["masterSku", "title", "productHandle"]);
const MAX_ENUM_SIZE = 20;

function discoverAttributes(definition) {
  const out = new Map();
  for (const m of definition?.resolver?.masterIndex || []) {
    if (!m || typeof m !== "object") continue;
    for (const [k, v] of Object.entries(m)) {
      if (RESERVED_KEYS.has(k)) continue;
      if (v === null || v === undefined) continue;
      if (!out.has(k)) out.set(k, new Set());
      // Coerce booleans and numbers to strings for the enum so the
      // LLM can supply "true"/"false"/"42" naturally.
      out.get(k).add(String(v));
    }
  }
  return Array.from(out.entries()).map(([name, vals]) => ({
    name,
    values: Array.from(vals).sort(),
  }));
}

// Translate one DecisionTree row into a Claude tool definition.
// Returns null if the definition is malformed — the caller silently
// drops it and logs, never crashes the chat.
export function recommenderToToolDef(tree) {
  if (!tree || !tree.definition) return null;
  const v = validateDecisionTree(tree.definition);
  if (!v.ok) {
    console.error(
      `[recommender] tree ${tree.id} (intent=${tree.intent}) invalid; skipping`,
      v.errors.slice(0, 3).join("; "),
    );
    return null;
  }

  const attrs = discoverAttributes(tree.definition);
  const properties = {};
  for (const a of attrs) {
    const prop = {
      type: "string",
      description: `${a.name} attribute used to refine the recommendation`,
    };
    if (a.values.length > 0 && a.values.length <= MAX_ENUM_SIZE) {
      prop.enum = a.values;
    }
    properties[a.name] = prop;
  }

  // Tool description Claude reads to decide WHEN to call. Two
  // jobs: (a) tell Claude this is the AUTHORITATIVE recommender
  // for the intent — preferred over search_products — so the
  // existing "MANDATORY SEARCH BEFORE TEXT" rule doesn't pre-empt
  // it; (b) bound when NOT to call (clearly unrelated queries) so
  // the merchant's "do not hijack other intents" requirement is
  // honored. Merchants will be able to customize this in the admin
  // (Layer 1 from the bulletproof discussion); the auto-generated
  // default below is reasonable until they do.
  const description =
    `AUTHORITATIVE recommender for "${tree.intent}" queries on this shop. ` +
    `When a customer is asking for help picking a ${tree.intent} product ` +
    `("recommend a ${tree.intent}", "I need a ${tree.intent} for X", ` +
    `"which ${tree.intent} for Y condition"), call THIS tool — do NOT call ` +
    `search_products for the same purpose. The resolver returns a single ` +
    `deterministic master SKU based on the attributes you supply, so the ` +
    `customer never gets a wrong-fit pick. Provide every attribute the ` +
    `customer has mentioned or clearly implied; unspecified attributes use ` +
    `sensible defaults. Returns one master SKU plus a product card.\n\n` +
    `Do NOT call this tool when the customer is asking about a different ` +
    `product type (e.g. shoes, sandals, socks, accessories), or about ` +
    `non-product topics (returns, sizing, shipping, store policies). For ` +
    `those, the existing search_products and other tools apply normally.`;

  return {
    name: `recommend_${tree.intent}`,
    description,
    input_schema: {
      type: "object",
      properties,
      required: [],
    },
  };
}

// Build the list of tool definitions for one shop. Skips
// recommenders that are disabled at the row level. Skips entirely
// when ShopConfig.decisionTreeEnabled is false. Hot path — called
// once per chat turn.
export async function buildRecommenderTools(shop, { decisionTreeEnabled }) {
  if (!shop || decisionTreeEnabled !== true) return { tools: [], trees: [] };
  const prisma = await getPrisma();
  let rows;
  try {
    rows = await prisma.decisionTree.findMany({
      where: { shop, enabled: true },
      select: {
        id: true,
        name: true,
        intent: true,
        triggerPhrases: true,
        triggerCategoryGroup: true,
        definition: true,
      },
    });
  } catch (err) {
    console.error("[recommender] load failed:", err?.message || err);
    return { tools: [], trees: [] };
  }
  const tools = [];
  const trees = [];
  for (const r of rows) {
    const td = recommenderToToolDef(r);
    if (td) {
      tools.push(td);
      trees.push(r);
    }
  }
  return { tools, trees };
}

// Resolve master SKU → product card using the same prefix-match
// approach the rest of the chat layer uses. Aetrex's variant SKUs
// are like "L100M07"; the master is "L100M". One DB query per
// recommendation; cached at the chat-turn boundary by the existing
// per-request cache pattern.
async function lookupProductByMasterSku(shop, masterSku) {
  if (!shop || !masterSku) return null;
  const m = String(masterSku).trim();
  if (!m) return null;
  const prisma = await getPrisma();
  // Try variant prefix match first — the most common Aetrex pattern.
  const variant = await prisma.productVariant.findFirst({
    where: {
      sku: { startsWith: m },
      product: {
        shop,
        NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
      },
    },
    include: { product: true },
    orderBy: { sku: "asc" },
  });
  if (!variant) return null;
  const p = variant.product;
  return {
    handle: p.handle,
    title: p.title,
    productType: p.productType || undefined,
    sku: variant.sku || undefined,
    price: variant.price || undefined,
    compareAtPrice: variant.compareAtPrice || undefined,
    image: p.featuredImageUrl || undefined,
    url: `https://${String(shop).replace(/^https?:\/\//, "")}/products/${p.handle}`,
  };
}

// Execute a recommend_<intent> tool call. Returns the structure the
// LLM gets back — a plain object the agentic loop can stringify
// into a tool_result block. The product card travels back via the
// dedicated card-extraction path the chat layer already has, so we
// also surface `product` directly for that side channel.
export async function executeRecommenderTool({ toolName, input, shop, trees }) {
  if (!toolName || !toolName.startsWith("recommend_")) {
    return { error: "not a recommender tool" };
  }
  const intent = toolName.slice("recommend_".length);
  const tree = (trees || []).find((t) => t.intent === intent);
  if (!tree) {
    return { error: `Recommender for intent="${intent}" is not enabled on this shop.` };
  }
  if (!tree.definition?.resolver) {
    return { error: "Recommender has no resolver configured." };
  }
  const result = resolveTree(input || {}, tree.definition.resolver);
  if (!result?.resolved) {
    return {
      error: result?.reason || "No matching product for the given attributes.",
      attributesUsed: result?.attrs || input,
    };
  }
  const product = await lookupProductByMasterSku(shop, result.resolved.masterSku);
  return {
    masterSku: result.resolved.masterSku,
    title: result.resolved.title,
    product,
    runnerUp: result.runnerUp
      ? { masterSku: result.runnerUp.masterSku, title: result.runnerUp.title }
      : null,
    attributesUsed: result.attrs,
    note: product
      ? "Show this product as the recommended pick. The card data is in `product`."
      : "Master SKU matched but the product card couldn't be loaded; recommend by name only and offer to retry.",
  };
}
