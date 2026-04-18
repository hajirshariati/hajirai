import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

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

    const body = await request.json();
    const upstream = await fetch(`${chatUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
        "x-anthropic-api-key": config.anthropicApiKey,
        "x-anthropic-model": config.anthropicModel,
      },
      body: JSON.stringify({ ...body, shop: session.shop }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return Response.json({ error: `upstream ${upstream.status}`, detail: text }, { status: 502 });
    }

    const text = await upstream.text();
    return new Response(text, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    console.error("[chat.jsx] error:", e);
    return Response.json({ error: "action failed", message: e.message }, { status: 500 });
  }
};
