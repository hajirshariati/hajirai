import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { TOOLS, executeTool } from "../lib/chat-tools.server";
import { recordChatUsage } from "../models/ChatUsage.server";
import { canSendMessage } from "../lib/billing.server";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-20250514";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const OPUS_MODEL = "claude-opus-4-20250514";
const MAX_TOKENS = parseInt(process.env.CHAT_MAX_TOKENS, 10) || 1024;
const MAX_TOOL_HOPS = parseInt(process.env.CHAT_MAX_TOOL_HOPS, 10) || 5;

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

function chooseModel(config, message, history) {
  const strategy = config.modelStrategy || "smart";
  const sonnet = config.anthropicModel || DEFAULT_MODEL;

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

async function runAgenticLoop({ anthropic, model, systemPrompt, messages, ctx, controller, encoder }) {
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let toolCallCount = 0;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const stream = anthropic.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        controller.enqueue(encoder.encode(sseChunk({ type: "text", text: event.delta.text })));
      }
    }

    const final = await stream.finalMessage();
    addUsage(totalUsage, final.usage || {});

    if (final.stop_reason !== "tool_use") {
      return { totalUsage, toolCallCount, model };
    }

    const toolUses = final.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return { totalUsage, toolCallCount, model };

    toolCallCount += toolUses.length;

    const results = await Promise.all(
      toolUses.map((u) => executeTool(u.name, u.input, ctx)),
    );

    messages.push({ role: "assistant", content: final.content });
    messages.push({
      role: "user",
      content: toolUses.map((u, i) => ({
        type: "tool_result",
        tool_use_id: u.id,
        content: JSON.stringify(results[i] ?? {}),
      })),
    });
  }

  const wrap = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    tools: TOOLS,
    tool_choice: { type: "none" },
    messages,
  });
  addUsage(totalUsage, wrap.usage || {});

  for (const block of wrap.content) {
    if (block.type === "text" && block.text) {
      controller.enqueue(encoder.encode(sseChunk({ type: "text", text: block.text })));
    }
  }

  return { totalUsage, toolCallCount, model };
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
    const systemPrompt = buildSystemPrompt({ config, knowledge, shop: session.shop, attributeNames });

    const history = sanitizeHistory(body.history);
    const model = chooseModel(config, String(body.message), history);

    const messages = [...history];
    messages.push({ role: "user", content: String(body.message) });

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const ctx = { shop: session.shop };
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const result = await runAgenticLoop({
            anthropic,
            model,
            systemPrompt,
            messages,
            ctx,
            controller,
            encoder,
          });

          if (config.showFollowUps !== false) {
            try {
              const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
              const lastText = typeof lastAssistant?.content === "string"
                ? lastAssistant.content
                : Array.isArray(lastAssistant?.content)
                  ? lastAssistant.content.filter((b) => b.type === "text").map((b) => b.text).join("")
                  : "";
              const fuRes = await anthropic.messages.create({
                model: HAIKU_MODEL,
                max_tokens: 150,
                messages: [
                  {
                    role: "user",
                    content: `Customer asked: "${String(body.message).slice(0, 200)}"\nAssistant replied: "${lastText.slice(0, 300)}"\n\nSuggest 2-3 brief follow-up questions the customer might ask next. Only suggest questions that can be answered from a product catalog or store knowledge base. Return ONLY a JSON array of strings, nothing else.`,
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

          recordChatUsage({
            shop: session.shop,
            model: result.model,
            usage: result.totalUsage,
            toolCalls: result.toolCallCount,
          }).catch((err) => console.error("[chat] usage log error:", err?.message));
        } catch (err) {
          console.error("[chat] stream error:", err?.message || err);
          controller.enqueue(
            encoder.encode(sseChunk({ type: "error", message: err?.message || "upstream error" })),
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
