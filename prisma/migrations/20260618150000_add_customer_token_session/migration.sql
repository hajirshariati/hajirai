-- AlterTable
ALTER TABLE "CustomerAccountToken" ADD COLUMN "chatSessionId" TEXT;

-- CreateIndex
CREATE INDEX "CustomerAccountToken_shop_chatSessionId_idx" ON "CustomerAccountToken"("shop", "chatSessionId");
