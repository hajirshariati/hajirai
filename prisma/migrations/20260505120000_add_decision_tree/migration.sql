-- Decision Tree Engine — clinical/expert funnels (e.g. Aetrex's orthotic
-- finder). Default OFF on every shop; merchants opt in after defining at
-- least one DecisionTree row. When false, chat behavior is identical to
-- pre-migration. See app/models/DecisionTree.server.js for the runtime
-- contract and prisma/schema.prisma for the JSON shape of `definition`.

ALTER TABLE "ShopConfig"
  ADD COLUMN "decisionTreeEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DecisionTree" (
  "id"                   TEXT NOT NULL,
  "shop"                 TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "intent"               TEXT NOT NULL,
  "triggerPhrases"       TEXT NOT NULL DEFAULT '[]',
  "triggerCategoryGroup" TEXT,
  "definition"           JSONB NOT NULL,
  "enabled"              BOOLEAN NOT NULL DEFAULT false,
  "startedCount"         INTEGER NOT NULL DEFAULT 0,
  "completedCount"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DecisionTree_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DecisionTree_shop_intent_key" ON "DecisionTree"("shop", "intent");
CREATE INDEX "DecisionTree_shop_idx"               ON "DecisionTree"("shop");
CREATE INDEX "DecisionTree_shop_enabled_idx"       ON "DecisionTree"("shop", "enabled");
