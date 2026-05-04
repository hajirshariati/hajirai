// Resilience helpers for Anthropic API calls.
//
// Production failures observed in Railway logs:
//   - Transient 5xx (Anthropic upstream blip): ~1-3 per 1000 calls
//   - 429 rate-limit (concurrent traffic spike): rare but bursts
//   - Network reset / ECONNRESET: rare
//
// Without retry, every one of these surfaces as the generic "I'm having
// trouble" message to the customer. With a short retry on safe-to-retry
// errors, most of them recover invisibly.
//
// What we retry:
//   - HTTP 5xx (server errors)
//   - HTTP 429 (rate limit; uses backoff, not retry-after header — keeps
//     this dependency-free)
//   - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, network)
//
// What we do NOT retry:
//   - HTTP 4xx other than 429 (auth, validation, billing) — retry won't
//     help and just delays the customer's error
//   - Errors after partial output (would duplicate to the customer)

const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504, 522, 524]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

function isRetryableError(err) {
  if (!err) return false;
  // Anthropic SDK exposes `.status` on APIError instances.
  const status = err.status ?? err.response?.status;
  if (typeof status === "number" && RETRYABLE_HTTP_CODES.has(status)) return true;
  const code = err.code ?? err.cause?.code;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  // Fallback: message includes a retry-eligible signal.
  const msg = String(err.message || "").toLowerCase();
  if (/network|timeout|econnreset|temporarily|overloaded|retry/.test(msg)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with jitter. Defaults: 2 retries, 500ms then 1500ms.
// Total worst-case added latency on success: ~2s. On failure: same as
// before, with the original error rethrown.
//
// Use ONLY for non-streaming calls or stream-init that hasn't emitted
// tokens to the customer yet. Retrying mid-stream would duplicate text.
export async function withAnthropicRetry(fn, opts = {}) {
  const { maxRetries = 2, baseDelayMs = 500, label = "anthropic" } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryableError(err)) throw err;
      const delay = baseDelayMs * Math.pow(3, attempt) + Math.floor(Math.random() * 200);
      console.log(`[${label}] retry ${attempt + 1}/${maxRetries} after ${delay}ms — ${err?.status || err?.code || "unknown"}: ${String(err?.message || err).slice(0, 120)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Classify an error so the customer-facing message can be specific.
// Used by the chat route's stream-error handler.
export function classifyAnthropicError(err) {
  const status = err?.status ?? err?.response?.status;
  const raw = String(err?.message || "").toLowerCase();
  if (raw.includes("credit balance") || raw.includes("billing") || raw.includes("insufficient")) {
    return { kind: "billing", retryable: false };
  }
  if (status === 429 || raw.includes("rate limit")) {
    return { kind: "rate_limit", retryable: true };
  }
  if (status && status >= 500 && status < 600) {
    return { kind: "upstream", retryable: true };
  }
  if (RETRYABLE_NETWORK_CODES.has(err?.code)) {
    return { kind: "network", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}
