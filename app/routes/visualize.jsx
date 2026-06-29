// App-proxy endpoint for "Visualize My Look" — generates an AI styling
// preview of a single recommended product, styled for what the customer
// described. Reached at /apps/hajirai/visualize (HMAC-verified proxy).
//
// The widget already knows the product (it received the visualize_cta
// event), but we re-resolve the product image SERVER-SIDE from the
// synced catalog by handle so the reference image can't be tampered
// with by the client. Style context (the customer's described look) is
// passed from the conversation.

import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { generateStyledImage, isImageProviderSupported } from "../lib/image-styling.server";
import { getProductImageUrls } from "../models/Product.server";
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
    let provider = String(config.imageProvider || "").trim();
    if (!isImageProviderSupported(provider)) {
      return Response.json({ ok: false, message: "Image provider not configured." }, { status: 400 });
    }
    // Prefer Gemini ("Nano Banana") when a key is available: it returns a
    // subject-preserving styled image in ~5-15s, whereas OpenAI gpt-image-1
    // routinely runs 40-60s and times out behind the app proxy (prod trace
    // 2026-06-24). Only override when we actually have a Gemini key; gate
    // off with VISUALIZE_PREFER_GEMINI=false to honor the merchant's pick.
    if (
      provider === "openai" &&
      String(config.geminiApiKey || "").trim() &&
      process.env.VISUALIZE_PREFER_GEMINI !== "false"
    ) {
      console.log(`[visualize] ${shop} preferring gemini over openai (faster; gemini key present)`);
      provider = "gemini";
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
      select: { title: true, featuredImageUrl: true, shopifyId: true },
    });
    if (!product?.featuredImageUrl) {
      return Response.json(
        { ok: false, message: "We couldn't find an image for that product to style." },
        { status: 404 },
      );
    }

    // Pull the product's full media gallery (multiple angles) so the image
    // model can reproduce the product faithfully instead of inventing the
    // sides a single featured photo never shows. Best-effort: any failure
    // falls straight back to the one featured image — never blocks the run.
    let productImageUrls = [product.featuredImageUrl];
    try {
      const { admin } = await unauthenticated.admin(shop);
      const gallery = await getProductImageUrls(admin, product.shopifyId);
      if (gallery.length) productImageUrls = gallery;
    } catch (err) {
      console.error(`[visualize] ${shop} gallery fetch failed, using featured only:`, err?.message || err);
    }

    // Logged BEFORE generation so we have a record even when the app
    // proxy severs the connection mid-flight (the access log shows
    // "- - - - ms" with no status in that case, and nothing else fired).
    const reqStart = Date.now();
    console.log(`[visualize] ${shop} start provider=${provider} handle="${handle}"`);

    let result;
    try {
      result = await generateStyledImage({
        provider,
        geminiApiKey: config.geminiApiKey || "",
        openaiApiKey: config.openaiApiKey || "",
        productImageUrl: product.featuredImageUrl,
        productImageUrls,
        productTitle: product.title || "",
        styleContext,
      });
    } catch (err) {
      console.error(
        `[visualize] ${shop} generation failed (${provider}) after ${Date.now() - reqStart}ms:`,
        err?.message || err,
      );
      return Response.json(
        { ok: false, message: "The styling preview couldn't be generated right now. Please try again." },
        { status: 502 },
      );
    }
    console.log(
      `[visualize] ${shop} ok provider=${result.provider} totalMs=${Date.now() - reqStart} payloadChars=${result.payloadChars || 0}`,
    );

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
