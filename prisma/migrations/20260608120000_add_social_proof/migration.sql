-- Social proof popup tables.
-- ProductViewerPing: live "X people viewing this right now" signal — one row
-- per (shop, product, anonymous tab), refreshed every ~25s by the storefront.
-- RecentPurchase: real recent orders per product (city only, no PII) recorded
-- by the orders/create webhook, powering "Someone in [City] just bought this".

CREATE TABLE "ProductViewerPing" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductViewerPing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductViewerPing_shop_productId_sessionId_key" ON "ProductViewerPing"("shop", "productId", "sessionId");
CREATE INDEX "ProductViewerPing_shop_productId_lastSeen_idx" ON "ProductViewerPing"("shop", "productId", "lastSeen");
CREATE INDEX "ProductViewerPing_lastSeen_idx" ON "ProductViewerPing"("lastSeen");

CREATE TABLE "RecentPurchase" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecentPurchase_shop_orderId_productId_key" ON "RecentPurchase"("shop", "orderId", "productId");
CREATE INDEX "RecentPurchase_shop_productId_createdAt_idx" ON "RecentPurchase"("shop", "productId", "createdAt");
CREATE INDEX "RecentPurchase_createdAt_idx" ON "RecentPurchase"("createdAt");
