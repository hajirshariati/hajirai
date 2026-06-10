// Phase 1 of the migration plan — "LLM owns the turn" entry point.
//
// What this module IS:
//   - A clean, narrow path that runs ONE model with the existing tool
//     set, validates the reply with the grounding validator, and on
//     validation failure hands the errors BACK to the model with a
//     retry instruction (the missing piece from both previous attempts).
//   - Feature-flagged: default OFF, opts in via LLM_OWNS_ALL_TURNS=true.
//   - Shadow-mode capable: LLM_OWNS_ALL_TURNS_SHADOW=true runs the new
//     path in parallel with the old (old answers the customer; new
//     answer is logged) so we diff before flipping the main switch.
//
// What this module is NOT:
//   - A second answer system. The actual model invocation reuses
//     runAgenticLoop from chat.jsx unchanged. We only wrap retry logic
//     around it.
//   - A replacement for tools, RAG, recommenders, or the orthotic
//     decision tree. Those stay code-owned. The model's job is reading
//     the customer's question and composing words from verified facts.
//
// Phase 2+ will move the engine's claim-fact attachment INTO the
// search_products tool result so every card already ships verified
// facts. This file's validator will then have richer evidence to
// check against, and code-owned templates can shrink to the safety-
// net floor they should be.

import {
  validateGrounding,
  buildRetryInstruction,
} from "./grounding-validator.server.js";

export function isLlmOwnsTurnEnabled() {
  // Default ON since 2026-06-10 (pre-launch, no live customers — the
  // owner asked for the new path in production directly). Set
  // LLM_OWNS_ALL_TURNS=false in Railway as the kill switch to fall
  // back to the legacy dispatcher cascade.
  const raw = String(process.env.LLM_OWNS_ALL_TURNS || "").toLowerCase();
  if (raw === "false") return false;
  return true;
}

export function isShadowModeEnabled() {
  return String(process.env.LLM_OWNS_ALL_TURNS_SHADOW || "").toLowerCase() === "true";
}

// Collect the products the model saw this turn from tool result history.
// runAgenticLoop pushes tool_result messages onto its conversation; we
// scan those for cards so the validator can check claims against the
// model's actual tool evidence.
//
// Returns a deduped array of product cards (by handle) shaped to match
// what extractProductCards emits — title, price_formatted, _description,
// _tags, _attributes, _claimFacts (when present).
export function gatherPoolFromMessages(messages = []) {
  const seen = new Map();
  for (const msg of messages || []) {
    if (msg?.role !== "user") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      if (part?.type !== "tool_result") continue;
      const blocks = Array.isArray(part.content) ? part.content : [];
      for (const b of blocks) {
        if (b?.type !== "text" || !b.text) continue;
        let parsed = null;
        try { parsed = JSON.parse(b.text); } catch { /* not JSON — skip */ }
        if (!parsed) continue;
        const products = Array.isArray(parsed.products) ? parsed.products : [];
        for (const p of products) {
          const handle = String(p?.handle || "").trim();
          if (!handle || seen.has(handle)) continue;
          seen.set(handle, p);
        }
      }
    }
  }
  return [...seen.values()];
}

// Gather the pool from an agent-loop result. Reads turnResult.products
// (the post-processed final cards — what the customer actually sees)
// when available, falls back to message-history scan otherwise.
// Live trace 2026-06-10: validator was reporting pool=0 even when the
// reply attached 5 cards, because runAgenticLoop doesn't return its
// internal messages array — it returns turnResult.products.
export function gatherPoolFromResult(result, fallbackMessages = []) {
  // 1) Preferred: post-processed final cards from the agent loop.
  const turnProducts = result?.turnResult?.products;
  if (Array.isArray(turnProducts) && turnProducts.length > 0) {
    return turnProducts;
  }
  // 2) Direct finalProductCards (some callers expose it).
  const finalCards = result?.finalProductCards;
  if (Array.isArray(finalCards) && finalCards.length > 0) {
    return finalCards;
  }
  // 3) Message-history scan (test fixtures + raw agent outputs).
  return gatherPoolFromMessages(result?.messages || fallbackMessages);
}

