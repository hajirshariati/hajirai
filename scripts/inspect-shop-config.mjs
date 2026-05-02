// Diagnostic for the RAG backfill chain. Reads ShopConfig for a shop
// and prints both the raw DB values and the decrypted ones, so we can
// see where the chain breaks (wrong DB, wrong ENCRYPTION_KEY, missing
// row, decrypt failure, etc).
//
// USAGE
//   node scripts/inspect-shop-config.mjs --shop=f031fc-3.myshopify.com
//
// Loads DATABASE_URL + ENCRYPTION_KEY from .env (via Prisma's dotenv).

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(`--${n}=`.length);
const shop = arg("shop");

if (!shop) {
  console.error("Usage: node scripts/inspect-shop-config.mjs --shop=<shop>");
  process.exit(1);
}

const { default: prisma } = await import("../app/db.server.js");
const { decrypt } = await import("../app/utils/encryption.server.js");

const dbHost = (process.env.DATABASE_URL || "").match(/@([^/]+)/)?.[1] || "(unknown)";
const keyLen = (process.env.ENCRYPTION_KEY || "").length;
console.log(`\n--- env ---`);
console.log(`  DATABASE_URL host:   ${dbHost}`);
console.log(`  ENCRYPTION_KEY len:  ${keyLen} ${keyLen === 64 ? "(✓ 32 bytes hex)" : "(✗ should be 64)"}`);

console.log(`\n--- raw DB row for ${shop} ---`);
const raw = await prisma.shopConfig.findUnique({ where: { shop } });
if (!raw) {
  console.log("  (no row found in this database)");
  await prisma.$disconnect();
  process.exit(2);
}
console.log(`  embeddingProvider:   "${raw.embeddingProvider}"`);
console.log(`  openaiApiKey length: ${(raw.openaiApiKey || "").length}`);
console.log(`  openaiApiKey prefix: "${(raw.openaiApiKey || "").slice(0, 12)}..."`);
console.log(`  voyageApiKey length: ${(raw.voyageApiKey || "").length}`);

console.log(`\n--- decrypt attempt ---`);
try {
  const decrypted = decrypt(raw.openaiApiKey);
  console.log(`  openaiApiKey decrypted length: ${decrypted.length}`);
  console.log(`  openaiApiKey decrypted prefix: "${decrypted.slice(0, 8)}..." (should look like "sk-...")`);
} catch (err) {
  console.log(`  ✗ decrypt threw: ${err?.message || err}`);
  console.log(`    → ENCRYPTION_KEY in this environment doesn't match the one used to encrypt this value.`);
}

await prisma.$disconnect();
