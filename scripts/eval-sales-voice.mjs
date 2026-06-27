// Sales voice / no-process-narration guard. The bot must answer like a store
// associate, never narrate retrieval ("I see I'm getting mostly sneakers… let me
// try one more search"). On sales-voiced workflows that is BLOCKING; everywhere
// else the final emit scrub removes the offending sentence. Pure-module eval.

import assert from "node:assert/strict";
import {
  detectProcessNarration,
  stripProcessNarration,
  shouldBlockProcessNarration,
  buildSalesVoiceFallback,
  PROCESS_NARRATION_RETRY_INSTRUCTION,
  SALES_JUDGMENT_WORKFLOWS,
} from "../app/lib/sales-voice.js";
import { validateGrounding } from "../app/lib/grounding-validator.server.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fail++; }
}

// ── detector: catches process narration, leaves shopper language alone ──
const NARRATION = [
  "I see I'm getting mostly sneakers in our system.",
  "I'm seeing mostly sneakers.",
  "I found mostly sneakers.",
  "The search returned a few options.",
  "The search didn't pull up a clean match.",
  "Let me try one more search.",
  "Let me search for something dressier.",
  "I'll search our catalog.",
  "I can search for that.",
  "I found results after filtering.",
  "From the data I have, I can't be sure.",
  "Our catalog may be limited here.",
  "In our system, these are the closest.",
];
const CLEAN = [
  "For all-day comfort with a more polished look, I'd start with these supportive styles.",
  "These come in black and tan and are available in your size.",
  "Check the product page for the full size run.",
  "This style runs true to size.",
  "Great for standing all day — supportive and work-appropriate.",
  "You can grab a gift card too.",
  "These look great by the pool.",
  "They pair well with most work outfits and have a cushioned footbed.",
];
check("detector flags every process-narration sentence", () => {
  for (const t of NARRATION) assert.equal(detectProcessNarration(t).hit, true, `should flag: ${t}`);
});
check("detector leaves normal shopper language alone (no false positives)", () => {
  for (const t of CLEAN) assert.equal(detectProcessNarration(t).hit, false, `should NOT flag: ${t}`);
});

// ── BLOCKING on sales-voiced workflows ──
function blocks(workflow, text, cards = 1) {
  const pool = Array.from({ length: cards }, (_, i) => ({ title: `Style ${i}` }));
  const v = validateGrounding({ text, pool, workflow });
  return !v.ok && v.errors.some((e) => e.kind === "process_narration");
}
check("Failure 1: 'standing at work, nicer than sneakers' → condition_recommendation blocks the narrated draft", () => {
  // Customer: "I need comfortable shoes for standing at work all day, but I want
  // something nicer than sneakers. What should I look at?"
  const badDraft = "I see I'm getting mostly sneakers in our system. Let me try one more search to find something dressier.";
  assert.equal(blocks("condition_recommendation", badDraft), true);
});
check("Failure 3: 'which is better, Aria or Nova?' → comparison blocks the narrated draft", () => {
  const badDraft = "The search didn't pull up a clean comparison between them.";
  assert.equal(blocks("comparison", badDraft), true);
});
check("named_product_advisory + availability + prior_evidence_availability all block narration", () => {
  assert.equal(blocks("named_product_advisory", "I found results after filtering."), true);
  assert.equal(blocks("availability", "Let me search our catalog for that size."), true);
  assert.equal(blocks("prior_evidence_availability", "I'm seeing mostly black in the catalog."), true);
});
check("multi_recommendation blocks only when cards are shown", () => {
  assert.equal(blocks("multi_recommendation", "I'm seeing mostly sandals in our system.", 3), true);
  assert.equal(blocks("multi_recommendation", "I'm seeing mostly sandals in our system.", 0), false);
});
check("a CLEAN sales answer passes on every sales workflow", () => {
  const good = "For all-day comfort with a more polished look, I'd start with these supportive styles. They look more work-appropriate than a sport sneaker.";
  for (const wf of ["condition_recommendation", "comparison", "named_product_advisory", "availability", "prior_evidence_availability"]) {
    assert.equal(blocks(wf, good), false, `clean answer wrongly blocked on ${wf}`);
  }
});
check("browse is NOT validator-blocked (caught by the emit scrub instead)", () => {
  // Failure 2: "Show me cute black sandals under $100." routes to browse.
  assert.equal(shouldBlockProcessNarration("browse"), false);
  assert.equal(detectProcessNarration("I found results after filtering.").hit, true);
});

// ── retry instruction is the exact sales-voice rewrite directive ──
check("blocking error carries the sales-voice rewrite instruction", () => {
  const v = validateGrounding({ text: "Let me try one more search.", pool: [{ title: "X" }], workflow: "comparison" });
  const e = v.errors.find((x) => x.kind === "process_narration");
  assert.ok(e);
  assert.equal(e.message, PROCESS_NARRATION_RETRY_INSTRUCTION);
  assert.match(e.message, /Start with the recommendation/);
  assert.match(e.message, /Do not mention searches, tools, system, catalog, data, filters, results/);
});

// ── emit scrub backup: remove only the narration sentence ──
check("scrub removes only the narration sentence, keeps the real recommendation", () => {
  const mixed = "For all-day comfort, I'd start with these supportive styles. I see I'm getting mostly sneakers, so let me try one more search.";
  assert.equal(stripProcessNarration(mixed), "For all-day comfort, I'd start with these supportive styles.");
});
check("all-narration draft scrubs to empty → caller uses a sales-safe fallback (never 'no clean match')", () => {
  const allBad = "I see I'm getting mostly sneakers. Let me try one more search.";
  assert.equal(stripProcessNarration(allBad).trim().length < 40, true);
  const fb = buildSalesVoiceFallback({ workflow: "condition_recommendation", hasCards: true });
  assert.match(fb, /start with/i);
  assert.doesNotMatch(fb, /search|catalog|filter|result|not finding|clean match/i);
});
check("comparison fallback is recommendation-first, no process words", () => {
  const fb = buildSalesVoiceFallback({ workflow: "comparison", hasCards: true });
  assert.doesNotMatch(fb, /search|catalog|filter|result|system|data/i);
});

// ── routing: sales-judgment workflows go to the stronger model ──
check("SALES_JUDGMENT_WORKFLOWS covers the taste/voice turns (Sonnet-first)", () => {
  for (const wf of ["condition_recommendation", "named_product_advisory", "comparison", "multi_recommendation"]) {
    assert.equal(SALES_JUDGMENT_WORKFLOWS.has(wf), true);
  }
  // simple turns stay cheap (fast model)
  for (const wf of ["browse", "policy_account", "availability", "sale_browse"]) {
    assert.equal(SALES_JUDGMENT_WORKFLOWS.has(wf), false);
  }
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  process.exit(1);
}
