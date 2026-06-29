-- Revert the "Visualize My Look" configurable scene theme. The add migration
-- (20260630120000) stays in history (it may already be applied); this drops the
-- column forward so the schema and database match again.
ALTER TABLE "ShopConfig" DROP COLUMN IF EXISTS "visualizeScenePrompt";
