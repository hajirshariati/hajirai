#!/usr/bin/env node
// Merge a regenerated masterIndex (output of regenerate-orthotic-masterindex.mjs)
// into an existing tree JSON, preserving everything else (questions, chips,
// derivations, etc). Pipe-friendly so you can copy/paste the result into the
// admin → Recommenders → Edit raw JSON textarea.
//
// USAGE
//   1. Open admin → Recommenders → Aetrex tree → "View raw JSON"
//   2. Copy the whole thing into a file: tree-current.json
//   3. node scripts/merge-master-index-into-tree.mjs \
//        --tree=tree-current.json \
//        --regen=scripts/regenerated-masterindex.json \
//        > tree-merged.json
//   4. Paste tree-merged.json's contents back into the admin textarea, Save.
//
// The script does TWO things:
//   - Replaces tree.resolver.masterIndex with regen.masterIndex
//   - Replaces tree.resolver.fallback with regen.fallback
// Everything else in tree.json (nodes, requiredAttributes, derivations,
// resolverMode, etc.) is preserved verbatim.
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(`--${n}=`.length);
const treePath = arg("tree");
const regenPath = arg("regen");

if (!treePath || !regenPath) {
  console.error("Usage: node scripts/merge-master-index-into-tree.mjs --tree=<file> --regen=<file>");
  process.exit(1);
}

const tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
const regen = JSON.parse(fs.readFileSync(regenPath, "utf8"));

if (!tree.resolver) tree.resolver = {};
if (!Array.isArray(regen.masterIndex)) {
  console.error("regen file is missing masterIndex array");
  process.exit(2);
}

const oldCount = (tree.resolver.masterIndex || []).length;
tree.resolver.masterIndex = regen.masterIndex;
if (regen.fallback) tree.resolver.fallback = regen.fallback;

console.error(
  `Merged: masterIndex ${oldCount} → ${regen.masterIndex.length}` +
  (regen.fallback ? `, fallback set to ${regen.fallback.masterSku || "?"}` : ""),
);

process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
