-- "Visualize My Look" feature: AI styling-preview image for a single
-- recommended product. Idempotent (IF NOT EXISTS) so databases that
-- already received these columns via `prisma db push` are untouched.

-- ShopConfig: feature toggle, provider selection, Google AI key, CTA label.
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "visualizeLookEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "imageProvider" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "geminiApiKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "visualizeLookLabel" TEXT NOT NULL DEFAULT 'Visualize My Look';

-- ChatUsage: per-turn image-generation accounting (priced separately).
ALTER TABLE "ChatUsage" ADD COLUMN IF NOT EXISTS "imageCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatUsage" ADD COLUMN IF NOT EXISTS "imageCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
