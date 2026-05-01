-- Campaign: per-shop scheduled marketing campaigns. The chat reads
-- only those where NOW() is between startsAt and endsAt, so expired
-- campaigns disappear from the system prompt automatically.

CREATE TABLE "Campaign" (
    "id"        TEXT NOT NULL,
    "shop"      TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    "startsAt"  TIMESTAMP(3) NOT NULL,
    "endsAt"    TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Campaign_shop_idx" ON "Campaign"("shop");
CREATE INDEX "Campaign_shop_startsAt_endsAt_idx" ON "Campaign"("shop", "startsAt", "endsAt");
