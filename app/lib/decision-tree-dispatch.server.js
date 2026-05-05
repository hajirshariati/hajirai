import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server.js";
import {
  getEnabledDecisionTrees,
  incrementStartedCount,
  incrementCompletedCount,
} from "../models/DecisionTree.server.js";
import { extractTreeStateFromHistory, stepTree } from "./decision-tree-engine.server.js";
import { validateDecisionTree } from "./decision-tree-schema.server.js";

// Cheap natural-language → chip-value translator. The decision-tree
// engine only does literal/substring matching against chip labels
// and values. When a customer types "sneakers" instead of clicking
// "Athletic — court / general", the engine doesn't know they're
// the same thing. We send Haiku a tiny structured prompt asking it
// to pick the closest chip (or NONE), and re-step the tree with the
// result. This gives the funnel free natural-language understanding
// without sacrificing the deterministic resolver.
//
// Bounded cost: only fires on unmatched mid-funnel input, ~30
// output tokens, model is Haiku 4.5. ~$0.0001 per call. Latency
// ~300-500ms.
const CHIP_MATCHER_MODEL = "claude-haiku-4-5-20251001";
const CHIP_MATCHER_MAX_TOKENS = 30;

async function llmMatchChip({ anthropic, node, userMessage }) {
  if (!anthropic || !node || !Array.isArray(node.chips) || node.chips.length === 0) {
    return null;
  }
  const text = String(userMessage || "").trim();
  if (!text) return null;
  // Limit chip list to viable chips (already pruned by engine) plus
  // raw labels — cheaper prompt, no junk options.
  const list = node.chips
    .map((c) => `- "${c.label}" → ${c.value}`)
    .join("\n");
  const prompt =
    `A customer is in a guided product funnel. They were asked:\n` +
    `"${node.question}"\n\n` +
    `They typed: "${text.slice(0, 200)}"\n\n` +
    `Available options (label → value):\n${list}\n\n` +
    `Pick the option whose meaning best matches what the customer said. ` +
    `Reply with ONLY the value (the part after →), exactly as written. ` +
    `If none of the options fit, reply with the single word: NONE`;

  let res;
  try {
    res = await anthropic.messages.create({
      model: CHIP_MATCHER_MODEL,
      max_tokens: CHIP_MATCHER_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    console.error("[decision-tree] chip-matcher LLM error:", err?.message || err);
    return null;
  }
  const out = String(res?.content?.[0]?.text || "").trim().replace(/^["']|["']$/g, "");
  if (!out || out.toUpperCase() === "NONE") return null;
  // Exact value match wins; fall back to label match.
  return (
    node.chips.find((c) => c.value === out) ||
    node.chips.find((c) => c.label === out) ||
    null
  );
}

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

// Mid-funnel lock. Walks every enabled tree's history reconstruction
// against the conversation; if any tree has prior answers and isn't
// completed, that tree owns the next turn — even if category-intent
// has shifted (e.g. customer typed "sneakers" mid-orthotic-funnel
// and category-intent re-routed to Footwear). Without this, the
// LLM hijacks mid-funnel turns. Returns { tree, priorState } or null.
function findInProgressTree(trees, messages, prefill) {
  if (!trees || trees.length === 0) return null;
  const historyOnly = messages.slice(0, -1);
  for (const t of trees) {
    let state;
    try {
      state = extractTreeStateFromHistory(t, historyOnly, prefill);
    } catch { continue; }
    if (!state || state.completed) continue;
    if (Object.keys(state.answers || {}).length > 0) {
      return { tree: t, priorState: state };
    }
  }
  return null;
}

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

  const prefill = buildPrefill({ sessionGender, answeredChoices });

  // Mid-funnel lock takes priority over category-intent matching.
  // If any enabled tree has in-progress state, that tree owns the
  // turn regardless of what the customer typed.
  const inProgress = findInProgressTree(trees, messages, prefill);
  let tree, priorState;
  if (inProgress) {
    tree = inProgress.tree;
    priorState = inProgress.priorState;
  } else {
    tree = pickActiveTree(trees, { categoryIntent, latestUserMessage });
    if (!tree) return { handled: false };
    priorState = extractTreeStateFromHistory(tree, messages.slice(0, -1), prefill);
  }

  // Validate the tree definition before running it. A merchant who
  // saves a malformed tree should not crash the chat — fall through
  // to the AI flow and log.
  const v = validateDecisionTree(tree.definition);
  if (!v.ok) {
    console.error(`[decision-tree] tree ${tree.id} invalid:`, v.errors.join("; "));
    return { handled: false };
  }

  let stepped = stepTree(tree, priorState, latestUserMessage);

  // If the engine couldn't literal-match the customer's typed input
  // to any chip on the current question, ask Haiku to translate. We
  // only do this when (a) the question node has chips (i.e. we know
  // what we're choosing between), (b) the customer typed something
  // non-trivial (skip empty / single-char), (c) we have an apiKey.
  if (
    stepped?.response?.unmatched &&
    !priorState.completed &&
    config.anthropicApiKey &&
    String(latestUserMessage || "").trim().length >= 2
  ) {
    const node = (tree.definition?.nodes || []).find((n) => n.id === priorState.currentNodeId);
    if (node && node.type === "question" && Array.isArray(node.chips) && node.chips.length > 0) {
      try {
        const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
        const matched = await llmMatchChip({
          anthropic,
          node,
          userMessage: latestUserMessage,
        });
        if (matched) {
          // Re-step with the chip's value — the engine's literal
          // matcher will hit on this exact value.
          stepped = stepTree(tree, priorState, matched.value);
          console.log(
            `[decision-tree] chip-matcher mapped "${String(latestUserMessage).slice(0, 60)}" → ${matched.value}`,
          );
        }
      } catch (err) {
        console.error("[decision-tree] chip-matcher failed:", err?.message || err);
        // fall through with the original unmatched response
      }
    }
  }

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
