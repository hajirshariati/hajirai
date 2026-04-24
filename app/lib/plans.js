export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    conversationsPerMonth: 50,
    knowledgeFiles: 1,
    analyticsRetentionDays: 7,
    smartRouting: false,
    allowBrandingRemoval: false,
    advancedModel: false,
    features: [
      "50 conversations per month",
      "1 knowledge file",
      "7-day analytics",
      "Standard AI model",
      "Seos branding",
    ],
  },
  starter: {
    id: "starter",
    name: "Starter",
    price: 39,
    conversationsPerMonth: 500,
    knowledgeFiles: 5,
    analyticsRetentionDays: 30,
    smartRouting: true,
    allowBrandingRemoval: false,
    advancedModel: false,
    features: [
      "500 conversations per month",
      "5 knowledge files",
      "30-day analytics",
      "Smart model routing (saves up to 60% on AI costs)",
      "Search rules & query synonyms",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 99,
    conversationsPerMonth: 3000,
    knowledgeFiles: Infinity,
    analyticsRetentionDays: 90,
    smartRouting: true,
    allowBrandingRemoval: true,
    advancedModel: false,
    features: [
      "3,000 conversations per month",
      "Unlimited knowledge files",
      "90-day analytics",
      "Remove Seos branding",
      "Product enrichment via CSV",
      "Priority email support",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 199,
    conversationsPerMonth: 10000,
    knowledgeFiles: Infinity,
    analyticsRetentionDays: 90,
    smartRouting: true,
    allowBrandingRemoval: true,
    advancedModel: true,
    features: [
      "10,000 conversations per month",
      "Unlimited knowledge files",
      "90-day analytics",
      "Advanced AI model for complex queries",
      "Prompt caching (reduce AI costs up to 90%)",
      "Priority support",
    ],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 499,
    conversationsPerMonth: Infinity,
    knowledgeFiles: Infinity,
    analyticsRetentionDays: 180,
    smartRouting: true,
    allowBrandingRemoval: true,
    advancedModel: true,
    features: [
      "Unlimited conversations",
      "Unlimited knowledge files",
      "180-day analytics",
      "Advanced AI model",
      "Prompt caching",
      "White-label branding",
      "Dedicated support",
    ],
  },
};

export const PLAN_ORDER = ["free", "starter", "growth", "pro", "enterprise"];

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

export function formatLimit(value) {
  if (value === Infinity) return "Unlimited";
  return value.toLocaleString();
}
