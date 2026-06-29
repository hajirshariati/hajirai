// Ownership-boundary regressions (Railway-log audit, 2026-06).
//
// TurnPlan owns workflow/search/clarify/display; the old prompt/router/
// postprocess layers must not override it. These assert the DETERMINISTIC
// boundaries that the four production fixes restored, as a single 6-turn
// session:
//   1. "show me danika black"                              → browse, searches
//   2. plantar fasciitis + flat feet: shoes/orthotics/both → condition_rec,
//      orthotic redirect MUST NOT hijack the footwear search, no gender chips
//   3. comfortable shoes for standing, not sneakers        → answer wf, gender
//      resolved (no gender chips), search once
//   4. do those come in black?                             → availability
//   5. current sales and promotions                        → sale_browse,
//      STATELESS (stale "orthotics" must not leak into the query)
//   6. delivered but not received                          → customer service
//
// Run: node scripts/eval-ownership-regressions.mjs

import assert from "node:assert/strict";
import {
  planTurn,
  buildTurnPlanPromptBlock,
  isAnswerWorkflow,
  plannedWorkflowCardOwnerViolation,
  plannedSearchSkippedViolation,
  cardsNotInEvidencePool,
} from "../app/lib/turn-plan.server.js";
import {
  redirectOrthoticSearchToRecommender,
  sanitizeSaleBrowseSearch,
} from "../app/lib/chat-tool-rewrite.server.js";
import { resolveTurnScope, detectNegativeAttributeFilter } from "../app/lib/product-turn-engine.server.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

// A minimal orthotic recommender tree (intent="orthotic") so the redirect has
// something to route to — mirrors Aetrex's enabled tree.
const ORTHO_TREES = [{ intent: "orthotic" }];

console.log("\nownership-boundary regressions (single session)\n");

// ── Turn 1: "show me danika black" ──────────────────────────────────────
test("1. 'show me danika black' → browse turn that searches (no stall)", () => {
  const plan = planTurn({ message: "show me danika black", namedProduct: true });
  assert.equal(plan.workflow, "browse", "named product browse");
  assert.equal(plan.searchRequired, true, "must search");
  assert.equal(plan.productDisplayPolicy, "show", "shows cards");
});

// ── Turn 2: plantar fasciitis + flat feet — shoes, orthotics, or both? ──
const MIXED = "I have plantar fasciitis and flat feet. Should I buy shoes, orthotics, or both?";

test("2. mixed shoes/orthotics/both → condition_recommendation, clarify=false", () => {
  const plan = planTurn({ message: MIXED });
  assert.equal(plan.workflow, "condition_recommendation");
  assert.equal(plan.clarificationAllowed, false);
  assert.equal(plan.searchRequired, true);
});

test("2. mixed question must NOT be hijacked into recommend_orthotic", () => {
  const plan = planTurn({ message: MIXED });
  // The model's footwear search this turn.
  const toolCall = { name: "search_products", input: { query: "plantar_fasciitis footwear" }, id: "t2" };
  const out = redirectOrthoticSearchToRecommender(toolCall, {
    recommenderTrees: ORTHO_TREES,
    latestUserMessage: MIXED,
    turnPlan: plan,
    classifiedIntent: { isOrthoticRequest: true, attributes: {} },
  });
  assert.equal(out.name, "search_products", "stays a footwear search — NOT recommend_orthotic");
});

test("2. the mixed guard works even without a TurnPlan (text-only)", () => {
  const toolCall = { name: "search_products", input: { query: "plantar_fasciitis footwear" }, id: "t2b" };
  const out = redirectOrthoticSearchToRecommender(toolCall, {
    recommenderTrees: ORTHO_TREES,
    latestUserMessage: MIXED,
    classifiedIntent: { isOrthoticRequest: true, attributes: {} },
  });
  assert.equal(out.name, "search_products", "footwear+orthotic+both text alone defers the redirect");
});

test("2. a PURE orthotic-only ask still routes to recommend_orthotic (no over-reach)", () => {
  const latest = "what orthotic is best for plantar fasciitis?";
  const plan = planTurn({ message: latest });
  const toolCall = { name: "search_products", input: { query: "orthotic plantar fasciitis" }, id: "t2c" };
  const out = redirectOrthoticSearchToRecommender(toolCall, {
    recommenderTrees: ORTHO_TREES,
    latestUserMessage: latest,
    turnPlan: plan,
    classifiedIntent: { isOrthoticRequest: true, attributes: {} },
  });
  assert.equal(out.name, "recommend_orthotic", "orthotic-only (no footwear noun) still routes to the gate");
});

