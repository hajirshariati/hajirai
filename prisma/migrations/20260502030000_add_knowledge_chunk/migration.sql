-- KnowledgeChunk: per-merchant, per-section chunk of a knowledge
-- file with semantic embedding for RAG retrieval. Replaces the
-- "dump every knowledge file in every prompt" pattern with
-- per-turn retrieval of the top-K relevant chunks.

CREATE TABLE "KnowledgeChunk" (
    "id"                 TEXT NOT NULL,
    "shop"               TEXT NOT NULL,
    "sourceFileId"       TEXT,
    "fileType"           TEXT NOT NULL,
    "sectionTitle"       TEXT,
    "chunkIndex"         INTEGER NOT NULL,
    "content"            TEXT NOT NULL,
    "embeddingProvider"  TEXT,
    "embeddingUpdatedAt" TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- pgvector column managed outside Prisma (same as Product.embedding).
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embedding" vector(1024);

CREATE INDEX "KnowledgeChunk_shop_idx" ON "KnowledgeChunk"("shop");
CREATE INDEX "KnowledgeChunk_shop_fileType_idx" ON "KnowledgeChunk"("shop", "fileType");
CREATE INDEX "KnowledgeChunk_sourceFileId_idx" ON "KnowledgeChunk"("sourceFileId");
