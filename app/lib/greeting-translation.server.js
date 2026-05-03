// Multilingual welcome-CTA translator. Generates translations of the
// merchant's greetingCta into a fixed set of high-traffic Shopify
// languages on demand, then caches the result on ShopConfig so repeat
// /widget-config requests don't re-pay the model.
//
// Cache shape (stored as JSON string in ShopConfig.greetingCtaTranslations):
//   {
//     phrase: "<verbatim greetingCta the cache was generated from>",
//     results: [{ code, dir, text }, ...]  // one entry per TARGET_LANGUAGES below
//   }
//
// Cache invalidation: if the cached `phrase` doesn't equal the current
// merchant greetingCta, regenerate. Languages are fixed (not configurable
// per merchant) to keep the system simple and the cost bounded — six
// translations per merchant phrase change.

import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";

// Fixed set of target languages. RTL flag drives `dir="rtl"` on the
// rendered span so glyph order is correct in Arabic, Hebrew, Farsi.
// Code (ISO 639-1) drives the `lang` attribute for screen readers.
const TARGET_LANGUAGES = [
  { code: "es", name: "Spanish", dir: "ltr" },
  { code: "ar", name: "Arabic", dir: "rtl" },
  { code: "ja", name: "Japanese", dir: "ltr" },
  { code: "he", name: "Hebrew", dir: "rtl" },
  { code: "hi", name: "Hindi", dir: "ltr" },
  { code: "fa", name: "Farsi (Persian)", dir: "rtl" },
];

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Public entry point. Returns an array of {code, dir, text} or [] if
// translation is unavailable (e.g. no API key, model error). The widget
// is responsible for treating an empty array as "rotator off".
export async function getGreetingCtaTranslations(config) {
  const phrase = String(config?.greetingCta || "").trim();
  if (!phrase) return [];

  // Read cache. Match on exact phrase — any edit invalidates.
  let cached = null;
  try { cached = JSON.parse(config?.greetingCtaTranslations || "{}"); } catch { /* */ }
  if (cached && cached.phrase === phrase && Array.isArray(cached.results) && cached.results.length === TARGET_LANGUAGES.length) {
    return cached.results;
  }

  const apiKey = config?.anthropicApiKey;
  if (!apiKey) return cached?.results || [];

  let results;
  try {
    results = await translatePhrase(phrase, apiKey);
  } catch (err) {
    console.error("[greeting-translation] failed:", err?.message || err);
    // Fall back to whatever's cached (even if stale) so the widget still
    // has something to rotate; never throw to the widget-config caller.
    return cached?.results || [];
  }

  // Persist cache. Best-effort — if the write fails, still return the
  // results so this request gets the value.
  prisma.shopConfig
    .update({
      where: { shop: config.shop },
      data: { greetingCtaTranslations: JSON.stringify({ phrase, results }) },
    })
    .catch((err) => console.error("[greeting-translation] cache write failed:", err?.message || err));

  return results;
}

// Single Haiku call returns all six translations as JSON. Prompt is
// strict about output shape so we don't have to do prose parsing.
async function translatePhrase(phrase, apiKey) {
  const anthropic = new Anthropic({ apiKey });
  const langList = TARGET_LANGUAGES
    .map((l) => `- ${l.code} (${l.name})`)
    .join("\n");

  const prompt = `Translate the following English phrase into each of the languages below. Preserve the conversational tone (a friendly retail assistant greeting a customer). Use gender-neutral phrasing where the target language allows it.

Phrase: "${phrase}"

Languages:
${langList}

Return ONLY a JSON array with no prose, no markdown fences, no explanation. Each element must be an object with two fields: "code" (the ISO 639-1 code from the list above) and "text" (the translated phrase, no surrounding quotes). Example shape:
[{"code":"es","text":"..."},{"code":"ar","text":"..."}]`;

  const res = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = res?.content?.[0]?.text || "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("model returned no JSON array");

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error("model returned non-array");

  const byCode = new Map(
    parsed
      .filter((p) => p && typeof p.code === "string" && typeof p.text === "string" && p.text.trim().length > 0)
      .map((p) => [p.code.trim().toLowerCase(), p.text.trim()]),
  );

  return TARGET_LANGUAGES
    .map(({ code, dir }) => {
      const text = byCode.get(code);
      if (!text) return null;
      return { code, dir, text };
    })
    .filter(Boolean);
}
