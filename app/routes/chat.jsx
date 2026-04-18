import { authenticate } from "../shopify.server";

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  console.log("[chat.jsx] action entered");
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      console.log("[chat.jsx] no session");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.log("[chat.jsx] authenticated for shop:", session.shop);

    const chatUrl = process.env.CHAT_SERVER_URL;
    const secret = process.env.CHAT_SERVER_INTERNAL_SECRET;
    console.log("[chat.jsx] chatUrl:", chatUrl, "secret set:", !!secret);
    if (!chatUrl || !secret) {
      return Response.json({ error: "chat server not configured" }, { status: 500 });
    }

    const body = await request.json();
    console.log("[chat.jsx] body keys:", Object.keys(body));

    const upstream = await fetch(`${chatUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ ...body, shop: session.shop }),
    });
    console.log("[chat.jsx] upstream status:", upstream.status);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.log("[chat.jsx] upstream error body:", text);
      return Response.json(
        { error: `upstream ${upstream.status}`, detail: text },
        { status: 502 },
      );
    }

    // Buffer the full response instead of streaming (Vite dev can't pipe raw ReadableStream reliably)
    const text = await upstream.text();
    console.log("[chat.jsx] upstream text length:", text.length);

    return new Response(text, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    console.error("[chat.jsx] caught error:", e);
    return Response.json({ error: "action failed", message: e.message, stack: e.stack }, { status: 500 });
  }
};
