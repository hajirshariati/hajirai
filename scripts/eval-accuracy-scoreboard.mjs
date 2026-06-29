// ACCURACY SCOREBOARD — measures the engine's DETERMINISTIC routing/ownership
// accuracy over the labeled corpus (scripts/seeds/accuracy-corpus.mjs) and prints
// a real, repeatable accuracy %: overall, per-dimension, and per-tag, with a list
// of every miss (expected vs actual) so the failures are actionable.
//
// Scope: this scores planTurn() + the product-truth detectors — the layer the
// recent bug-fixing has targeted. It does NOT call the LLM or the DB, so it runs
// in milliseconds and is safe in CI. Live LLM wording quality is a separate,
// API-gated measurement.
//
// Run:  node scripts/eval-accuracy-scoreboard.mjs
//       node scripts/eval-accuracy-scoreboard.mjs --strict   (exit 1 below threshold)
//
// --strict gates CI at THRESHOLD overall accuracy; without it the script always
// exits 0 (it's a report, not a pass/fail gate) so it never blocks unrelated work.

import { planTurn, planForcesProductDisplay } from "../app/lib/turn-plan.server.js";
import { isBroadGenderRequest } from "../app/lib/turn-intent.server.js";
import { isOrthoticSandalCompatibilityQuestion } from "../app/lib/compatibility-truth.server.js";
import { CASES } from "./seeds/accuracy-corpus.mjs";

const STRICT = process.argv.includes("--strict");
const THRESHOLD = 0.9; // overall accuracy gate for --strict

// Evaluate one case → { ok, dims: {dim: bool}, actual, misses: [str] }
function evaluate(c) {
  const plan = planTurn({ message: c.message, ...(c.ctx || {}) });
  const actual = {
    workflow: plan.workflow,
    clarify: plan.clarificationAllowed,
    display: plan.productDisplayPolicy,
    forcesCards: planForcesProductDisplay(plan),
    gender: plan.gender ?? null,
    broadGender: isBroadGenderRequest(c.message),
    compatTruth: isOrthoticSandalCompatibilityQuestion(c.message),
  };
  const dims = {};
  const misses = [];
  for (const [key, want] of Object.entries(c.expect || {})) {
    const got = actual[key];
    let ok;
    if (key === "workflow" && Array.isArray(want)) ok = want.includes(got);
    else ok = got === want;
    dims[key] = ok;
    if (!ok) misses.push(`${key}: expected ${Array.isArray(want) ? JSON.stringify(want) : want}, got ${got}`);
  }
  return { ok: misses.length === 0, dims, actual, misses };
}

// Aggregate.
let casesPassed = 0;
const dimTotals = {};   // dim -> { pass, total }
const tagTotals = {};   // tag -> { pass, total }
const failures = [];

for (const c of CASES) {
  const r = evaluate(c);
  if (r.ok) casesPassed++;
  else failures.push({ id: c.id, message: c.message, misses: r.misses });
  for (const [dim, ok] of Object.entries(r.dims)) {
    (dimTotals[dim] ||= { pass: 0, total: 0 });
    dimTotals[dim].total++; if (ok) dimTotals[dim].pass++;
  }
  for (const tag of c.tags || []) {
    (tagTotals[tag] ||= { pass: 0, total: 0 });
    tagTotals[tag].total++; if (r.ok) tagTotals[tag].pass++;
  }
}

const pct = (p, t) => t === 0 ? "  n/a" : `${((100 * p) / t).toFixed(1).padStart(5)}%`;
const overall = (100 * casesPassed) / CASES.length;

console.log("\n══════════ ACCURACY SCOREBOARD ══════════");
console.log(`corpus: ${CASES.length} labeled turns  (deterministic routing/ownership layer)\n`);

console.log("Per dimension (field-level accuracy):");
for (const [dim, { pass, total }] of Object.entries(dimTotals).sort()) {
  console.log(`  ${dim.padEnd(13)} ${pct(pass, total)}   (${pass}/${total})`);
}

console.log("\nPer tag (case-level accuracy):");
for (const [tag, { pass, total }] of Object.entries(tagTotals).sort()) {
  console.log(`  ${tag.padEnd(16)} ${pct(pass, total)}   (${pass}/${total})`);
}

if (failures.length > 0) {
  console.log(`\nMisses (${failures.length}):`);
  for (const f of failures) {
    console.log(`  ✗ [${f.id}] "${f.message.slice(0, 56)}"`);
    for (const m of f.misses) console.log(`      ${m}`);
  }
}

console.log("\n─────────────────────────────────────────");
console.log(`OVERALL: ${overall.toFixed(1)}%  (${casesPassed}/${CASES.length} turns fully correct)`);
console.log("─────────────────────────────────────────\n");

if (STRICT && overall < THRESHOLD * 100) {
  console.log(`❌  below --strict threshold ${(THRESHOLD * 100).toFixed(0)}%\n`);
  process.exit(1);
}
process.exit(0);
