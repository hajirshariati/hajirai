-- ChatConversion: one row per order tagged "SEoS" by the orders/create webhook.
-- Lets the analytics + home page surface chat-driven order count and revenue
-- without re-querying Shopify Admin on every page load.

CREATE TABLE "ChatConversion" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "totalAmount" DOUBLE PRECISION,
    "currency" TEXT,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatConversion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatConversion_shop_orderId_key" ON "ChatConversion"("shop", "orderId");
CREATE INDEX "ChatConversion_shop_idx" ON "ChatConversion"("shop");
CREATE INDEX "ChatConversion_shop_createdAt_idx" ON "ChatConversion"("shop", "createdAt");
CREATE INDEX "ChatConversion_createdAt_idx" ON "ChatConversion"("createdAt");
