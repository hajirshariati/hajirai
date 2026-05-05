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

check("Plantar Fasciitis + dress (Men) → PFKM", () => {
  const { response } = runScenario({}, ["Men", "dress", "plantar_fasciitis", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "PFKM");
});

check("Heel Spurs + casual (Women) → L2460W", () => {
  const { response } = runScenario({}, ["Women", "casual", "heel_spurs", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "L2460W");
});

check("Cleats + ball-of-foot (Men) → L1205U (Unisex met)", () => {
  const { response, state } = runScenario({}, ["Men", "cleats", "metatarsalgia", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "L1205U");
  assert.equal(state.answers.metSupport, true);
});

check("Skates + no condition (Woman) → L2500X (Unisex)", () => {
  const { response } = runScenario({}, ["Women", "skates", "none", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(response.resolved?.masterSku, "L2500X");
});

check("Diabetic + casual (Men) → L200M (Conform)", () => {
  const { response } = runScenario({}, ["Men", "casual", "diabetic", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert(response.resolved?.masterSku?.startsWith("L20"), `got ${response.resolved?.masterSku}`);
});

check("Flat arch derives posted=true (Women, athletic running)", () => {
  const { state, response } = runScenario({}, ["Women", "athletic_running", "none", "Flat / Low Arch"]);
  assert(response.completed);
  assert.equal(state.answers.posted, true);
  assert(/posted/i.test(response.resolved?.title || ""), `expected posted SKU, got ${response.resolved?.title}`);
});

check("Overpronation Yes derives posted=true even when no posted SKU exists for that arch", () => {
  // Aetrex's catalog only stocks 'Posted' Casual SKUs in Flat/Low
  // Arch — there is no Medium/High + Posted Casual master. The
  // derivation must still fire (spec: posted = flat OR overpron),
  // and the resolver must gracefully fall back to the closest
  // non-posted match rather than dead-end.
  const { state, response } = runScenario({}, ["Men", "casual", "none", "Medium / High Arch", "yes"]);
  assert(response.completed);
  assert.equal(state.answers.posted, true, "derivation should set posted=true");
  assert(response.resolved?.masterSku, "must resolve a SKU even when posted variant is missing");
});

check("Flat arch + Casual finds the actual posted SKU", () => {
  // Same shape as above but with flat arch — here the catalog
  // DOES have a Posted SKU. Confirms scoring picks it.
  const { state, response } = runScenario({}, ["Men", "casual", "none", "Flat / Low Arch"]);
  assert(response.completed);
  assert.equal(state.answers.posted, true);
  assert(/posted/i.test(response.resolved?.title || ""),
    `expected posted SKU for flat arch, got ${response.resolved?.title}`);
});

check("Pre-filled gender (Men) skips Q1", () => {
  const { state, response } = runScenario({ gender: "Men" }, ["dress", "none", "Medium / High Arch", "no"]);
  assert(response.completed);
  assert.equal(state.answers.gender, "Men");
});

check("Boys → kids tree resolves in 2 taps", () => {
  const { state, response } = runScenario({}, ["Boys", "kids"]);
  assert(response.completed, `did not complete; node=${state.currentNodeId}`);
  assert(response.resolved?.masterSku);
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
  const replies = ["Men", "casual", "plantar_fasciitis", "Medium / High Arch", "no"];
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
