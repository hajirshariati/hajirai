import { authenticate } from "../shopify.server";
import { upsertProductFromWebhook } from "../models/Product.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  try {
    await upsertProductFromWebhook(shop, payload);
  } catch (err) {
    console.error(`[webhook ${topic}] upsert failed:`, err?.message || err);
  }
  return new Response();
};
