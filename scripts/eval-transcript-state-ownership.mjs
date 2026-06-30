// 20-turn STATE / SCOPE OWNERSHIP transcript regression — reconstructed from the
// latest QA Railway log. Asserts the five root failure classes are fixed
// turn-by-turn against the deterministic backbone (planTurn + the pure parsers
// + the orthotic gate + the support-handoff decision). The full chat handler
// needs a DB, so — like eval-transcript-ownership.mjs — each turn asserts the
// deterministic owner/parse, never a live LLM call.
//
// Run: node scripts/eval-transcript-state-ownership.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planTurn } from "../app/lib/turn-plan.server.js";
import { extractUserConstraints } from "../app/lib/catalog-resolver.server.js";
import { deriveCatalogRequirements } from "../app/lib/catalog-query.server.js";
import { detectRejectedCategories, parseCategoryConstraints, negationCorruptedPositiveCategory } from "../app/lib/chat-postprocessing.js";
import { priorAvailabilityConstraints, staleWidthAppliedAcrossProducts, availabilityTextCardColorMismatch } from "../app/lib/availability-truth.js";
import { detectSupportHandoffNeed, handoffOnCatalogBrowse } from "../app/lib/support-handoff.js";
import { maybeRunOrthoticFlow, orthoticPendingFlowDecision, isOrthoticAbandonment } from "../app/lib/orthotic-flow-gate.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const orthoticTree = { intent: "orthotic", definition: JSON.parse(readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8")) };
const KNOWN_CATS = ["sandals", "sneakers", "boots", "loafers", "wedges", "heels", "flats", "clogs"];
const KNOWN_COLORS = ["rose", "champagne", "black", "denim", "navy", "blush"];

let pass = 0, fail = 0, step = 0;
const fails = [];
function turn(label, fn) {
  step += 1;
  const name = `T${step}. ${label}`;
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}
async function turnAsync(label, fn) {
  step += 1;
  const name = `T${step}. ${label}`;
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; fails.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}
function mockSse() {
  const events = [];
  return { events, encoder: { encode: (s) => s }, controller: { enqueue: (s) => events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim())) } };
}
const reqTerms = (m) => deriveCatalogRequirements({ latestUserMessage: m, knownCategories: KNOWN_CATS }).requiredTerms;

console.log("\n20-turn state/scope ownership transcript\n");

// ── CLASS 1: current-turn negation ───────────────────────────────────────────
turn("'Now only show me sandals, not shoes' keeps category=sandals, never searches 'not'", () => {
  const m = "Now only show me sandals, not shoes.";
  assert.equal(extractUserConstraints(m).category, "sandals", "positive category=sandals must survive");
  const { positive, rejected } = parseCategoryConstraints(m);
  assert.ok(positive.has("sandal"), "sandals is a positive constraint");
  assert.ok(!rejected.has("sandals"), "sandals must NOT be rejected");
  assert.ok(rejected.has("shoes"), "shoes IS rejected");
  assert.equal(negationCorruptedPositiveCategory(m), false, "no negation corruption");
  const terms = reqTerms(m);
  assert.ok(!terms.some((t) => /\bnot\b/.test(t)), `must not search 'not': ${JSON.stringify(terms)}`);
});

turn("'not shoes' does NOT expand-reject every footwear type (sandals/sneakers survive selection)", () => {
  const rejected = detectRejectedCategories("Now only show me sandals, not shoes.");
  assert.ok(!rejected.has("sandals"), "sandals not swept up by umbrella");
  assert.ok(!rejected.has("sneakers"), "sneakers not swept up (no umbrella expansion when a positive exists)");
});

turn("the sandals browse does NOT hard-handoff to support (Class 5)", () => {
  const h = detectSupportHandoffNeed({
    text: "Here are some great supportive sandals.",
    ctx: { latestUserMessage: "Now only show me sandals, not shoes.", turnPlan: { workflow: "browse" } },
    pool: [{ title: "Maui Sandal" }],
  });
  assert.notEqual(h.mode, "hard", "a normal sandals browse must not hard-handoff");
  assert.equal(handoffOnCatalogBrowse({ ...h, workflow: "browse" }), false);
});

turn("even a 0-card sandals browse is a no-match REFINE, never a support handoff", () => {
  const h = detectSupportHandoffNeed({
    text: "I couldn't find sandals matching that exact request.",
    ctx: { latestUserMessage: "purple glitter sandals", turnPlan: { workflow: "browse" } },
    pool: [],
  });
  assert.equal(h.mode, null, "browse no-match → refine, not handoff");
  assert.equal(h.reason, "catalog_no_match_refine");
});

