// Recommender-vs-catalog audit. Cross-references every master SKU in
// every enabled DecisionTree against the shop's synced ProductVariant
// table. Tells you exactly which SKUs the recommender will resolve to
// but cannot render (missing variants → empty product card), where
// casing or prefix mismatches break the lookup, and which clinical
// scenarios fail the per-shop catalog filter at runtime.
//
// READ-ONLY. Talks to your Postgres mirror only. Does not call the
// Shopify Admin API and does not touch production chat code paths.
//
// USAGE
//   node scripts/audit-recommender-vs-catalog.mjs
//   node scripts/audit-recommender-vs-catalog.mjs --shop=aetrex.myshopify.com
//   node scripts/audit-recommender-vs-catalog.mjs --intent=orthotic
//   node scripts/audit-recommender-vs-catalog.mjs --json
//   node scripts/audit-recommender-vs-catalog.mjs --verbose   # list every miss
//
// FLAGS
//   --shop=<domain>     Audit a specific shop (default: all enabled trees)
//   --intent=<intent>   Audit a specific tree intent (default: all)
//   --json              Print full report to stdout instead of summary
//   --verbose           Show every missing/casing miss in the console
//
// OUTPUT
//   Console summary + scripts/audit-recommender-vs-catalog.json with:
//     - missing       : master SKUs with zero matching variants
//     - casingMismatch: variants that match case-insensitively but not
//                       case-sensitively (Prisma startsWith is case-
//                       sensitive on Postgres so these silently fail
//                       the runtime filterMasterIndexByShop check)
//     - archived      : matched a variant but the parent product is
//                       DRAFT or ARCHIVED (won't show on storefront)
//     - blocked       : combinations the resolver could land on but
//                       which would resolve to a missing/archived SKU
//                       (gender + useCase + condition combos)
//     - covered       : SKU has a healthy active variant ✓

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "audit-recommender-vs-catalog.json");

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const hasFlag = (name) => args.includes(`--${name}`);

const shopArg = arg("shop");
const intentArg = arg("intent");
const jsonOnly = hasFlag("json");
const verbose = hasFlag("verbose");

const { default: prisma } = await import("../app/db.server.js");

const treeWhere = { enabled: true };
if (shopArg) treeWhere.shop = shopArg;
if (intentArg) treeWhere.intent = intentArg;

const trees = await prisma.decisionTree.findMany({
  where: treeWhere,
  select: { id: true, shop: true, intent: true, name: true, definition: true, updatedAt: true },
});

if (trees.length === 0) {
  console.log(
    `No enabled DecisionTree rows found${shopArg ? ` for shop=${shopArg}` : ""}${intentArg ? ` intent=${intentArg}` : ""}.`,
  );
  await prisma.$disconnect();
  process.exit(0);
}

const reports = [];

