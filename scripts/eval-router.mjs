// Route-level / gate integration eval (Milestone 1.3).
//
// Tests the resolver-first chat orchestration end-to-end through
// maybeRunOrthoticFlow. Asserts on:
//   - which router case fires (C / D / F / suppression)
//   - what the gate emits via SSE (path-ambig text, gender ask, etc.)
//   - the invariants from the M1.3 state machine.
//
// Avoids the DB and the Anthropic API by passing fixtures via
// resolverState / classifiedIntent and stubbing the SSE controller.

import assert from "node:assert/strict";
import { maybeRunOrthoticFlow } from "../app/lib/orthotic-flow-gate.server.js";
import { resolverPromisedRecommendation } from "../app/lib/chat-postprocessing.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

// Fake SSE controller: collects every emitted chunk as plain text.
function makeCapturingController() {
  const chunks = [];
  return {
    chunks,
    controller: {
      enqueue(buf) {
        chunks.push(typeof buf === "string" ? buf : new TextDecoder().decode(buf));
      },
    },
    encoder: { encode(s) { return s; } },
    text() { return chunks.join("\n"); },
  };
}

// Minimal viable orthotic tree.
const ORTHOTIC_TREE = {
  intent: "orthotic",
  definition: {
    nodes: [
      {
        id: "q_gender",
        type: "question",
        attribute: "gender",
        text: "Are you shopping for men's or women's?",
        chips: [
          { label: "Men's", value: "Men's" },
          { label: "Women's", value: "Women's" },
        ],
      },
      {
        id: "q_condition",
        type: "question",
        attribute: "condition",
        text: "What's the issue?",
        chips: [
          { label: "Plantar fasciitis", value: "plantar_fasciitis" },
          { label: "Ball-of-foot pain / metatarsalgia", value: "metatarsalgia" },
          { label: "Bunions", value: "bunions" },
        ],
      },
      {
        id: "q_arch",
        type: "question",
        attribute: "arch",
        text: "What's your arch?",
        chips: [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ],
      },
      {
        id: "q_overpronation",
        type: "question",
        attribute: "overpronation",
        text: "Do your ankles roll inward?",
        chips: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      },
    ],
  },
};

const SHOP = "test.myshopify.com";

console.log("Router / gate integration eval (Milestone 1.3)\n");

// ── Stabilization invariant: denial-recovery defers to resolver no_match ─
// chat.jsx denial-recovery overwrites the LLM's "we don't carry X"
// with a generic "Actually, take a look at these…" pitch when it
// can't see a search call. When the resolver explicitly returned
// no_match (or impossible_constraints), the LLM's denial is the
// catalog-grounded TRUTH and recovery MUST stand down.
await test("Stabilization — denial-recovery predicate stands down on resolver no_match", async () => {
  // Mirrors the chat.jsx inline check. Kept as a unit-style assertion
  // so future refactors don't quietly drop the gating.
  const isResolverNoMatchVerdict = (resolverState) =>
    resolverState?.recommended_next_action?.type === "no_match" ||
    (Array.isArray(resolverState?.impossible_constraints) &&
      resolverState.impossible_constraints.length > 0);

  assert.equal(isResolverNoMatchVerdict(null), false);
  assert.equal(isResolverNoMatchVerdict({ type: "resolver_state", impossible_constraints: [] }), false);
  assert.equal(
    isResolverNoMatchVerdict({
      type: "resolver_state",
      impossible_constraints: [{ field: "color", value: "pink", reason: "no pink in men's" }],
      recommended_next_action: { type: "ask" },
    }),
    true,
    "impossible_constraints alone must trip the recovery-stand-down",
  );
  assert.equal(
    isResolverNoMatchVerdict({
      type: "resolver_state",
      impossible_constraints: [],
      recommended_next_action: { type: "no_match", reason: "no products match these constraints" },
    }),
    true,
    "no_match action must trip the recovery-stand-down",
  );
  assert.equal(
    isResolverNoMatchVerdict({
      type: "resolver_state",
      impossible_constraints: [],
      recommended_next_action: { type: "recommend" },
    }),
    false,
    "recommend action must NOT trip the recovery-stand-down",
  );
});

