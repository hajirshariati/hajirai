// Pure cost-estimator math + copy — shared by the admin CostEstimator
// component and its unit tests. No React, no DB: just the numbers and the
// honest labels. Keeping it here means the accounting can be tested without
// rendering the component.

export const CALC_MIN_SAMPLE = 25; // recorded chat replies needed before trusting the store's own average

// Per-reply cost falls as volume grows: at low traffic nearly every
// conversation pays a fresh prompt-cache write with nothing amortizing it,
// while at high traffic the cache stays hot (reads bill at ~1/10th the input
// price) and the fast-model share of routing rises. Log-interpolate from the
// anchored low-volume rate down to the at-scale blended rate.
export const CALC_AMORT_START = 2000;
export const CALC_AMORT_FULL = 100000;

// Auxiliary per-turn LLM calls — the orthotic Haiku classifier, the
// product-turn / policy voice-synthesis Haiku calls, and the orthotic-flow
// layer-3 mapping — run DURING a customer turn but are not separately metered
// into ChatUsage (they live in dispatch paths with their own emit flow). They
// are small Haiku calls that fire on a subset of turns, so the recorded chat
// average understates true cost by a few percent. We correct the ANCHORED real
// average with this small, conservative, DISCLOSED allowance. The fallback
// blended rates below already bake auxiliary overhead in, so they are NOT
// multiplied again. See docs/cost-accounting-audit.md for the full audit.
export const SIDE_CALL_OVERHEAD = 1.06;

// The per-reply rate is driven mostly by which model answers. At scale the
// dominant cost is the cached system-prefix READ, so these scale with each
// model's cache-read + output price relative to Sonnet (pricing.server.js).
export const STRATEGY_RATES = {
  smart: { fallback: 0.008, atScale: 0.006 },
  "cost-optimized": { fallback: 0.005, atScale: 0.0035 },
  "always-opus": { fallback: 0.014, atScale: 0.011 },
};

export function strategyProfile(strategy) {
  switch (strategy) {
    case "cost-optimized":
    case "always-haiku":
      return { rates: STRATEGY_RATES["cost-optimized"], label: "Cost-optimized routing" };
    case "always-opus":
    case "premium":
      return { rates: STRATEGY_RATES["always-opus"], label: "Premium quality" };
    default:
      return { rates: STRATEGY_RATES.smart, label: "Smart routing" };
  }
}

export function effectiveRate(baseRate, monthlyReplies, atScaleRate) {
  if (baseRate <= atScaleRate) return baseRate;
  if (!Number.isFinite(monthlyReplies) || monthlyReplies <= CALC_AMORT_START) return baseRate;
  const t = Math.min(
    1,
    (Math.log10(monthlyReplies) - Math.log10(CALC_AMORT_START)) /
      (Math.log10(CALC_AMORT_FULL) - Math.log10(CALC_AMORT_START)),
  );
  return baseRate + (atScaleRate - baseRate) * t;
}

// Decide the anchor: the store's own recorded CHAT average (image previews
// excluded) once there are enough recorded replies, otherwise the strategy's
// fallback blended rate. The anchored real average is nudged up by the
// documented side-call allowance; the fallback already includes it.
export function resolveEstimatorBaseRate({ avgChatCostPerMessage, totalMessages, rates }) {
  const anchored = totalMessages >= CALC_MIN_SAMPLE && avgChatCostPerMessage > 0;
  const baseRate = anchored ? avgChatCostPerMessage * SIDE_CALL_OVERHEAD : rates.fallback;
  return { anchored, baseRate };
}

// UI copy for the active anchor — kept here so tests assert exact wording.
export const ANCHOR_COPY = {
  // shown when totalMessages >= CALC_MIN_SAMPLE
  anchored: "Based on your recorded chat average over the selected analytics period.",
  // shown when the sample is too small to trust
  fallback: "Based on typical model-routing assumptions until your store has enough traffic.",
};

// The per-period multiplier label. This is estimated assistant replies (chat
// turns), NOT raw provider API requests — a single reply can include classifier
// calls, model retries, follow-up suggestions, tools, and embeddings.
export const REPLIES_LABEL = "assistant replies / mo";
export const PER_REPLY_NOUN = "assistant reply";
