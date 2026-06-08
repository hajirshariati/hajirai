import { authenticate } from "../shopify.server";
import {
  pingViewer,
  countViewers,
  getRecentPurchase,
  gcViewerPings,
} from "../models/SocialProof.server";

// Storefront social-proof popup data, served through the Shopify app proxy at
// /apps/hajirai/social-proof. authenticate.public.appProxy verifies the proxy
// HMAC, so unsigned/forged requests never reach the DB. Returns ONLY a viewer
// count and a city — no customer names or emails. On any error we return an
// empty (zero/null) payload so the storefront popup simply hides itself rather
// than surfacing an error.

function payload(viewers, purchase) {
  return {
    viewers: viewers || 0,
    purchase:
      purchase && purchase.city
        ? { city: purchase.city, purchasedAt: purchase.createdAt }
        : null,
  };
}

// GET — read-only (does not register the caller as a viewer).
export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const productId = new URL(request.url).searchParams.get("productId");
    if (!productId) return Response.json({ viewers: 0, purchase: null });

    const [viewers, purchase] = await Promise.all([
      countViewers({ shop: session.shop, productId }),
      getRecentPurchase({ shop: session.shop, productId }),
    ]);
    return Response.json(payload(viewers, purchase), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ viewers: 0, purchase: null });
  }
};

// POST — register/refresh this session, then return the live numbers.
export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let body = {};
    try {
      body = await request.json();
    } catch {
      /* tolerate empty/non-JSON body */
    }

    const productId = String(body.productId || "");
    const sessionId = String(body.sessionId || "");
    if (!productId || !sessionId) return Response.json({ viewers: 0, purchase: null });

    await pingViewer({ shop: session.shop, productId, sessionId });
    if (Math.random() < 0.1) gcViewerPings(); // ~10% of pings sweep stale rows

    const [viewers, purchase] = await Promise.all([
      countViewers({ shop: session.shop, productId }),
      getRecentPurchase({ shop: session.shop, productId }),
    ]);
    return Response.json(payload(viewers, purchase), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[social-proof] error:", e?.message || e);
    return Response.json({ viewers: 0, purchase: null });
  }
};
