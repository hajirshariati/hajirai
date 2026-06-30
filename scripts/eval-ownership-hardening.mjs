// OWNERSHIP HARDENING regression suite (legacy-owner cleanup phase).
//
// Asserts the TurnPlan-ownership contract the legacy-owner audit hardened:
//   1. condition_recommendation must NOT ask a gender/orthotic clarifier — the
//      orthotic gate defers when TurnPlan says clarify=false.
//   2. prior_evidence_availability is a forced-display workflow, so the
//      prior_evidence_zero_cards invariant guards "search hits → not finalCards=0".
//   3. a broad gender request drops stale category/condition/width.
//   4. named-product styling keeps the named card visible (show_focused).
//   5. a policy/account turn suppresses cards (and customer_service hands off).
// Plus: the canonical logTurnInvariant() helper emits one [turn-invariant] line
//       so EVERY turn — including deterministic dispatcher early-returns — ends
//       with an ownership record.
//
// Run: node scripts/eval-ownership-hardening.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planTurn, planForcesProductDisplay } from "../app/lib/turn-plan.server.js";
import { maybeRunOrthoticFlow } from "../app/lib/orthotic-flow-gate.server.js";
import { resolveTurnIntent } from "../app/lib/turn-intent.server.js";
import { parseAvailabilityConstraints } from "../app/lib/availability-truth.js";
import { logTurnInvariant } from "../app/lib/turn-invariant.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const orthoticTree = { intent: "orthotic", definition: JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8")) };

let pass = 0, fail = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}

function mockSse() {
  const events = [];
  return {
    events,
    encoder: { encode: (s) => s },
    controller: { enqueue: (s) => events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim())) },
  };
}

console.log("\nownership hardening\n");

// 1 ── condition_recommendation must not ask a gender/orthotic clarifier ───────
await test("1. condition_recommendation: TurnPlan disallows clarify, gate DEFERS (no seed Q)", async () => {
  const plan = planTurn({ message: "Show me supportive shoes for standing all day" });
  assert.equal(plan.workflow, "condition_recommendation");
  assert.equal(plan.clarificationAllowed, false, "condition_recommendation must disallow clarification");
  assert.ok(planForcesProductDisplay(plan), "condition_recommendation must force product display");

  // The orthotic gate must defer to the LLM and emit NO seed question, even
  // though the message is condition-shaped (the old gate would ask gender first).
  const { events, encoder, controller } = mockSse();
  const messages = [{ role: "user", content: "I have plantar fasciitis, what supportive shoes do you have?" }];
  const out = await maybeRunOrthoticFlow({ messages, tree: orthoticTree, shop: "t.myshopify.com", controller, encoder, turnPlan: plan });
  assert.equal(out.handled, false, `gate must DEFER, got handled=${out.handled}`);
  assert.equal(out.case, "turn_plan_owns_condition_recommendation", `expected turn-plan override case, got ${out.case}`);
  const askedClarifier = events.some((e) => e?.type === "text" &&
    /(what kind of|men'?s or women'?s|are you (looking|shopping)|orthotic insole)/i.test(e.text || ""));
  assert.equal(askedClarifier, false, "gate must NOT emit any clarifier/seed question");
});

// 2 ── prior_evidence_availability with hits must not end finalCards=0 ─────────
await test("2. prior_evidence_availability is forced-display (zero-card invariant guards it)", () => {
  const plan = planTurn({
    message: "What about wide widths?",
    hasPriorCards: true,
    priorCardFamilies: ["Reagan", "Sandra", "Maui"],
    attrs: { gender: "women" },
  });
  assert.equal(plan.workflow, "prior_evidence_availability");
  assert.equal(plan.productDisplayPolicy, "show_availability");
  // planForcesProductDisplay === true is exactly the predicate the runtime
  // prior_evidence_zero_cards invariant uses to assert "search-found must show
  // cards" — so this turn can never silently finish at finalCards=0.
  assert.ok(planForcesProductDisplay(plan), "show_availability must force display");
  assert.equal(parseAvailabilityConstraints("What about wide widths?").width, "wide");
  // Gender stays the customer's line — no men fail-open.
  assert.equal(plan.gender, "women");
});

// 3 ── broad gender request must not inherit stale category/condition/width ────
await test("3. broad gender request drops stale category/condition/width", () => {
  const plan = planTurn({ message: "Show me men’s options", hasPriorCards: true, attrs: { gender: "men" } });
  assert.equal(plan.workflow, "browse");
  assert.equal(plan.gender, "men");
  const intent = resolveTurnIntent({
    latestUserText: "Show me men’s options",
    previousScope: { gender: "men", category: "footwear", color: "black", width: "wide", condition: "heel_pain" },
  });
  for (const k of ["category", "color", "width", "condition"]) {
    assert.ok(intent.staleKeysToDrop.includes(k), `must drop ${k}; got ${JSON.stringify(intent.staleKeysToDrop)}`);
  }
});

// 4 ── named product styling must keep the named product card visible ─────────
await test("4. named_product_advisory styling keeps the named card (show_focused)", () => {
  const plan = planTurn({ message: "i want to wear gabby with a short white dress", namedProduct: true });
  assert.equal(plan.workflow, "named_product_advisory");
  assert.equal(plan.productDisplayPolicy, "show_focused");
  assert.ok(planForcesProductDisplay(plan), "styling a named product must keep its card visible");
});

// 5 ── policy/account turn suppresses cards (+ customer_service hands off) ──────
await test("5. policy/account suppresses cards; customer_service routes to handoff", () => {
  const policy = planTurn({ message: "What is your return policy?" });
  assert.equal(policy.workflow, "policy_knowledge");
  assert.equal(policy.productDisplayPolicy, "suppress");
  assert.equal(planForcesProductDisplay(policy), false, "policy turn must NOT force product cards");

  const cs = planTurn({ message: "I need to cancel my order" });
  assert.equal(cs.workflow, "account_private_handoff");
  assert.equal(cs.productDisplayPolicy, "suppress");
  assert.equal(planForcesProductDisplay(cs), false, "account_private_handoff must suppress cards (deterministic handoff owns the turn)");
});

// 6 ── every turn ends with a canonical [turn-invariant] log ───────────────────
await test("6. logTurnInvariant emits one canonical ownership line", () => {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    logTurnInvariant({ workflow: "policy_account", answerOwner: "policy-engine", cardOwner: "none", finalCards: 0, path: "policy-engine" });
  } finally { console.log = orig; }
  assert.equal(lines.length, 1, "exactly one line");
  const line = lines[0];
  assert.match(line, /^\[turn-invariant\] /);
  for (const f of ["workflow=policy_account", "answerOwner=policy-engine", "cardOwner=none", "finalCards=0", "path=policy-engine"]) {
    assert.ok(line.includes(f), `line must include ${f}; got: ${line}`);
  }
});

console.log("");
if (fail === 0) {
  console.log(`✅  ${pass} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${pass} passed, ${fail} failed\n`);
  for (const f of fails) console.log(`  ${f.name}\n    ${f.err.message}`);
  process.exit(1);
}
