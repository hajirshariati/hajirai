// TurnPlan failure-regression eval — the EXACT prompts from the visible
// production failures, asserted end-to-end across the deterministic layers:
//   planTurn → namedProduct gate → enforceTurnPlanOnToolCall (search args)
//   → validateGrounding (non-answer block) → exhaustion floor.
//
// No network: every layer here is a pure function the chat route calls, so
// the harness exercises the SAME code path. Live PRD checks (real tool
// results, real card counts) layer on top.
//
// Run: node scripts/eval-turn-plan-failures.mjs

import assert from "node:assert/strict";
import {
  planTurn,
  WORKFLOWS as W,
  isAnswerWorkflow,
  buildAnswerWorkflowExhaustionText,
} from "../app/lib/turn-plan.server.js";
import { enforceTurnPlanOnToolCall } from "../app/lib/chat-tool-rewrite.server.js";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

// Mirror of the production namedProduct gate (chat.jsx): a leftover
// focusProduct from a PRIOR card must NOT mark a fresh turn as named.
function computeNamedProduct(message, { messageNamesProduct = false, focusProduct = null } = {}) {
  const deicticRef = /\b(this one|that one|these|those|\bit\b|\bthis\b|\bthat\b)\b/i.test(message);
  return messageNamesProduct || (deicticRef && Boolean(focusProduct));
}

// A scoped search the model might emit, with stale men + an occasion remap.
const searchCall = (filters) => ({ name: "search_products", input: { query: "shoes", filters } });
const GENERIC_FALLBACK = "Take a look — these are the closest matches I've got.";
const GENDER_STALL = "Sure! Are you shopping for men's or women's?";

// ── B. namedProduct detection ─────────────────────────────────────────
check("B: stale focusProduct does NOT make a PF/use-case turn named", () => {
  const msg = "I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?";
  const named = computeNamedProduct(msg, { messageNamesProduct: false, focusProduct: { title: "Jillian" } });
  assert.equal(named, false);
  const plan = planTurn({ message: msg, namedProduct: named, focusProduct: "jillian", attrs: { condition: "plantar_fasciitis", useCase: "walking" } });
  assert.equal(plan.workflow, W.CONDITION_RECOMMENDATION);
});
check("B: message naming Jillian IS named", () => {
  assert.equal(computeNamedProduct("Do you have the Jillian in black size 8?", { messageNamesProduct: true }), true);
});
check("B: deictic 'it' + focusProduct IS named", () => {
  assert.equal(computeNamedProduct("Do you have it in black size 8?", { focusProduct: { title: "Jillian" } }), true);
});
check("B: deictic 'it' with NO focusProduct is NOT named", () => {
  assert.equal(computeNamedProduct("Do you have it in black?", { focusProduct: null }), false);
});

// ── Scenario 1: cute + standing all day at a wedding, Jillian? ─────────
check("1: 'standing all day at a wedding, should I get Jillian' → advisory, search, display, women", () => {
  const plan = planTurn({
    message: "I want something cute but I'll be standing all day at a wedding. Should I get Jillian or something else?",
    namedProduct: true, attrs: { useCase: "wedding" },
  });
  assert.equal(plan.workflow, W.NAMED_PRODUCT_ADVISORY);
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.gender, "women");
  assert.equal(isAnswerWorkflow(plan), true);
  // occasion remap to Loafers + stale men must both be corrected.
  const out = enforceTurnPlanOnToolCall(searchCall({ gender: "men", category: "Loafers" }), { turnPlan: plan }, searchCall({}));
  assert.equal(out.input.filters.gender, "women", "gender forced to women");
  assert.equal(out.input.filters.category, undefined, "injected Loafers dropped (named product owns search)");
  // generic fallback must be blocked for this workflow.
  const v = validateGrounding({ text: GENERIC_FALLBACK, pool: [{ title: "Jillian Sandal" }], userMessage: "should I get Jillian", workflow: plan.workflow });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "answer_workflow_non_answer"));
});

// ── Scenario 2: Jillian vs Savannah for all-day walking ───────────────
check("2: 'which is better for all-day walking, Jillian or Savannah' → comparison, women, no men", () => {
  const plan = planTurn({ message: "Which is better for all-day walking, Jillian or Savannah?", namedProduct: true, attrs: { useCase: "walking" } });
  assert.equal(plan.workflow, W.COMPARISON);
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.gender, "women");
  const out = enforceTurnPlanOnToolCall(searchCall({ gender: "men" }), { turnPlan: plan }, searchCall({ gender: "men" }));
  assert.equal(out.input.filters.gender, "women", "comparison never searches men when default is women");
});

