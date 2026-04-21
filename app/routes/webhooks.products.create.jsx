import { authenticate } from "../shopify.server";
import { upsertProductFromWebhook } from "../models/Product.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const syncState = await prisma.catalogSyncState.findUnique({ where: { shop } });
  if (syncState?.status === "running") {
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);
  try {
    await upsertProductFromWebhook(shop, payload);
  } catch (err) {
    console.error(`[webhook ${topic}] upsert failed:`, err?.message || err);
  }
  return new Response();
};
