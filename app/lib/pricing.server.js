const MODEL_PRICING = {
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  "claude-opus-4-20250514": { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
};

const DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-20250514"];

export function computeCost(model, usage) {
  const p = MODEL_PRICING[model] || DEFAULT_PRICING;
  const input = ((usage.input_tokens || 0) * p.input) / 1_000_000;
  const output = ((usage.output_tokens || 0) * p.output) / 1_000_000;
  const cacheRead = ((usage.cache_read_input_tokens || 0) * p.cacheRead) / 1_000_000;
  const cacheWrite = ((usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

export function getModelLabel(model) {
  if (model?.includes("haiku")) return "Haiku 4.5";
  if (model?.includes("opus")) return "Opus 4";
  return "Sonnet 4";
}

export { MODEL_PRICING };
