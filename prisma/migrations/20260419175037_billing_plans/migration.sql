-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "subscriptionActivatedAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT;
