import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

// Storefront chat widget reads runtime config from this endpoint via the
// Shopify app proxy. authenticate.public.appProxy verifies the proxy HMAC,
// so unsigned or forged requests never reach the DB. We deliberately return
// 401 (not a fallback config object) on auth failure so a misconfigured
// proxy is loud rather than silently serving merchant settings.
export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = await getShopConfig(session.shop);
    let hideOnUrls = [];
    try {
      hideOnUrls = JSON.parse(config.hideOnUrls || "[]");
    } catch {
      /* malformed json — fall through with empty array */
    }

    return Response.json(
      {
        hideOnUrls,
        klaviyoFormId: config.klaviyoFormId || "",
        klaviyoCompanyId: config.klaviyoCompanyId || "",
        klaviyoListId: config.klaviyoListId || "",
        vipModeEnabled: config.vipModeEnabled === true,
        showLoginPill: config.showLoginPill !== false,
      },
      {
        // 60s keeps the storefront responsive without making merchant config
        // toggles wait 5 minutes to propagate.
        headers: { "Cache-Control": "public, max-age=60" },
      },
    );
  } catch (err) {
    console.error("[widget-config] error:", err?.message || err);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
};
