// "Visualize My Look" — AI styling-preview image generation.
//
// Takes the REAL product photo as a locked reference and asks a
// subject-preserving image model to compose a photorealistic styling
// scene around it (on a model / styled in context) for the thing the
// customer described ("heels to go with my blue dress"). The product
// must come back IDENTICAL — the prompt hard-constrains the model not
// to alter it, and we feed the actual catalog image as the reference.
//
// Two providers, merchant-selected (like the embeddings provider):
//   - gemini  → Google "Nano Banana" (Gemini 2.5 Flash Image): best at
//               keeping a reference subject identical while restyling.
//   - openai  → gpt-image-1 image edits.
//
// The merchant pays their own provider directly; we only meter it.
// Model ids are env-overridable so they can be bumped without a deploy.

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

// Hard ceilings so a slow/hung provider can't leave a socket open
// forever (the app proxy kills the upstream connection long before
// these, but without our own bound the fetch keeps running and burns
// resources after the client is already gone). Env-overridable.
const PROVIDER_TIMEOUT_MS = Number(process.env.VISUALIZE_PROVIDER_TIMEOUT_MS) || 55000;
const IMAGE_FETCH_TIMEOUT_MS = Number(process.env.VISUALIZE_IMAGE_FETCH_TIMEOUT_MS) || 15000;

// AbortSignal.timeout (Node 17.3+) — a self-arming abort that fires after
// `ms` and rejects the fetch with a TimeoutError we translate below.
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined; // very old runtime — degrade to no timeout
  }
}

// Rough per-image cost (USD) for metering only — overridable via env.
// Both providers land near $0.04/image at the sizes we request.
const IMAGE_COST_USD = {
  gemini: Number(process.env.GEMINI_IMAGE_COST_USD) || 0.04,
  openai: Number(process.env.OPENAI_IMAGE_COST_USD) || 0.04,
};

export function isImageProviderSupported(provider) {
  return provider === "gemini" || provider === "openai";
}

// The fidelity-locked stylist prompt. The product image is the
// authority; the text only governs the SCENE around it.
function buildStylistPrompt({ productTitle, styleContext }) {
  const ctx = String(styleContext || "").trim();
  const styleLine = ctx
    ? `Style it for this customer's described look: "${ctx}".`
    : "Style it in a tasteful, editorial e-commerce scene.";
  return [
    "You are a professional product stylist creating ONE photorealistic styling preview for an online shopper.",
    "The attached image is the EXACT product to feature — it is the HERO of the shot and must dominate the frame.",
    "ABSOLUTE RULE — DO NOT CHANGE THE PRODUCT: reproduce it exactly as shown — identical shape, silhouette, color, materials, texture, hardware, stitching, patterns, logos, and proportions. Do not redesign, recolor, restyle, embellish, add, or remove anything on the product itself.",
    styleLine,
    `The product is: ${String(productTitle || "the item").trim()}.`,
    "COMPOSITION RULES (critical — the product must be unmistakably the focus):",
    "- Frame the product LARGE and central: it should occupy roughly half the image, sit in the foreground, be sharply focused and well-lit, and be the first thing the eye lands on.",
    "- If the product is footwear (shoes, sneakers, sandals, heels, boots, slippers, clogs): use a CLOSE, feet-forward crop framed from about the knee or mid-calf down. Show the shoes big and crisp. NEVER produce a full-length head-to-toe shot that shrinks the shoes to a small detail at the bottom of the frame.",
    "- Any model, clothing, props, or background are SUPPORTING CONTEXT only — keep them secondary and never let them obscure, crop, or visually compete with the product.",
    "- Use a shallow depth of field: product razor-sharp, background gently soft.",
    "Keep the product pixel-faithful to the reference. Photorealistic, natural lighting, clean modern e-commerce editorial quality. No text, watermarks, or logos added to the image.",
  ].join("\n");
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url, { signal: timeoutSignal(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`could not fetch product image (${res.status})`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("product image was empty");
  return { base64: buf.toString("base64"), mimeType: contentType.split(";")[0].trim(), bytes: buf };
}

async function generateWithGemini({ apiKey, prompt, image }) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: image.mimeType, data: image.base64 } },
        ],
      },
    ],
    // Ask for an image back.
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini image API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inline_data?.data || p?.inlineData?.data);
  const data = imgPart?.inline_data?.data || imgPart?.inlineData?.data;
  const mime = imgPart?.inline_data?.mime_type || imgPart?.inlineData?.mimeType || "image/png";
  if (!data) throw new Error("Gemini returned no image");
  return `data:${mime};base64,${data}`;
}

async function generateWithOpenAI({ apiKey, prompt, image }) {
  // gpt-image-1 edits: multipart form with the reference image + prompt.
  // gpt-image-1 default quality is "auto" → "high", which routinely runs
  // 40-60s and blows past the app-proxy/request window (prod trace
  // 2026-06-24: 45s timeout). "low" cuts that to ~10-20s with quality
  // that's fine for a styling preview; env-overridable if a merchant
  // wants to trade speed for fidelity.
  const form = new FormData();
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("size", "1024x1024");
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || "low");
  // input_fidelity=high is the single most important fidelity lever for
  // gpt-image-1 edits: it forces the model to PRESERVE the reference
  // image's fine details (the product's exact shape, color, materials,
  // hardware) instead of loosely re-imagining it. Default ("low") is why
  // styled products came back looking nothing like the real item. Costs a
  // little more latency/tokens; env-overridable to dial back if needed.
  form.append("input_fidelity", process.env.OPENAI_IMAGE_INPUT_FIDELITY || "high");
  form.append(
    "image",
    new Blob([image.bytes], { type: image.mimeType || "image/png" }),
    "product.png",
  );
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI image API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return `data:image/png;base64,${b64}`;
}

// Returns { imageDataUrl, costUsd, provider } or throws with a
// customer-safe message in err.message.
export async function generateStyledImage({
  provider,
  geminiApiKey = "",
  openaiApiKey = "",
  productImageUrl,
  productTitle = "",
  styleContext = "",
}) {
  if (!isImageProviderSupported(provider)) {
    throw new Error(`unsupported image provider: ${provider || "(none)"}`);
  }
  const apiKey = provider === "gemini" ? geminiApiKey : openaiApiKey;
  if (!apiKey) throw new Error(`no API key configured for image provider "${provider}"`);
  if (!productImageUrl) throw new Error("product has no image to style");

  const startedAt = Date.now();
  let image;
  try {
    image = await fetchImageAsBase64(productImageUrl);
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`product image fetch timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const prompt = buildStylistPrompt({ productTitle, styleContext });

  let imageDataUrl;
  try {
    imageDataUrl =
      provider === "gemini"
        ? await generateWithGemini({ apiKey, prompt, image })
        : await generateWithOpenAI({ apiKey, prompt, image });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(
        `${provider} image generation timed out after ${PROVIDER_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

  // Visibility for the visualize path (previously a black box). Duration
  // tells us whether we're racing the app-proxy deadline; bytes tells us
  // whether the base64 payload is large enough to trip a proxy response
  // size limit. ~chars*0.75 ≈ decoded image bytes.
  const ms = Date.now() - startedAt;
  const payloadChars = imageDataUrl ? imageDataUrl.length : 0;
  console.log(
    `[image-styling] provider=${provider} ms=${ms} payloadChars=${payloadChars} ~bytes=${Math.round(payloadChars * 0.73)}`,
  );

  return { imageDataUrl, costUsd: IMAGE_COST_USD[provider] || 0.04, provider, ms, payloadChars };
}
