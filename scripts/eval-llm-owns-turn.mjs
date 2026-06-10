// Phase 1 orchestrator — verifies the retry-on-ungrounded contract
// without invoking the real Anthropic API. The runLoop function is a
// stub that returns deterministic responses, so we can assert how
// runWithGroundingRetry handles success, failure, and retry exhaustion.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLlmOwnsTurnEnabled,
  isShadowModeEnabled,
  gatherPoolFromMessages,
  runWithGroundingRetry,
  shadowDiffRecord,
} from "../app/lib/llm-owns-turn.server.js";

// ─── Feature flags ─────────────────────────────────────────────

test("LLM_OWNS_ALL_TURNS defaults to ON (pre-launch, no live customers)", () => {
  delete process.env.LLM_OWNS_ALL_TURNS;
  assert.equal(isLlmOwnsTurnEnabled(), true);
});

test("LLM_OWNS_ALL_TURNS=false is the kill switch back to legacy", () => {
  process.env.LLM_OWNS_ALL_TURNS = "false";
  assert.equal(isLlmOwnsTurnEnabled(), false);
  delete process.env.LLM_OWNS_ALL_TURNS;
});

test("LLM_OWNS_ALL_TURNS=true also enables (explicit)", () => {
  process.env.LLM_OWNS_ALL_TURNS = "true";
  assert.equal(isLlmOwnsTurnEnabled(), true);
  delete process.env.LLM_OWNS_ALL_TURNS;
});

test("LLM_OWNS_ALL_TURNS_SHADOW flag defaults to false", () => {
  delete process.env.LLM_OWNS_ALL_TURNS_SHADOW;
  assert.equal(isShadowModeEnabled(), false);
});

// ─── Pool gathering from tool result messages ──────────────────

test("gatherPoolFromMessages pulls products from tool_result JSON blocks", () => {
  const messages = [
    { role: "user", content: "what sandals do you have?" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "search_products", input: { query: "sandals" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                products: [
                  { handle: "jillian-black", title: "Jillian Sandal - Black" },
                  { handle: "vicki-tan", title: "Vicki Sandal - Tan" },
                ],
              }),
            },
          ],
        },
      ],
    },
  ];
  const pool = gatherPoolFromMessages(messages);
  assert.equal(pool.length, 2);
  assert.equal(pool[0].handle, "jillian-black");
});

test("gatherPoolFromMessages dedupes by handle across multiple tool calls", () => {
  const messages = [
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: JSON.stringify({ products: [{ handle: "x", title: "X" }] }) }],
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t2",
        content: [{ type: "text", text: JSON.stringify({ products: [{ handle: "x", title: "X" }, { handle: "y", title: "Y" }] }) }],
      }],
    },
  ];
  const pool = gatherPoolFromMessages(messages);
  assert.equal(pool.length, 2);
});

test("gatherPoolFromMessages tolerates malformed tool_result content (no throw)", () => {
  const messages = [
    {
      role: "user",
      content: [{
        type: "tool_result", tool_use_id: "t",
        content: [{ type: "text", text: "not JSON at all" }],
      }],
    },
  ];
  assert.doesNotThrow(() => gatherPoolFromMessages(messages));
  assert.equal(gatherPoolFromMessages(messages).length, 0);
});

// ─── Retry-on-ungrounded behavior ─────────────────────────────