// ── CLASS 3: availability text/card color truth + color-as-family ────────────
const availMsgs = [];
turn("'Does Jillian come in rose or champagne?' — color words are not product families", () => {
  const m = "Does Jillian come in rose or champagne?";
  // colors must never leak into hard catalog terms / family search
  assert.deepEqual(reqTerms(m), [], "rose/champagne are colors, never required terms");
  availMsgs.push({ role: "user", content: m });
});

turn("availability text 'available in Rose' with a Denim card FIRES the mismatch invariant", () => {
  const mismatch = availabilityTextCardColorMismatch({
    text: "Yes — the Jillian is available in Rose.",
    cards: [{ title: "Jillian Braided Quarter Strap Sandal - Denim" }],
  });
  assert.equal(mismatch, "rose", "saying Rose while showing Denim is a violation");
});

turn("availability text 'available in Rose' with the Rose card is consistent (no violation)", () => {
  availMsgs.push({ role: "assistant", content: "Yes — the Jillian is available in Rose." });
  const ok = availabilityTextCardColorMismatch({
    text: "Yes — the Jillian is available in Rose.",
    cards: [{ title: "Jillian Braided Quarter Strap Sandal - Rose" }],
  });
  assert.equal(ok, null, "Rose answer + Rose card is the same truth owner");
});

// ── CLASS 2: availability state scoped to the active product ──────────────────
turn("'What about size 8?' does NOT inherit a stale wide width from an unrelated turn", () => {
  // History: a far-back wide turn, then the rose/champagne color turn, then size 8.
  const msgs = [
    { role: "user", content: "Do you have Jillian in wide?" },
    { role: "assistant", content: "..." },
    ...availMsgs,
    { role: "user", content: "What about size 8?" },
  ];
  const inherited = priorAvailabilityConstraints(msgs, KNOWN_COLORS);
  assert.equal(inherited.width, null, "width must NOT leak from the far-back wide turn");
  assert.equal(staleWidthAppliedAcrossProducts(msgs, KNOWN_COLORS), false);
});

turn("width DOES carry when the IMMEDIATE prior availability turn had width", () => {
  const msgs = [
    { role: "user", content: "Do you have Jillian in wide?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "What about size 8?" },
  ];
  assert.equal(priorAvailabilityConstraints(msgs, KNOWN_COLORS).width, "wide");
});

turn("'Actually make it black' stays AVAILABILITY refinement (not clarification/browse)", () => {
  const msgs = [
    { role: "user", content: "Does Jillian come in rose?" },
    { role: "assistant", content: "Yes — the Jillian is available in Rose." },
    { role: "user", content: "Actually make it black" },
  ];
  const p = planTurn({ message: "Actually make it black", messages: msgs, priorCardCount: 1, focusProduct: { title: "Jillian Sandal - Rose" } });
  assert.equal(p.workflow, "availability", `expected availability, got ${p.workflow}`);
});

turn("'what about size 8?' also routes to availability refinement (deictic follow-up)", () => {
  const msgs = [
    { role: "user", content: "Does Jillian come in rose?" },
    { role: "assistant", content: "Yes — available in Rose." },
    { role: "user", content: "what about size 8?" },
  ];
  const p = planTurn({ message: "what about size 8?", messages: msgs, priorCardCount: 1, focusProduct: { title: "Jillian Sandal - Rose" } });
  assert.equal(p.workflow, "availability");
});

// ── CLASS 4: orthotic owns end-to-end ────────────────────────────────────────
await turnAsync("orthotic selection stays orthotic-owned (asks next question, no sneaker cards)", async () => {
  const messages = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "Who are these orthotics for?" },
    { role: "user", content: "Women's orthotics." },
    { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
    { role: "user", content: "I'll use them in Hoka sneakers for walking." },
  ];
  const { events, encoder, controller } = mockSse();
  const out = await maybeRunOrthoticFlow({
    messages, tree: orthoticTree, shop: "t.myshopify.com", controller, encoder,
    classifiedIntent: { intent: "recommend_orthotic", isOrthoticRequest: true, attributes: { gender: "Women" } },
    turnPlan: { workflow: "condition_recommendation", clarificationAllowed: false, searchRequired: true, productDisplayPolicy: "show" },
  });
  assert.equal(out.handled, true, "orthotic gate must own the turn");
  const products = events.find((e) => e?.type === "products");
  assert.ok(!products || (products.products || []).length === 0, "no sneaker/product cards under an orthotic question");
  assert.equal(orthoticPendingFlowDecision({ messages, tree: orthoticTree }), "continue");
});