test("2. answer-workflow prompt block forbids gender chips when gender resolved", () => {
  const plan = planTurn({ message: MIXED });
  assert.ok(isAnswerWorkflow(plan), "condition_recommendation is an answer workflow");
  assert.ok(plan.gender === "women" || plan.gender === "men", "gender is defaulted");
  const block = buildTurnPlanPromptBlock(plan);
  assert.match(block, /ALREADY RESOLVED\/DEFAULTED by TurnPlan/, "explicit gender-resolved directive");
  assert.match(block, /do NOT emit <<Men's>>\/<<Women's>> chips/i, "forbids gender chips");
});

// ── Turn 3: comfortable shoes for standing at work, not sneakers ────────
const STANDING = "Show me comfortable shoes for standing at work that don't look like sneakers.";

test("3. standing-at-work shoes → answer workflow, clarify=false, searches once", () => {
  const plan = planTurn({ message: STANDING });
  assert.ok(isAnswerWorkflow(plan) || plan.workflow === "browse", `got ${plan.workflow}`);
  assert.equal(plan.clarificationAllowed, false, "no clarifier — act and search");
  assert.equal(plan.searchRequired, true, "search runs");
});

test("3. gender chips suppressed upstream for the standing-at-work turn", () => {
  const plan = planTurn({ message: STANDING });
  if (isAnswerWorkflow(plan) && plan.gender) {
    const block = buildTurnPlanPromptBlock(plan);
    assert.match(block, /do NOT emit <<Men's>>\/<<Women's>> chips/i, "no <<Women's sneakers>>/<<Men's sneakers>> loop");
  }
});

// ── Turn 4: do those come in black? ─────────────────────────────────────
test("4. 'do those come in black?' (prior cards) → availability, no clarifier", () => {
  const plan = planTurn({ message: "do those come in black?", hasPriorCards: true, priorCardFamilies: ["danika"] });
  assert.ok(
    plan.workflow === "availability" || plan.workflow === "prior_evidence_availability",
    `availability follow-up, got ${plan.workflow}`,
  );
  assert.equal(plan.clarificationAllowed, false);
});

// ── Turn 5: current sales and promotions (STATELESS) ────────────────────
const SALE = "Show me current sales and promotions.";

test("5. 'current sales and promotions' → sale_browse, clarify=false", () => {
  const plan = planTurn({ message: SALE });
  assert.equal(plan.workflow, "sale_browse");
  assert.equal(plan.clarificationAllowed, false);
});

test("5. sale_browse search is STATELESS — stale 'orthotics' does not leak", () => {
  const plan = planTurn({ message: SALE });
  // The model reaches for a stale-context search after an orthotic conversation.
  const toolCall = {
    name: "search_products",
    input: { query: "orthotics", filters: { category: "orthotics", condition: "plantar_fasciitis" } },
    id: "t5",
  };
  const out = sanitizeSaleBrowseSearch(toolCall, { turnPlan: plan, latestUserMessage: SALE });
  assert.equal(out.input.query, "sale", "broad sale query, not 'orthotics'");
  assert.equal(out.input.onSale, true, "onSale filter applied");
  assert.equal(out.input.filters.category, undefined, "stale category dropped");
  assert.equal(out.input.filters.condition, undefined, "stale condition dropped");
});

test("5. sale_browse with a NAMED category is kept ('sneakers on sale')", () => {
  const latest = "sneakers on sale";
  const plan = planTurn({ message: latest });
  const toolCall = { name: "search_products", input: { query: "sneakers", filters: { category: "sneakers" } }, id: "t5b" };
  const out = sanitizeSaleBrowseSearch(toolCall, { turnPlan: plan, latestUserMessage: latest });
  // Category named this turn — keep it, just ensure onSale.
  assert.equal(out.input.filters.category, "sneakers", "named category preserved");
  assert.equal(out.input.onSale, true, "onSale still applied");
});