// Wrap an agent-loop call with grounding validation and retry. Caller
// passes a `runLoop` function that performs ONE model invocation and
// returns { fullResponseText, finalProductCards, messages }. We:
//
//   1. Run the loop.
//   2. Validate the reply against the pool gathered from tool results.
//   3. If ok → return as-is.
//   4. If not ok → push a retry instruction back into the conversation
//      and run the loop again. Max 2 retries.
//   5. If still not ok after 2 retries → return the last attempt but
//      flag it so the caller can fall back to a safe template.
//
// The retry never silently rewrites text. The model gets the structured
// errors and produces a corrected reply itself — that's the whole
// reason this works where post-processing fails.
//
// Returns:
//   {
//     fullResponseText, finalProductCards, messages,
//     validation: { ok, errors, attempts },
//   }
export async function runWithGroundingRetry({
  runLoop,
  initialMessages,
  maxRetries = 2,
  onAttempt = null,
} = {}) {
  let messages = (initialMessages || []).slice();
  let attempt = 0;
  let last = null;
  let lastErrors = [];

  while (attempt <= maxRetries) {
    const result = await runLoop({ messages: messages.slice() });
    last = result;
    const text = result?.fullResponseText || "";
    const pool = gatherPoolFromResult(result, messages);
    const validation = validateGrounding({ text, pool });

    if (typeof onAttempt === "function") {
      onAttempt({ attempt, validation, textLen: text.length, poolSize: pool.length });
    }

    if (validation.ok) {
      return {
        ...result,
        validation: { ok: true, errors: [], attempts: attempt + 1 },
      };
    }

    lastErrors = validation.errors;
    // Don't retry if we've hit the cap.
    if (attempt >= maxRetries) break;

    // Hand the errors back to the model. The retry instruction is
    // appended as a NEW user turn so the model treats it as a
    // correction request from the system, not a customer message.
    // Include the failed draft in the instruction: runAgenticLoop does
    // NOT return its messages array, so result?.messages is undefined
    // and the retry conversation would otherwise reference "your
    // previous reply" without the model ever seeing that reply.
    const retryInstruction = buildRetryInstruction(validation.errors, text);
    messages = (result?.messages || messages).slice();
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "[GROUNDING VALIDATOR — internal correction, not from the customer]\n\n" +
            retryInstruction,
        },
      ],
    });
    attempt += 1;
  }

  return {
    ...last,
    validation: { ok: false, errors: lastErrors, attempts: attempt + 1 },
  };
}

// Build the diff record for shadow-mode logs. The old pipeline's
// answer is the ground truth for the customer; the new pipeline's
// answer is recorded so we can compare. Differences worth flagging:
//   - text length deltas (huge swings = behavior change)
//   - card-count deltas
//   - validator findings on either side
//   - whether either path emitted cards at all
export function shadowDiffRecord({ oldResult, newResult }) {
  const oldText = oldResult?.fullResponseText || "";
  const newText = newResult?.fullResponseText || "";
  const oldCards = oldResult?.finalProductCards?.length || 0;
  const newCards = newResult?.finalProductCards?.length || 0;
  return {
    old: {
      textLen: oldText.length,
      cards: oldCards,
      hasText: oldText.length > 0,
    },
    new: {
      textLen: newText.length,
      cards: newCards,
      hasText: newText.length > 0,
      validation: newResult?.validation || null,
    },
    delta: {
      textLenDiff: newText.length - oldText.length,
      cardsDiff: newCards - oldCards,
      bothEmpty: !oldText && !newText,
      newOnlyEmpty: oldText.length > 0 && newText.length === 0,
      oldOnlyEmpty: newText.length > 0 && oldText.length === 0,
    },
  };
}