await turnAsync("a fresh footwear request mid-orthotic-flow CANCELS (no orthotic Q, routes to footwear)", async () => {
  const messages = [
    { role: "user", content: "Help me choose the right Aetrex orthotic." },
    { role: "assistant", content: "Any specific foot pain or condition we should match?" },
    { role: "user", content: "I'm on my feet 10 hours in a clinic and want something supportive but not bulky. What would you pick first?" },
  ];
  assert.equal(orthoticPendingFlowDecision({ messages, tree: orthoticTree }), "cancel");
  const { encoder, controller } = mockSse();
  const out = await maybeRunOrthoticFlow({ messages, tree: orthoticTree, shop: "t.myshopify.com", controller, encoder, turnPlan: { workflow: "condition_recommendation", clarificationAllowed: false } });
  assert.equal(out.handled, false);
  assert.equal(out.case, "pending_flow_cancelled_fresh_request");
});

await turnAsync("'show me shoes instead, not orthotics' CLEARS orthotic-only state (defers to footwear)", async () => {
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "men" },
    { role: "assistant", content: "What kind of shoes will the orthotics go in?" },
    { role: "user", content: "show me shoes instead, not orthotics" },
  ];
  assert.equal(isOrthoticAbandonment("show me shoes instead, not orthotics"), true);
  const { encoder, controller } = mockSse();
  const out = await maybeRunOrthoticFlow({ messages, tree: orthoticTree, shop: "t.myshopify.com", controller, encoder });
  assert.equal(out.handled, false, "must defer to footwear routing");
  assert.equal(out.case, "orthotic_abandoned_pivot_to_footwear");
});

await turnAsync("repeated unanswered clarifier → SAFE general orthotic rec, never a resolver fallthrough", async () => {
  const useCaseQ = "What kind of shoes will the orthotics go in?";
  const messages = [
    { role: "user", content: "I need orthotics" },
    { role: "assistant", content: "Who are these orthotics for? <<Men>><<Women>><<Kids>>" },
    { role: "user", content: "men" },
    { role: "assistant", content: useCaseQ },
    { role: "user", content: "blah" },
    { role: "assistant", content: useCaseQ },
    { role: "user", content: "qwerty" },
  ];
  const { events, encoder, controller } = mockSse();
  const out = await maybeRunOrthoticFlow({ messages, tree: orthoticTree, shop: "t.myshopify.com", controller, encoder });
  assert.equal(out.handled, true, "stays orthotic-owned");
  assert.equal(out.case, "seed_loop_cap_safe_recommendation");
  const reco = events.find((e) => e?.type === "text");
  assert.ok(reco && /orthotic/i.test(reco.text) && /general suggestion|not a medical/i.test(reco.text), "safe general orthotic rec with caveat");
  const products = events.find((e) => e?.type === "products");
  assert.ok(!products || (products.products || []).length === 0, "no sneaker/stale product cards");
});

// ── CLASS 5: handoff only for true support ───────────────────────────────────
turn("delivered-but-not-received ORDER help → hard support handoff", () => {
  const h = detectSupportHandoffNeed({
    text: "Let me get you to the right place.",
    ctx: { latestUserMessage: "my order was marked delivered but I never received it — can I talk to a human?", turnPlan: { workflow: "customer_service" } },
    pool: [],
  });
  assert.equal(h.mode, "hard", "a real order/support problem must reach a human");
  assert.equal(h.reason, "explicit_human_request");
  assert.equal(handoffOnCatalogBrowse({ ...h, workflow: "customer_service" }), false, "this is not a catalog-browse handoff");
});

turn("a plain browse never reaches a human even with dead-end-shaped text", () => {
  const h = detectSupportHandoffNeed({
    text: "I'm not able to find that.",
    ctx: { latestUserMessage: "show me sandals", turnPlan: { workflow: "browse" } },
    pool: [],
  });
  assert.notEqual(h.mode, "hard");
});

// ── Cross-class: negation + gender never produce a corrupted positive ─────────
turn("'show me women's sandals, not boots' keeps sandals + women (no corruption)", () => {
  const m = "show me women's sandals, not boots";
  assert.equal(extractUserConstraints(m).category, "sandals", "positive sandals survives");
  assert.equal(extractUserConstraints(m).gender, "women", "stated gender survives");
  assert.equal(negationCorruptedPositiveCategory(m), false);
  assert.ok(detectRejectedCategories(m).has("boots"), "boots is rejected");
});

turn("a non-negation browse still extracts its category normally (no false rejection)", () => {
  assert.equal(extractUserConstraints("show me wide black boots").category, "boots");
  assert.deepEqual([...parseCategoryConstraints("show me wide black boots").rejected], []);
});

turn("'no orthotics, just shoes' rejects orthotics, keeps shoes as the footwear intent", () => {
  assert.equal(isOrthoticAbandonment("no orthotics, just shoes"), true);
});

console.log("");
if (fail === 0) {
  console.log(`✅  ${pass} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`❌  ${pass} passed, ${fail} failed\n`);
  for (const f of fails) console.error(`FAIL: ${f.name}\n${f.err.stack}`);
  process.exit(1);
}
