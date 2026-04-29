import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent, incrementRateLimitHits } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { getCatalogCategories, getAllCatalogCategories } from "../models/Product.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { filterForbiddenCategoryChips } from "../lib/chip-filter.server";
import { sanitizeCtaLabel } from "../lib/cta-label.server";
import { TOOLS, executeTool, extractProductCards, CUSTOMER_ORDERS_TOOL, FIT_PREDICTOR_TOOL } from "../lib/chat-tools.server";
import { fetchCustomerContext } from "../lib/customer-context.server";
import { fetchKlaviyoEnrichment } from "../lib/klaviyo-enrichment.server";
import { fetchYotpoLoyalty } from "../lib/yotpo-loyalty.server";
import prisma from "../db.server";
import { recordChatUsage, getTodayMessageCount } from "../models/ChatUsage.server";
import { canSendMessage } from "../lib/billing.server";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-6";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const OPUS_MODEL = "claude-opus-4-7";
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

const MALE_PATTERN = /\b(men['‘’]?s|mens|men|male|males|guy|guys|dude|dudes|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|man|boy|boys)\b/i;
const FEMALE_PATTERN = /\b(women['‘’]?s|womens|women|female|females|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|woman|girl|girls)\b/i;

function detectGenderFromHistory(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = typeof messages[i].content === "string" ? messages[i].content : "";
    if (messages[i].role === "user") {
      if (MALE_PATTERN.test(text)) return "men";
      if (FEMALE_PATTERN.test(text)) return "women";
    }
    if (messages[i].role === "assistant") {
      if (/\bmen['‘’]?s\b/i.test(text) && !/\bwomen['‘’]?s\b/i.test(text)) return "men";
      if (/\bwomen['‘’]?s\b/i.test(text) && !/\bmen['‘’]?s\b/i.test(text)) return "women";
    }
  }
  return null;
}

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
      const userText = ctx.conversationText || "";
      const aiText = fullResponseText || "";
      const userAskedSupport = /\b(contact|reach|talk to|speak (to|with)|get (a )?hold of|how do i .{0,20}(contact|reach))\b.{0,40}\b(customer|support|service|care|team|human|agent|representative|rep|person|someone)\b/i.test(userText)
        || /\b(customer (service|care|support)|support (hub|team)|return policy|refund|exchange|my order|order status|shipping issue|problem with my)\b/i.test(userText);
      const aiMentionsSupport = /\b(our (team|support|customer service|customer care)|support team|customer service|customer care|reach out|contact us|get in touch|happy to help)\b/i.test(aiText);
      if (userAskedSupport || aiMentionsSupport) {
        const defaultOldLabel = "Contact customer service";
        const label = ctx.supportLabel && ctx.supportLabel.trim() && ctx.supportLabel.trim() !== defaultOldLabel
          ? ctx.supportLabel.trim()
          : "Visit Support Hub";
        supportCTA = { url: ctx.supportUrl, label };
      }
    }
  }

  const pool = Array.from(allProductPool.values());

  // If the AI tried a product search, got nothing back, but still wrote a
  // pitch-sounding response, clear the text so the fallback below kicks in.
  // Prevents "Here are some options!" showing above an empty card area.
  if (productSearchAttempted && pool.length === 0 && fullResponseText) {
    const looksLikePitch = /\b(here are|check out|check these|some great|great options|top picks|picks for you|styles for you|perfect (for|match)|gorgeous)\b/i.test(fullResponseText);
    if (looksLikePitch) {
      console.log(`[chat] empty-pool repair: replacing positive pitch with fallback`);
      fullResponseText = "";
    }
  }

  if (!fullResponseText && pool.length === 0) {
    fullResponseText = "I'm not finding a great match for that right now. Want to try a different style, or I can connect you with our support team?";
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
  }


const collection = extractCollectionCTA(fullResponseText);
fullResponseText = collection.text;

console.log(`[chat] emit textLen=${fullResponseText.length} poolSize=${pool.length} searchAttempted=${productSearchAttempted}`);

controller.enqueue(encoder.encode(sseChunk({
  type: "text",
  text: fullResponseText
})));


if (supportCTA) {
  controller.enqueue(encoder.encode(sseChunk({
    type: "link",
    url: supportCTA.url,
    label: supportCTA.label
  })));
}

  if (!supportCTA && fullResponseText) {
  const generic = extractGenericCTA(fullResponseText);
  fullResponseText = generic.text;

  if (generic.cta) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: generic.cta.url,
      label: generic.cta.label,
    })));
  }
}

  const userAskedSignup = /\b(sign ?up for (our|the|your|a).{0,25}(newsletter|list|email|sms|updates|deals|offers)|subscribe to (our|the|your).{0,20}(newsletter|list|email|sms|updates)|newsletter|mailing list|join our (list|newsletter|email|sms)|opt.?in|stay (connected|in touch|updated).{0,20}(email|offers|updates|news|deals))\b/i.test(ctx.userText || "");
  const aiMentionsSignup = /\b(newsletter|mailing list|subscribe to (our|the|your).{0,20}(newsletter|list|sms|email)|sign ?up for (our|the|my|your).{0,25}(newsletter|list|email|sms|updates|deals|offers)|join our (newsletter|list|email|sms)|stay connected.{0,20}(email|offers|updates|deals))\b/i.test(fullResponseText || "");
  if (userAskedSignup || aiMentionsSignup) {
    controller.enqueue(encoder.encode(sseChunk({ type: "klaviyo_form" })));
  }

  if (pool.length > 0 && fullResponseText) {
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

    let cards;
    if (matched.length > 0) {
      cards = matched.slice(0, 3).map((s) => s.card);
    } else if (!saysNoMatch) {
      cards = dropSiblingCards(scored, textLower).slice(0, 3).map((s) => s.card);
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
} else if (Array.isArray(ctx.collectionLinks) && ctx.collectionLinks.length > 0 && categoryCounts.size > 0) {
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

  return { totalUsage, toolCallCount, model, fullResponseText };
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

    let [knowledge, attrMappings, catalogProductTypes, allCatalogCategories] = await Promise.all([
      getKnowledgeFilesWithContent(session.shop),
      getAttributeMappings(session.shop),
      getCatalogCategories(session.shop, { gender: sessionGender }),
      getAllCatalogCategories(session.shop),
    ]);

    // Merchant-configured category groups: when the customer's latest message
    // contains a trigger word from exactly ONE group, narrow the catalog
    // allow-list passed to the prompt to that group's categories only. This
    // is fully data-driven — no hardcoded vocabulary anywhere.
    //
    // - Zero groups configured: no filter applied (full allow-list goes
    //   through). Configure groups in Rules & Knowledge to enable.
    // - Multiple groups match (e.g. "orthotic shoes" hits both Footwear and
    //   Orthotics): no filter applied — the AI sees the full allow-list
    //   and resolves the ambiguity itself. Safer than picking wrong.
    let merchantGroups = [];
    try { merchantGroups = JSON.parse(config.categoryGroups || "[]"); } catch { /* */ }

    const latestMessage = String(body.message || "");
    const messageLower = latestMessage.toLowerCase();
    let groupFilterApplied = "";

    if (Array.isArray(merchantGroups) && merchantGroups.length > 0) {
      const triggerMatches = (msg, triggers) => {
        if (!Array.isArray(triggers) || triggers.length === 0) return false;
        for (const t of triggers) {
          const phrase = String(t || "").trim();
          if (!phrase) continue;
          const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const withS = /s$/.test(phrase)
            ? `(?:${escaped}|${escaped.slice(0, -1)})`
            : `${escaped}(?:s|es)?`;
          if (new RegExp(`\\b${withS}\\b`, "i").test(msg)) return true;
        }
        return false;
      };
      const matched = merchantGroups.filter((g) => triggerMatches(messageLower, g?.triggers || []));
      if (matched.length === 1) {
        const g = matched[0];
        const allowed = new Set((g.categories || []).map((c) => String(c).toLowerCase()));
        const filtered = catalogProductTypes.filter((c) => allowed.has(String(c).toLowerCase()));
        if (filtered.length >= 1) {
          catalogProductTypes = filtered;
          groupFilterApplied = g.name;
        }
      }
    }

    console.log(`[chat] ${session.shop} gender=${sessionGender || "any"} scoped-categories=${catalogProductTypes.length} full-catalog-categories=${allCatalogCategories.length}${groupFilterApplied ? ` group=${groupFilterApplied}` : ""}`);
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

    const systemPrompt = buildSystemPrompt({
      config,
      knowledge,
      shop: session.shop,
      attributeNames,
      categoryExclusions,
      querySynonyms,
      customerContext,
      fitPredictorEnabled: config.fitPredictorEnabled === true,
      catalogProductTypes,
      scopedGender: sessionGender,
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
      trackingPageUrl: config.trackingPageUrl || "",
      returnsPageUrl: config.returnsPageUrl || "",
      catalogCategories: catalogProductTypes,
      shopConfig: config,
      fullCatalogCategories: allCatalogCategories,
      latestUserMessage: String(body.message || ""),
    };
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
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
