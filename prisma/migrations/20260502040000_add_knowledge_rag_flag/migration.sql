-- Per-shop opt-in flag for the RAG path in chat-prompt.server.js.
-- Default OFF: feature requires (1) embedding provider configured,
-- (2) backfill of existing knowledge files run, (3) the merchant
-- (or admin) explicitly turning it on. Off = legacy full-dump path.

ALTER TABLE "ShopConfig" ADD COLUMN "knowledgeRagEnabled" BOOLEAN NOT NULL DEFAULT false;