for (const tree of trees) {
  const definition = tree.definition || {};
  const masterIndex = Array.isArray(definition?.resolver?.masterIndex)
    ? definition.resolver.masterIndex
    : [];
  const fallback = definition?.resolver?.fallback || null;

  if (masterIndex.length === 0) {
    reports.push({
      shop: tree.shop,
      intent: tree.intent,
      treeId: tree.id,
      empty: true,
      reason: "masterIndex is empty or missing",
    });
    continue;
  }

  // Single bulk fetch: every variant whose SKU starts with any of the
  // master prefixes, scoped to this shop. Mirrors the runtime
  // filterMasterIndexByShop query exactly so we report what the chat
  // layer would actually see.
  const prefixes = [...new Set(masterIndex.map((m) => String(m.masterSku || "").trim()).filter(Boolean))];
  if (prefixes.length === 0) {
    reports.push({
      shop: tree.shop,
      intent: tree.intent,
      treeId: tree.id,
      empty: true,
      reason: "no usable masterSku values in masterIndex",
    });
    continue;
  }

  const variantRows = await prisma.productVariant.findMany({
    where: {
      OR: prefixes.map((p) => ({ sku: { startsWith: p } })),
      product: { shop: tree.shop },
    },
    select: {
      sku: true,
      productId: true,
      product: { select: { handle: true, status: true, title: true } },
    },
  });

  // Case-insensitive pass to catch casing mismatches the runtime
  // filter would silently miss. Postgres `startsWith` is case-
  // sensitive (LIKE), so a master like "L100M" can't match a variant
  // stored as "l100m07". Build the casing-insensitive set by fetching
  // every variant whose SKU contains any of the lowercase prefixes
  // (Prisma `contains` with mode:insensitive avoids raw-SQL injection
  // concerns and works on the indexed sku column).
  const lowerPrefixes = prefixes.map((p) => p.toLowerCase());
  const variantRowsCI = await prisma.productVariant.findMany({
    where: {
      OR: lowerPrefixes.map((p) => ({ sku: { startsWith: p, mode: "insensitive" } })),
      product: { shop: tree.shop },
    },
    select: {
      sku: true,
      product: { select: { handle: true, status: true, title: true } },
    },
  });

  const ciByPrefix = new Map();
  for (const v of variantRowsCI) {
    const sku = String(v.sku || "").toLowerCase();
    for (const p of prefixes) {
      if (sku.startsWith(p.toLowerCase())) {
        if (!ciByPrefix.has(p)) ciByPrefix.set(p, []);
        ciByPrefix.get(p).push(v);
        break;
      }
    }
  }

  // Group case-sensitive matches the same way.
  const csByPrefix = new Map();
  for (const v of variantRows) {
    const sku = String(v.sku || "");
    for (const p of prefixes) {
      if (sku.startsWith(p)) {
        if (!csByPrefix.has(p)) csByPrefix.set(p, []);
        csByPrefix.get(p).push(v);
        break;
      }
    }
  }

  const missing = [];
  const casingMismatch = [];
  const archived = [];
  const covered = [];
  const inactiveStatuses = new Set(["DRAFT", "draft", "ARCHIVED", "archived"]);

  for (const m of masterIndex) {
    const sku = String(m.masterSku || "").trim();
    if (!sku) continue;
    const cs = csByPrefix.get(sku) || [];
    const ci = ciByPrefix.get(sku) || [];

    if (cs.length === 0 && ci.length === 0) {
      missing.push({
        masterSku: sku,
        title: m.title || "",
        gender: m.gender || null,
        useCase: m.useCase || null,
        condition: m.condition || null,
        reason: "no variant in synced catalog (case-insensitive)",
      });
      continue;
    }

    if (cs.length === 0 && ci.length > 0) {
      casingMismatch.push({
        masterSku: sku,
        title: m.title || "",
        actualVariantSkus: ci.slice(0, 3).map((v) => v.sku),
        reason: "variant exists but with different casing — Postgres LIKE is case-sensitive so the runtime startsWith filter misses it",
      });
      continue;
    }

    const allInactive = cs.every((v) => inactiveStatuses.has(v.product?.status || ""));
    if (allInactive) {
      archived.push({
        masterSku: sku,
        title: m.title || "",
        productHandle: cs[0].product?.handle || null,
        productStatus: cs[0].product?.status || null,
        variantCount: cs.length,
      });
      continue;
    }

    covered.push({
      masterSku: sku,
      title: m.title || "",
      productHandle: cs.find((v) => !inactiveStatuses.has(v.product?.status || ""))?.product?.handle || null,
      activeVariantCount: cs.filter((v) => !inactiveStatuses.has(v.product?.status || "")).length,
    });
  }

  // Per-(gender, useCase) coverage so the merchant can see which
  // clinical scenarios are at risk of returning the empty-card
  // failure mode at chat time.
  const scenarioMap = new Map();
  for (const m of masterIndex) {
    const key = `${m.gender || "?"}|${m.useCase || "?"}`;
    if (!scenarioMap.has(key)) scenarioMap.set(key, { gender: m.gender || "?", useCase: m.useCase || "?", total: 0, healthy: 0, missing: 0 });
    const s = scenarioMap.get(key);
    s.total++;
    const sku = String(m.masterSku || "").trim();
    const cs = csByPrefix.get(sku) || [];
    const isHealthy = cs.some((v) => !inactiveStatuses.has(v.product?.status || ""));
    if (isHealthy) s.healthy++;
    else s.missing++;
  }
  const blockedScenarios = [...scenarioMap.values()]
    .filter((s) => s.missing > 0)
    .sort((a, b) => b.missing - a.missing);

  // Fallback check — runtime resolver returns `resolver.fallback`
  // when no candidates pass the hard filter, but the fallback path
  // bypasses the per-shop availability check. If the fallback SKU is
  // missing, every fallback path resolves to an empty card.
  let fallbackHealth = null;
  if (fallback?.masterSku) {
    const fbSku = String(fallback.masterSku).trim();
    const fbCS = csByPrefix.get(fbSku) || [];
    const fbCI = ciByPrefix.get(fbSku) || [];
    if (fbCS.some((v) => !inactiveStatuses.has(v.product?.status || ""))) {
      fallbackHealth = { masterSku: fbSku, status: "healthy" };
    } else if (fbCS.length === 0 && fbCI.length === 0) {
      fallbackHealth = { masterSku: fbSku, status: "missing", reason: "fallback SKU has no variant in catalog — every fallback resolution will return an empty product card" };
    } else if (fbCS.length === 0 && fbCI.length > 0) {
      fallbackHealth = { masterSku: fbSku, status: "casing-mismatch", actualVariantSkus: fbCI.slice(0, 3).map((v) => v.sku) };
    } else {
      fallbackHealth = { masterSku: fbSku, status: "all-inactive", productStatus: fbCS[0]?.product?.status || null };
    }
  }

  reports.push({
    shop: tree.shop,
    intent: tree.intent,
    treeId: tree.id,
    treeName: tree.name,
    masterIndexSize: masterIndex.length,
    coverage: {
      covered: covered.length,
      missing: missing.length,
      casingMismatch: casingMismatch.length,
      archived: archived.length,
    },
    coveragePct: Math.round((covered.length / masterIndex.length) * 100),
    fallback: fallbackHealth,
    blockedScenarios: blockedScenarios.slice(0, 25),
    missing,
    casingMismatch,
    archived,
    covered: verbose ? covered : undefined,
  });
}

