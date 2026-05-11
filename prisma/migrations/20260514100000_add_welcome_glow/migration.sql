-- Welcome glow intro effect config. Two columns:
--   welcomeGlowStyle  — "none" | "internal" | "external"
--   welcomeGlowColors — comma-separated hex codes, e.g. "#6366f1,#a855f7,..."
-- Default style is "internal" (matches the gradient-ring intro shipped in
-- the widget). Default palette is the indigo→purple→pink→amber→emerald→cyan
-- sweep used in the original implementation.

ALTER TABLE "ShopConfig"
  ADD COLUMN "welcomeGlowStyle"  TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN "welcomeGlowColors" TEXT NOT NULL DEFAULT '#6366f1,#a855f7,#ec4899,#f59e0b,#10b981,#06b6d4';
