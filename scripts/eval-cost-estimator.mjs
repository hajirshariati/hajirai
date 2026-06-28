// Admin Analytics CostEstimator accuracy (PRD 2026-06-28).
//
// Locks the honest accounting: the estimator anchors on chat-only cost (image
// previews excluded), labels say "assistant replies" not "AI requests", and the
// anchored/fallback copy switches on sample size. Pure modules → no DB, no
// React render.
//
// Run: node scripts/eval-cost-estimator.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { summarizeUsageRecords } from "../app/lib/usage-summary.js";
import {
  resolveEstimatorBaseRate,
  strategyProfile,
  ANCHOR_COPY,
  REPLIES_LABEL,
  CALC_MIN_SAMPLE,
  SIDE_CALL_OVERHEAD,
} from "../app/lib/cost-estimator-math.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${String(err.message).split("\n")[0]}`); }
}

const day = (d) => new Date(`2026-06-0${d}T10:00:00Z`);
const chatRow = (cost, emb = 0) => ({ model: "claude-sonnet", costUsd: cost, embeddingCostUsd: emb, inputTokens: 100, outputTokens: 50, toolCalls: 1, createdAt: day(1) });
const imageRow = (cost) => ({ model: "image:gemini", imageCostUsd: cost, imageCount: 1, costUsd: 0, createdAt: day(2) });

console.log("\ncost-estimator accuracy eval\n");

// ── Problem 2: chat-only cost excludes image previews ──
test("chatOnlyCost = Anthropic chat + embeddings, image previews excluded", () => {
  const s = summarizeUsageRecords([chatRow(0.006, 0.0005), chatRow(0.006, 0.0005), imageRow(0.04)], "a", "b");
  assert.equal(s.totalMessages, 2, "image rows are not chat messages");
  assert.ok(Math.abs(s.chatOnlyCost - 0.013) < 1e-9, `chatOnlyCost=${s.chatOnlyCost}`);
  assert.ok(Math.abs(s.imageCost - 0.04) < 1e-9, "image cost kept separate");
  assert.ok(Math.abs(s.totalCost - 0.053) < 1e-9, "totalCost still includes image");
});

test("avgChatCostPerMessage = chatOnlyCost / totalMessages (not total avg)", () => {
  const s = summarizeUsageRecords([chatRow(0.006), chatRow(0.006), imageRow(0.04)], "a", "b");
  assert.ok(Math.abs(s.avgChatCostPerMessage - 0.006) < 1e-9, `avgChat=${s.avgChatCostPerMessage}`);
  // The all-in average is inflated by the image preview — and is NOT what the
  // estimator uses.
  assert.ok(s.avgCostPerMessage > s.avgChatCostPerMessage, "all-in avg is higher");
  assert.ok(Math.abs(s.avgCostPerMessage - 0.026) < 1e-9, `avgAll=${s.avgCostPerMessage}`);
});

test("adding image previews does NOT change avgChatCostPerMessage", () => {
  const base = summarizeUsageRecords([chatRow(0.006), chatRow(0.008)], "a", "b");
  const withImages = summarizeUsageRecords([chatRow(0.006), chatRow(0.008), imageRow(0.04), imageRow(0.04)], "a", "b");
  assert.ok(Math.abs(base.avgChatCostPerMessage - withImages.avgChatCostPerMessage) < 1e-12, "image clicks must not move the chat rate");
  assert.equal(withImages.imageCount, 2, "image count tracked separately");
});

test("empty / no-message window → safe zeros", () => {
  const s = summarizeUsageRecords([], "a", "b");
  assert.equal(s.avgChatCostPerMessage, 0);
  assert.equal(s.chatOnlyCost, 0);
});

// ── Problem 1 + 4: estimator anchors on chat-only avg, with copy by sample ──
const { rates } = strategyProfile("smart");

test("anchored when there are enough recorded chat replies", () => {
  const r = resolveEstimatorBaseRate({ avgChatCostPerMessage: 0.006, totalMessages: CALC_MIN_SAMPLE, rates });
  assert.equal(r.anchored, true);
  // Anchored base = recorded chat avg × the disclosed side-call overhead.
  assert.ok(Math.abs(r.baseRate - 0.006 * SIDE_CALL_OVERHEAD) < 1e-12, `baseRate=${r.baseRate}`);
});

test("fallback to the blended rate when the sample is too small", () => {
  const r = resolveEstimatorBaseRate({ avgChatCostPerMessage: 0.006, totalMessages: CALC_MIN_SAMPLE - 1, rates });
  assert.equal(r.anchored, false);
  assert.equal(r.baseRate, rates.fallback, "uses the strategy fallback, not the store avg");
});

test("fallback when there is no recorded average yet", () => {
  const r = resolveEstimatorBaseRate({ avgChatCostPerMessage: 0, totalMessages: 1000, rates });
  assert.equal(r.anchored, false);
  assert.equal(r.baseRate, rates.fallback);
});

test("side-call overhead lifts the anchored rate but never the fallback", () => {
  const anchored = resolveEstimatorBaseRate({ avgChatCostPerMessage: 0.01, totalMessages: 100, rates });
  assert.ok(anchored.baseRate > 0.01, "anchored real avg is nudged up for unmetered side calls");
  const fb = resolveEstimatorBaseRate({ avgChatCostPerMessage: 0.01, totalMessages: 2, rates });
  assert.equal(fb.baseRate, rates.fallback, "fallback already includes overhead — not multiplied again");
});

test("anchored vs fallback COPY is correct and distinct", () => {
  assert.match(ANCHOR_COPY.anchored, /recorded chat average over the selected analytics period/i);
  assert.match(ANCHOR_COPY.fallback, /typical model-routing assumptions until your store has enough traffic/i);
  assert.notEqual(ANCHOR_COPY.anchored, ANCHOR_COPY.fallback);
});

test("multiplier label says assistant replies, not AI requests", () => {
  assert.equal(REPLIES_LABEL, "assistant replies / mo");
  assert.doesNotMatch(REPLIES_LABEL, /request/i);
});

// ── Problem 1 + 6: the component source must not imply raw API request counts ──
const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT = readFileSync(join(here, "..", "app", "components", "CostEstimator.jsx"), "utf8");
const ROUTE = readFileSync(join(here, "..", "app", "routes", "app.analytics.jsx"), "utf8");

test("CostEstimator labels/copy never say 'AI request' or 'per request'", () => {
  // (Allowed only inside the explanatory comment that says it's NOT requests.)
  const code = COMPONENT.replace(/\/\/[^\n]*\n/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /AI request/i, "no 'AI requests' label");
  assert.doesNotMatch(code, /per AI request/i);
  assert.match(COMPONENT, /assistant repl/i, "uses 'assistant replies' wording");
});

test("the route passes avgChatCostPerMessage (not avgCostPerMessage) to the estimator", () => {
  assert.match(ROUTE, /<CostEstimator[^>]*avgChatCostPerMessage=\{usage\.avgChatCostPerMessage\}/);
  assert.doesNotMatch(ROUTE, /<CostEstimator[^>]*avgCostPerMessage=\{usage\.avgCostPerMessage\}/);
});

test("the component accepts the avgChatCostPerMessage prop", () => {
  assert.match(COMPONENT, /function CostEstimator\(\{\s*avgChatCostPerMessage/);
});

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) console.error(`FAIL: ${f.name}\n${f.err.stack}`); process.exit(1); }
