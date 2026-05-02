import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent, incrementRateLimitHits } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { getCatalogCategories, getAllCatalogCategories, getCategoryGenderAvailability } from "../models/Product.server";
import { getActiveCampaigns, formatCampaignsForCS } from "../models/Campaign.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { retrieveRelevantChunks } from "../lib/knowledge-chunks.server";
import { filterForbiddenCategoryChips, filterContradictingGenderChips } from "../lib/chip-filter.server";
import { sanitizeCtaLabel } from "../lib/cta-label.server";
import { analyzeCategoryIntent, cardMatchesActiveGroup, textIntentDivergesFromGroup, matchingGroupsForText } from "../lib/category-intent.server";
import { extractAnsweredChoices } from "../lib/conversation-memory.server";
import {
  detectGenderFromHistory as _detectGenderFromHistory,
  stripBannedNarration,
  stripMetaNarration,
  looksLikeProductPitch,
  looksLikeDefinitionalHallucination,
  hasChoiceButtons,
  dedupeConsecutiveSentences,
  isSingularPrescriptive,
  detectConditionOrOccasion,
} from "../lib/chat-helpers.server";
import { TOOLS, executeTool, extractProductCards, CUSTOMER_ORDERS_TOOL, FIT_PREDICTOR_TOOL } from "../lib/chat-tools.server";
import { fetchCustomerContext } from "../lib/customer-context.server";
import { fetchKlaviyoEnrichment } from "../lib/klaviyo-enrichment.server";
import { fetchYotpoLoyalty } from "../lib/yotpo-loyalty.server";
import prisma from "../db.server";
import { recordChatUsage, getTodayMessageCount } from "../models/ChatUsage.server";
import { canSendMessage } from "../lib/billing.server";

// Model IDs are env-driven so you can update them in Railway without a code
// deploy. When Anthropic ships a new model:
//   1. Railway → Service → Variables → set OPUS_MODEL=<new-id> (or HAIKU/DEFAULT)
//   2. Service auto-restarts
//   3. Smoke-test a few chats; if anything's off, revert the env var
// Defaults below are the current best as of code commit time. Without env vars
// set, behavior is unchanged.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-6";
const HAIKU_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";
const OPUS_MODEL = process.env.OPUS_MODEL || "claude-opus-4-7";
const MAX_TOKENS = parseInt(process.env.CHAT_MAX_TOKENS, 10) || 1024;
const MAX_TOOL_HOPS = parseInt(process.env.CHAT_MAX_TOOL_HOPS, 10) || 3;

const DEPRECATED_MODELS = new Set(["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620", "claude-opus-4-20250514"]);

const RATE_LIMIT_PER_IP_SHOP = parseInt(process.env.RATE_LIMIT_PER_IP_SHOP, 10) || 20;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const RATE_LIMIT_MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS, 10) || 10_000;

const ipShopBuckets = new Map();

function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

function checkIpShopRate(shop, ip) {
  const key = `${shop}|${ip}`;
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = (ipShopBuckets.get(key) || []).filter((t) => t > cutoff);
  if (bucket.length >= RATE_LIMIT_PER_IP_SHOP) {
    const retryAfter = Math.max(1, Math.ceil((bucket[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    ipShopBuckets.set(key, bucket);
    return { ok: false, retryAfter };
  }
  bucket.push(now);
  ipShopBuckets.set(key, bucket);
  if (ipShopBuckets.size > RATE_LIMIT_MAX_KEYS) {
    const evictCount = ipShopBuckets.size - RATE_LIMIT_MAX_KEYS;
    let evicted = 0;
    for (const k of ipShopBuckets.keys()) {
      if (evicted >= evictCount) break;
      if (k === key) continue;
      ipShopBuckets.delete(k);
      evicted++;
    }
  }
  return { ok: true };
}

if (!globalThis.__shopagentRateSweeper) {
  globalThis.__shopagentRateSweeper = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [key, bucket] of ipShopBuckets) {
      const filtered = bucket.filter((t) => t > cutoff);
      if (filtered.length === 0) ipShopBuckets.delete(key);
      else ipShopBuckets.set(key, filtered);
    }
  }, RATE_LIMIT_WINDOW_MS);
  globalThis.__shopagentRateSweeper.unref?.();
}

function sanitizeHistory(history) {
  const out = [];
  for (const turn of history || []) {
    if (!turn?.role || !turn?.content) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    out.push({ role: turn.role, content: String(turn.content) });
  }
  return out;
}

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const SIMPLE_PATTERN = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|bye|goodbye|cool|great|got it|perfect|sure|nice|awesome|alright|yep|nope|sounds good|that helps|appreciate it)\s*[.!?]*$/i;

const detectGenderFromHistory = _detectGenderFromHistory;

function chooseModel(config, message, history) {
  const strategy = config.modelStrategy || "smart";
  const stored = config.anthropicModel || DEFAULT_MODEL;
  const sonnet = DEPRECATED_MODELS.has(stored) ? DEFAULT_MODEL : stored;

  if (strategy === "always-haiku") return HAIKU_MODEL;
  if (strategy === "always-opus") return OPUS_MODEL;
  if (strategy !== "smart") return sonnet;

  if (history.length > 0 && message.length < 80 && SIMPLE_PATTERN.test(message.trim())) {
    return HAIKU_MODEL;
  }
  return sonnet;
}

function addUsage(acc, usage) {
  acc.input_tokens += usage.input_tokens || 0;
  acc.output_tokens += usage.output_tokens || 0;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
}

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

