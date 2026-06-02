-- Merchant-data-driven claim configuration (2026-06-02).
-- Three additive tables that replace the hardcoded BRAND_RULES /
-- FOOTWEAR_CATEGORIES / NON_FOOTWEAR_CATEGORIES constants from
-- app/lib/product-claim-facts.server.js. No existing data modified.

CREATE TABLE "ClaimRule" (
  "id"              TEXT PRIMARY KEY,
  "shop"            TEXT NOT NULL,
  "claim"           TEXT NOT NULL,
  "ruleType"        TEXT NOT NULL,
  "appliesToGroup"  TEXT,
  "excludeGroups"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ruleConfig"      JSONB,
  "active"          BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "ClaimRule_shop_claim_key" ON "ClaimRule"("shop", "claim");
CREATE INDEX "ClaimRule_shop_idx" ON "ClaimRule"("shop");

CREATE TABLE "CategoryGroup" (
  "id"          TEXT PRIMARY KEY,
  "shop"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "categories"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "CategoryGroup_shop_name_key" ON "CategoryGroup"("shop", "name");
CREATE INDEX "CategoryGroup_shop_idx" ON "CategoryGroup"("shop");

CREATE TABLE "ColorFamily" (
  "id"        TEXT PRIMARY KEY,
  "shop"      TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "members"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "ColorFamily_shop_name_key" ON "ColorFamily"("shop", "name");
CREATE INDEX "ColorFamily_shop_idx" ON "ColorFamily"("shop");
