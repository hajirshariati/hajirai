-- Enable the pgvector extension. Safe to run repeatedly.
CREATE EXTENSION IF NOT EXISTS vector;

-- Per-merchant semantic search config (provider + encrypted API keys).
ALTER TABLE "ShopConfig" ADD COLUMN "embeddingProvider" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "voyageApiKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "openaiApiKey" TEXT NOT NULL DEFAULT '';

-- Product embeddings. 1024 dimensions works for both providers when
-- configured: Voyage voyage-3 is natively 1024; OpenAI
-- text-embedding-3-small is requested with dimensions=1024 to match.
-- Nullable so existing products without embeddings stay valid.
ALTER TABLE "Product" ADD COLUMN "embedding" vector(1024);
ALTER TABLE "Product" ADD COLUMN "embeddingUpdatedAt" TIMESTAMP;

-- Index for fast cosine-distance ANN search. ivfflat is the simplest
-- index type; for small catalogs (<10k products) it works well.
-- The list count of 100 is a reasonable starting point.
CREATE INDEX IF NOT EXISTS "Product_embedding_idx"
  ON "Product" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
