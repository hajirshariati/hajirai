# Hajirai — Handoff for New Claude Code Session

## What This Is

You are connected to `github.com/hajirshariati/hajirai` — a Shopify AI chat widget app called "Hajirai". The app uses Remix (React Router v7), Prisma 6.x + Postgres (hosted on Railway), Shopify App Bridge + Polaris, and the Anthropic SDK.

## What Needs To Be Done

The app already has **Step 1 (catalog sync)** deployed. You need to commit and push **Step 2 (CSV↔SKU enrichment)** and **Step 3 (tool use / agentic loop)** to `main`.

**IMPORTANT**: The repo's root IS the app (e.g. `app/routes/chat.jsx`, `prisma/schema.prisma` at root level). There is NO `hajirai-app/` subdirectory.

## After pushing, the user needs to run on their laptop:
1. `npx prisma migrate dev --name product_enrichment` (against their Railway Postgres)
2. `railway up` to deploy

## Files to Create or Modify

Below are ALL the files. For existing files, replace the ENTIRE file content. For new files, create them.

---

### FILE 1: `prisma/schema.prisma` (REPLACE ENTIRE FILE)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
  refreshToken  String?
  refreshTokenExpires DateTime?
}

model ShopConfig {
  id                  String   @id @default(cuid())
  shop                String   @unique

  assistantName       String   @default("AI Shopping Assistant")
  assistantTagline    String   @default("Smart Support for Every Step")
  greeting            String   @default("Hi! I'm your personal shopping assistant.")
  greetingCta         String   @default("What can I help you find today?")
  avatarUrl           String   @default("")
  bannerUrl           String   @default("")
  colorPrimary        String   @default("#2d6b4f")
  colorAccent         String   @default("#e8f5ee")
  colorCtaBg          String   @default("#e8f5ee")
  colorCtaText        String   @default("#2d6b4f")
  colorCtaHover       String   @default("#d6eee0")

  launcherPlaceholder String   @default("How can I help you today?")
  inputPlaceholder    String   @default("How can I help you today?")
  launcherWidth       String   @default("500")
  widgetPosition      String   @default("bottom-center")
  showBanner          Boolean  @default(true)

  cta1Label           String   @default("")
  cta1Message         String   @default("")
  cta2Label           String   @default("")
  cta2Message         String   @default("")
  cta3Label           String   @default("")
  cta3Message         String   @default("")
  cta4Label           String   @default("")
  cta4Message         String   @default("")

  qp1Label            String   @default("")
  qp1Message          String   @default("")
  qp2Label            String   @default("")
  qp2Message          String   @default("")
  qp3Label            String   @default("")
  qp3Message          String   @default("")
  qp4Label            String   @default("")
  qp4Message          String   @default("")

  ctaHint             String   @default("")
  disclaimerText      String   @default("Powered by AI")
  privacyUrl          String   @default("/pages/privacy-policy")

  anthropicApiKey     String   @default("")
  anthropicModel      String   @default("claude-sonnet-4-20250514")
  yotpoApiKey         String   @default("")
  aftershipApiKey     String   @default("")

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}

model KnowledgeFile {
  id        String   @id @default(cuid())
  shop      String
  fileName  String
  fileType  String
  fileSize  Int
  content   String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([shop])
}

model Product {
  id          String           @id @default(cuid())
  shop        String
  shopifyId   String
  handle      String
  title       String
  vendor      String?
  productType String?
  tags        String[]
  description String?
  status      String?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  variants    ProductVariant[]

  @@unique([shop, shopifyId])
  @@index([shop])
  @@index([shop, handle])
}

model ProductVariant {
  id               String   @id @default(cuid())
  productId        String
  product          Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  shopifyId        String
  sku              String?
  title            String?
  price            String?
  compareAtPrice   String?
  inventoryQty     Int?
  optionsJson      String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([productId, shopifyId])
  @@index([sku])
}

