// Plan catalog for SEoS Assistant.
//
// Three tiers, intentionally simple: Free for evaluation / very small stores,
// Growth for the typical Shopify merchant, Enterprise for high-volume or
// data-rich stores. Each plan exposes a `features` flag set used by admin
// pages to gate UI sections — when a feature is locked we still render the
// section (so merchants can see what's available), but disable the inputs
// and surface an "Upgrade plan" banner.
export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    conversationsPerMonth: 50,
    knowledgeFiles: 1,
    analyticsRetentionDays: 7,
    features: {
      smartRouting: false,
      advancedModel: false,
      promptCaching: false,
      removeBranding: false,
      searchRules: false,
      productEnrichment: false,
      fitPredictor: false,
      vipMode: false,
      klaviyoIntegration: false,
      yotpoIntegration: false,
      aftershipIntegration: false,
    },
    summary: [
      "50 conversations per month",
      "1 knowledge file",
      "7-day analytics history",
      "Standard AI model",
      "Category groups for sharper chip suggestions",
      "Semantic search — bring your own Voyage AI or OpenAI key (optional)",
      "SEoS Assistant branding on widget",
      "Email support",
    ],
  },

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
      removeBranding: true,
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
      "Remove SEoS Assistant branding",
      "Email support",
    ],
  },

  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 199,
    conversationsPerMonth: Infinity,
    knowledgeFiles: Infinity,
    analyticsRetentionDays: 180,
    features: {
      smartRouting: true,
      advancedModel: true,
      promptCaching: true,
      removeBranding: true,
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
      "Remove SEoS Assistant branding",
      "Email support",
    ],
  },
};

export const PLAN_ORDER = ["free", "growth", "enterprise"];

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

// Returns the lowest-priced plan that has the requested feature enabled, used
// by the admin UI to render an accurate "Available on Growth plan" CTA.
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
