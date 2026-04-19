-- CreateTable
CREATE TABLE "ChatProductMention" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatProductMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatProductMention_shop_idx" ON "ChatProductMention"("shop");

-- CreateIndex
CREATE INDEX "ChatProductMention_shop_createdAt_idx" ON "ChatProductMention"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ChatProductMention_shop_handle_idx" ON "ChatProductMention"("shop", "handle");

-- CreateIndex
CREATE INDEX "ChatProductMention_createdAt_idx" ON "ChatProductMention"("createdAt");
