-- CreateTable
CREATE TABLE "CustomerAccountToken" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "storefrontDomain" TEXT,
    "state" TEXT,
    "codeVerifier" TEXT,
    "customerId" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccountToken_state_key" ON "CustomerAccountToken"("state");

-- CreateIndex
CREATE INDEX "CustomerAccountToken_shop_customerId_idx" ON "CustomerAccountToken"("shop", "customerId");
