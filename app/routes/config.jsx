import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

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