await prisma.$disconnect();

if (jsonOnly) {
  console.log(JSON.stringify(reports, null, 2));
  process.exit(0);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(reports, null, 2));

// Console summary.
console.log("\n=== Recommender vs Catalog audit ===\n");
for (const r of reports) {
  if (r.empty) {
    console.log(`✗ ${r.shop} / ${r.intent} (tree=${r.treeId}) — ${r.reason}`);
    continue;
  }
  const cov = r.coverage;
  const okMark = r.coveragePct >= 95 ? "✓" : r.coveragePct >= 80 ? "~" : "✗";
  console.log(
    `${okMark} ${r.shop} / ${r.intent}  ` +
      `coverage=${cov.covered}/${r.masterIndexSize} (${r.coveragePct}%)  ` +
      `missing=${cov.missing}  casing=${cov.casingMismatch}  archived=${cov.archived}`,
  );
  if (r.fallback) {
    const f = r.fallback;
    if (f.status === "healthy") {
      console.log(`    fallback: ${f.masterSku} ✓`);
    } else {
      console.log(`    fallback: ${f.masterSku} ⚠ ${f.status}${f.reason ? ` — ${f.reason}` : ""}`);
    }
  }
  if (r.blockedScenarios.length > 0) {
    console.log(`    at-risk scenarios (gender × useCase):`);
    for (const s of r.blockedScenarios.slice(0, 8)) {
      console.log(`      ${s.gender.padEnd(8)} / ${s.useCase.padEnd(20)}  ${s.healthy}/${s.total} healthy`);
    }
    if (r.blockedScenarios.length > 8) console.log(`      …and ${r.blockedScenarios.length - 8} more`);
  }
  if (verbose) {
    if (r.missing.length > 0) {
      console.log(`    MISSING (${r.missing.length}):`);
      for (const m of r.missing.slice(0, 30)) {
        console.log(`      ${m.masterSku.padEnd(10)} ${m.title}`);
      }
      if (r.missing.length > 30) console.log(`      …and ${r.missing.length - 30} more (see JSON report)`);
    }
    if (r.casingMismatch.length > 0) {
      console.log(`    CASING MISMATCH (${r.casingMismatch.length}):`);
      for (const m of r.casingMismatch.slice(0, 10)) {
        console.log(`      seed=${m.masterSku.padEnd(10)} catalog=${m.actualVariantSkus.join(",")}`);
      }
    }
    if (r.archived.length > 0) {
      console.log(`    ARCHIVED/DRAFT (${r.archived.length}):`);
      for (const a of r.archived.slice(0, 10)) {
        console.log(`      ${a.masterSku.padEnd(10)} ${a.productHandle} [${a.productStatus}]`);
      }
    }
  }
}

console.log(`\nFull report: ${path.relative(process.cwd(), OUT_PATH)}`);
console.log(`Re-run with --verbose to print every miss inline, or --json to emit machine-readable output.\n`);