// ── Scenario 3: Jillian in black size 8 (availability) ────────────────
check("3: 'Jillian in black size 8' → availability, preserves black+size, no stale men", () => {
  const plan = planTurn({ message: "Do you have the Jillian in black size 8?", namedProduct: true });
  assert.equal(plan.workflow, W.AVAILABILITY);
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.productDisplayPolicy, "show_availability");
  // model passed color+size; a rewrite dropped them and injected stale men.
  const original = searchCall({ color: "black", size: "8" });
  const mangled = searchCall({ gender: "men" }); // color/size dropped, men injected
  const out = enforceTurnPlanOnToolCall(mangled, { turnPlan: plan }, original);
  assert.equal(out.input.filters.color, "black", "black preserved");
  assert.equal(out.input.filters.size, "8", "size 8 preserved");
  assert.equal(out.input.filters.gender, undefined, "stale injected men dropped (family owns gender)");
});
check("3b: availability KEEPS a customer-stated gender ('his')", () => {
  const plan = planTurn({ message: "is the Lloyd in his size 11 in stock?", namedProduct: true });
  assert.equal(plan.gender, "men");
  const out = enforceTurnPlanOnToolCall(searchCall({}), { turnPlan: plan }, searchCall({}));
  assert.equal(out.input.filters.gender, "men", "stated men forced for availability");
});

// ── Scenario 4: PF sandals for walking vacation ───────────────────────
check("4: PF vacation → condition_recommendation, not named, no gender ask, women default", () => {
  const msg = "I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?";
  const named = computeNamedProduct(msg, { messageNamesProduct: false, focusProduct: { title: "Jillian" } });
  const plan = planTurn({ message: msg, namedProduct: named, attrs: { condition: "plantar_fasciitis", useCase: "walking" } });
  assert.equal(plan.workflow, W.CONDITION_RECOMMENDATION);
  assert.equal(plan.clarificationAllowed, false);
  assert.equal(plan.searchRequired, true);
  assert.equal(plan.gender, "women");
  // a gender stall must be blocked (no "men's or women's?" first).
  const v = validateGrounding({ text: GENDER_STALL, pool: [{ title: "Lynco Sandal" }], userMessage: msg, workflow: plan.workflow });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "answer_workflow_non_answer"));
});

// ── 5. General guard: generic fallback banned for answer workflows ────
for (const wf of ["availability", "comparison", "named_product_advisory", "condition_recommendation"]) {
  check(`5: generic fallback blocked for ${wf}`, () => {
    const v = validateGrounding({ text: GENERIC_FALLBACK, pool: [{ title: "X Sandal" }], userMessage: "q", workflow: wf });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.kind === "answer_workflow_non_answer"));
  });
}
check("5: generic fallback is FINE for plain browse (not an answer workflow)", () => {
  const v = validateGrounding({ text: GENERIC_FALLBACK, pool: [{ title: "X Sandal" }], userMessage: "show me sandals", workflow: "browse" });
  assert.equal(v.ok, true);
});
check("5: short yes/no availability answer is NOT blocked", () => {
  const v = validateGrounding({ text: "Yes — the Jillian is available in black, size 8.", pool: [{ title: "Jillian" }], userMessage: "Jillian black size 8?", workflow: "availability" });
  assert.equal(v.ok, true);
});

// ── Exhaustion floor: honest, never the banned phrase ─────────────────
check("exhaustion line for comparison names the products, not 'take a look'", () => {
  const plan = planTurn({ message: "Jillian or Savannah for walking?", namedProduct: true, attrs: { useCase: "walking" } });
  const txt = buildAnswerWorkflowExhaustionText(plan, [{ title: "Jillian Sandal" }, { title: "Savannah Sandal" }]);
  assert.match(txt, /Jillian Sandal/);
  assert.match(txt, /Savannah Sandal/);
  // must not itself trip the generic-fallback / clarifier block.
  const v = validateGrounding({ text: txt, pool: [{ title: "Jillian Sandal" }, { title: "Savannah Sandal" }], userMessage: "compare", workflow: "comparison" });
  assert.equal(v.ok, true, "exhaustion line is not itself a non-answer");
});
check("exhaustion line for availability is honest about unknown, names product", () => {
  const plan = planTurn({ message: "Jillian in black size 8?", namedProduct: true });
  const txt = buildAnswerWorkflowExhaustionText(plan, [{ title: "Jillian Sandal" }]);
  assert.match(txt, /Jillian Sandal/);
  assert.doesNotMatch(txt, /take a look — these are the closest/i);
});

// ── browse gender enforcement (no men from account on no-gender browse) ──
check("browse forces women onto a search that came in as men (account leak)", () => {
  const plan = planTurn({ message: "Show me cute black sandals under $100" });
  assert.equal(plan.workflow, W.BROWSE);
  assert.equal(plan.gender, "women");
  const out = enforceTurnPlanOnToolCall(searchCall({ gender: "men", category: "sandals", color: "black" }), { turnPlan: plan }, searchCall({ category: "sandals" }));
  assert.equal(out.input.filters.gender, "women", "account-leaked men overridden to women");
  assert.equal(out.input.filters.category, "sandals", "browse keeps category (only gender is forced)");
});
check("browse keeps stated men", () => {
  const plan = planTurn({ message: "Show me black sandals for men" });
  assert.equal(plan.gender, "men");
  const out = enforceTurnPlanOnToolCall(searchCall({ gender: "men" }), { turnPlan: plan }, searchCall({}));
  assert.equal(out.input.filters.gender, "men");
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
