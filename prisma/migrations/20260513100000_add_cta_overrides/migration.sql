-- CTA override rules. JSON array stored as TEXT:
--   [{ modifier?, gender?, category?, url, label? }, ...]
-- When the conversation's resolved intent matches a rule (loose,
-- case-insensitive; blank fields are wildcards), the rule's URL+label
-- override the auto-generated storefront search CTA. Most-specific
-- match wins (more fields set = higher priority). Use for dedicated
-- landing pages (e.g. /collections/womens-sale) that don't surface
-- well via the storefront's ?q= search.

ALTER TABLE "ShopConfig"
  ADD COLUMN "ctaOverrides" TEXT NOT NULL DEFAULT '[]';
