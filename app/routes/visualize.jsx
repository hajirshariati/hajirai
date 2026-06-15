// App-proxy endpoint for "Visualize My Look" — generates an AI styling
// preview of a single recommended product, styled for what the customer
// described. Reached at /apps/hajirai/visualize (HMAC-verified proxy).
//
// The widget already knows the product (it received the visualize_cta
// event), but we re-resolve the product image SERVER-SIDE from the
// synced catalog by handle so the reference image can't be tampered
// with by the client. Style context (the customer's described look) is
// passed from the conversation.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { generateStyledImage, isImageProviderSupported } from "../lib/image-styling.server";
import { recordImageUsage } from "../models/ChatUsage.server";

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const shop = session.shop;

    const config = await getShopConfig(shop);
    if (!config?.visualizeLookEnabled) {
      return Response.json({ ok: false, message: "Feature not enabled." }, { status: 403 });
    }
    const provider = String(config.imageProvider || "").trim();
    if (!isImageProviderSupported(provider)) {
      return Response.json({ ok: false, message: "Image provider not configured." }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const handle = String(body?.productHandle || "").trim();
    const styleContext = String(body?.styleContext || "").slice(0, 600);
    if (!handle) {
      return Response.json({ ok: false, message: "Missing product." }, { status: 400 });
    }

    // Resolve the product image from the catalog (authoritative, not the
    // client). Scoped to this shop.
    const product = await prisma.product.findFirst({
      where: { shop, handle },
      select: { title: true, featuredImageUrl: true },
    });
    if (!product?.featuredImageUrl) {
      return Response.json(
        { ok: false, message: "We couldn't find an image for that product to style." },
        { status: 404 },
      );
    }

    let result;
    try {
      result = await generateStyledImage({
        provider,
        geminiApiKey: config.geminiApiKey || "",
        openaiApiKey: config.openaiApiKey || "",
        productImageUrl: product.featuredImageUrl,
        productTitle: product.title || "",
        styleContext,
      });
    } catch (err) {
      console.error(`[visualize] ${shop} generation failed (${provider}):`, err?.message || err);
      return Response.json(
        { ok: false, message: "The styling preview couldn't be generated right now. Please try again." },
        { status: 502 },
      );
    }

    // Meter the image cost (merchant pays the provider directly).
    recordImageUsage({ shop, provider: result.provider, costUsd: result.costUsd }).catch((e) =>
      console.error("[visualize] usage record failed:", e?.message || e),
    );

    return Response.json({ ok: true, imageDataUrl: result.imageDataUrl });
  } catch (e) {
    console.error("[visualize] error:", e?.message || e);
    return Response.json({ ok: false, message: "Something went wrong." }, { status: 500 });
  }
};
