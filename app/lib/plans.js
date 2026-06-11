// Plan catalog for SEoS Assistant.
//
// Two tiers: Growth for the typical Shopify merchant, Pro for high-volume or
// data-rich stores. The Free tier was removed — every merchant who installs
// the app starts on Growth, with billing collected through Shopify. Stores
// listed in the COMP_PRO_SHOPS env var are upgraded to Pro automatically and
// permanently by billing.server.js (used for partner / launch-customer
// arrangements like Aetrex).
//
// Each plan exposes a `features` flag set used by admin pages to gate UI
// sections — when a feature is locked we still render the section (so
// merchants can see what's available), but disable the inputs and surface
// an "Upgrade plan" banner.
export const PLANS = {
  growth: {
    id: "growth",
    name: "Growth",
    price: 99,
    conversationsPerMonth: 3000,
    knowledgeFiles: Infinity,
    analyticsRetentionDays: 90,
    features: {
      smartRouting: true,
      advancedModel: false,
      promptCaching: true,
      searchRules: true,
      productEnrichment: true,
      fitPredictor: false,
      vipMode: false,
      klaviyoIntegration: true,
      yotpoIntegration: false,
      aftershipIntegration: true,
    },
    summary: [
      "3,000 conversations per month",
      "Unlimited knowledge files",
      "90-day analytics history",
      "Smart model routing — uses a faster, cheaper model for simple follow-ups",
      "Prompt caching — lower input cost on repeat messages",
      "Search rules, query synonyms, similar-match attributes",
      "Category groups for sharper chip suggestions",
      "Semantic search — bring your own Voyage AI or OpenAI key (optional)",
      "Product enrichment via CSV",
      "Klaviyo + Aftership integrations",
      "Email support",
    ],
  },

  pro: {
    id: "pro",
    name: "Pro",
    price: 199,
    conversationsPerMonth: Infinity,
    knowledgeFiles: Infinity,
    analyticsRetentionDays: 180,
    features: {
      smartRouting: true,
      advancedModel: true,
      promptCaching: true,
      searchRules: true,
      productEnrichment: true,
      fitPredictor: true,
      vipMode: true,
      klaviyoIntegration: true,
      yotpoIntegration: true,
      aftershipIntegration: true,
    },
    summary: [
      "Unlimited conversations",
      "Unlimited knowledge files",
      "180-day analytics history",
      "Advanced AI model for complex catalogs",
      "Smart routing + prompt caching",
      "Fit predictor with size confidence",
      "VIP mode for logged-in customers (uses order history)",
      "Category groups for sharper chip suggestions",
      "Semantic search — bring your own Voyage AI or OpenAI key (optional)",
      "Klaviyo, Yotpo loyalty + reviews, Aftership integrations",
      "Priority email support",
    ],
  },
};

export const PLAN_ORDER = ["growth", "pro"];

// Default plan for shops that don't have a recorded plan yet (fresh installs,
// historical rows from when 'free' existed, etc.). Single source of truth —
// don't hard-code "growth" elsewhere.
export const DEFAULT_PLAN_ID = "growth";

export function getPlan(planId) {
  // Legacy IDs: old "free" rows fall through to Growth (the new entry tier);
  // old "enterprise" rows map to its renamed equivalent, Pro. This keeps
  // existing shops working without a database migration.
  if (planId === "enterprise") return PLANS.pro;
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}

// Returns the lowest-priced plan that has the requested feature enabled, used
// by the admin UI to render an accurate "Available on Pro plan" CTA.
export function requiredPlanFor(featureName) {
  for (const id of PLAN_ORDER) {
    const plan = PLANS[id];
    if (plan.features?.[featureName]) return plan;
  }
  return null;
}

export function planAllows(plan, featureName) {
  return Boolean(plan?.features?.[featureName]);
}

export function formatLimit(value) {
  if (value === Infinity) return "Unlimited";
  return value.toLocaleString();
}
