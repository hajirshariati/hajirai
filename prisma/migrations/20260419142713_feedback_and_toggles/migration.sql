-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "showFeedback" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showFollowUps" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ChatFeedback" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "botResponse" TEXT NOT NULL,
    "products" TEXT[],
    "conversation" TEXT,
    "userHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatFeedback_shop_idx" ON "ChatFeedback"("shop");

-- CreateIndex
CREATE INDEX "ChatFeedback_shop_createdAt_idx" ON "ChatFeedback"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ChatFeedback_createdAt_idx" ON "ChatFeedback"("createdAt");
