-- Welcome glow animation tuning fields. All exposed to merchants via
-- admin → Settings → Widget visibility → Welcome panel intro effect.

ALTER TABLE "ShopConfig"
  ADD COLUMN "welcomeGlowBorderWidth" INTEGER          NOT NULL DEFAULT 2,
  ADD COLUMN "welcomeGlowSize"        INTEGER          NOT NULL DEFAULT 18,
  ADD COLUMN "welcomeGlowFadeInMs"    INTEGER          NOT NULL DEFAULT 1500,
  ADD COLUMN "welcomeGlowHoldMs"      INTEGER          NOT NULL DEFAULT 4000,
  ADD COLUMN "welcomeGlowFadeOutMs"   INTEGER          NOT NULL DEFAULT 2000,
  ADD COLUMN "welcomeGlowSpeed"       DOUBLE PRECISION NOT NULL DEFAULT 1.0;