// ── Route-level fulfillment regression (M1 stabilization) ─────
//
// Production trace: customer pivots from "Find men's shoes for my
// needs" to "how about women orthotics?". Resolver returns
// action=recommend with 6 candidates, but the customer saw the
// empty-pool fallback "Hmm, nothing's quite hitting that
// combination..." — because the LLM never called search_products
// (resolverState told it to trust the resolver verdict), the pool
// stayed empty, and empty-pool repair fired.
//
// Fix invariant: when resolverState says recommend with candidates,
// (a) the gate must yield to the resolver path (Case C), (b) the
// route must hydrate cards if the LLM didn't, and (c) empty-pool
// repair / no-match fallbacks must stand down. We can verify (a) +
// the predicate side of (b/c) here.

await test("Fulfillment — 'how about women orthotics?' after men-shoes pivot: gate yields, predicate promises", async () => {
  const cap = makeCapturingController();
  const resolverState = {
    type: "resolver_state",
    matched_constraints: { category: "orthotics", gender: "women" },
    inferred_constraints: {},
    impossible_constraints: [],
    remaining_disambiguators: [],
    do_not_ask: ["category", "gender"],
    candidate_products: [
      { handle: "l620w", title: "L620W Women's Casual Posted Orthotics", availability: "in_stock" },
      { handle: "l800w", title: "L800W Women's Medium Arch Orthotics", availability: "in_stock" },
      { handle: "l200w", title: "L200W Women's Diabetic Orthotics", availability: "in_stock" },
    ],
    recommended_next_action: { type: "recommend", reason: "3 products match" },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "Find men's shoes for my needs" },
      { role: "assistant", content: "(asks gender)" },
      { role: "user", content: "Men's" },
      { role: "assistant", content: "(shows men's shoes)" },
      { role: "user", content: "how about women orthotics?" },
    ],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, attributes: { gender: "Women" } },
    resolverState,
  });
  // (a) Gate must yield via Case C — resolver wins
  assert.equal(out.handled, false, "gate must yield to resolver");
  assert.equal(out.case, "C_resolver_strong_action", `expected case=C; got ${out.case}`);
  // (b)/(c) Predicate must hold so chat.jsx hydrates + suppresses no-match
  assert.equal(
    resolverPromisedRecommendation(resolverState),
    true,
    "predicate must promise so empty-pool repair stands down and recovery hydration runs",
  );
  // The gate itself must not emit any no-match text
  assert.ok(!/nothing.{0,3}s quite hitting/i.test(cap.text()), "gate must not emit no-match");
  assert.ok(!/no match/i.test(cap.text()), "gate must not say 'no match'");
  assert.ok(!/can.{0,2}t find/i.test(cap.text()), "gate must not say 'can't find'");
  assert.ok(!/combination/i.test(cap.text()), "gate must not mention 'combination'");
});

await test("Fulfillment — 'how about orthotics?' with gender known but no condition: recommender asks, never no-match", async () => {
  // When resolver matched gender+category but no condition/useCase
  // is set, the orthotic recommender flow should drive the next
  // question (via case A in the gate's tree walking) OR resolver
  // returns ask. Either way the customer must NOT see no-match.
  const cap = makeCapturingController();
  const resolverState = {
    type: "resolver_state",
    matched_constraints: { category: "orthotics", gender: "women" },
    inferred_constraints: {},
    impossible_constraints: [],
    remaining_disambiguators: [],
    do_not_ask: ["category", "gender"],
    candidate_products: [
      { handle: "l620w", title: "L620W", availability: "in_stock" },
    ],
    recommended_next_action: { type: "recommend", reason: "1 product match" },
  };
  await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "Women's" },
      { role: "assistant", content: "(noted)" },
      { role: "user", content: "how about orthotics?" },
    ],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, attributes: { gender: "Women" } },
    resolverState,
  });
  // Predicate enforces the no-match suppression in chat.jsx.
  assert.equal(resolverPromisedRecommendation(resolverState), true);
  // The gate must not emit no-match text either.
  assert.ok(!/nothing.{0,3}s quite hitting/i.test(cap.text()));
  assert.ok(!/no match/i.test(cap.text()));
  assert.ok(!/can.{0,2}t find/i.test(cap.text()));
  assert.ok(!/combination/i.test(cap.text()));
});

// ── M2 routing-correctness regressions ────────────────────────
//
// Production bug: resolver returned action=no_match with
// impossible_constraints=[] and candidates=[], gate yielded Case
// C, LLM said "we don't have women's orthotics in stock". The fix
// is structural — empty preview is not authoritative.

