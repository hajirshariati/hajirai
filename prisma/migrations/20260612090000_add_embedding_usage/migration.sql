-- Per-chat semantic-search (embedding) usage. Query-time embedding
-- calls (semantic product search + RAG retrieval) previously went
-- unaccounted — ChatUsage.costUsd covered Anthropic tokens only.
-- These columns let every cost total/chart reflect true spend.
ALTER TABLE "ChatUsage" ADD COLUMN IF NOT EXISTS "embeddingTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatUsage" ADD COLUMN IF NOT EXISTS "embeddingCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