model CatalogSyncState {
  id            String    @id @default(cuid())
  shop          String    @unique
  status        String    @default("idle")
  lastSyncedAt  DateTime?
  lastError     String?
  productsCount Int       @default(0)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}

model ProductEnrichment {
  id             String   @id @default(cuid())
  shop           String
  sku            String
  data           Json
  sourceFileId   String?
  sourceFileType String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([shop, sku])
  @@index([shop])
  @@index([sourceFileId])
}
```

---

### FILE 2: `app/lib/csv.server.js` (CREATE NEW FILE)

```js
export function parseCsv(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { headers: [], rows: [] };
  }

  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter(
    (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== "")
  );
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1);
  return { headers, rows };
}

const SKU_COLUMN_CANDIDATES = [
  "sku",
  "variant_sku",
  "variant sku",
  "item_sku",
  "item sku",
  "product_sku",
  "product sku",
];

export function detectSkuColumn(headers) {
  const normalized = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of SKU_COLUMN_CANDIDATES) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function extractEnrichmentRows(content) {
  const { headers, rows } = parseCsv(content);
  if (headers.length === 0 || rows.length === 0) return null;

  const skuIdx = detectSkuColumn(headers);
  if (skuIdx === -1) return null;

  const seen = new Map();
  for (const row of rows) {
    const sku = (row[skuIdx] || "").trim();
    if (!sku) continue;

    const data = {};
    for (let j = 0; j < headers.length; j++) {
      if (j === skuIdx) continue;
      const key = headers[j];
      if (!key) continue;
      const value = row[j] !== undefined ? row[j] : "";
      data[key] = value;
    }
    seen.set(sku, data);
  }

  return {
    skuColumn: headers[skuIdx],
    rows: Array.from(seen, ([sku, data]) => ({ sku, data })),
  };
}
```

---

### FILE 3: `app/models/ProductEnrichment.server.js` (CREATE NEW FILE)

```js
import prisma from "../db.server";
import { extractEnrichmentRows } from "../lib/csv.server";

export async function upsertEnrichmentsFromCsv(shop, file, content) {
  const extracted = extractEnrichmentRows(content);
  if (!extracted) {
    return { matched: 0, total: 0, skuColumn: null, noSkuColumn: true };
  }

  const sourceFileId = file?.id || null;
  const sourceFileType = file?.fileType || null;

  if (sourceFileId) {
    await prisma.productEnrichment.deleteMany({
      where: { shop, sourceFileId },
    });
  }

  const skus = extracted.rows.map((r) => r.sku);

  const matching = skus.length
    ? await prisma.productVariant.findMany({
        where: { sku: { in: skus }, product: { shop } },
        select: { sku: true },
      })
    : [];
  const matchedSkus = new Set(matching.map((v) => v.sku));

  for (const { sku, data } of extracted.rows) {
    await prisma.productEnrichment.upsert({
      where: { shop_sku: { shop, sku } },
      update: { data, sourceFileId, sourceFileType, updatedAt: new Date() },
      create: { shop, sku, data, sourceFileId, sourceFileType },
    });
  }

  return {
    matched: matchedSkus.size,
    total: extracted.rows.length,
    skuColumn: extracted.skuColumn,
  };
}

export async function deleteEnrichmentsBySourceFile(sourceFileId) {
  if (!sourceFileId) return { count: 0 };
  return prisma.productEnrichment.deleteMany({ where: { sourceFileId } });
}

export async function countEnrichmentsByShop(shop) {
  return prisma.productEnrichment.count({ where: { shop } });
}

export async function countEnrichmentsBySourceFile(sourceFileId) {
  if (!sourceFileId) return 0;
  return prisma.productEnrichment.count({ where: { sourceFileId } });
}

export async function getEnrichmentsBySkus(shop, skus) {
  if (!skus || skus.length === 0) return [];
  return prisma.productEnrichment.findMany({
    where: { shop, sku: { in: skus } },
    select: { sku: true, data: true },
  });
}
```
