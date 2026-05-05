import prisma from "../db.server.js";
import {
  getEnabledDecisionTrees,
  incrementStartedCount,
  incrementCompletedCount,
} from "../models/DecisionTree.server.js";
import { extractTreeStateFromHistory, stepTree } from "./decision-tree-engine.server.js";
import { validateDecisionTree } from "./decision-tree-schema.server.js";

// Decision-tree turn dispatcher. Called from chat.jsx BEFORE the
// AI loop, but ONLY when ShopConfig.decisionTreeEnabled is true.
// If it handles the turn, the chat layer skips the LLM entirely
// and emits the engine's response as SSE chunks. If not, the
// existing AI flow runs unchanged.
//
// Activation logic (intentionally narrow — never hijacks an
// out-of-scope conversation):
//   1. Find an enabled tree whose triggerCategoryGroup matches the
//      currently-active category-intent group, OR whose
//      triggerPhrases include a substring of the customer's latest
//      message.
//   2. Reconstruct state from message history (the engine walks the
//      assistant/user pairs and matches them against the tree's
//      questions). If no questions have been answered yet AND the
//      latest message doesn't mention a trigger, do NOT activate —
//      this is the "Disney trip" case from the merchant brief.
//   3. Once activated, step the tree with the latest user message.
//      Return text + chips (mid-funnel) or text + product card
//      (resolved).

const PER_REQUEST_CACHE = new WeakMap();

function pickActiveTree(trees, { categoryIntent, latestUserMessage }) {
  if (!trees || trees.length === 0) return null;
  const groupName = categoryIntent?.activeGroup?.name || null;
  const ambiguous = Boolean(categoryIntent?.ambiguous);
  const text = String(latestUserMessage || "").toLowerCase();

  // Never fire on ambiguous category intent — the merchant's
  // existing disambiguation flow handles that better than us.
  if (ambiguous) return null;

  for (const t of trees) {
    if (groupName && t.triggerCategoryGroup &&
        groupName.toLowerCase() === t.triggerCategoryGroup.toLowerCase()) {
      return t;
    }
  }
  // Phrase-trigger fallback (only when no category group matched).
  for (const t of trees) {
    let phrases = [];
    try {
      phrases = JSON.parse(t.triggerPhrases || "[]");
    } catch { /* ignore */ }
    for (const p of phrases) {
      const ps = String(p || "").trim().toLowerCase();
      if (ps && text.includes(ps)) return t;
    }
  }
  return null;
}

function buildPrefill({ sessionGender, answeredChoices }) {
  const prefill = {};
  if (sessionGender === "men") prefill.gender = "Men";
  else if (sessionGender === "women") prefill.gender = "Women";
  // Map answered-choices that look like gender for completeness
  // (in case the choice button system stored it as "Men's" / "Women's").
  if (!prefill.gender && Array.isArray(answeredChoices)) {
    for (const c of answeredChoices) {
      const a = String(c?.answer || "").toLowerCase();
      if (/\bmen('?s)?\b/.test(a)) { prefill.gender = "Men"; break; }
      if (/\bwomen('?s)?\b/.test(a)) { prefill.gender = "Women"; break; }
    }
  }
  return prefill;
}

// Map a master SKU (e.g. "L100M") to a single product card. Uses
// prefix match against variant SKUs because Aetrex (and any
// merchant with size-suffixed variants) stores per-size variants
// like "L100M07", "L100M08" etc. The first matching variant wins;
// the card describes the parent product.
async function lookupProductByMasterSku(shop, masterSku) {
  if (!shop || !masterSku) return null;
  const m = String(masterSku).trim();
  if (!m) return null;
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
    price: variant.price || undefined,
    compareAtPrice: variant.compareAtPrice || undefined,
    image: p.featuredImageUrl || undefined,
    url: `https://${shop.replace(/^https?:\/\//, "")}/products/${p.handle}`,
  };
}

function formatChips(chips) {
  if (!Array.isArray(chips) || chips.length === 0) return "";
  return chips.map((c) => `<<${c.label}>>`).join("");
}

// Main entry. Returns { handled: bool, response?, telemetry? }.
// `handled: false` means the chat layer should run the normal AI
// flow. `handled: true` means we own this turn — chat layer should
// emit response.text + response.products and stop.
export async function dispatchDecisionTree({
  shop,
  config,
  categoryIntent,
  messages,
  latestUserMessage,
  sessionGender,
  answeredChoices,
}) {
  if (!shop || !config) return { handled: false };
  if (config.decisionTreeEnabled !== true) return { handled: false };

  let trees = PER_REQUEST_CACHE.get(config);
  if (!trees) {
    try {
      trees = await getEnabledDecisionTrees(shop);
    } catch (err) {
      console.error("[decision-tree] load failed:", err?.message || err);
      return { handled: false };
    }
    PER_REQUEST_CACHE.set(config, trees);
  }

  const tree = pickActiveTree(trees, { categoryIntent, latestUserMessage });
  if (!tree) return { handled: false };

  // Validate the tree definition before running it. A merchant who
  // saves a malformed tree should not crash the chat — fall through
  // to the AI flow and log.
  const v = validateDecisionTree(tree.definition);
  if (!v.ok) {
    console.error(`[decision-tree] tree ${tree.id} invalid:`, v.errors.join("; "));
    return { handled: false };
  }

  const prefill = buildPrefill({ sessionGender, answeredChoices });
  // Reconstruct state from message HISTORY (excluding the latest
  // user message — that's the message we still need to step).
  const historyOnly = messages.slice(0, -1);
  const priorState = extractTreeStateFromHistory(tree, historyOnly, prefill);

  const stepped = stepTree(tree, priorState, latestUserMessage);
  const state = stepped.nextState;
  const response = stepped.response;

  // Counter side-effects (analytics only, never throw)
  const wasFreshStart = Object.keys(priorState.answers).length === 0
    && !priorState.completed
    && !response.unmatched;
  if (wasFreshStart && !response.completed) {
    incrementStartedCount(shop, tree.id).catch(() => {});
  }
  if (response.completed && !priorState.completed) {
    incrementCompletedCount(shop, tree.id).catch(() => {});
  }

  if (response.completed && response.resolved) {
    const product = await lookupProductByMasterSku(shop, response.resolved.masterSku);
    const text = product
      ? `Based on what you told me, the **${product.title}** is the right match for you.`
      : `Based on what you told me, the **${response.resolved.title}** is the right match — but I couldn't load the product card right now. Try one more time, or contact support.`;
    return {
      handled: true,
      response: {
        text,
        products: product ? [product] : [],
      },
      telemetry: {
        treeId: tree.id,
        intent: tree.intent,
        completed: true,
        masterSku: response.resolved.masterSku,
        attributes: state.answers,
      },
    };
  }

  if (response.completed && !response.resolved) {
    // Resolver returned no SKU (shouldn't happen if fallback is set,
    // but guard anyway). Fall through to AI so the customer isn't
    // dead-ended.
    console.warn(`[decision-tree] tree ${tree.id} completed without a resolved SKU`);
    return { handled: false };
  }

  // Mid-funnel — emit question + chips
  const text = response.text + (response.chips?.length ? "\n\n" + formatChips(response.chips) : "");
  return {
    handled: true,
    response: { text, products: [] },
    telemetry: {
      treeId: tree.id,
      intent: tree.intent,
      completed: false,
      currentNodeId: state.currentNodeId,
      attributes: state.answers,
    },
  };
}
