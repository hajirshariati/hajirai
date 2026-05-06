import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTree,
  stepTree,
  extractTreeStateFromHistory,
} from "../app/lib/decision-tree-engine.server.js";
import { resolveTree } from "../app/lib/decision-tree-resolver.server.js";
import { validateDecisionTree, fingerprintTree } from "../app/lib/decision-tree-schema.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const definition = JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8"));
const tree = { id: "aetrex-orthotic", intent: "orthotic", definition };

let pass = 0;
let fail = 0;
function ok(label) { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) { console.log(`  ✗ ${label}\n      ${err?.message || err}`); fail++; }

function check(label, fn) {
  try { fn(); ok(label); } catch (err) { bad(label, err); }
}

// 1. Schema validation
console.log("\nschema");
check("seed validates", () => {
  const v = validateDecisionTree(definition);
  assert(v.ok, v.errors.join("; "));
});
check("fingerprint stable", () => {
  const a = fingerprintTree(definition);
  const b = fingerprintTree(definition);
  assert.equal(a, b);
  assert(a.length > 0);
});

// 2. Resolver determinism (same input → same output every time)
console.log("\nresolver determinism");
check("3x same answer set yields same SKU", () => {
  const attrs = { gender: "Men", useCase: "dress", arch: "Medium / High Arch", posted: false, metSupport: false };
  const r1 = resolveTree(attrs, definition.resolver);
  const r2 = resolveTree(attrs, definition.resolver);
  const r3 = resolveTree(attrs, definition.resolver);
  assert.equal(r1.resolved?.masterSku, r2.resolved?.masterSku);
  assert.equal(r2.resolved?.masterSku, r3.resolved?.masterSku);
  assert(r1.resolved?.masterSku, "no SKU resolved");
});

// 3. Clinical scenarios — these are the doctor-grade requirements
console.log("\nclinical scenarios");

function runScenario(prefill, replies) {
  let { nextState, response } = startTree(tree, { prefill });
  for (const r of replies) {
    if (response.completed) break;
    ({ nextState, response } = stepTree(tree, nextState, r));
  }
  return { state: nextState, response };
}

// New tree order: useCase first, then gender, then condition, arch,
// overpronation. Reply lists below match that order.

