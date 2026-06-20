import { getPlan } from "./plans";

// This app is free: every feature is unlocked and there is no billing.
//
// The plan/pricing UI and the Shopify billing flow (appSubscriptionCreate and
// the /app/plans + /app/billing/callback routes) have been removed. These two
// helpers are kept because several route loaders and the chat endpoint still
// import them — they now always report a single, fully-unlocked plan with no
// limits, so nothing is gated and no usage cap is ever hit.

const UNLOCKED_PLAN = {
  ...getPlan("pro"),
  conversationsPerMonth: Infinity,
  knowledgeFiles: Infinity,
  analyticsRetentionDays: Infinity,
};

export async function getShopPlan() {
  return UNLOCKED_PLAN;
}

export async function canSendMessage() {
  return { ok: true, plan: UNLOCKED_PLAN, used: null, limit: Infinity };
}
