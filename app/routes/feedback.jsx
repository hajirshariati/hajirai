import { authenticate } from "../shopify.server";
import { recordFeedback } from "../models/ChatFeedback.server";

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    if (!body?.vote || !["up", "down"].includes(body.vote)) {
      return Response.json({ error: "Invalid vote" }, { status: 400 });
    }

    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      request.headers.get("x-real-ip") || "unknown";

    await recordFeedback({
      shop: session.shop,
      sessionId: body.session || "",
      vote: body.vote,
      botResponse: body.botResponse || "",
      products: body.products || [],
      conversation: body.conversation || null,
      ip,
    });

    return Response.json({ ok: true });
  } catch (e) {
    console.error("[feedback] error:", e);
    return Response.json({ error: "Failed to record feedback" }, { status: 500 });
  }
};
