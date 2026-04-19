import { authenticate } from "../shopify.server";
import { deleteProductByShopifyId } from "../models/Product.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  try {
    const shopifyId = payload?.admin_graphql_api_id || payload?.id;
    if (shopifyId) await deleteProductByShopifyId(shop, shopifyId);
  } catch (err) {
    console.error(`[webhook ${topic}] delete failed:`, err?.message || err);
  }
  return new Response();
};
