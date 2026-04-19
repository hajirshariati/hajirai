-- CreateTable
CREATE TABLE "ProductEnrichment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "sourceFileId" TEXT,
    "sourceFileType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEnrichment_shop_idx" ON "ProductEnrichment"("shop");

-- CreateIndex
CREATE INDEX "ProductEnrichment_sourceFileId_idx" ON "ProductEnrichment"("sourceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEnrichment_shop_sku_key" ON "ProductEnrichment"("shop", "sku");
