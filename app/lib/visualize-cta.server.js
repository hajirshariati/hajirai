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

  return {
    type: "visualize_cta",
    productHandle: handle,
    productTitle: String(product?.title || "").trim(),
    productImage: image,
    styleContext: recentUserStyleContext(messages),
    label: String(config.visualizeLookLabel || "").trim() || "Visualize My Look",
  };
}
