export const PLANS = {
  free: {
    id: "free", name: "Free", price: 0,
    conversationsPerMonth: 50, knowledgeFiles: 1,
    analyticsRetentionDays: 7, smartRouting: false,
    allowBrandingRemoval: false, advancedModel: false,
    features: ["50 conversations per month","1 knowledge file","7-day analytics","Standard AI model","ShopAgent branding"],
  },
  starter: {
    id: "starter", name: "Starter", price: 19,
    conversationsPerMonth: 500, knowledgeFiles: 5,
    analyticsRetentionDays: 30, smartRouting: true,
    allowBrandingRemoval: false, advancedModel: false,
    features: ["500 conversations per month","5 knowledge files","30-day analytics","Smart model routing (saves 60% on AI costs)","Customer question insights"],
  },
  growth: {
    id: "growth", name: "Growth", price: 49,
    conversationsPerMonth: 2000, knowledgeFiles: Infinity,
    analyticsRetentionDays: 90, smartRouting: true,
    allowBrandingRemoval: true, advancedModel: false,
    features: ["2,000 conversations per month","Unlimited knowledge files","90-day analytics","Remove ShopAgent branding","Priority email support"],
  },
  pro: {
    id: "pro", name: "Pro", price: 99,
    conversationsPerMonth: Infinity, knowledgeFiles: Infinity,
    analyticsRetentionDays: 90, smartRouting: true,
    allowBrandingRemoval: true, advancedModel: true,
    features: ["Unlimited conversations","Unlimited knowledge files","90-day analytics","Advanced AI model for complex queries","White-label branding","Priority support"],
  },
};
export const PLAN_ORDER = ["free","starter","growth","pro"];
export function getPlan(id) { return PLANS[id] || PLANS.free; }
export function formatLimit(v) { return v === Infinity ? "Unlimited" : v.toLocaleString(); }
