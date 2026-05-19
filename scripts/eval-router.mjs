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