// Drop "sibling" cards the AI didn't actually name. Example: the AI names
// "Speed Orthotics W/ Metatarsal Support" but the near-duplicate "Speed
// Posted Orthotics W/ Metatarsal Support" scores high purely from overlapping
// title words, even though the AI never mentioned "Posted". For each
// lower-scored card that shares >=80% of distinctive title words with a
// higher-scored, already-kept card AND introduces at least one extra word
// that does not appear in the AI text, drop it. Pure title-token math, no
// product terminology.
function dropSiblingCards(scored, textLower) {
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

function scoreCardAgainstText(card, textLower, userTextLower) {

  const raw = card.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const generic = new Set(["the", "a", "an", "for", "and", "or", "in", "on", "with", "men", "mens", "women", "womens", "black", "white", "tan", "brown", "red", "blue", "grey", "gray", "pink", "dark", "light"]);
  const nameWords = raw.filter((w) => !generic.has(w));
  const titleScore = nameWords.length === 0 ? 0 : nameWords.filter((w) => textLower.includes(w)).length / nameWords.length;

  // If the card came from a search whose query term appears in this card's
  // description snippet, boost it — it's a direct textual match for what the
  // user asked about (e.g. "UltraSKY" asked, description contains "UltraSKY").
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

const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

function skusFromCardText(value) {
  if (!value) return [];
  const matches = String(value).toUpperCase().match(SKU_PATTERN) || [];
  return matches;
}

function extractOrphanSkus(text, pool) {
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

function stripMissingSkus(text, missing) {
  if (!text || missing.length === 0) return text;
  let cleaned = text;
  for (const sku of missing) {
    const safe = sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\s*\\(\\s*${safe}\\s*\\)`, "gi"), "");
    cleaned = cleaned.replace(new RegExp(`\\b${safe}\\b`, "gi"), "");
  }
  cleaned = cleaned
    .replace(/\(\s*\)/g, "")
    // Repair dangling conjunction patterns left behind by SKU removal.
    // E.g. "the L1305 and  are great picks" → "the L1305 is a great pick".
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
  return cleaned;
}

const SUPPORT_ANCHOR_RE = /\b(contact|customer\s+(service|care|support)|support\s+(hub|team|center)|support|care\s+team|help\s+team|reach\s+(out|us)|our\s+team|speak.*(human|agent|rep|person))\b/i;

function normalizeUrl(u) {
  return String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

function extractSupportCTA(text, supportUrl, supportLabel) {
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


function extractCollectionCTA(text) {
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


function extractGenericCTA(text) {
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


// Mirror of the backend helper — extracts the first meaningful word of a
// title as a style-family key. Used to drop the find_similar_products
// reference (and its siblings) from the display pool so the customer never
// sees the product they asked to compare against.
const FAMILY_STOP_WORDS_UI = new Set(["the", "a", "an", "my", "our", "new"]);
function titleStyleFamily(title) {
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

async function runAgenticLoop({ anthropic, model, systemPrompt, messages, ctx, controller, encoder, promptCaching, tools }) {
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let toolCallCount = 0;
  let productSearchAttempted = false;
  const allProductPool = new Map();
  const excludedFamilies = new Set();
  const excludedHandles = new Set();
  // Product handles the fit tool focused on. When present, the final card
  // display filters to just these — a size question about "Miles" should
  // only show the Miles card, not Elise/Dylan/etc. that happened to match
  // the search query on generic words like "arch support sneaker".
  const focusedHandles = new Set();
  let fullResponseText = "";


  const system = promptCaching
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const activeTools = tools || TOOLS;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    // If the previous hop emitted text and this hop is about to emit more,
    // insert a paragraph break so the two streamed chunks don't run together
    // as "...you!Here are..." in the rendered message.
    if (hop > 0 && fullResponseText && !/\s$/.test(fullResponseText)) {
      fullResponseText += "\n\n";
    }

    const hopStart = Date.now();
    const stream = anthropic.messages.stream({

      model,
      max_tokens: MAX_TOKENS,
      system,
      tools: activeTools,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        fullResponseText += event.delta.text;
      }
    }

    const final = await stream.finalMessage();
    addUsage(totalUsage, final.usage || {});
    console.log(`[chat] hop=${hop} stop=${final.stop_reason} ms=${Date.now() - hopStart} textLen=${fullResponseText.length}`);

    if (final.stop_reason !== "tool_use") {
      break;
    }

    const toolUses = final.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    toolCallCount += toolUses.length;
    if (toolUses.some((u) => u.name === "search_products" || u.name === "get_product_details" || u.name === "lookup_sku" || u.name === "find_similar_products")) {
      productSearchAttempted = true;
    }


    const results = await Promise.all(
      toolUses.map((u) => executeTool(u.name, u.input, ctx)),
    );

    let hopHasProducts = false;
    for (let i = 0; i < toolUses.length; i++) {
      const u = toolUses[i];
      const r = results[i];
      if (u.name === "find_similar_products" && r && !r.error && r.reference) {
        if (r.reference.handle) excludedHandles.add(String(r.reference.handle).toLowerCase());
        const fam = titleStyleFamily(r.reference.title || "");
        if (fam) excludedFamilies.add(fam);
      }
      if (u.name === "get_fit_recommendation" && r && !r.error && r.recommendation?.shouldDisplay) {
        if (r.handle) focusedHandles.add(String(r.handle).toLowerCase());
        const display = typeof ctx.fitPredictorConfig?.display === "string" ? ctx.fitPredictorConfig.display : "bar";
        controller.enqueue(encoder.encode(sseChunk({
          type: "fit_report",
          handle: r.handle,
          productTitle: r.productTitle,
          recommendedSize: r.recommendation.recommendedSize,
          confidence: r.recommendation.confidence,
          reasons: r.recommendation.reasons || [],
          sizesAvailable: r.recommendation.sizesAvailable || [],
          display,
        })));
      }
      const cards = extractProductCards(u.name, r);
      for (const c of cards) {
        const key = c.handle || c.title;
        if (!allProductPool.has(key)) {
          allProductPool.set(key, c);
          hopHasProducts = true;
        }
      }
    }

    messages.push({ role: "assistant", content: final.content });
    messages.push({
      role: "user",
      content: toolUses.map((u, i) => {
        const payload = results[i] ?? {};
        if (hopHasProducts && (u.name === "search_products" || u.name === "get_product_details" || u.name === "lookup_sku" || u.name === "find_similar_products")) {
          payload._display = "Product cards are shown automatically. Do NOT list products with links. Write a brief summary only.";
        }
        return {
          type: "tool_result",
          tool_use_id: u.id,
          content: JSON.stringify(payload),
        };
      }),
    });
  }

  let initialPool = Array.from(allProductPool.values());

  if (!fullResponseText && initialPool.length > 0) {
    const wrap = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOLS,
      tool_choice: { type: "none" },
      messages,
    });
    addUsage(totalUsage, wrap.usage || {});

    for (const block of wrap.content) {
      if (block.type === "text" && block.text) {
        fullResponseText += block.text;
      }
    }
  }

  if (fullResponseText) {
    const poolForCheck = Array.from(allProductPool.values());
    const orphanSkus = extractOrphanSkus(fullResponseText, poolForCheck);
    if (orphanSkus.length > 0) {
      const recoveredSkus = new Set();
      try {
        const recovery = await executeTool("lookup_sku", { skus: orphanSkus.slice(0, 10) }, ctx);
        toolCallCount += 1;
        const newCards = extractProductCards("lookup_sku", recovery);
        for (const card of newCards) {
          const key = card.handle || card.title;
          if (!allProductPool.has(key)) allProductPool.set(key, card);
          for (const s of skusFromCardText(card.title)) recoveredSkus.add(s);
          for (const s of skusFromCardText(card.handle)) recoveredSkus.add(s);
        }
        if (recovery && Array.isArray(recovery.found)) {
          for (const f of recovery.found) {
            if (f?.sku) recoveredSkus.add(String(f.sku).toUpperCase());
          }
        }
      } catch (err) {
        console.error("[chat] SKU recovery failed:", err?.message || err);
      }
      const stillMissing = orphanSkus.filter((s) => !recoveredSkus.has(s));
      if (stillMissing.length > 0) {
        fullResponseText = stripMissingSkus(fullResponseText, stillMissing);
      }
    }
  }

  let supportCTA = null;
  if (fullResponseText && ctx.supportUrl) {
    const result = extractSupportCTA(fullResponseText, ctx.supportUrl, ctx.supportLabel);
    fullResponseText = result.text;
    supportCTA = result.cta;

    if (!supportCTA) {
      // Scope support-trigger detection to the LATEST user message, not
      // the full conversation. Without this, any historical mention of
      // "exchange", "refund", "return policy", "my order", etc. ANYWHERE
      // earlier in the chat keeps gluing the Visit Support Hub button to
      // every subsequent reply — even chip-only gating questions like
      // "What shoes will your dad wear them in?".
      const userText = ctx.userText || "";
      const aiText = fullResponseText || "";
      const userAskedSupport = /\b(contact|reach|talk to|speak (to|with)|get (a )?hold of|how do i .{0,20}(contact|reach))\b.{0,40}\b(customer|support|service|care|team|human|agent|representative|rep|person|someone)\b/i.test(userText)
        || /\b(customer (service|care|support)|support (hub|team)|return policy|refund|exchange|my order|order status|shipping issue|problem with my)\b/i.test(userText);
      // Tightened: only fires when AI explicitly redirects to support, not
      // on generic conversational phrases ('happy to help', 'our team', etc.)
      // that legitimately appear in normal product replies.
      const aiMentionsSupport = /\b(support team|customer service|customer care|reach out (to )?(our |the )?(team|support|customer service|customer care)|contact (our|the) (team|support|customer service|customer care))\b/i.test(aiText);
      if (userAskedSupport || aiMentionsSupport) {
        const defaultOldLabel = "Contact customer service";
        const label = ctx.supportLabel && ctx.supportLabel.trim() && ctx.supportLabel.trim() !== defaultOldLabel
          ? ctx.supportLabel.trim()
          : "Visit Support Hub";
        supportCTA = { url: ctx.supportUrl, label };
      }
    }
  }

  // Recovery hop — if the AI shipped pitch text without ever calling
  // search_products, but the customer's history mentions a condition
  // (plantar fasciitis, bunion, etc.) or occasion (trip, walking),
  // bypass the AI and run the search ourselves. Replace the pitch
  // text with neutral framing. Deterministic, no extra API call.
  //
  // Without this, the empty-pool repair below wipes the pitch text
  // and renders a dead-end fallback — even when the customer gave
  // us everything we needed to find a real product.
  if (
    !productSearchAttempted &&
    looksLikeProductPitch(fullResponseText) &&
    allProductPool.size === 0
  ) {
    const intent = detectConditionOrOccasion(ctx.userText || "");
    if (intent) {
      console.log(`[chat] recovery search: AI did not call tool, forcing query="${intent.phrase}" (${intent.kind})`);
      try {
        const recovery = await executeTool(
          "search_products",
          { query: intent.phrase, limit: intent.kind === "condition" ? 1 : 3 },
          ctx,
        );
        if (recovery && Array.isArray(recovery.products) && recovery.products.length > 0) {
          productSearchAttempted = true;
          for (const p of recovery.products) {
            if (p?.handle && !allProductPool.has(p.handle)) allProductPool.set(p.handle, p);
          }
          fullResponseText = intent.kind === "condition"
            ? `Here's what I'd recommend for ${intent.phrase}.`
            : `Here are some options for ${intent.phrase}.`;
          console.log(`[chat] recovery search: filled pool with ${recovery.products.length} product(s)`);
        } else {
          console.log(`[chat] recovery search: returned 0 products`);
        }
      } catch (err) {
        console.error("[chat] recovery search failed:", err?.message || err);
      }
    }
  }

  const pool = Array.from(allProductPool.values());

  // Compliance backstop for the BANNED NARRATION prompt rule. Strips
  // "let me look that up", "i'll find", "one moment", etc. — phrases
  // the model ships despite being told not to.
  if (fullResponseText) {
    const stripped = stripBannedNarration(fullResponseText);
    if (stripped !== fullResponseText.trim()) {
      console.log(`[chat] stripped banned narration`);
      fullResponseText = stripped;
    }
  }

  // Strip meta-narration: "Since the customer already established
  // Men's via the choice button…", "we know: A, B, C —", "the user
  // has chosen…". Customer-facing text addresses them in second
  // person; AI's reasoning chain doesn't belong in the bubble.
  if (fullResponseText) {
    const beforeMeta = fullResponseText;
    const stripped = stripMetaNarration(fullResponseText);
    if (stripped !== beforeMeta.trim()) {
      console.log(`[chat] stripped meta-narration`);
      fullResponseText = stripped;
    }
  }

  // Dedupe back-to-back near-duplicate sentences. AI sometimes ships
  // an "echo opener" pair ("Here are some great X. Here are some great
  // X with arch support…") despite the NO REPETITION prompt rule.
  if (fullResponseText) {
    const beforeDedupe = fullResponseText;
    const deduped = dedupeConsecutiveSentences(fullResponseText);
    if (deduped !== beforeDedupe.trim()) {
      console.log(`[chat] deduped repeated sentences`);
      fullResponseText = deduped;
    }
  }

  // Pitch text without products = incoherent turn. Replace with the
  // graceful fallback below. Catches both "search ran, returned 0" and
  // "AI claimed a recommendation without ever searching" cases.
  if (pool.length === 0 && looksLikeProductPitch(fullResponseText)) {
    console.log(`[chat] empty-pool repair: pitch text without products (searchAttempted=${productSearchAttempted})`);
    fullResponseText = "";
  }

  // Definitional hallucination check. If the AI tried a search,
  // got nothing, but then confidently defines an unknown brand/line
  // ("Lynco is our premium orthotic line that…"), strip the response.
  // Forces the AI to ask a clarifying question on the next turn.
  if (
    productSearchAttempted &&
    pool.length === 0 &&
    looksLikeDefinitionalHallucination(fullResponseText)
  ) {
    console.log(`[chat] empty-pool repair: definitional hallucination`);
    fullResponseText = "";
  }

  if (!fullResponseText && pool.length === 0) {
    fullResponseText = "I'm not finding a great match for that right now. Want to try a different style, or I can connect you with our support team?";
  } else if (!fullResponseText && pool.length > 0) {
    // Strips wiped the entire text (e.g. AI's only output was
    // "Let me look that up for you!") but a search returned products.
    // Without a fallback we'd ship an empty bubble above the cards.
    console.log(`[chat] empty-text repair: text wiped by strips, pool=${pool.length}`);
    fullResponseText = "Here are some options that match what you're looking for.";
  }

  // Strip stray HTML the model sometimes emits (literal <br>, <p>, etc.).
  // The widget renders markdown / plain text, not HTML, so tags otherwise
  // surface as raw characters. Whitelist real HTML tag names so the
  // <<Option>> choice-button syntax used by the widget is never matched.
  if (fullResponseText) {
    const HTML_TAG = /<\/?(?:br|p|div|span|b|i|u|strong|em|small|sup|sub|ul|ol|li|h[1-6]|hr|a|img|figure|figcaption|blockquote|code|pre|table|thead|tbody|tr|td|th)(?:\s[^>]*)?\/?>/gi;
    fullResponseText = fullResponseText
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(HTML_TAG, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const filtered = filterForbiddenCategoryChips(fullResponseText, ctx.catalogCategories, ctx.fullCatalogCategories);
    if (filtered.stripped.length > 0) {
      console.log(`[chat] ${ctx.shop} stripped off-catalog chips:`, filtered.stripped, "allowed:", ctx.catalogCategories);
    }
    fullResponseText = filtered.text;

    // Strip gender chips that contradict the catalog given the user's
    // mentioned categories. e.g. user said "boots" + AI offered <<Men's>>
    // when only women's boots exist → strip the Men's chip. Keeps both
    // when the mentioned category supports both, or when no category was
    // mentioned. Pure data — categoryGenderMap is computed from the
    // catalog every request.
    if (ctx.categoryGenderMap) {
      const genderFiltered = filterContradictingGenderChips(
        fullResponseText,
        ctx.conversationText,
        ctx.categoryGenderMap,
      );
      if (genderFiltered.stripped.length > 0) {
        console.log(`[chat] ${ctx.shop} stripped contradicting-gender chips:`, genderFiltered.stripped);
      }
      fullResponseText = genderFiltered.text;
    }
  }

  // Strip any markdown directive blocks (`:::name ... :::`) the model may
  // emit. Some Anthropic responses generate `:::product-list ... :::` blocks
  // listing handles separated by '|' as a markup directive — but our widget
  // doesn't render directives, so the literal markup leaks into the chat
  // message. Product cards already render via the separate `type: products`
  // SSE event, so we just strip the directive blocks entirely.
  if (fullResponseText) {
    fullResponseText = fullResponseText
      .replace(/:::[a-zA-Z][\w-]*[\s\S]*?:::/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }


  const collection = extractCollectionCTA(fullResponseText);
  fullResponseText = collection.text;

  let genericCTA = null;
  if (!supportCTA && fullResponseText) {
    const generic = extractGenericCTA(fullResponseText);
    fullResponseText = generic.text;
    genericCTA = generic.cta;
  }

  console.log(`[chat] emit textLen=${fullResponseText.length} poolSize=${pool.length} searchAttempted=${productSearchAttempted}`);

  // Observability only — no behavior change. Flag long non-product
  // replies (text >450 chars, no pool, no search) so we can spot
  // runaway FAQ/explanation answers in the logs without truncating.
  // Threshold ≈ 4 sentences worth — generous enough to allow real
  // FAQ explanations, tight enough to surface unusual ramblings.
  if (
    fullResponseText &&
    pool.length === 0 &&
    !productSearchAttempted &&
    fullResponseText.length > 450
  ) {
    const sentenceCount = (fullResponseText.match(/[.!?](?:\s|$)/g) || []).length;
    console.log(`[chat] WARN long-non-product-reply chars=${fullResponseText.length} sentences~=${sentenceCount}`);
  }

  controller.enqueue(encoder.encode(sseChunk({
    type: "text",
    text: fullResponseText
  })));

  // STALE-CARDS GUARD: emit an empty products event up front so the
  // widget clears any cards left over from prior turns. The card-render
  // block below may emit a non-empty products event afterwards — the
  // widget treats each products event as a full replacement, so the last
  // one wins. Without this guard, a customer who saw "Chase Sneaker" in
  // turn 3 still sees those cards in turn 5 even after the AI pivoted to
  // recommending an orthotic and didn't search this turn.
  controller.enqueue(encoder.encode(sseChunk({
    type: "products",
    products: [],
  })));

  if (supportCTA) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: supportCTA.url,
      label: supportCTA.label
    })));
  }

  if (!supportCTA && genericCTA) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: genericCTA.url,
      label: genericCTA.label,
    })));
  }

  const userAskedSignup = /\b(sign ?up for (our|the|your|a).{0,25}(newsletter|list|email|sms|updates|deals|offers)|subscribe to (our|the|your).{0,20}(newsletter|list|email|sms|updates)|newsletter|mailing list|join our (list|newsletter|email|sms)|opt.?in|stay (connected|in touch|updated).{0,20}(email|offers|updates|news|deals))\b/i.test(ctx.userText || "");
  const aiMentionsSignup = /\b(newsletter|mailing list|subscribe to (our|the|your).{0,20}(newsletter|list|sms|email)|sign ?up for (our|the|my|your).{0,25}(newsletter|list|email|sms|updates|deals|offers)|join our (newsletter|list|email|sms)|stay connected.{0,20}(email|offers|updates|deals))\b/i.test(fullResponseText || "");
  if (userAskedSignup || aiMentionsSignup) {
    controller.enqueue(encoder.encode(sseChunk({ type: "klaviyo_form" })));
  }

  // STRUCTURAL: never render cards in the same turn as choice buttons.
  // Prompt rule said this; the AI sometimes ignores it. Customer reads
  // cards as the answer and skips the buttons, getting wrong products.
  const hasChoiceButtonsForCards = hasChoiceButtons(fullResponseText);
  if (hasChoiceButtonsForCards && pool.length > 0) {
    console.log(`[chat] suppressing ${pool.length} cards: turn has choice buttons`);
  }

  if (pool.length > 0 && fullResponseText && !hasChoiceButtonsForCards) {
    const textLower = fullResponseText.toLowerCase();
    const saysNoMatch = /\b(don't (?:have|see|carry)|not (?:see|carry|have)|don't appear|we don't|no .{0,20} available)\b/i.test(fullResponseText);

    // When find_similar_products ran, drop every card whose handle or style
    // family matches the reference — otherwise Jillian from an earlier
    // search_products call wins the scoring pass because the AI text still
    // names "Jillian" as the comparison point.
    let filteredPool = (excludedFamilies.size === 0 && excludedHandles.size === 0)
      ? pool
      : pool.filter((card) => {
          const handle = String(card.handle || "").toLowerCase();
          if (excludedHandles.has(handle)) return false;
          const fam = titleStyleFamily(card.title || "");
          if (fam && excludedFamilies.has(fam)) return false;
          return true;
        });

    if (ctx.activeCategoryGroup) {
      // Mirror of the search-layer override (chat-tools.server.js): when
      // the AI's reply matches the terms of a DIFFERENT merchant group
      // than the active one, the group lock is stale. Trust the AI's
      // intent and skip the render-layer filter so the right cards
      // aren't wiped.
      //
      // Pure data-driven: the merchant's categoryGroups define the
      // divergence vocabulary. Works for any vertical (footwear,
      // jewelry, apparel, etc.).
      const replyDiverges = textIntentDivergesFromGroup(
        fullResponseText,
        ctx.activeCategoryGroup,
        ctx.merchantGroups,
      );

      if (replyDiverges) {
        // The AI's reply is about a different group than the locked
        // one — switch the filter to that group instead of skipping
        // entirely. Skipping was the old behavior and let wrong cards
        // through (e.g. customer asks for orthotics → conversation
        // locks Footwear via a chip → AI says "the right orthotic
        // is X" but cards are sneakers because the filter was bypassed).
        // Now we filter to whatever group the reply actually mentions.
        const replyGroups = matchingGroupsForText(fullResponseText, ctx.merchantGroups, { includeTriggers: true });
        if (replyGroups.length === 1) {
          const replyGroup = replyGroups[0];
          const beforeGroup = filteredPool.length;
          const groupScoped = filteredPool.filter((card) => cardMatchesActiveGroup(card, replyGroup));
          if (groupScoped.length > 0) {
            console.log(`[chat] product-card group guard: SWITCH locked=${ctx.activeCategoryGroup.name || "-"} → reply-matched=${replyGroup.name} (${groupScoped.length}/${beforeGroup})`);
            filteredPool = groupScoped;
          } else {
            // Reply mentions a group but no cards match it. Wipe so
            // the empty-pool repair turns this into the dead-end
            // fallback rather than rendering wrong cards beneath
            // text the AI got right.
            console.log(`[chat] product-card group guard: reply mentions ${replyGroup.name} but no matching cards in pool — wiping`);
            filteredPool = [];
          }
        } else {
          console.log(`[chat] product-card group guard: skip — reply matches ${replyGroups.length} groups, ambiguous`);
        }
      } else {
        const beforeGroup = filteredPool.length;
        const groupScoped = filteredPool.filter((card) => cardMatchesActiveGroup(card, ctx.activeCategoryGroup));
        if (groupScoped.length === 0 && beforeGroup > 0) {
          // Fail-open: filter wiped every card. Stale group lock; better
          // to render the search results than ship an empty bubble that
          // the customer reads as "AI claimed a recommendation but no
          // card". Same fail-open pattern as the search layer.
          console.log(`[chat] product-card group guard: WIPED ALL ${beforeGroup} for group=${ctx.activeCategoryGroup.name || "-"} → falling back to unfiltered`);
        } else {
          if (groupScoped.length !== beforeGroup) {
            console.log(
              `[chat] product-card group guard: kept ${groupScoped.length}/${beforeGroup} for group=${ctx.activeCategoryGroup.name || "-"}`,
            );
          }
          filteredPool = groupScoped;
        }
      }
    }

    // When get_fit_recommendation ran, the customer is asking about ONE
    // specific product. Narrow the display to just the focused handle(s),
    // so a search that over-matched on generic words ("arch support
    // sneaker") doesn't show random sibling products alongside.
    if (focusedHandles.size > 0) {
      const focused = filteredPool.filter((card) =>
        focusedHandles.has(String(card.handle || "").toLowerCase()),
      );
      if (focused.length > 0) filteredPool = focused;
    }

    const userTextLower = (ctx.userText || "").toLowerCase();
    const scored = filteredPool.map((card) => ({
      card,
      score: scoreCardAgainstText(card, textLower, userTextLower),
    }));
    scored.sort((a, b) => b.score - a.score);

    const matched = dropSiblingCards(
      scored.filter((s) => s.score >= 0.6),
      textLower,
    );

    // Per-shop card cap, set in chat action from config.productCardStyle.
    // Horizontal layout = 3 (legacy); showcase layout = 10 (scroll-snap row).
    const cardCap = ctx.productCardCap || 3;

    // SKU-mention narrowing: if the AI text named a specific SKU (e.g.
    // "the L700M is your best match"), render ONLY the card(s) for that
    // SKU instead of all top-3 from the pool. Prevents the "text says one
    // product, cards show three different ones" mismatch. Tolerant of
    // gender suffixes — L700M and L700W both match L700 in the pool.
    const baseSku = (s) => String(s).toUpperCase().replace(/[A-Z]$/, "");
    const mentionedSkus = fullResponseText.match(SKU_PATTERN) || [];
    let skuNarrowedCards = null;
    if (mentionedSkus.length > 0) {
      const wantedBases = new Set(mentionedSkus.map(baseSku));
      const skuMatches = filteredPool.filter((card) => {
        const cardSkus = [
          ...skusFromCardText(card.title),
          ...skusFromCardText(card.handle),
        ];
        return cardSkus.some((s) => wantedBases.has(baseSku(s)));
      });
      if (skuMatches.length > 0) {
        skuNarrowedCards = skuMatches.slice(0, cardCap);
        console.log(
          `[chat] SKU-narrow: text mentions ${[...wantedBases].join(",")} → showing ${skuNarrowedCards.length} of ${filteredPool.length} pool cards`,
        );
      }
    }

    // Singular-prescriptive narrowing: even without a SKU, when the AI
    // uses singular "the X is your best/perfect match" language, the
    // customer expects ONE card. Narrow to the top-scored card so the
    // text and the rendered card agree. Patterns expanded to catch:
    //   "is the right pick / right choice / right fit / right one"
    //   "is the go-to pick / go-to choice / go-to option"
    //   "is a great choice / great pick / great option / great fit"
    //   "is a good choice / good pick / good fit / good option"
    //   "would be perfect / would be a great pick"
    //   "I'd recommend / I'd suggest"
    const singularPrescriptive = isSingularPrescriptive(fullResponseText);

    let cards;
    if (skuNarrowedCards) {
      cards = skuNarrowedCards;
    } else if (singularPrescriptive && scored.length > 0 && scored[0].score >= 0.6) {
      cards = [scored[0].card];
      console.log(`[chat] singular-narrow: text says "the X is best" → showing 1 card`);
    } else if (matched.length > 0) {
      cards = matched.slice(0, cardCap).map((s) => s.card);
    } else if (!saysNoMatch) {
      cards = dropSiblingCards(scored, textLower).slice(0, cardCap).map((s) => s.card);
    }

    // Text-card coherence guard: if the AI used singular-prescriptive
    // language ("is the right pick", etc.) but no card scored ≥0.4
    // (i.e. no card title meaningfully matches the AI's claim), the AI
    // is naming a product that isn't really in the pool. Replace the
    // text with neutral framing so the customer doesn't read "Kids
    // Orthotics is the right pick" while seeing a Unisex Edge card.
    if (
      singularPrescriptive &&
      cards && cards.length > 0 &&
      (scored.length === 0 || scored[0].score < 0.4)
    ) {
      console.log(`[chat] coherence guard: AI named a product but no card matches well (top score=${scored[0]?.score?.toFixed(2) || "n/a"}) — neutral text`);
      fullResponseText = "Here's an option that might work — let me know if you'd like to look at something different.";
    }


    if (cards && cards.length > 0) {
      const seen = new Set();
      const deduped = [];
      const categoryCounts = new Map();
      const genderCounts = new Map();
      for (const c of cards) {
        const key = c.handle || c.title;
        if (seen.has(key)) continue;
        seen.add(key);
        if (c._category) {
          categoryCounts.set(c._category, (categoryCounts.get(c._category) || 0) + 1);
        }
        if (c._gender) {
          genderCounts.set(c._gender, (genderCounts.get(c._gender) || 0) + 1);
        }
        const { _descriptionSnippet, _searchQuery, _category, _gender, ...publicCard } = c;
        deduped.push(publicCard);
      }
      // show product cards
controller.enqueue(encoder.encode(sseChunk({
  type: "products",
  products: deduped
})));

// Collection CTA: AI-emitted <<Label|URL>> takes priority; otherwise look up
// the dominant (category, gender) across the shown cards in the merchant's
// configured collectionLinks mapping. Matching prefers an exact
// category+gender rule, then falls back to a gender-agnostic rule for the
// same category. No mapping → no CTA (avoids 404s).
const collection = extractCollectionCTA(fullResponseText);
if (collection.cta) {
  controller.enqueue(encoder.encode(sseChunk({
    type: "link",
    url: collection.cta.url,
    label: collection.cta.label,
  })));
} else if (
  Array.isArray(ctx.collectionLinks) &&
  ctx.collectionLinks.length > 0 &&
  categoryCounts.size > 0 &&
  !ctx.categoryIntentAmbiguous
) {
  const dominantCat = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const dominantGender = genderCounts.size > 0
    ? [...genderCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : (ctx.sessionGender || "");
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
    const label = `Shop all ${String(match.label || match.category).trim()}`;
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: match.url,
      label,
    })));
  }
}
    }
  }

  return { totalUsage, toolCallCount, model, fullResponseText, productSearchAttempted };
}

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const rate = checkIpShopRate(session.shop, clientIp(request));
    if (!rate.ok) {
      return Response.json(
        { error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
      );
    }

    const config = await getShopConfig(session.shop);
    if (!config.anthropicApiKey) {
      return Response.json(
        { error: "AI engine API key not configured. Set it in the app admin under Settings." },
        { status: 503 },
      );
    }

    const quota = await canSendMessage(session.shop);
    if (!quota.ok) {
      return Response.json(
        {
          error: "plan_limit_reached",
          message: `This store reached its ${quota.limit.toLocaleString()} conversations for the month. Upgrade the plan in the SEoS Assistant admin to keep helping customers.`,
          plan: quota.plan.id,
          used: quota.used,
          limit: quota.limit,
        },
        { status: 402 },
      );
    }

    // Optional merchant-defined daily spending guardrail. When enabled, the
    // chat endpoint stops accepting new conversations once the configured
    // count is reached for the UTC day. Counts come from ChatUsage so the
    // limit is enforced consistently across multiple server instances.
    if (config.dailyCapEnabled && config.dailyCapMessages > 0) {
      const todayCount = await getTodayMessageCount(session.shop);
      if (todayCount >= config.dailyCapMessages) {
        return Response.json(
          {
            error: "daily_cap_reached",
            message:
              "The shop's daily AI assistant limit has been reached. The assistant will be available again tomorrow.",
            limit: config.dailyCapMessages,
            used: todayCount,
          },
          { status: 429 },
        );
      }
    }

    const body = await request.json();
    if (!body?.message) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const history = sanitizeHistory(body.history);
    const messages = [...history, { role: "user", content: String(body.message) }];
    const sessionGender = detectGenderFromHistory(messages);
    const answeredChoices = extractAnsweredChoices(messages);

    // When gender was detected from natural language ("for my dad",
    // "my wife", "I'm a man") rather than from a chip answer, the
    // existing answeredChoices doesn't include it — so the prompt's
    // "Established Answers" block has no gender entry, and the AI
    // ignores the rules-knowledge "gender is locked" intent and asks
    // anyway. Inject a synthetic entry so the AI sees gender as
    // already-answered and skips the gender question.
    if (sessionGender && !answeredChoices.some((c) =>
      /\b(men|women|gender|him|her|man|woman)\b/i.test(c.question || "") ||
      /\b(men|women|men's|women's)\b/i.test(c.answer || "")
    )) {
      answeredChoices.unshift({
        question: "Are these for men's or women's?",
        answer: sessionGender === "men" ? "Men's" : "Women's",
        rawAnswer: sessionGender === "men" ? "Men's" : "Women's",
        options: ["Men's", "Women's"],
      });
    }

    let [knowledge, attrMappings, catalogProductTypes, allCatalogCategories, categoryGenderMap, activeCampaigns] = await Promise.all([
      getKnowledgeFilesWithContent(session.shop),
      getAttributeMappings(session.shop),
      getCatalogCategories(session.shop, { gender: sessionGender }),
      getAllCatalogCategories(session.shop),
      getCategoryGenderAvailability(session.shop),
      getActiveCampaigns(session.shop),
    ]);

    // Merchant-configured category groups: keep a server-side product-intent
    // group from the conversation, then narrow the prompt/catalog surface to
    // that group's categories. This is fully data-driven — no hardcoded store
    // vocabulary anywhere.
    //
    // - Zero groups configured: no filter applied (full allow-list goes
    //   through). Configure groups in Rules & Knowledge to enable.
    // - Multiple groups match in the same user message (e.g. "orthotic shoes" hits both Footwear and
    //   Orthotics): no filter applied — the AI sees the full allow-list
    //   and resolves the ambiguity itself. Safer than picking wrong.
    // - Short follow-up answers like "Men's" or "Running Shoes" keep the
    //   prior product goal when the previous assistant turn was asking a
    //   contextual question about another group. That preserves "orthotic"
    //   as the thing to buy while using "running shoes" as fit context.
    let merchantGroups = [];
    try { merchantGroups = JSON.parse(config.categoryGroups || "[]"); } catch { /* */ }

    let groupFilterApplied = "";
    const categoryIntent = analyzeCategoryIntent(messages, merchantGroups);

    if (Array.isArray(merchantGroups) && merchantGroups.length > 0) {
      if (categoryIntent.activeGroup && !categoryIntent.ambiguous) {
        const g = categoryIntent.activeGroup;
        const allowed = new Set((g.categories || []).map((c) => String(c).toLowerCase()));
        const filtered = catalogProductTypes.filter((c) => allowed.has(String(c).toLowerCase()));
        if (filtered.length >= 1) {
          catalogProductTypes = filtered;
          groupFilterApplied = g.name;
        }
      }
    }

    // Same idea as the synthetic gender injection above: if the category
    // intent locked an active group from history (e.g. user said
    // "orthotics" three turns ago, then answered "Both" for pain), make
    // sure the prompt knows the category is established so the AI doesn't
    // re-ask "what type of product?" after it already committed.
    if (
      categoryIntent.activeGroup &&
      !categoryIntent.ambiguous &&
      categoryIntent.activeGroup.name &&
      !answeredChoices.some((c) =>
        new RegExp(`\\b${categoryIntent.activeGroup.name}\\b`, "i").test(c.answer || "") ||
        /\b(category|product type|what (?:type|kind))\b/i.test(c.question || "")
      )
    ) {
      answeredChoices.unshift({
        question: "What type of product are you looking for?",
        answer: categoryIntent.activeGroup.name,
        rawAnswer: categoryIntent.activeGroup.name,
        options: [categoryIntent.activeGroup.name],
      });
    }

    console.log(`[chat] ${session.shop} gender=${sessionGender || "any"} scoped-categories=${catalogProductTypes.length} full-catalog-categories=${allCatalogCategories.length}${groupFilterApplied ? ` group=${groupFilterApplied}` : ""}${categoryIntent.contextGroup ? ` contextGroup=${categoryIntent.contextGroup.name}` : ""}${categoryIntent.ambiguous ? " group=ambiguous" : ""}`);
    const attributeNames = attrMappings.map((m) => m.attribute);

    let categoryExclusions = [];
    try { categoryExclusions = JSON.parse(config.categoryExclusions || "[]"); } catch { /* */ }
    let querySynonyms = [];
    try { querySynonyms = JSON.parse(config.querySynonyms || "[]"); } catch { /* */ }
    let similarMatchAttributes = [];
    try {
      const raw = JSON.parse(config.similarMatchAttributes || "[]");
      similarMatchAttributes = Array.isArray(raw)
        ? raw.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
        : [];
    } catch { /* */ }
    let collectionLinks = [];
    try {
      const raw = JSON.parse(config.collectionLinks || "[]");
      collectionLinks = Array.isArray(raw)
        ? raw
            .map((r) => ({
              category: String(r?.category || "").trim().toLowerCase(),
              gender: String(r?.gender || "").trim().toLowerCase(),
              url: String(r?.url || "").trim(),
              label: String(r?.label || r?.category || "").trim(),
            }))
            .filter((r) => r.category && r.url)
        : [];
    } catch { /* */ }
    let fitPredictorConfig = {};
    try {
      const raw = JSON.parse(config.fitPredictorConfig || "{}");
      if (raw && typeof raw === "object") fitPredictorConfig = raw;
    } catch { /* */ }

    // Logged-in customer ID is HMAC-verified by Shopify on app proxy requests.
    // This is the only trustworthy customer identifier — we NEVER use any
    // customer_id sent in the POST body from the widget JS.
    const url = new URL(request.url);
    const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;

    // session.accessToken from app proxy may be an online/proxy token; for
    // Admin API calls we need the offline token. Fall back to the Session
    // table if the proxy session's token is missing.
    let accessToken = session.accessToken;
    if (!accessToken) {
      const offline = await prisma.session.findFirst({
        where: { shop: session.shop, isOnline: false },
        orderBy: { expires: "desc" },
      });
      accessToken = offline?.accessToken || null;
    }

    let customerContext = null;
    if (loggedInCustomerId && config.vipModeEnabled === true && accessToken) {
      customerContext = await fetchCustomerContext({
        shop: session.shop,
        accessToken,
        customerId: loggedInCustomerId,
        orderLimit: 5,
      });

      // Enrich with Klaviyo segments + Yotpo loyalty in parallel. Both are
      // opt-in (require a configured API key) and fail silently — enrichment
      // must never block a chat response. Email is used only server-side for
      // the lookup and is never placed in the system prompt.
      if (customerContext?._email) {
        const [klaviyo, loyalty] = await Promise.all([
          config.klaviyoPrivateKey
            ? fetchKlaviyoEnrichment({ privateKey: config.klaviyoPrivateKey, email: customerContext._email })
            : Promise.resolve(null),
          config.yotpoLoyaltyApiKey
            ? fetchYotpoLoyalty({ apiKey: config.yotpoLoyaltyApiKey, guid: config.yotpoLoyaltyGuid, email: customerContext._email })
            : Promise.resolve(null),
        ]);
        if (klaviyo) customerContext.klaviyo = klaviyo;
        if (loyalty) customerContext.loyalty = loyalty;
      }
    }

    // RAG retrieval (batch 2c). When the shop has opted in via
    // knowledgeRagEnabled and a query string is available, retrieve
    // top-K most-relevant KnowledgeChunk rows for the customer's
    // latest message and pass them to buildSystemPrompt INSTEAD of
    // the full knowledge dump. Failures (no provider, no chunks
    // embedded yet, query empty) return [] and the prompt builder
    // falls back to the legacy full-dump path automatically.
    let retrievedChunks = null;
    if (config.knowledgeRagEnabled === true) {
      const ragQuery = String(body.message || "").trim();
      if (ragQuery) {
        try {
          retrievedChunks = await retrieveRelevantChunks(prisma, {
            shop: session.shop,
            query: ragQuery,
            config,
            limit: 5,
          });
          console.log(`[rag] retrieved ${retrievedChunks?.length || 0} chunk(s) for query="${ragQuery.slice(0, 60)}"`);
        } catch (err) {
          console.error("[rag] retrieval failed, falling back to full dump:", err?.message || err);
          retrievedChunks = null;
        }
      }
    }

    const systemPrompt = buildSystemPrompt({
      config,
      knowledge,
      retrievedChunks,
      shop: session.shop,
      attributeNames,
      categoryExclusions,
      querySynonyms,
      customerContext,
      fitPredictorEnabled: config.fitPredictorEnabled === true,
      catalogProductTypes,
      scopedGender: sessionGender,
      answeredChoices,
      categoryGenderMap,
      activeCampaigns,
    });

    const model = chooseModel(config, String(body.message), history);

    const conversationText = messages.map((m) => typeof m.content === "string" ? m.content : "").join(" ");
    const userText = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "").join(" ");

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const ctx = {
      shop: session.shop,
      deduplicateColors: config.deduplicateColors,
      sessionGender,
      categoryExclusions,
      querySynonyms,
      similarMatchAttributes,
      collectionLinks,
      fitPredictorConfig,
      fitPredictorEnabled: config.fitPredictorEnabled === true,
      conversationText,
      userText,
      yotpoApiKey: config.yotpoApiKey || "",
      aftershipApiKey: config.aftershipApiKey || "",
      supportUrl: body.support_url || config.supportUrl || "",
      supportLabel: body.support_label || config.supportLabel || "",
      accessToken,
      loggedInCustomerId,
      vipModeEnabled: config.vipModeEnabled === true,
      // Showcase layout supports a horizontal scroll-snap row of up to
      // 10 cards. Legacy horizontal layout stays capped at 3 since
      // 4+ stacked cards crowd the chat panel vertically.
      productCardCap: config.productCardStyle === "showcase" ? 10 : 3,
      trackingPageUrl: config.trackingPageUrl || "",
      returnsPageUrl: config.returnsPageUrl || "",
      catalogCategories: catalogProductTypes,
      activeCategoryGroup: categoryIntent.activeGroup,
      contextCategoryGroup: categoryIntent.contextGroup,
      categoryIntentAmbiguous: Boolean(categoryIntent.ambiguous),
      merchantGroups,
      shopConfig: config,
      fullCatalogCategories: allCatalogCategories,
      categoryGenderMap,
      latestUserMessage: String(body.message || ""),
    };
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // CS-team cheat code: if the customer's exact message
          // matches the merchant-configured phrase, skip the AI and
          // emit a deterministic dump of every active campaign.
          //
          // Inner try/catch so any failure here (Prisma, stream
          // controller, formatter) just falls through to the normal
          // AI flow instead of returning the generic "having trouble"
          // error to the customer. The actual error still logs.
          try {
            const cheatCode = String(config.campaignCheatCode || "").trim().toLowerCase();
            const userMessageNorm = String(body?.message || "").trim().toLowerCase();
            if (cheatCode && userMessageNorm === cheatCode) {
              const dump = formatCampaignsForCS(activeCampaigns, new Date());
              controller.enqueue(encoder.encode(sseChunk({ type: "text", text: dump })));
              controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
              controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
              // Don't call controller.close() — the start() callback
              // returning is what the React Router stream wrapper uses
              // as the close signal. Calling close here can race with
              // the wrapper's own teardown.
              return;
            }
          } catch (cheatErr) {
            console.error("[chat] cheat-code path failed, falling back to AI:", cheatErr?.stack || cheatErr?.message || cheatErr);
          }

          const activeTools = [...TOOLS];
          if (loggedInCustomerId && config.vipModeEnabled === true && accessToken) {
            activeTools.push(CUSTOMER_ORDERS_TOOL);
          }
          if (config.fitPredictorEnabled === true) {
            activeTools.push(FIT_PREDICTOR_TOOL);
          }
          const result = await runAgenticLoop({
            anthropic,
            model,
            systemPrompt,
            messages,
            ctx,
            controller,
            encoder,
            promptCaching: config.promptCaching === true,
            tools: activeTools,
          });

          const lastText = result.fullResponseText || "";
          const hasChoiceButtons = /<<[^<>]+>>/.test(lastText);

          if (config.showFollowUps !== false && !hasChoiceButtons) {
            try {
              const catalogLine = catalogProductTypes.length > 0
                ? `\n\nCATALOG ALLOW-LIST: this store sells ONLY these product categories: ${catalogProductTypes.join(", ")}. Any follow-up that names or implies a category MUST use one of these exact categories — it is FORBIDDEN to reference a category not on this list.`
                : "";
              const fuRes = await anthropic.messages.create({
                model: HAIKU_MODEL,
                max_tokens: 150,
                messages: [
                  {
                    role: "user",
                    content: `You are generating follow-up suggestions for "${ctx.shop}", a Shopify store. The store's AI assistant is named "${config.assistantName || "AI Shopping Assistant"}".\n\nCustomer asked: "${String(body.message).slice(0, 200)}"\nAssistant replied: "${lastText.slice(0, 300)}"${catalogLine}\n\nSuggest 2-3 brief follow-up questions the CUSTOMER would naturally ask next.\n\nRULES:\n- Questions MUST be directly relevant to the assistant's response. If the assistant asked the customer a question, suggest answers the customer might give — not unrelated questions.\n- Only reference products, styles, or details the assistant ACTUALLY mentioned. Never ask about things not yet discussed.\n- NEVER invent product categories the store might not carry. Only reference categories or product types that appeared in the conversation above OR appear in the CATALOG ALLOW-LIST above.\n- NEVER mention "brands" — this is a single-brand store.\n- NEVER ask about shoe size, availability, or pricing if no specific product has been shown yet.\n- Write from the customer's perspective.\n- Keep questions short and specific.\n\nReturn ONLY a JSON array of strings, nothing else.`,
                  },
                ],
              });
              const raw = fuRes.content?.[0]?.text || "";
              const match = raw.match(/\[[\s\S]*\]/);
              if (match) {
                const questions = JSON.parse(match[0]).filter((q) => typeof q === "string").slice(0, 3);
                if (questions.length > 0) {
                  controller.enqueue(encoder.encode(sseChunk({ type: "suggestions", questions })));
                }
              }
              addUsage(result.totalUsage, fuRes.usage || {});
            } catch (fuErr) {
              console.error("[chat] follow-up error:", fuErr?.message);
            }
          }

          controller.enqueue(encoder.encode(sseChunk({ type: "done" })));

          const u = result.totalUsage;
          if (u.cache_creation_input_tokens || u.cache_read_input_tokens) {
            console.log(`[cache] created=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens} input=${u.input_tokens}`);
          }

          recordChatUsage({
            shop: session.shop,
            model: result.model,
            usage: result.totalUsage,
            toolCalls: result.toolCallCount,
          }).catch((err) => console.error("[chat] usage log error:", err?.message));
        } catch (err) {
          console.error("[chat] stream error:", err?.message || err);
          let userMsg = "I'm sorry, I'm having trouble right now. Please try again in a moment.";
          const raw = String(err?.message || "");
          if (raw.includes("credit balance") || raw.includes("billing") || raw.includes("insufficient")) {
            userMsg = "I'm temporarily unavailable. Please try again later or reach out to our customer service team for help.";
          } else if (raw.includes("rate limit") || raw.includes("429")) {
            userMsg = "I'm getting a lot of questions right now! Please try again in a moment.";
            incrementRateLimitHits(session.shop).catch(() => {});
          }
          controller.enqueue(
            encoder.encode(sseChunk({ type: "error", message: userMsg })),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    // Server-side log keeps the detail; the storefront only ever sees the
    // friendly message. Leaking e.message to the public widget can expose
    // upstream API errors, internal paths, or library stack hints.
    console.error("[chat] error:", e);
    return Response.json(
      {
        error: "action_failed",
        message: "I'm having trouble right now. Please try again in a moment.",
      },
      { status: 500 },
    );
  }
};
