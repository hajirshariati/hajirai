// Provider-agnostic embedding service. Used by:
// - product sync (one embedding per product)
// - chat search (one embedding per customer query)
//
// Both Voyage and OpenAI are supported. Voyage is recommended (cheapest,
// owned by Anthropic, 1024 dim natively). OpenAI is offered for merchants
// who already have an OpenAI account.
//
// All providers are normalized to 1024-dimensional vectors so the same
// pgvector column works regardless of provider choice.

export const EMBEDDING_DIMENSIONS = 1024;

const PROVIDERS = {
  voyage: {
    label: "Voyage AI",
    model: "voyage-3",
    endpoint: "https://api.voyageai.com/v1/embeddings",
  },
  openai: {
    label: "OpenAI",
    model: "text-embedding-3-small",
    endpoint: "https://api.openai.com/v1/embeddings",
  },
};

export function isProviderSupported(provider) {
  return provider === "voyage" || provider === "openai";
}

export function providerLabel(provider) {
  return PROVIDERS[provider]?.label || "";
}

// Embed an array of texts in one API call. Returns array of vectors
// (each is a number[] of length EMBEDDING_DIMENSIONS), aligned with the
// input order. Throws on auth/network/rate-limit errors so callers can
// retry or surface a useful message to the merchant.
export async function embedTexts(provider, apiKey, texts, { inputType = "document" } = {}) {
  if (!isProviderSupported(provider)) {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(`Missing API key for ${provider}`);
  }
  const inputs = Array.isArray(texts) ? texts : [texts];
  if (inputs.length === 0) return [];

  const cfg = PROVIDERS[provider];
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  let body;
  if (provider === "voyage") {
    // Voyage takes input_type to optimize embeddings for query vs document.
    body = {
      model: cfg.model,
      input: inputs,
      input_type: inputType === "query" ? "query" : "document",
    };
  } else {
    // OpenAI: request 1024 dimensions explicitly so it matches Voyage's
    // native size — same DB column works for both providers.
    body = {
      model: cfg.model,
      input: inputs,
      dimensions: EMBEDDING_DIMENSIONS,
    };
  }

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const truncated = errText.length > 300 ? errText.slice(0, 300) + "…" : errText;
    throw new Error(`${cfg.label} embedding error ${res.status}: ${truncated}`);
  }

  const data = await res.json();
  // Both providers return { data: [{ embedding: [...] }, ...] }
  if (!data || !Array.isArray(data.data) || data.data.length !== inputs.length) {
    throw new Error(`${cfg.label} returned malformed response`);
  }
  return data.data.map((d) => d.embedding);
}

// Convenience: embed a single text. Returns one vector.
export async function embedText(provider, apiKey, text, opts = {}) {
  const [vec] = await embedTexts(provider, apiKey, [text], opts);
  return vec;
}

// Build the text that gets embedded for a product. Combines title +
// vendor + product type + tags + truncated description + flattened
// attributes. Same shape on initial sync and on update so embeddings
// stay consistent.
export function productEmbeddingText(p) {
  const parts = [];
  if (p.title) parts.push(p.title);
  if (p.vendor) parts.push(p.vendor);
  if (p.productType) parts.push(p.productType);
  if (Array.isArray(p.tags) && p.tags.length > 0) parts.push(p.tags.join(" "));
  if (p.description) parts.push(String(p.description).slice(0, 1500));
  if (p.attributesJson && typeof p.attributesJson === "object") {
    const attrText = Object.entries(p.attributesJson)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => {
        const value = Array.isArray(v) ? v.join(" ") : String(v);
        return `${k}:${value}`;
      })
      .join(" ");
    if (attrText) parts.push(attrText);
  }
  return parts.join("\n").trim();
}

// Format a JS number[] as a pgvector literal: "[0.1,0.2,...]". Used when
// writing embeddings via $executeRaw.
export function vectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}
