import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent } from "../models/ShopConfig.server";

const CONFIG_FIELDS_FOR_AI = [
  "assistantName",
  "assistantTagline",
  "greeting",
  "greetingCta",
  "disclaimerText",
];

function pickConfigForAI(config) {
  const out = {};
  for (const k of CONFIG_FIELDS_FOR_AI) {
    if (config[k] !== undefined && config[k] !== null && config[k] !== "") {
      out[k] = config[k];
    }
  }
  return out;
}

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const config = await getShopConfig(session.shop);
    if (!config.anthropicApiKey) {
      return Response.json(
        { error: "Anthropic API key not configured. Set it in the app admin under API Keys." },
        { status: 503 },
      );
    }

    const chatUrl = process.env.CHAT_SERVER_URL;
    const secret = process.env.CHAT_SERVER_INTERNAL_SECRET;
    if (!chatUrl || !secret) {
      return Response.json({ error: "chat server not configured" }, { status: 500 });
    }

    const knowledge = await getKnowledgeFilesWithContent(session.shop);
    const body = await request.json();

    const upstream = await fetch(`${chatUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
        "x-anthropic-api-key": config.anthropicApiKey,
        "x-anthropic-model": config.anthropicModel,
      },
      body: JSON.stringify({
        shop: session.shop,
        message: body.message,
        history: body.history || [],
        config: pickConfigForAI(config),
        knowledge,
      }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return Response.json({ error: `upstream ${upstream.status}`, detail: text }, { status: 502 });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error("[chat.jsx] error:", e);
    return Response.json({ error: "action failed", message: e.message }, { status: 500 });
  }
};
