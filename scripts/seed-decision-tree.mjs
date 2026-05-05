#!/usr/bin/env node
// Seeds (or updates) a DecisionTree row for a given shop from a
// JSON definition file. Idempotent — running twice with the same
// inputs is safe; the second run upserts and bumps updatedAt.
//
// Usage:
//   node scripts/seed-decision-tree.mjs \
//        --shop=aetrex-us.myshopify.com \
//        --intent=orthotic \
//        --name="Aetrex Orthotic Finder" \
//        --definition=scripts/seeds/aetrex-orthotic-tree.json \
//        [--enabled=false] \
//        [--triggerPhrases="orthotic,insole,arch support,custom orthotic"]
//
// Flags can also be set via environment for CI:
//   SEED_SHOP, SEED_INTENT, SEED_NAME, SEED_DEFINITION_PATH,
//   SEED_ENABLED, SEED_TRIGGER_PHRASES
//
// Notes:
//   • Does NOT flip ShopConfig.decisionTreeEnabled. The merchant
//     does that explicitly from the admin once the tree is reviewed.
//   • Validates the definition with the same validator the runtime
//     uses — refuses to write a malformed tree.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import prisma from "../app/db.server.js";
import { saveDecisionTree, getDecisionTreeByIntent } from "../app/models/DecisionTree.server.js";
import { validateDecisionTree } from "../app/lib/decision-tree-schema.server.js";

function flag(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (arg) return arg.slice(name.length + 3);
  return process.env[`SEED_${name.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`] ?? fallback;
}

const shop = flag("shop");
const intent = flag("intent", "orthotic");
const name = flag("name", "Decision Tree");
const definitionPath = flag("definition");
const enabled = String(flag("enabled", "false")).toLowerCase() === "true";
const triggerPhrasesRaw = flag("triggerPhrases", "");

if (!shop) {
  console.error("--shop is required");
  process.exit(1);
}
if (!definitionPath) {
  console.error("--definition is required");
  process.exit(1);
}

const definition = JSON.parse(readFileSync(resolve(definitionPath), "utf8"));
const v = validateDecisionTree(definition);
if (!v.ok) {
  console.error("Invalid tree definition:");
  for (const e of v.errors) console.error("  -", e);
  process.exit(1);
}

const triggerPhrases = JSON.stringify(
  triggerPhrasesRaw
    ? triggerPhrasesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["orthotic", "orthotics", "insole", "insoles", "arch support", "custom orthotic"],
);

try {
  const existing = await getDecisionTreeByIntent(shop, intent);
  const saved = await saveDecisionTree(shop, {
    id: existing?.id,
    name,
    intent,
    triggerPhrases,
    triggerCategoryGroup: "Orthotics",
    definition,
    enabled,
  });
  const masterCount = (definition.resolver?.masterIndex || []).length;
  console.log(
    `[seed] ${existing ? "updated" : "created"} DecisionTree ${saved.id} ` +
      `(shop=${shop} intent=${intent} masters=${masterCount} enabled=${enabled})`,
  );
  console.log(
    `[seed] To activate, flip ShopConfig.decisionTreeEnabled=true in admin (or DB).`,
  );
  await prisma.$disconnect();
  process.exit(0);
} catch (err) {
  console.error("[seed] failed:", err?.message || err);
  await prisma.$disconnect();
  process.exit(1);
}
