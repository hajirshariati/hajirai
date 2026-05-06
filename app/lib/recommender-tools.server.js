import { resolveTree } from "./decision-tree-resolver.server.js";
import { validateDecisionTree } from "./decision-tree-schema.server.js";

// Apply tree-level derivations to the customer's answer set BEFORE
// resolving. Derivations let merchants encode rules like "if
// condition is metatarsalgia, set metSupport=true" or "if
// arch=Flat OR overpronation=yes, set posted=true". These were
// part of the original engine; the refactor moved resolution into
// a tool but the derivations slipped through the cracks. Without
// this, the resolver sees only what the LLM passed in and can't
// honor the merchant's clinical mappings, so e.g. ball-of-foot
// pain returns the no-met SKU instead of the W/ Met Support twin.
//
// Pure function. The when-clause grammar (any / all / eq / in)
// matches the original engine's evalCondition for backward compat
// with tree definitions authored under the funnel-era schema.
function evalDerivationCondition(cond, answers) {
  if (!cond) return false;
  if (Array.isArray(cond.any)) return cond.any.some((c) => evalDerivationCondition(c, answers));
  if (Array.isArray(cond.all)) return cond.all.every((c) => evalDerivationCondition(c, answers));
  if (cond.attr && "eq" in cond) return answers[cond.attr] === cond.eq;
  if (cond.attr && Array.isArray(cond.in)) return cond.in.includes(answers[cond.attr]);
  return false;
}
function applyDerivations(answers, derivations) {
  if (!Array.isArray(derivations) || derivations.length === 0) return answers || {};
  const out = { ...(answers || {}) };
  for (const rule of derivations) {
    if (!rule || !rule.set || rule.value === undefined || !rule.when) continue;
    if (evalDerivationCondition(rule.when, out)) {
      out[rule.set] = rule.value;
    }
  }
  return out;
}

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
  // "Unisex" is a product-side compatibility tag (a Unisex SKU
  // satisfies both Men's and Women's queries via genderMatch), not
  // a gender the customer can select. Keep it on products in the
  // masterIndex but hide it from the LLM's gender enum so the tool
  // can't be called with gender="Unisex".
  if (out.has("gender")) {
    out.get("gender").delete("Unisex");
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

  // Tool description Claude reads to decide WHEN to call. Three jobs:
  // (a) tell Claude this is the AUTHORITATIVE recommender for the
  // intent — preferred over search_products; (b) bound when NOT to
  // call (different product types, non-product topics); (c) when
  // requiredAttributes is set, instruct Claude to gather those FIRST
  // through normal conversation before calling the tool.
  const required = Array.isArray(tree.definition?.requiredAttributes)
    ? tree.definition.requiredAttributes.filter((s) => typeof s === "string" && s.trim())
    : [];
  const requiredLine = required.length > 0
    ? `\n\nALWAYS call this tool when the customer asks for a ${tree.intent} recommendation, even if you only ` +
      `have partial information. Pass whatever attributes the customer has mentioned. ` +
      `If required attributes (${required.join(", ")}) are missing, the tool will return a needMoreInfo response ` +
      `containing the exact natural-language questions to ask the customer. Read the tool's "instruction" field, ` +
      `write those questions to the customer in your reply, wait for their answer, then call this tool again ` +
      `with the complete set. Do NOT skip calling the tool just because you're missing attributes — the tool ` +
      `IS how you find out what to ask. Do NOT make up answers; only use values the customer provided.`
    : "";
  const description =
    `AUTHORITATIVE recommender for "${tree.intent}" queries on this shop. ` +
    `When a customer is asking for help picking a ${tree.intent} product ` +
    `("recommend a ${tree.intent}", "I need a ${tree.intent} for X", ` +
    `"which ${tree.intent} for Y condition"), call THIS tool — do NOT call ` +
    `search_products for the same purpose. The resolver returns a single ` +
    `deterministic master SKU based on the attributes you supply, so the ` +
    `customer never gets a wrong-fit pick. Provide every attribute the ` +
    `customer has mentioned or clearly implied; unspecified non-required ` +
    `attributes use sensible defaults. Returns one master SKU plus a product card.\n\n` +
    `Do NOT call this tool when the customer is asking about a different ` +
    `product type (e.g. shoes, sandals, socks, accessories), or about ` +
    `non-product topics (returns, sizing, shipping, store policies). For ` +
    `those, the existing search_products and other tools apply normally.` +
    requiredLine;

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

// Filter the resolver's masterIndex to only SKUs the shop actually
// carries in its synced Shopify catalog. The merchant's recommender
// data may be a superset (e.g. shared across dev/prod replicas, or
// authored before products were imported); without this filter the
// resolver can pick a SKU that has no ProductVariant and the
// recommendation card is empty.
//
// One Postgres query per tool call. Could be cached per-shop if it
// shows up in profiling, but the variant table is indexed on `sku`
// and we're doing a single IN over <200 prefixes — fast.
async function filterMasterIndexByShop(shop, masterIndex) {
  if (!shop || !Array.isArray(masterIndex) || masterIndex.length === 0) {
    return masterIndex || [];
  }
  const prisma = await getPrisma();
  // For each master SKU, check whether ANY variant whose SKU starts
  // with it exists on this shop with a non-archived product. Batched
  // with OR-startsWith — Prisma converts to a SQL OR-LIKE chain.
  const prefixes = masterIndex.map((m) => m.masterSku).filter(Boolean);
  if (prefixes.length === 0) return [];
  let rows;
  try {
    rows = await prisma.productVariant.findMany({
      where: {
        OR: prefixes.map((p) => ({ sku: { startsWith: p } })),
        product: {
          shop,
          NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
        },
      },
      select: { sku: true },
    });
  } catch (err) {
    console.error("[recommender] catalog filter failed, using full index:", err?.message || err);
    return masterIndex;
  }
  const presentPrefixes = new Set();
  for (const r of rows) {
    const sku = String(r.sku || "");
    for (const p of prefixes) {
      if (sku.startsWith(p)) {
        presentPrefixes.add(p);
        break;
      }
    }
  }
  return masterIndex.filter((m) => presentPrefixes.has(m.masterSku));
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

  // Required-attributes gate. If the merchant declared any
  // requiredAttributes on this recommender (e.g. ["gender",
  // "useCase"]), the LLM must collect them through conversation
  // BEFORE the tool resolves a SKU. Without this gate the LLM is
  // too eager — a single attribute mention triggers a tool call,
  // defaults fill the rest, and the customer gets a generic pick
  // without ever being asked the questions a doctor would. The
  // gate returns a structured needMoreInfo response that tells
  // the LLM exactly what to ask next; on the next turn (after the
  // customer answers), the LLM calls the tool again with the
  // complete attribute set.
  const required = Array.isArray(tree.definition.requiredAttributes)
    ? tree.definition.requiredAttributes.filter((s) => typeof s === "string" && s.trim())
    : [];
  const attributePrompts = (tree.definition.attributePrompts && typeof tree.definition.attributePrompts === "object")
    ? tree.definition.attributePrompts
    : {};
  if (required.length > 0) {
    const provided = input || {};
    const missing = required.filter((k) => {
      const v = provided[k];
      return v === undefined || v === null || (typeof v === "string" && !v.trim());
    });
    if (missing.length > 0) {
      const questions = missing.map((k) => {
        const prompt = attributePrompts[k];
        if (typeof prompt === "string" && prompt.trim()) return `- ${prompt}`;
        // Fallback question text by attribute name. Reasonable
        // defaults; merchant overrides via attributePrompts.
        return `- What is the customer's ${k}?`;
      }).join("\n");
      console.log(
        `[recommender] gate: ${missing.length} required attribute(s) missing on ` +
          `tool call — ${missing.join(", ")}. Asking LLM to gather first.`,
      );
      return {
        needMoreInfo: true,
        missingAttributes: missing,
        instruction:
          `Before recommending, the customer needs to answer the following question${missing.length === 1 ? "" : "s"} ` +
          `in normal conversation. ASK them — do NOT call this tool again until you have answers:\n\n${questions}\n\n` +
          `Once the customer has provided each missing attribute, call recommend_${tree.intent} again with the ` +
          `complete attribute set. Use only the enum values listed in this tool's schema for those attributes.`,
        attributesProvided: provided,
      };
    }
  }

  // Filter the masterIndex to SKUs the shop actually has in stock
  // BEFORE the resolver picks. Without this, the resolver can land
  // on a SKU that's in the merchant's recommender data but missing
  // from their Shopify catalog (e.g. dev shop with a partial sync,
  // or a recommender authored ahead of catalog imports), and the
  // resulting recommendation card comes through empty.
  const fullMasterIndex = tree.definition.resolver.masterIndex || [];
  const availableMasterIndex = await filterMasterIndexByShop(shop, fullMasterIndex);
  if (availableMasterIndex.length === 0) {
    console.warn(
      `[recommender] no resolver SKUs in shop catalog for intent=${intent} ` +
        `(masterIndex has ${fullMasterIndex.length}, shop has 0). ` +
        `Either the merchant's catalog isn't synced or the recommender data ` +
        `references SKUs that don't exist on this shop.`,
    );
    return {
      error:
        "None of the recommender's SKUs are present in this shop's catalog. " +
        "Please verify the catalog sync and the recommender's master-index data.",
      attributesUsed: input,
    };
  }
  if (availableMasterIndex.length < fullMasterIndex.length) {
    console.log(
      `[recommender] filtered masterIndex: ${availableMasterIndex.length}/${fullMasterIndex.length} ` +
        `SKUs are present in shop catalog`,
    );
  }

  const filteredResolver = { ...tree.definition.resolver, masterIndex: availableMasterIndex };

  // Apply tree-level derivations BEFORE resolving so merchant-
  // defined clinical mappings (condition → metSupport, arch →
  // posted, etc.) are honored. Without this, the resolver only
  // sees raw LLM-provided attributes and misses the implied ones.
  const derivedInput = applyDerivations(input || {}, tree.definition.derivations);
  if (Object.keys(derivedInput).length !== Object.keys(input || {}).length) {
    const added = Object.keys(derivedInput).filter((k) => !(k in (input || {})));
    if (added.length > 0) {
      console.log(`[recommender] derivations added attribute(s): ${added.join(", ")}`);
    }
  }
  const result = resolveTree(derivedInput, filteredResolver);
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