// (A) Full sequence: "men's sneakers" → "in red" → "how about women orthotics?"
// With the resolver authority fix, this scenario gives action=skip
// (orthotic recommender owns clinical attrs). Gate must NOT yield
// Case C (no_match would need impossible>0; recommend/oos don't
// apply). Gate proceeds to its existing orthotic flow.
await test("M2-A — 'how about women orthotics?' after men's-sneakers history: gate runs orthotic flow, never emits stock-denial", async () => {
  const cap = makeCapturingController();
  const resolverState = {
    type: "resolver_state",
    matched_constraints: { gender: "women", category: "orthotics" },
    inferred_constraints: {},
    impossible_constraints: [],
    remaining_disambiguators: [],
    do_not_ask: ["gender", "category"],
    candidate_products: [],
    recommended_next_action: { type: "skip", reason: "orthotic_recommender_owns_clinical_attrs" },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "show me men's sneakers" },
      { role: "assistant", content: "(here you go)" },
      { role: "user", content: "in red" },
      { role: "assistant", content: "(here are red men's sneakers)" },
      { role: "user", content: "how about women orthotics?" },
    ],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, attributes: { gender: "Women" } },
    resolverState,
  });
  // The gate must NOT yield Case C — no_match with impossible=0
  // OR resolver action=skip both mean "not authoritative".
  assert.notEqual(out.case, "C_resolver_strong_action", `gate must not treat empty-preview as authoritative; got case=${out.case}`);
  // Whatever the gate emitted must NOT contain stock-denial language.
  const t = cap.text();
  for (const banned of ["don't have", "not in stock", "nothing's quite hitting", "no match", "combination"]) {
    assert.ok(!new RegExp(banned, "i").test(t), `gate emitted forbidden phrase "${banned}": ${t}`);
  }
});

// (B) Fresh "how about women orthotics?" — same invariants
await test("M2-B — fresh 'how about women orthotics?' never emits stock-denial", async () => {
  const cap = makeCapturingController();
  const resolverState = {
    type: "resolver_state",
    matched_constraints: { gender: "women", category: "orthotics" },
    inferred_constraints: {},
    impossible_constraints: [],
    remaining_disambiguators: [],
    do_not_ask: ["gender", "category"],
    candidate_products: [],
    recommended_next_action: { type: "skip", reason: "orthotic_recommender_owns_clinical_attrs" },
  };
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "how about women orthotics?" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, attributes: { gender: "Women" } },
    resolverState,
  });
  assert.notEqual(out.case, "C_resolver_strong_action");
  const t = cap.text();
  for (const banned of ["don't have", "not in stock", "nothing's quite hitting", "no match", "combination"]) {
    assert.ok(!new RegExp(banned, "i").test(t), `forbidden phrase "${banned}": ${t}`);
  }
});

// (C) Defense-in-depth: a stale resolverState shape with no_match
// but impossible=[] must not yield Case C.
await test("M2-C — gate ignores no_match-with-empty-impossible (defense-in-depth)", async () => {
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "how about women orthotics?" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: true, isFootwearRequest: false, attributes: {} },
    // Stale shape — should be impossible to produce after the resolver
    // fix, but the gate defends regardless.
    resolverState: {
      type: "resolver_state",
      matched_constraints: { gender: "women", category: "orthotics" },
      inferred_constraints: {},
      impossible_constraints: [], // empty
      remaining_disambiguators: [],
      do_not_ask: [],
      candidate_products: [],
      recommended_next_action: { type: "no_match", reason: "x" },
    },
  });
  assert.notEqual(out.case, "C_resolver_strong_action", `gate must NOT yield Case C on no_match with impossible=0`);
});

// (D) Real impossibility — Case C must still fire so the LLM relays
// the honest "no exact red in men's sneakers — closest are X" message.
await test("M2-D — gate yields Case C on no_match WITH impossible_constraints (real impossibility)", async () => {
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "men's red sandals" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: false, isFootwearRequest: true, attributes: {} },
    resolverState: {
      type: "resolver_state",
      matched_constraints: { gender: "men", category: "sandals" },
      inferred_constraints: {},
      impossible_constraints: [{ field: "color", value: "red", reason: "no red in men's sandals" }],
      remaining_disambiguators: [],
      do_not_ask: ["gender", "category", "color"],
      candidate_products: [
        { handle: "x", title: "Black Sandal", availability: "in_stock" },
        { handle: "y", title: "Brown Sandal", availability: "in_stock" },
      ],
      recommended_next_action: { type: "no_match", reason: "no red in men's sandals", alternatives: ["Black Sandal", "Brown Sandal"] },
    },
  });
  assert.equal(out.handled, false);
  assert.equal(out.case, "C_resolver_strong_action", `real impossibility must yield Case C; got case=${out.case}`);
});