check("Plantar Fasciitis + dress (Men) → PFKM", () => {
  const { response } = runScenario({}, ["dress", "Men", "plantar_fasciitis", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "PFKM");
});

check("Heel Spurs + casual (Women) → L2460W", () => {
  const { response } = runScenario({}, ["casual", "Women", "heel_spurs", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "L2460W");
});

check("Cleats + ball-of-foot (Men) → L1205U — gender auto-skipped", () => {
  // Skates / cleats are Unisex-only in the catalog. With the new
  // order (useCase first), the gender question auto-skips because
  // only one chip survives the dynamic filter. Customer doesn't
  // see "Who are these for?" at all.
  const { response, state } = runScenario(
    {},
    ["cleats", "metatarsalgia", "Medium / High Arch", "no"],
  );
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "L1205U");
  assert.equal(state.answers.gender, "Unisex", "gender should be auto-set to Unisex");
  assert.equal(state.answers.metSupport, true);
});

check("Skates + no condition (any gender) → L2500X — gender auto-skipped", () => {
  const { state, response } = runScenario({}, ["skates", "none", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "L2500X");
  assert.equal(state.answers.gender, "Unisex");
});

check("Diabetic + casual (Men) → L200M (Conform)", () => {
  const { response } = runScenario({}, ["casual", "Men", "diabetic", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert(response.resolved?.masterSku?.startsWith("L20"), `got ${response.resolved?.masterSku}`);
});

check("Flat arch derives posted=true (Women, athletic running)", () => {
  const { state, response } = runScenario({}, ["athletic_running", "Women", "none", "Flat / Low Arch"]);
  assert(response.completed);
  assert.equal(state.answers.posted, true);
  assert(/posted/i.test(response.resolved?.title || ""), `expected posted SKU, got ${response.resolved?.title}`);
});

check("Overpronation Yes derives posted=true even when no posted SKU exists for that arch", () => {
  const { state, response } = runScenario({}, ["casual", "Men", "none", "Medium / High Arch", "yes"]);
  assert(response.completed);
  assert.equal(state.answers.posted, true, "derivation should set posted=true");
  assert(response.resolved?.masterSku, "must resolve a SKU even when posted variant is missing");
});

check("Flat arch + Casual finds the actual posted SKU", () => {
  const { state, response } = runScenario({}, ["casual", "Men", "none", "Flat / Low Arch"]);
  assert(response.completed);
  assert.equal(state.answers.posted, true);
  assert(/posted/i.test(response.resolved?.title || ""),
    `expected posted SKU for flat arch, got ${response.resolved?.title}`);
});

check("Pre-filled gender (Men) — gender question auto-skips when only one chip is viable", () => {
  // With prefill, advance() uses skipIfKnown to skip past gender.
  const { state, response } = runScenario({ gender: "Men" }, ["dress", "none", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(state.answers.gender, "Men");
});

check("Kids → casual → resolves to a Kids SKU", () => {
  // Kids is exposed as a gender chip; useCases for Kids are casual,
  // dress, kids (sport). After picking 'casual' use case, gender
  // chip pruning leaves Men/Women/Kids (no Unisex casual SKUs in
  // catalog), so Kids is selectable.
  const { state, response } = runScenario({}, ["casual", "Kids", "none", "Medium / High Arch", "no"]);
  assert(response.completed, `did not complete; node=${state.currentNodeId}`);
  assert.equal(state.answers.gender, "Kids");
  assert(response.resolved?.masterSku);
});

// Dynamic chip pruning + single-option auto-skip (merchant-requested):
// gender chips after useCase=skates should reduce to only Unisex
// and the engine should auto-fill gender without ever asking.
console.log("\nchip pruning + auto-skip");

check("After useCase=skates, gender question is auto-skipped (only Unisex viable)", () => {
  let { nextState, response } = startTree(tree);
  // Q1 should be useCase
  assert(response.text.includes("kind of shoes"), `expected useCase question, got ${response.text}`);
  ({ nextState, response } = stepTree(tree, nextState, "skates"));
  // Should NOT show q_gender — should jump straight to q_condition
  assert(response.text.includes("foot pain") || response.text.includes("condition"),
    `expected condition question, got ${response.text}`);
  assert.equal(nextState.answers.gender, "Unisex", "gender auto-set to Unisex");
});

check("After useCase=cleats, gender question is auto-skipped", () => {
  let { nextState, response } = startTree(tree);
  ({ nextState, response } = stepTree(tree, nextState, "cleats"));
  assert.equal(nextState.answers.gender, "Unisex");
  assert(!response.text.includes("Who are these"), "gender question should not be shown");
});

check("After useCase=casual, gender chips are pruned to Men/Women/Kids (no Unisex casual SKUs)", () => {
  let { nextState, response } = startTree(tree);
  ({ nextState, response } = stepTree(tree, nextState, "casual"));
  const chipValues = (response.chips || []).map((c) => c.value).sort();
  assert.deepEqual(chipValues, ["Kids", "Men", "Women"],
    `expected pruned to Men/Women/Kids; got ${JSON.stringify(chipValues)}`);
});

check("Boys and Girls are no longer offered as gender chips (collapsed into Kids)", () => {
  const genderNode = definition.nodes.find((n) => n.id === "q_gender");
  const labels = genderNode.chips.map((c) => c.label);
  assert(!labels.includes("Boys"), "Boys chip removed");
  assert(!labels.includes("Girls"), "Girls chip removed");
  assert(labels.includes("Kids"), "Kids chip present");
  assert(labels.includes("Unisex"), "Unisex chip present");
});

check("Smart-quote apostrophes match chip labels (macOS auto-correct fix)", () => {
  // Customer typing "Morton's neuroma" with curly apostrophe (auto-correct
  // on macOS) used to fail the literal match against the straight-quote
  // chip label. matchChip now normalizes typographic punctuation.
  const { state, response } = runScenario({}, ["casual", "Women", "Morton’s neuroma", "Medium / High Arch", "no"]);
  assert(response.completed, `did not complete; node=${state.currentNodeId}`);
  assert.equal(state.answers.condition, "mortons_neuroma");
});

check("Unmatched user reply re-asks (no advance)", () => {
  let { nextState, response } = startTree(tree);
  ({ nextState, response } = stepTree(tree, nextState, "I have no idea"));
  assert(!response.completed);
  assert(response.unmatched, "expected unmatched flag");
  assert(nextState.currentNodeId === definition.rootNodeId, "should not advance on unmatched");
});

// 4. State reconstruction parity — what the engine reconstructs from
// message history must equal what step-by-step yields. This is the
// key invariant that lets us avoid storing transient state per turn.
console.log("\nstate reconstruction");
check("history walk == live step (medium scenario)", () => {
  // New order: useCase, gender, condition, arch, overpronation.
  const replies = ["casual", "Men", "plantar_fasciitis", "Medium / High Arch", "no"];
  // Live step
  let { nextState: liveState, response: liveResp } = startTree(tree);
  const messages = [];
  for (const r of replies) {
    messages.push({ role: "assistant", content: liveResp.text });
    messages.push({ role: "user", content: r });
    if (liveResp.completed) break;
    ({ nextState: liveState, response: liveResp } = stepTree(tree, liveState, r));
  }
  // Reconstruct from those messages
  const reconstructed = extractTreeStateFromHistory(tree, messages);
  assert.equal(reconstructed.completed, liveState.completed);
  assert.equal(reconstructed.currentNodeId, liveState.currentNodeId);
  assert.deepEqual(reconstructed.answers, liveState.answers);
  if (liveState.completed) {
    assert.equal(reconstructed.resolved?.masterSku, liveState.resolved?.masterSku);
  }
});

// Mid-funnel lock: if state has any answers and isn't completed,
// we treat the tree as in-progress. The dispatcher uses the same
// signal to override category-intent and prevent LLM hijack.
console.log("\nmid-funnel lock signal");
check("after one answer, state is in-progress (non-empty answers, not completed)", () => {
  let { nextState } = startTree(tree);
  ({ nextState } = stepTree(tree, nextState, "casual"));
  assert(Object.keys(nextState.answers).length > 0, "answers should be populated");
  assert(!nextState.completed, "should not be completed");
});

check("dispatcher source has findInProgressTree + chip-matcher hook", () => {
  const src = readFileSync(resolve(here, "../app/lib/decision-tree-dispatch.server.js"), "utf8");
  assert(/function\s+findInProgressTree/.test(src), "missing findInProgressTree");
  assert(/llmMatchChip/.test(src), "missing llmMatchChip");
  assert(/CHIP_MATCHER_MODEL/.test(src), "missing CHIP_MATCHER_MODEL constant");
  // Mid-funnel lock must run BEFORE pickActiveTree fallback.
  const inProgressIdx = src.indexOf("findInProgressTree(trees");
  const pickActiveIdx = src.indexOf("pickActiveTree(trees,");
  assert(inProgressIdx > 0, "findInProgressTree call site not found");
  assert(pickActiveIdx > 0, "pickActiveTree call site not found");
  assert(inProgressIdx < pickActiveIdx, "findInProgressTree must be checked before pickActiveTree");
});

// 5. Regression: with the master flag OFF, the dispatcher must be
// a strict no-op — no DB calls, no compute, just `handled: false`.
// This is the property that lets us ship without touching the
// existing 9/10 chat behavior.
console.log("\nregression: flag-off is no-op");
check("dispatch source short-circuits on decisionTreeEnabled !== true", () => {
  const src = readFileSync(resolve(here, "../app/lib/decision-tree-dispatch.server.js"), "utf8");
  // The early return must appear before any prisma/await reference
  // inside dispatchDecisionTree.
  const fn = src.slice(src.indexOf("export async function dispatchDecisionTree"));
  const flagCheckIdx = fn.indexOf("decisionTreeEnabled !== true");
  const firstAwait = fn.indexOf("await ");
  assert(flagCheckIdx > 0, "missing flag check");
  assert(firstAwait > flagCheckIdx,
    "early-return for flag-off must precede any await — otherwise flag-off paths could trigger DB I/O");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
