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

// How many reference angles to feed the image model. More views = more
// faithful product reproduction; capped so the request stays well within
// the proxy window. Env-overridable.
const MAX_REFERENCE_IMAGES = Math.max(1, Number(process.env.VISUALIZE_MAX_REFERENCE_IMAGES) || 4);

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

// Default "scene theme" — the consistent brand treatment applied to EVERY
// generated image. The chosen setting lives only in the soft, blurred
// background and dissolves into a clean, seamless white floor in the
// foreground that the shopper is walking on — bright, airy, editorial. Merchant-
// editable via ShopConfig.visualizeScenePrompt (admin → Visualize My Look).
export const DEFAULT_VIZ_SCENE_THEME =
  "BRAND SCENE TREATMENT (apply to EVERY image regardless of the setting): " +
  "the chosen setting appears ONLY in the soft, gently blurred BACKGROUND (the upper part of the frame) and SEAMLESSLY FADES into a clean, bright, seamless matte WHITE floor surface in the foreground that the person is walking on. " +
  "The foreground is smooth white with soft, natural contact shadows under the shoes — no visible floor texture, tiles, grout, rug, sand, grass, or hard horizon line, and no harsh seam: the background scene dissolves gently into the white so the transition is smooth. " +
  "Keep it bright, airy, and editorial, with the footwear crisp and well-lit on the white surface in the sharp foreground. This white-floor-fade look must be consistent across all previews.";

// The fidelity-locked stylist prompt. The product image is the authority; the
// text governs the SCENE around it. `sceneTheme` (merchant-configurable) is the
// consistent brand treatment; `styleContext` (per-turn) chooses WHICH setting.
export function buildStylistPrompt({ productTitle, styleContext, sceneTheme }) {
  const ctx = String(styleContext || "").trim();
  const theme = String(sceneTheme || "").trim() || DEFAULT_VIZ_SCENE_THEME;
  const sceneLine = ctx
    ? `Choose the BACKGROUND setting from BOTH the footwear style AND what the shopper told us they need it for: "${ctx}". If the shopper named a destination, occasion, activity, or weather, set the background scene THERE (e.g. they mentioned hiking or a mountain → a real mountain trail; a beach or vacation → a sunny boardwalk or sand path; the gym or running → a track or city street; a wedding or evening out → an elegant venue). Match the environment to what they actually said.`
    : "Choose a real-world BACKGROUND setting that naturally suits this style of footwear (boots → outdoor trail, sandals → sunny boardwalk, sneakers → city street or park, heels → elegant evening venue).";
  return [
    "You are a professional footwear stylist creating ONE photorealistic action shot for an online shopper.",
    "The attached image(s) are the EXACT product to feature. When several images are attached they are MULTIPLE ANGLES OF THE SAME single product (top/front/side) — not different products. The footwear is the HERO of the shot and must dominate the frame.",
    "ABSOLUTE RULE — DO NOT CHANGE THE PRODUCT: reproduce it exactly as shown across the reference angles — identical shape, silhouette, color, materials, texture, hardware, stitching, patterns, logos, and proportions. Do not redesign, recolor, restyle, embellish, add, or remove anything on the product itself.",
    `The product is: ${String(productTitle || "the item").trim()}.`,
    "MOTION (required): show a person WALKING — captured mid-stride in natural motion, one foot stepping forward with the weight shifting, as if photographed in the middle of a walk. NEVER a static standing, seated, or posed-still shot. The person should always read as moving.",
    "SCENE: " + sceneLine,
    theme,
    "COMPOSITION RULES (critical — the footwear must be unmistakably the focus):",
    "- Use a CLOSE, feet-forward crop framed from roughly the knee or mid-calf down, following the feet in motion. Show the shoes LARGE and crisp — they should occupy about half the frame and sit in the sharp foreground. NEVER a full-length head-to-toe shot that shrinks the shoes to a small detail.",
    "- Keep the footwear razor-sharp and perfectly lit even while walking: freeze the shoes crisply. Any motion blur belongs ONLY in the background, NEVER on the product.",
    "- The person, clothing, and environment are SUPPORTING CONTEXT only — secondary, and never obscuring, cropping, or visually competing with the footwear.",
    "- Shallow depth of field: footwear razor-sharp, background gently soft with a subtle sense of movement.",
    "Keep the product pixel-faithful to the reference angles. Photorealistic, natural lighting, clean modern editorial quality. No text, watermarks, or added logos.",
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

async function generateWithGemini({ apiKey, prompt, images }) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // Feed every reference angle we have. Multiple views (top/front/side) let
  // the model reproduce the product faithfully instead of inventing the
  // sides a single photo never showed.
  const reqParts = [{ text: prompt }];
  for (const img of images) {
    reqParts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }
  const body = {
    contents: [{ parts: reqParts }],
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

async function generateWithOpenAI({ apiKey, prompt, images }) {
  // OpenAI edits take the primary reference only (single-image request kept
  // byte-for-byte stable); the multi-angle win applies to the Gemini path.
  const image = images[0];
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
  productImageUrls,
  productTitle = "",
  styleContext = "",
  sceneTheme = "",
}) {
  if (!isImageProviderSupported(provider)) {
    throw new Error(`unsupported image provider: ${provider || "(none)"}`);
  }
  const apiKey = provider === "gemini" ? geminiApiKey : openaiApiKey;
  if (!apiKey) throw new Error(`no API key configured for image provider "${provider}"`);

  // Accept a list of reference angles (preferred) or a single URL (legacy).
  // De-dupe and bound it so a slow/huge gallery can't blow the request window.
  const candidateUrls = (
    Array.isArray(productImageUrls) && productImageUrls.length
      ? productImageUrls
      : [productImageUrl]
  )
    .map((u) => String(u || "").trim())
    .filter(Boolean)
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, MAX_REFERENCE_IMAGES);
  if (!candidateUrls.length) throw new Error("product has no image to style");

  const startedAt = Date.now();
  // Fetch all references in parallel; tolerate individual failures as long as
  // at least one survives (so a single dead gallery URL can't kill the run).
  const fetched = await Promise.all(
    candidateUrls.map((u) =>
      fetchImageAsBase64(u).catch((err) => {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") return null;
        console.error(`[image-styling] reference fetch failed (${u}):`, err?.message || err);
        return null;
      }),
    ),
  );
  const images = fetched.filter(Boolean);
  if (!images.length) {
    throw new Error(`product image fetch failed or timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
  }
  const prompt = buildStylistPrompt({ productTitle, styleContext, sceneTheme });

  let imageDataUrl;
  try {
    imageDataUrl =
      provider === "gemini"
        ? await generateWithGemini({ apiKey, prompt, images })
        : await generateWithOpenAI({ apiKey, prompt, images });
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
    `[image-styling] provider=${provider} refs=${images.length} ms=${ms} payloadChars=${payloadChars} ~bytes=${Math.round(payloadChars * 0.73)}`,
  );

  return { imageDataUrl, costUsd: IMAGE_COST_USD[provider] || 0.04, provider, ms, payloadChars };
}