// ── Case C: resolver_strong_action yields ─────────────────────
await test("Router C — fresh 'red sandals' yields to resolver (no gender hard-ask)", async () => {
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "red sandals" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: false, isFootwearRequest: true, attributes: {} },
    resolverState: {
      type: "resolver_state",
      matched_constraints: { color: "red", category: "sandals" },
      inferred_constraints: { gender: { value: "women", reason: "red sandals only exist in women's" } },
      impossible_constraints: [],
      remaining_disambiguators: [],
      do_not_ask: ["color", "category", "gender"],
      candidate_products: [{ handle: "kendall", title: "Kendall Red Sandal", availability: "in_stock" }],
      recommended_next_action: { type: "recommend", reason: "match" },
    },
  });
  assert.equal(out.handled, false, "gate must yield");
  assert.equal(out.case, "C_resolver_strong_action", `expected case=C; got ${out.case}`);
  assert.ok(!/men's or women's/i.test(cap.text()), `gate must NOT emit gender ask; got: ${cap.text()}`);
  assert.ok(!/Just to make sure/i.test(cap.text()), `gate must NOT emit path-ambig`);
});

// ── Case D: resolver_ask_with_scope yields ────────────────────
await test("Router D — 'navy options' with color scope yields (gender inferred, no ask)", async () => {
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "navy options" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: false, isFootwearRequest: true, attributes: {} },
    resolverState: {
      type: "resolver_state",
      matched_constraints: { color: "navy" },
      inferred_constraints: { gender: { value: "men", reason: "navy only in men's" } },
      impossible_constraints: [],
      remaining_disambiguators: ["category"],
      do_not_ask: ["color", "gender"],
      candidate_products: [],
      recommended_next_action: { type: "ask", field: "category", chip_options: ["sneakers"] },
    },
  });
  assert.equal(out.handled, false, "gate must yield");
  assert.equal(out.case, "D_resolver_ask_with_scope", `expected case=D; got ${out.case}`);
  assert.ok(!/men's or women's/i.test(cap.text()), `gate must NOT emit gender ask`);
});

await test("Router D — 'flat feet sneakers' (footwear noun) yields, not hijacked into orthotic", async () => {
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "flat feet sneakers" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: false, isFootwearRequest: true, attributes: { condition: "flat_feet" } },
    resolverState: {
      type: "resolver_state",
      matched_constraints: { category: "sneakers", condition: "flat_feet" },
      inferred_constraints: {},
      impossible_constraints: [],
      remaining_disambiguators: ["gender"],
      do_not_ask: ["category", "condition"],
      candidate_products: [],
      recommended_next_action: { type: "ask", field: "gender", chip_options: ["men", "women"] },
    },
  });
  assert.equal(out.handled, false);
  assert.ok(out.case === "D_resolver_ask_with_scope" || out.case === "D_footwear_request_with_noun");
});

// ── Case skip: broad shopping question is allowed to ask ──────
await test("Router — broad 'show me shoes' (no scope, no orthotic intent) yields to LLM", async () => {
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: [{ role: "user", content: "show me shoes" }],
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: false, isFootwearRequest: false, attributes: {} },
    resolverState: {
      type: "resolver_state",
      matched_constraints: {},
      inferred_constraints: {},
      impossible_constraints: [],
      remaining_disambiguators: ["gender", "category"],
      do_not_ask: [],
      candidate_products: [],
      recommended_next_action: { type: "ask", field: "gender", chip_options: ["men", "women"] },
    },
  });
  // No classifier orthotic intent, no resolver scope — gate may
  // either yield (handled=false) or do nothing actionable. Either
  // way, no path-ambig text and no orthotic flow hijack.
  assert.ok(!/Just to make sure I get this right/i.test(cap.text()), "no path-ambig on broad query");
});

