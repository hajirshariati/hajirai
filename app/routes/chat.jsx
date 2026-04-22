import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent, incrementRateLimitHits } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { TOOLS, executeTool, extractProductCards, CUSTOMER_ORDERS_TOOL } from "../lib/chat-tools.server";
import { fetchCustomerContext } from "../lib/customer-context.server";
import { fetchKlaviyoEnrichment } from "../lib/klaviyo-enrichment.server";
import { fetchYotpoLoyalty } from "../lib/yotpo-loyalty.server";
import prisma from "../db.server";
import { recordChatUsage } from "../models/ChatUsage.server";
import { canSendMessage } from "../lib/billing.server";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-6";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const OPUS_MODEL = "claude-opus-4-20250514";
const MAX_TOKENS = parseInt(process.env.CHAT_MAX_TOKENS, 10) || 1024;
const MAX_TOOL_HOPS = parseInt(process.env.CHAT_MAX_TOOL_HOPS, 10) || 3;

const DEPRECATED_MODELS = new Set(["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620"]);

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

const MALE_PATTERN = /\b(men[''']?s|mens|male|guy|dude|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|man)\b/i;
const FEMALE_PATTERN = /\b(women[''']?s|womens|female|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|woman)\b/i;

function detectGenderFromHistory(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = typeof messages[i].content === "string" ? messages[i].content : "";
    if (messages[i].role === "user") {
      if (MALE_PATTERN.test(text)) return "men";
      if (FEMALE_PATTERN.test(text)) return "women";
    }
    if (messages[i].role === "assistant") {
      if (/\bmen[''']?s\b/i.test(text) && !/\bwomen[''']?s\b/i.test(text)) return "men";
      if (/\bwomen[''']?s\b/i.test(text) && !/\bmen[''']?s\b/i.test(text)) return "women";
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

async function runAgenticLoop({ anthropic, model, systemPrompt, messages, ctx, controller, encoder, promptCaching, tools }) {
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let toolCallCount = 0;
  const allProductPool = new Map();
  let fullResponseText = "";

  const system = promptCaching
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const activeTools = tools || TOOLS;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
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

    const results = await Promise.all(
      toolUses.map((u) => executeTool(u.name, u.input, ctx)),
    );

    let hopHasProducts = false;
    for (let i = 0; i < toolUses.length; i++) {
      const cards = extractProductCards(toolUses[i].name, results[i]);
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
        if (hopHasProducts && (u.name === "search_products" || u.name === "get_product_details" || u.name === "lookup_sku")) {
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

  if (!fullResponseText && pool.length === 0) {
    fullResponseText = "I'm not finding a great match for that right now. Want to try a different style, or I can connect you with our support team?";
  }

  if (fullResponseText) {
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text: fullResponseText })));
  }

  if (supportCTA) {
    controller.enqueue(encoder.encode(sseChunk({ type: "link", url: supportCTA.url, label: supportCTA.label })));
  }

  const userAskedSignup = /\b(sign ?up|subscribe|newsletter|email list|mailing list|sms|text (me|updates|alerts)|join.{0,15}(list|email|sms)|opt.?in|stay.{0,10}(connected|touch|updated))\b/i.test(ctx.userText || "");
  const aiMentionsSignup = /\b(sign ?up|subscribe|newsletter|email|sms|mailing list|stay.{0,10}(connected|touch|updated))\b/i.test(fullResponseText || "");
  if (userAskedSignup || aiMentionsSignup) {
    controller.enqueue(encoder.encode(sseChunk({ type: "klaviyo_form" })));
  }

  if (pool.length > 0 && fullResponseText) {
    const textLower = fullResponseText.toLowerCase();
    const saysNoMatch = /\b(don't (?:have|see|carry)|not (?:see|carry|have)|don't appear|we don't|no .{0,20} available)\b/i.test(fullResponseText);

    const userTextLower = (ctx.userText || "").toLowerCase();
    const scored = pool.map((card) => ({
      card,
      score: scoreCardAgainstText(card, textLower, userTextLower),
    }));
    scored.sort((a, b) => b.score - a.score);

    const matched = scored.filter((s) => s.score >= 0.4);

    let cards;
    if (matched.length > 0) {
      cards = matched.slice(0, 3).map((s) => s.card);
    } else if (!saysNoMatch) {
      cards = scored.slice(0, 3).map((s) => s.card);
    }

    if (cards && cards.length > 0) {
      const seen = new Set();
      const deduped = [];
      for (const c of cards) {
        const key = c.handle || c.title;
        if (seen.has(key)) continue;
        seen.add(key);
        const { _descriptionSnippet, _searchQuery, ...publicCard } = c;
        deduped.push(publicCard);
      }
      controller.enqueue(encoder.encode(sseChunk({ type: "products", products: deduped })));
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
          message: `This store reached its ${quota.limit.toLocaleString()} conversations for the month. Upgrade the plan in the ShopAgent admin to keep helping customers.`,
          plan: quota.plan.id,
          used: quota.used,
          limit: quota.limit,
        },
        { status: 402 },
      );
    }

    const body = await request.json();
    if (!body?.message) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const [knowledge, attrMappings] = await Promise.all([
      getKnowledgeFilesWithContent(session.shop),
      getAttributeMappings(session.shop),
    ]);
    const attributeNames = attrMappings.map((m) => m.attribute);

    let categoryExclusions = [];
    try { categoryExclusions = JSON.parse(config.categoryExclusions || "[]"); } catch { /* */ }
    let querySynonyms = [];
    try { querySynonyms = JSON.parse(config.querySynonyms || "[]"); } catch { /* */ }

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
    });

    const history = sanitizeHistory(body.history);
    const model = chooseModel(config, String(body.message), history);

    const messages = [...history];
    messages.push({ role: "user", content: String(body.message) });

    const sessionGender = detectGenderFromHistory(messages);
    const conversationText = messages.map((m) => typeof m.content === "string" ? m.content : "").join(" ");
    const userText = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "").join(" ");

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const ctx = {
      shop: session.shop,
      deduplicateColors: config.deduplicateColors,
      sessionGender,
      categoryExclusions,
      querySynonyms,
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
    };
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const activeTools = [...TOOLS];
          if (loggedInCustomerId && config.vipModeEnabled === true && accessToken) {
            activeTools.push(CUSTOMER_ORDERS_TOOL);
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
              const fuRes = await anthropic.messages.create({
                model: HAIKU_MODEL,
                max_tokens: 150,
                messages: [
                  {
                    role: "user",
                    content: `You are generating follow-up suggestions for "${ctx.shop}", a Shopify store. The store's AI assistant is named "${config.assistantName || "AI Shopping Assistant"}".\n\nCustomer asked: "${String(body.message).slice(0, 200)}"\nAssistant replied: "${lastText.slice(0, 300)}"\n\nSuggest 2-3 brief follow-up questions the CUSTOMER would naturally ask next.\n\nRULES:\n- Questions MUST be directly relevant to the assistant's response. If the assistant asked the customer a question, suggest answers the customer might give — not unrelated questions.\n- Only reference products, styles, or details the assistant ACTUALLY mentioned. Never ask about things not yet discussed.\n- NEVER invent product categories the store might not carry. Only reference categories or product types that appeared in the conversation above.\n- NEVER mention "brands" — this is a single-brand store.\n- NEVER ask about shoe size, availability, or pricing if no specific product has been shown yet.\n- Write from the customer's perspective.\n- Keep questions short and specific.\n\nReturn ONLY a JSON array of strings, nothing else.`,
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
    console.error("[chat] error:", e);
    return Response.json({ error: "action failed", message: e.message }, { status: 500 });
  }
};