test("5. engine scope reset — stale orthotics memory cleared for broad sale browse", () => {
  const plan = planTurn({ message: SALE });
  const scope = resolveTurnScope({
    latestUserMessage: SALE,
    sessionMemory: { explicit: { category: "orthotics", condition: "plantar_fasciitis", useCase: "athletic_training", gender: "women" } },
    classifiedIntent: { attributes: {} },
    turnPlan: plan,
  });
  assert.equal(scope.category, null, "stale category cleared");
  assert.equal(scope.condition, null, "stale condition cleared");
  assert.equal(scope.useCase, null, "stale use-case cleared");
  assert.equal(scope.onSale, true, "onSale set");
  assert.equal(scope.catalogQuery, "sale", "deterministic 'sale' query");
});

// ── Turn 6: delivered but not received ──────────────────────────────────
test("6. 'delivered but not received' → customer-service/policy, no product search", () => {
  const plan = planTurn({ message: "My order says delivered but I never received it." });
  assert.ok(
    plan.workflow === "customer_service" || plan.workflow === "policy_account",
    `support turn, got ${plan.workflow}`,
  );
  assert.equal(plan.searchRequired, false, "no product search");
  assert.equal(plan.productDisplayPolicy, "suppress", "no cards");
});

// ── Fix 4: compatibility answer is capped ──────────────────────────────
test("compatibility turn carries a 2-3 sentence cap directive", () => {
  const plan = planTurn({ message: "Can I wear orthotics inside sandals, or do I need closed shoes?" });
  assert.equal(plan.workflow, "compatibility");
  assert.ok(
    plan.directives.some((d) => /2-3 sentences MAX/i.test(d)),
    "compatibility directive caps length at 2-3 sentences",
  );
});

// ── Ownership cleanup: mixed shoes-or-orthotics must not collapse to orthotic ──
const SHOES_OR_ORTHO = "Help me find Aetrex shoes or orthotics for foot pain or all-day comfort";

test("ownership: 'shoes or orthotics for foot pain' is a footwear advisory, not orthotic-only", () => {
  const plan = planTurn({ message: SHOES_OR_ORTHO });
  // Whatever the exact workflow, it must be an answer/commerce turn that SEARCHES
  // (not the orthotic gate) and must not clarify gender.
  assert.equal(plan.searchRequired, true, "searches");
  assert.notEqual(plan.workflow, "clarification", "not a clarifier turn");
});

test("ownership: 'shoes or orthotics' search is NOT hijacked into recommend_orthotic", () => {
  const plan = planTurn({ message: SHOES_OR_ORTHO });
  const toolCall = { name: "search_products", input: { query: "foot pain comfort footwear" }, id: "soo" };
  const out = redirectOrthoticSearchToRecommender(toolCall, {
    recommenderTrees: ORTHO_TREES,
    latestUserMessage: SHOES_OR_ORTHO,
    turnPlan: plan,
    classifiedIntent: { isOrthoticRequest: true, attributes: {} },
  });
  assert.equal(out.name, "search_products", "stays a footwear search — user asked shoes OR orthotics");
});

// ── Hard invariant #4: pinned workflows cannot be scorer-owned ──────────
test("invariant: a TurnPlan-pinned workflow that ships cards must NOT be scorer-owned", () => {
  for (const wf of ["availability", "comparison", "multi_recommendation", "compatibility", "named_product_advisory", "prior_evidence_availability"]) {
    assert.equal(
      plannedWorkflowCardOwnerViolation({ workflow: wf, finalCards: 3, cardOwner: "scorer" }),
      true,
      `${wf} + scorer + cards must be a violation`,
    );
    // The deterministic owners are fine.
    assert.equal(plannedWorkflowCardOwnerViolation({ workflow: wf, finalCards: 3, cardOwner: "evidence-plan" }), false, `${wf} + evidence-plan is fine`);
  }
  // No cards → no violation; non-pinned workflow (browse) → scorer is fine.
  assert.equal(plannedWorkflowCardOwnerViolation({ workflow: "comparison", finalCards: 0, cardOwner: "scorer" }), false, "0 cards = no violation");
  assert.equal(plannedWorkflowCardOwnerViolation({ workflow: "browse", finalCards: 5, cardOwner: "scorer" }), false, "browse may be scorer-owned");
});