test("first attempt grounded → returns immediately, no retry", async () => {
  let calls = 0;
  const runLoop = async () => {
    calls += 1;
    return {
      fullResponseText: "Thanks for asking! Here's what I'd recommend.",
      finalProductCards: [],
      messages: [],
    };
  };
  const out = await runWithGroundingRetry({
    runLoop,
    initialMessages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.validation.ok, true);
  assert.equal(out.validation.attempts, 1);
  assert.equal(calls, 1);
});

test("ungrounded product → retries with error feedback, succeeds on attempt 2", async () => {
  let calls = 0;
  const pool = [{ handle: "jillian-black", title: "Jillian Sandal - Black" }];
  const runLoop = async ({ messages }) => {
    calls += 1;
    // First attempt: invent a product.
    // Second attempt: stick to the pool.
    const text = calls === 1
      ? "The **Phantom Sneaker** is a great pick."
      : "The **Jillian Sandal** would work well.";
    // Simulate the agent loop pushing a tool_result onto messages.
    const updatedMessages = (messages || []).concat([{
      role: "user",
      content: [{
        type: "tool_result", tool_use_id: "t",
        content: [{ type: "text", text: JSON.stringify({ products: pool }) }],
      }],
    }]);
    return {
      fullResponseText: text,
      finalProductCards: pool,
      messages: updatedMessages,
    };
  };
  const out = await runWithGroundingRetry({
    runLoop,
    initialMessages: [{ role: "user", content: "show me a sandal" }],
  });
  assert.equal(out.validation.ok, true);
  assert.equal(out.validation.attempts, 2);
  assert.equal(calls, 2);
  assert.match(out.fullResponseText, /Jillian/);
});

test("retry instruction is appended to messages before second attempt", async () => {
  let secondCallMessages = null;
  let calls = 0;
  const pool = [{ handle: "jillian-black", title: "Jillian Sandal - Black" }];
  const runLoop = async ({ messages }) => {
    calls += 1;
    if (calls === 2) secondCallMessages = messages;
    const text = calls === 1
      ? "The **Phantom** is the pick."
      : "The **Jillian Sandal** works.";
    return {
      fullResponseText: text,
      finalProductCards: [],
      messages: (messages || []).concat([{
        role: "user",
        content: [{
          type: "tool_result", tool_use_id: "t",
          content: [{ type: "text", text: JSON.stringify({ products: pool }) }],
        }],
      }]),
    };
  };
  await runWithGroundingRetry({
    runLoop,
    initialMessages: [{ role: "user", content: "show me" }],
  });
  const lastTurn = secondCallMessages[secondCallMessages.length - 1];
  const lastText = lastTurn?.content?.[0]?.text || "";
  assert.match(lastText, /GROUNDING VALIDATOR/);
  assert.match(lastText, /Phantom/);
});

test("max retries exhausted → returns last attempt with validation.ok=false", async () => {
  let calls = 0;
  const pool = [{ handle: "jillian-black", title: "Jillian Sandal - Black" }];
  const runLoop = async ({ messages }) => {
    calls += 1;
    return {
      // Always ungrounded — the model never fixes it.
      fullResponseText: "The **Phantom Sneaker** is great.",
      finalProductCards: [],
      messages: (messages || []).concat([{
        role: "user",
        content: [{
          type: "tool_result", tool_use_id: "t",
          content: [{ type: "text", text: JSON.stringify({ products: pool }) }],
        }],
      }]),
    };
  };
  const out = await runWithGroundingRetry({
    runLoop,
    initialMessages: [{ role: "user", content: "show me" }],
    maxRetries: 2,
  });
  assert.equal(out.validation.ok, false);
  assert.equal(out.validation.attempts, 3); // attempts = initial + 2 retries
  assert.ok(out.validation.errors.length > 0);
  assert.equal(calls, 3);
});

test("onAttempt callback fires per attempt with validation + sizes", async () => {
  const seen = [];
  const runLoop = async () => ({
    fullResponseText: "hi",
    finalProductCards: [],
    messages: [],
  });
  await runWithGroundingRetry({
    runLoop,
    initialMessages: [],
    onAttempt: (info) => seen.push(info),
  });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].textLen, "number");
  assert.equal(typeof seen[0].poolSize, "number");
});

// ─── Shadow-mode diff record ───────────────────────────────────

test("shadowDiffRecord captures both sides and computes deltas", () => {
  const oldResult = { fullResponseText: "Old answer about Jillian.", finalProductCards: [{}, {}] };
  const newResult = {
    fullResponseText: "New answer about Jillian sandal in tan.",
    finalProductCards: [{}, {}, {}],
    validation: { ok: true, errors: [], attempts: 1 },
  };
  const diff = shadowDiffRecord({ oldResult, newResult });
  assert.equal(diff.old.cards, 2);
  assert.equal(diff.new.cards, 3);
  assert.equal(diff.delta.cardsDiff, 1);
  assert.ok(diff.delta.textLenDiff > 0);
  assert.equal(diff.new.validation.ok, true);
});

test("shadowDiffRecord flags new-only-empty (regression risk)", () => {
  const diff = shadowDiffRecord({
    oldResult: { fullResponseText: "Real answer", finalProductCards: [] },
    newResult: { fullResponseText: "", finalProductCards: [] },
  });
  assert.equal(diff.delta.newOnlyEmpty, true);
  assert.equal(diff.delta.oldOnlyEmpty, false);
});

console.log("\nAll llm-owns-turn orchestrator tests done.");