// ── Case F: path-ambig fires at most once across a full orthotic sequence ─
await test("Router F — path-ambig sequence: chips after orthotic-lock never re-trigger disambig", async () => {
  // Build the conversation incrementally and call the gate after
  // every customer reply. Asserts that "Just to make sure" text
  // appears at most once across all gate calls.
  let history = [];
  let pathAmbigEmissions = 0;
  const pushTurn = async (userText, classifierIntent = {}, resolverState = null) => {
    history = [...history, { role: "user", content: userText }];
    const cap = makeCapturingController();
    await maybeRunOrthoticFlow({
      messages: history,
      tree: ORTHOTIC_TREE,
      shop: SHOP,
      controller: cap.controller,
      encoder: cap.encoder,
      anthropic: null,
      haikuModel: "haiku",
      classifiedIntent: { isOrthoticRequest: true, attributes: {}, ...classifierIntent },
      resolverState,
    });
    if (/Just to make sure I get this right/i.test(cap.text())) {
      pathAmbigEmissions += 1;
      history = [
        ...history,
        {
          role: "assistant",
          content: "Just to make sure I get this right — are you looking for those you can wear, or an orthotic insole to put in your those?\n\n<<The shoes themselves>><<Orthotic insole for these>>",
        },
      ];
    } else {
      // Stub assistant follow-up so chat history reads naturally.
      history = [...history, { role: "assistant", content: "(assistant continues flow)" }];
    }
  };

  // 1. Customer says they want shoes (footwear commit)
  await pushTurn("I need new shoes for work", { isOrthoticRequest: false, isFootwearRequest: true });
  // 2. Customer pivots: "I have ball of foot pain"  (condition signal, no product noun → classifier flips to ortho)
  await pushTurn("I have ball of foot pain", { isOrthoticRequest: true });
  // 3. Chip answer to condition question
  await pushTurn("Ball-of-foot pain / metatarsalgia", { isOrthoticRequest: true });
  // 4. Path-lock choice
  await pushTurn("Orthotic insole for these", { isOrthoticRequest: true });
  // 5. Arch chip
  await pushTurn("Medium", { isOrthoticRequest: true });
  // 6. Overpronation chip
  await pushTurn("No", { isOrthoticRequest: true });

  assert.ok(
    pathAmbigEmissions <= 1,
    `path-ambig disambig must fire at most once; fired ${pathAmbigEmissions} times`,
  );
});

// ── After path-lock, pivot to catalog request → resolver/LLM handles ──
await test("Router — after orthotic path-lock, 'show me red sandals' is handled by resolver, not gate", async () => {
  const history = [
    { role: "user", content: "I need shoes" },
    { role: "assistant", content: "(asks something)" },
    { role: "user", content: "ball of foot pain" },
    { role: "assistant", content: "(emits path-ambig once)" },
    { role: "user", content: "Orthotic insole for these" },
    { role: "assistant", content: "(asks arch)" },
    { role: "user", content: "Medium" },
    { role: "assistant", content: "(asks more)" },
    // Customer pivots to catalog request
    { role: "user", content: "show me red sandals" },
  ];
  const cap = makeCapturingController();
  const out = await maybeRunOrthoticFlow({
    messages: history,
    tree: ORTHOTIC_TREE,
    shop: SHOP,
    controller: cap.controller,
    encoder: cap.encoder,
    anthropic: null,
    haikuModel: "haiku",
    classifiedIntent: { isOrthoticRequest: false, isFootwearRequest: true, attributes: {} },
    resolverState: {
      type: "resolver_state",
      matched_constraints: { color: "red", category: "sandals" },
      inferred_constraints: { gender: { value: "women", reason: "red sandals women-only" } },
      impossible_constraints: [],
      remaining_disambiguators: [],
      do_not_ask: ["color", "category", "gender"],
      candidate_products: [{ handle: "kendall", title: "Kendall Red Sandal", availability: "in_stock" }],
      recommended_next_action: { type: "recommend", reason: "match" },
    },
  });
  assert.equal(out.handled, false, "path-lock history must not trap customer; resolver should win");
  assert.equal(out.case, "C_resolver_strong_action");
  assert.ok(!/Just to make sure/i.test(cap.text()), "no path-ambig after lock");
  assert.ok(!/men's or women's/i.test(cap.text()), "no gender ask — resolver inferred it");
});

console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) {
    console.log(`  ${f.name}:`);
    console.log(`    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}