// ── Hard invariant #5: searchRequired+display=show ⟹ searchAttempted ────
test("invariant: searchRequired + display=show must end with searchAttempted=true", () => {
  const showPlan = planTurn({ message: "I have plantar fasciitis and flat feet. Should I buy shoes, orthotics, or both?" });
  assert.equal(showPlan.searchRequired, true);
  assert.equal(plannedSearchSkippedViolation({ plan: showPlan, searchAttempted: false }), true, "no search on a search+show plan is a violation");
  assert.equal(plannedSearchSkippedViolation({ plan: showPlan, searchAttempted: true }), false, "search attempted → clean");
  // A suppress-display turn (clarification/support) is exempt.
  const clarPlan = planTurn({ message: "hi there" });
  assert.equal(plannedSearchSkippedViolation({ plan: clarPlan, searchAttempted: false }), false, "non-display turn is exempt");
});

// ── Audit #2: negated color SYNONYMS clear the positive color ──────────
test("audit#2: 'not maroon'/'not wine'/'not coral' resolve to the canonical family", () => {
  assert.equal(detectNegativeAttributeFilter("sneakers but not in maroon").color, "burgundy", "maroon → burgundy");
  assert.equal(detectNegativeAttributeFilter("not wine").color, "burgundy", "wine → burgundy");
  assert.equal(detectNegativeAttributeFilter("anything but coral").color, "pink", "coral → pink");
  assert.equal(detectNegativeAttributeFilter("nothing in charcoal").color, "charcoal", "charcoal kept");
});

test("audit#2: a negated synonym CLEARS the positive color and excludes the family", () => {
  // Classifier resolved color=burgundy from "maroon"; the negation must clear it.
  const scope = resolveTurnScope({
    latestUserMessage: "show me sneakers but not in maroon",
    sessionMemory: { explicit: { category: "sneakers", color: "burgundy" } },
    classifiedIntent: { attributes: { category: "sneakers", color: "burgundy" } },
  });
  assert.equal(scope.color, null, "positive color cleared (was the rejected family)");
  assert.equal(scope.excluded?.color, "burgundy", "excluded carries the canonical family");
});

test("audit#2: negating a DIFFERENT color does not clear an unrelated positive color", () => {
  const scope = resolveTurnScope({
    latestUserMessage: "show me black sneakers but not in maroon",
    classifiedIntent: { attributes: { category: "sneakers", color: "black" } },
  });
  assert.equal(scope.color, "black", "black survives — only burgundy is excluded");
  assert.equal(scope.excluded?.color, "burgundy");
});

// ── Audit #6: every shown card must be in the evidence pool ────────────
test("audit#6: cardsNotInEvidencePool flags a stray card, passes pooled cards", () => {
  const pool = [{ handle: "danika", title: "Danika Sneaker" }, { handle: "kendall", title: "Kendall Sandal" }];
  assert.equal(cardsNotInEvidencePool({ finalCards: [{ handle: "danika" }], evidencePool: pool }).length, 0, "pooled by handle → clean");
  assert.equal(cardsNotInEvidencePool({ finalCards: [{ title: "Kendall Sandal" }], evidencePool: pool }).length, 0, "pooled by title → clean");
  const stray = cardsNotInEvidencePool({ finalCards: [{ handle: "ghost", title: "Ghost Boot" }], evidencePool: pool });
  assert.equal(stray.length, 1, "card not in pool → flagged");
  assert.equal(stray[0].handle, "ghost");
});

test("audit#4/#6: a multi-reco pinned card seeded into the pool is NOT flagged as stray", () => {
  // #4 seeds the slot's pinned card into the evidence pool; #6 then sees it as
  // grounded. Simulate: the pinned card IS in the pool → no violation.
  const pinned = { handle: "l1300u-m", title: "Unisex Thinsoles Orthotics" };
  const poolWithSeed = [{ handle: "danika", title: "Danika Sneaker" }, pinned];
  assert.equal(cardsNotInEvidencePool({ finalCards: [pinned], evidencePool: poolWithSeed }).length, 0, "seeded pin is grounded");
  // Without the #4 seed it WOULD be flagged (the bug we fixed).
  const poolNoSeed = [{ handle: "danika", title: "Danika Sneaker" }];
  assert.equal(cardsNotInEvidencePool({ finalCards: [pinned], evidencePool: poolNoSeed }).length, 1, "un-seeded pin would be flagged");
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
