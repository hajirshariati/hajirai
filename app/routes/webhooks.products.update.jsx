import { authenticate } from "../shopify.server";
import { upsertProductFromWebhook } from "../models/Product.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { embedSingleProductInBackground } from "../lib/embeddings.server";
import prisma from "../db.server";

// In-memory dedup window. Shopify fires PRODUCTS_UPDATE for many small
// changes (inventory adjustments, metafield tweaks, variant edits) that
// don't change anything we care about for chat. With 800+ products this
// becomes a webhook storm — every burst opens a Postgres connection and
// has caused FATAL "too many clients already" errors during deploys.
//
// Coalesce repeat webhooks for the same product within 30s to a single
// processing pass. The ack still happens immediately so Shopify sees a
// 200 and doesn't retry. Acceptable trade-off: a real change might be
// up to 30s stale until the next non-deduped webhook comes through —
// fine for chat (RAG / search) which doesn't need second-by-second
// freshness.
//
// In-memory only — survives a single container restart loses dedup
// state (first 30s after restart processes everything). Multi-instance
// deployments would each have their own map. Both fine for this app.
const RECENT_WEBHOOKS = new Map(); // key=`${shop}:${productId}` → ms
const DEDUP_WINDOW_MS = 30_000;
const MAX_ENTRIES = 5000;

function shouldDedupe(shop, productId) {
  const key = `${shop}:${productId}`;
  const now = Date.now();
  const last = RECENT_WEBHOOKS.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  RECENT_WEBHOOKS.set(key, now);
  // Opportunistic cleanup so the map doesn't grow forever in a long-
  // running process. Triggered only when we cross the soft cap, so
  // hot path stays cheap.
  if (RECENT_WEBHOOKS.size > MAX_ENTRIES) {
    const cutoff = now - DEDUP_WINDOW_MS;
    for (const [k, t] of RECENT_WEBHOOKS) {
      if (t < cutoff) RECENT_WEBHOOKS.delete(k);
    }
  }
  return false;
}

export const action = async ({ request }) => {
  const { shop, payload, topic, admin } = await authenticate.webhook(request);

  const syncState = await prisma.catalogSyncState.findUnique({ where: { shop } });
  if (syncState?.status === "running") {
    return new Response();
  }

  const productId = payload?.id;
  if (productId && shouldDedupe(shop, productId)) {
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);
  try {
    const product = await upsertProductFromWebhook(shop, payload, admin);
    // Re-embed in background if semantic search is configured for this shop.
    if (product?.id) {
      const config = await getShopConfig(shop).catch(() => null);
      if (config) embedSingleProductInBackground(prisma, shop, product.id, config);
    }
  } catch (err) {
    console.error(`[webhook ${topic}] upsert failed:`, err?.message || err);
  }
  return new Response();
};
