-- Cache for the multilingual welcome-CTA rotator. The widget shows
-- the merchant's English greetingCta then cycles through translations
-- of that exact phrase. Translations are generated on demand via
-- Anthropic Haiku and cached here so we only pay for the call once
-- per phrase change. JSON shape:
--   { "phrase": "<verbatim greetingCta>",
--     "results": [{"code","dir","text"}, ...] }
-- Empty {} means "not yet generated; generate on next widget-config".
ALTER TABLE "ShopConfig"
  ADD COLUMN "greetingCtaTranslations" TEXT NOT NULL DEFAULT '{}';

-- Merchant toggle to disable the rotator entirely (English only).
-- Default true so existing installs get the new behavior.
ALTER TABLE "ShopConfig"
  ADD COLUMN "rotateGreetingCta" BOOLEAN NOT NULL DEFAULT true;
