import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ hideOnUrls: [] });

    const config = await getShopConfig(session.shop);
    let hideOnUrls = [];
    try { hideOnUrls = JSON.parse(config.hideOnUrls || "[]"); } catch { /* */ }

    return Response.json({
      hideOnUrls,
      klaviyoFormId: config.klaviyoFormId || "",
      klaviyoCompanyId: config.klaviyoCompanyId || "",
      klaviyoListId: config.klaviyoListId || "",
      vipModeEnabled: config.vipModeEnabled === true,
      showLoginPill: config.showLoginPill !== false,
    }, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch {
    return Response.json({ hideOnUrls: [] });
  }
};
