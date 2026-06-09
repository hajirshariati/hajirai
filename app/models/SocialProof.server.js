import prisma from "../db.server";

const VIEWER_WINDOW_MS = 60 * 1000; // "viewing now" = pinged in the last 60s
const PING_TTL_MS = 5 * 60 * 1000; // opportunistic GC of stale pings
const PURCHASE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // hard cap; client narrows further

// Register/refresh this anonymous session as currently viewing the product.
export async function pingViewer({ shop, productId, sessionId }) {
  if (!shop || !productId || !sessionId) return;
  try {
    await prisma.productViewerPing.upsert({
      where: { shop_productId_sessionId: { shop, productId, sessionId } },
      update: { lastSeen: new Date() },
      create: { shop, productId, sessionId },
    });
  } catch (err) {
    console.error("[SocialProof] ping error:", err?.message);
  }
}

// Real count of distinct sessions currently on this product.
export async function countViewers({ shop, productId }) {
  const since = new Date(Date.now() - VIEWER_WINDOW_MS);
  try {
    return await prisma.productViewerPing.count({
      where: { shop, productId, lastSeen: { gte: since } },
    });
  } catch {
    return 0;
  }
}

// Most recent real purchase of this product. Returns the timestamp only —
// no city, no name, no customer identifier — so the storefront can show a
// privacy-safe "Someone just bought this".
export async function getRecentPurchase({ shop, productId }) {
  const since = new Date(Date.now() - PURCHASE_LOOKBACK_MS);
  try {
    return await prisma.recentPurchase.findFirst({
      where: { shop, productId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
  } catch {
    return null;
  }
}

// Keep the ping table small. Called opportunistically from the action.
export async function gcViewerPings() {
  const cutoff = new Date(Date.now() - PING_TTL_MS);
  try {
    await prisma.productViewerPing.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  } catch {
    /* best effort */
  }
}

// Record one row per distinct purchased product. Stores only the product +
// timestamp — NO city, name, email, or any address — just enough to show
// "Someone just bought this". Idempotent on (shop, orderId, productId).
export async function recordRecentPurchases({ shop, orderId, lineItems }) {
  if (!shop || !orderId || !Array.isArray(lineItems)) return;
  const seen = new Set();
  for (const li of lineItems) {
    const productId = li?.product_id ? String(li.product_id) : null;
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    try {
      await prisma.recentPurchase.upsert({
        where: { shop_orderId_productId: { shop, orderId: String(orderId), productId } },
        update: {},
        create: {
          shop,
          orderId: String(orderId),
          productId,
          productTitle: li?.title ? String(li.title).slice(0, 140) : null,
        },
      });
    } catch (err) {
      console.error("[SocialProof] purchase record error:", err?.message);
    }
  }
}
