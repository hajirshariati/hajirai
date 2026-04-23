ALTER TABLE "ShopConfig" ADD COLUMN "fitPredictorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN "fitPredictorConfig" TEXT NOT NULL DEFAULT '{}';
