-- Cheat code for CS team: exact phrase typed in chat dumps all
-- active campaigns. Default empty disables the feature.

ALTER TABLE "ShopConfig" ADD COLUMN "campaignCheatCode" TEXT NOT NULL DEFAULT '';
