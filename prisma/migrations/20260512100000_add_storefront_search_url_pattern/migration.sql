-- Auto-generated storefront search CTA. Adds a single column
-- (storefrontSearchUrlPattern) to ShopConfig. Default empty string
-- preserves existing behavior (auto-CTA disabled, legacy
-- collectionLinks JSON used for shops that haven't migrated). Aetrex
-- and other merchants opt in by setting the pattern to something like
-- "https://example.com/collections/shop?q={q}&tab=products".

ALTER TABLE "ShopConfig"
  ADD COLUMN "storefrontSearchUrlPattern" TEXT NOT NULL DEFAULT '';
