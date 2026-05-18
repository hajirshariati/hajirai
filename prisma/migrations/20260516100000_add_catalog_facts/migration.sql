-- Catalog brain (Milestone 1, 2026-05-13).
-- Additive only: two new tables, no existing data modified.

CREATE TABLE "CatalogFact" (
  "id"                 TEXT PRIMARY KEY,
  "shop"               TEXT NOT NULL,
  "factKey"            TEXT NOT NULL,
  "productHandle"      TEXT NOT NULL,
  "productId"          TEXT NOT NULL,
  "variantId"          TEXT,
  "variantSku"         TEXT,

  "title"              TEXT NOT NULL,
  "category"           TEXT,
  "productType"        TEXT,
  "gender"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "colors"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sizes"              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "widths"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "conditionTags"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "useCaseTags"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fitTags"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "available"          BOOLEAN NOT NULL DEFAULT TRUE,
  "totalInventory"     INTEGER NOT NULL DEFAULT 0,
  "inventoryUntracked" BOOLEAN NOT NULL DEFAULT FALSE,

  "priceMin"           DECIMAL(65,30),
  "priceMax"           DECIMAL(65,30),

  "sourceUpdatedAt"    TIMESTAMP(3),
  "syncedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "CatalogFact_shop_factKey_key" ON "CatalogFact"("shop", "factKey");
CREATE INDEX "CatalogFact_shop_idx" ON "CatalogFact"("shop");
CREATE INDEX "CatalogFact_shop_available_idx" ON "CatalogFact"("shop", "available");
CREATE INDEX "CatalogFact_shop_category_available_idx" ON "CatalogFact"("shop", "category", "available");

CREATE TABLE "CatalogFacetIndex" (
  "id"                      TEXT PRIMARY KEY,
  "shop"                    TEXT NOT NULL,

  "categoryByGender"        JSONB NOT NULL,
  "colorByGenderCategory"   JSONB NOT NULL,
  "conditionByCategory"     JSONB NOT NULL,
  "sizeByGenderCategory"    JSONB NOT NULL,

  "totalProducts"           INTEGER NOT NULL DEFAULT 0,
  "availableProducts"       INTEGER NOT NULL DEFAULT 0,
  "syncedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "CatalogFacetIndex_shop_key" ON "CatalogFacetIndex"("shop");
