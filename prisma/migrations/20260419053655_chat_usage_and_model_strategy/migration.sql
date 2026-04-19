-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "modelStrategy" TEXT NOT NULL DEFAULT 'smart';

-- CreateTable
CREATE TABLE "ChatUsage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatUsage_shop_idx" ON "ChatUsage"("shop");

-- CreateIndex
CREATE INDEX "ChatUsage_shop_createdAt_idx" ON "ChatUsage"("shop", "createdAt");
