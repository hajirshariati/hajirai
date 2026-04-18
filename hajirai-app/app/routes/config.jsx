import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

/**
 * App Proxy endpoint: returns admin-only config for the storefront widget.
 * Visual config (colors, greeting, CTAs, images) lives in theme editor,
 * so the widget reads those from window.__AI_CHAT_CONFIG (liquid-injected).
 * This endpoint only returns values that must come from admin — currently
 * the chat server URL and future per-shop feature flags.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const c = await getShopConfig(session.shop);

  return Response.json(
    {
      apiUrl: c.chatServerUrl,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=30",
        "Content-Type": "application/json",
      },
    },
  );
};
