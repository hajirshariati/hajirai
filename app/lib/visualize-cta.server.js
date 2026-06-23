// "Visualize My Look" CTA payload builder (pure, no heavy deps so the
// recommender gate can import it without pulling in Prisma).
//
// Emitted as an SSE `visualize_cta` event ONLY when the turn ends with
// exactly ONE recommended product AND the feature is fully configured.
// The widget renders it as a distinct, attention-grabbing FIRST chip;
// on click it POSTs { productHandle, styleContext } to /visualize.

import { isImageProviderSupported } from "./image-styling.server.js";

function recentUserStyleContext(messages, max = 4) {
  if (!Array.isArray(messages)) return "";
  const users = messages
    .filter((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim())
    .map((m) => m.content.trim());
  return users.slice(-max).join(" — ").slice(0, 500);
}

// Returns the SSE event object or null. `config` must carry the
// (decrypted) provider keys, as getShopConfig provides.
export function buildVisualizeCtaEvent({ config, product, messages }) {
  if (!config?.visualizeLookEnabled) return null;
  const provider = String(config.imageProvider || "").trim();
  if (!isImageProviderSupported(provider)) return null;
  // Don't dangle a button that will error on click — require the key
  // for the selected provider.
  const hasKey = provider === "gemini" ? Boolean(config.geminiApiKey) : Boolean(config.openaiApiKey);
  if (!hasKey) return null;

  const handle = String(product?.handle || "").trim();
  const image = product?.image || product?.featuredImageUrl || "";
  if (!handle || !image) return null; // need a product with an image to style

  // "Visualize My Look" is an AI styling preview of the product being
  // worn — it only makes sense for wearable footwear. Never offer it for
  // accessories, shoe-care, socks, gift cards, or $0 service line items
  // (prod trace 2026-06-23: a "VIP Processing" $0.00 SKU got the CTA on an
  // order-status turn). Keeps real footwear (incl. orthotics) eligible.
  const NON_WEARABLE_RE =
    /\b(?:accessor|shoe[\s-]*care|care[\s-]*kit|cleaner|cleaning|protect|spray|sock|gift[\s-]*card|lace|freshener|deodor|processing|shipping|handling|surcharge|warranty|\bfee\b|deposit)/i;
  const category = String(product?.category || product?._category || product?.productType || "");
  if (NON_WEARABLE_RE.test(category) || NON_WEARABLE_RE.test(String(product?.title || ""))) return null;
  const priceNum = Number(product?.price);
  if (Number.isFinite(priceNum) && priceNum <= 0) return null;

  return {
    type: "visualize_cta",
    productHandle: handle,
    productTitle: String(product?.title || "").trim(),
    productImage: image,
    styleContext: recentUserStyleContext(messages),
    label: String(config.visualizeLookLabel || "").trim() || "Visualize My Look",
  };
}
