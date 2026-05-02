// Embed every merchant's existing KnowledgeFile rows into the new
// KnowledgeChunk table. Required ONCE per shop after the
// 20260502030000_add_knowledge_chunk migration runs — without this,
// the RAG retrieval (batch 2c-3) returns zero results and falls
// back to the legacy full-dump path silently.
//
// Idempotent. Safe to run repeatedly; rebuilds chunks for each file
// each time. Each file is processed independently — a failure on
// one file doesn't block others.
//
// USAGE
//   node scripts/backfill-knowledge-chunks.mjs                    # all shops
//   node scripts/backfill-knowledge-chunks.mjs --shop=foo.myshopify.com
//   node scripts/backfill-knowledge-chunks.mjs --dry-run          # report only
//
// COST
//   Voyage / OpenAI embedding cost per shop is ~$0.001 per knowledge
//   file. Even a maximalist merchant with 10 large files = ~$0.01.
//   Trivial. Re-running is also trivial.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(`--${n}=`.length);
const hasFlag = (n) => args.includes(`--${n}`);
const shopArg = arg("shop");
const dryRun = hasFlag("dry-run");

const { default: prisma } = await import("../app/db.server.js");
const { rebuildChunksForFile, countShopChunks } = await import("../app/lib/knowledge-chunks.server.js");
const { resolveShopEmbedding } = await import("../app/lib/embeddings.server.js");
const { getShopConfig, getKnowledgeFilesWithContent } = await import("../app/models/ShopConfig.server.js");

// Pull the list of shops to process. With --shop, just one. Without,
// every shop that has at least one knowledge file.
async function listShops() {
  if (shopArg) return [shopArg];
  const rows = await prisma.knowledgeFile.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });
  return rows.map((r) => r.shop);
}

const shops = await listShops();
if (shops.length === 0) {
  console.log("No shops have knowledge files yet. Nothing to backfill.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`${dryRun ? "[DRY-RUN] " : ""}Backfilling KnowledgeChunk for ${shops.length} shop(s)…\n`);

let totalProcessed = 0;
let totalSkipped = 0;
let totalFailed = 0;

for (const shop of shops) {
  const config = await getShopConfig(shop);
  const resolved = resolveShopEmbedding(config);
  if (!resolved) {
    console.log(`  ${shop}: SKIP — no embedding provider configured`);
    totalSkipped++;
    continue;
  }

  const files = await getKnowledgeFilesWithContent(shop);
  if (files.length === 0) {
    console.log(`  ${shop}: SKIP — no knowledge files`);
    totalSkipped++;
    continue;
  }

  // The existing getKnowledgeFilesWithContent select doesn't return
  // id/fileType, but for backfill we want both — re-query directly
  // so chunks can link back to their source file (sourceFileId).
  const filesFull = await prisma.knowledgeFile.findMany({
    where: { shop },
    select: { id: true, fileName: true, fileType: true, content: true },
    orderBy: { updatedAt: "desc" },
  });

  console.log(`  ${shop}: ${filesFull.length} knowledge file(s), provider=${resolved.provider}`);

  for (const file of filesFull) {
    if (dryRun) {
      console.log(`    [DRY-RUN] would chunk + embed: ${file.fileName} (${file.fileType}, ${file.content?.length || 0} chars)`);
      continue;
    }
    try {
      const result = await rebuildChunksForFile(prisma, {
        shop,
        sourceFileId: file.id,
        fileType: file.fileType,
        content: file.content,
        provider: resolved.provider,
        apiKey: resolved.apiKey,
      });
      if (result.skipped) {
        console.log(`    ${file.fileName}: skipped (${result.reason})`);
      } else if (result.error) {
        console.log(`    ${file.fileName}: FAILED — ${result.error}`);
        totalFailed++;
      } else {
        console.log(`    ${file.fileName}: ${result.processed} chunk(s) embedded (replaced ${result.removed || 0})`);
        totalProcessed += result.processed;
      }
    } catch (err) {
      console.log(`    ${file.fileName}: ERROR — ${err?.message || err}`);
      totalFailed++;
    }
  }

  if (!dryRun) {
    const total = await countShopChunks(prisma, shop);
    console.log(`    → total chunks in shop: ${total}`);
  }
}

console.log(`\n${dryRun ? "[DRY-RUN] " : ""}Done. processed=${totalProcessed} skipped=${totalSkipped} failed=${totalFailed}`);
await prisma.$disconnect();
process.exit(totalFailed > 0 ? 1 : 0);
