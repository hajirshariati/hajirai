import { authenticate } from "../shopify.server";
import { upsertProductFromWebhook } from "../models/Product.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { embedSingleProductInBackground } from "../lib/embeddings.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const syncState = await prisma.catalogSyncState.findUnique({ where: { shop } });
  if (syncState?.status === "running") {
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);
  try {
    const product = await upsertProductFromWebhook(shop, payload);
    if (product?.id) {
      const config = await getShopConfig(shop).catch(() => null);
      if (config) embedSingleProductInBackground(prisma, shop, product.id, config);
    }
  } catch (err) {
    console.error(`[webhook ${topic}] upsert failed:`, err?.message || err);
  }
  return new Response();
};
