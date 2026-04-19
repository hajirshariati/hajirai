-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "supportLabel" TEXT NOT NULL DEFAULT 'Contact customer service',
ADD COLUMN     "supportUrl" TEXT NOT NULL DEFAULT '';
