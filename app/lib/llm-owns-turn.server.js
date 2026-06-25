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

// ── Orthotic-gate shadow ────────────────────────────────────────────
// The orthotic finder is a PRE-LLM router gate: it inspects the turn and,
// when it decides the customer wants a fitting, short-circuits the turn
// with its own deterministic chip questionnaire — the model never sees the
// turn. That makes the gate a SECOND engage/defer decision-maker competing
// with the model, which already has a `recommend_orthotic` TOOL it can call
// for exactly the same job. Every bug in this domain (browse hijacked into
// a quiz, an efficacy question answered with "what's your arch type?") is
// the regex gate engaging where the model would not have.
//
// Before we hand that decision to the model (and let the questionnaire live
// behind the tool), we measure the disagreement. When ORTHOTIC_GATE_SHADOW
// is on AND the gate decided to engage, we ask the model — same conversation,
// same tools — what IT would do, and log whether it agrees (reaches for the
// recommender) or would have just answered. Pure observation: it never emits
// to the customer and never alters the gate's behavior. Default OFF.
export function isOrthoticGateShadowEnabled() {
  return String(process.env.ORTHOTIC_GATE_SHADOW || "").toLowerCase() === "true";
}

// Run the shadow probe. Single non-streaming model call; inspects the first
// turn's tool choice. Returns { llmChoice, agree } and logs one line. Throws
// nothing to the caller — a probe failure must never affect the live turn.
export async function logOrthoticGateShadow({
  anthropic,
  model,
  system,
  tools,
  messages,
  shop,
  gateCase = "",
}) {
  try {
    const probe = await anthropic.messages.create({
      model,
      max_tokens: 256,
      system,
      tools,
      messages,
    });
    const toolUses = (probe?.content || []).filter((b) => b?.type === "tool_use");
    const names = toolUses.map((u) => String(u?.name || "")).filter(Boolean);
    const calledRecommend = names.some((n) => n.startsWith("recommend_"));
    const calledOther = names.length > 0 && !calledRecommend;
    const llmChoice = calledRecommend
      ? "recommend_orthotic"
      : calledOther
        ? `other_tool(${names.join(",")})`
        : "text_answer";
    // Gate ENGAGED the finder; "agree" means the model would also reach for
    // the recommender. text_answer / other_tool ⇒ the gate over-engaged.
    const agree = calledRecommend;
    console.log(
      `[orthotic-gate-shadow] ${shop} gate=engage${gateCase ? `(case=${gateCase})` : ""} ` +
        `llm=${llmChoice} agree=${agree}`,
    );
    return { llmChoice, agree };
  } catch (err) {
    console.log(`[orthotic-gate-shadow] ${shop} probe failed: ${err?.message || err}`);
    return null;
  }
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
  // 1) Preferred: the EVIDENCE pool — every product the model received
  //    from tool calls this turn, before display guards filtered the
  //    visible card set. Grounding is about what the model SAW, not
  //    what the UI shows. Live trace 2026-06-10: a display guard wiped
  //    6 valid Reagan cards; validating against the post-guard display
  //    pool flagged a perfectly grounded answer and burned 3 retries.
  const evidence = result?.evidencePool;
  if (Array.isArray(evidence) && evidence.length > 0) {
    return evidence;
  }
  // 2) Post-processed final display cards from the agent loop.
  const turnProducts = result?.turnResult?.products;
  if (Array.isArray(turnProducts) && turnProducts.length > 0) {
    return turnProducts;
  }
  // 3) Direct finalProductCards (some callers expose it).
  const finalCards = result?.finalProductCards;
  if (Array.isArray(finalCards) && finalCards.length > 0) {
    return finalCards;
  }
  // 4) Message-history scan (test fixtures + raw agent outputs).
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

// Truth/safety errors that must NEVER ship — they keep blocking through
// every attempt and, if still failing at exhaustion, force a deterministic
// safe fallback instead of the bad draft.
const HARD_BLOCKER_KINDS = new Set([
  "ungrounded_product_name",
  "wrong_price",
  "unsupported_feature_claim",
  "false_catalog_denial",
  "false_color_denial",
  "raw_handle_leak",
  "missing_product_lookup",
]);
// Style failures that are downgraded to warnings AFTER the first retry —
// shipping a real-but-slightly-imperfect answer beats looping or gutting.
const SOFT_STYLE_KINDS = new Set(["too_long", "answer_first"]);

const SHORTEN_CHARS = Number(process.env.VALIDATOR_MAX_CHARS) || 500;

// Keep whole sentences up to a character budget (answer-first content lives
// at the front, so this preserves the actual answer). Never leaves a
// dangling half-sentence.
function shortenToBudget(text, maxChars = SHORTEN_CHARS) {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;
  const sentences = t.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    if (out && (out + " " + s).length > maxChars) break;
    out = out ? out + " " : s;
    if (out.length >= maxChars) break;
  }
  if (!out) out = t.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return out;
}

// Intent-aware safe fallback for when validation can't be satisfied. NEVER
// returns generic "tell me more" or a fragment — it answers honestly within
// the intent, and only promises "closest matches" when cards actually exist.
function buildSafeFallback(userMessage, hasCards) {
  const m = String(userMessage || "").toLowerCase();
  const isSizing = /\bwhat\s+size|which\s+size|size\s+(?:should|do|would|to)|true\s+to\s+size|size\s+up|size\s+down|size\s*\d|runs?\s+(?:small|large|big|narrow|wide|tight)/i.test(m);
  const isComparison = /\b(?:vs\.?|versus|compare|which\s+is\s+better|better\s+for|which\s+(?:one\s+)?should)\b/i.test(m);

  if (isSizing) {
    return "I can't verify exact size guidance from the product data right now, but a safe bet is to start with your usual size — if your feet swell or you're between sizes, look for an adjustable strap and lean on our easy returns so you can swap if the fit isn't right.";
  }
  if (isComparison && hasCards) {
    return "Both are solid picks and I want to double-check the finer specs before I call a winner — take a look at the options below. If all-day walking support matters most, tell me and I'll point you to the sturdier one; if it's more about style for lighter days, the other's a great choice.";
  }
  if (hasCards) {
    return "I want to double-check that style's details before I give you a firm answer — here are the closest matches so you can compare in the meantime, and tell me what matters most and I'll narrow it down.";
  }
  return "I couldn't pull up verified details for that just now — want me to run the search again, or tell me a bit more (support, style, or budget) so I can find the right pair?";
}

export async function runWithGroundingRetry({
  runLoop,
  initialMessages,
  maxRetries = 2,
  onAttempt = null,
  // Catalog gender×category truth, so the validator can reject a false
  // "we don't carry men's footwear" denial and let the model self-correct.
  categoryGenderMap = null,
  // The customer's latest message — lets the validator enforce the retail
  // answer contract (answer-first + concise) for decision/advisory turns.
  userMessage = "",
  // True when the customer named a specific catalog product this turn — so
  // the validator can force a product lookup on value/fit/condition questions.
  namedProductMentioned = false,
} = {}) {
  let messages = (initialMessages || []).slice();
  let attempt = 0;
  let last = null;
  let lastErrors = [];
  // Best substantial answer seen across attempts, for fragment recovery.
  // The grounding validator sometimes false-rejects a legitimate
  // product-feature phrase (prod 2026-06-24: "Built-in Aetrex Signature
  // Arch Support" flagged as unsupported on a sandal that obviously has
  // arch support). The model then "corrects" into a gutted retry that the
  // scrubbers reduce to "Take a look — these are the closest matches" — a
  // trivially-grounded NON-answer that passes validation and ships, while
  // the real 1900-char answer is discarded. We keep the best substantial
  // draft so we can ship it instead of a fragment. ONLY drafts whose only
  // errors are the false-positive-prone `unsupported_feature_claim` kind
  // qualify — we never recover a draft with a wrong price or a
  // hallucinated product name.
  let bestSubstantial = null; // { result, len }
  const FRAGMENT_MAX = 90;
  const SUBSTANTIAL_MIN = 250;
  const considerSubstantial = (result, text, validation) => {
    const len = (text || "").trim().length;
    if (len < SUBSTANTIAL_MIN) return;
    // Preserve a substantial real answer whose only problems are the
    // false-positive-prone feature claim OR pure style (too long / not
    // answer-first). At exhaustion we shorten and ship it rather than
    // collapsing to a "tell me more" non-answer.
    const RECOVERABLE = new Set(["unsupported_feature_claim", "too_long", "answer_first"]);
    const onlySoftErrors =
      validation.errors.length > 0 &&
      validation.errors.length <= 3 &&
      validation.errors.every((e) => RECOVERABLE.has(e?.kind));
    if (!onlySoftErrors) return;
    if (!bestSubstantial || len > bestSubstantial.len) {
      bestSubstantial = { result, len };
    }
  };
  // Usage accumulates across ALL attempts so the caller bills what was
  // actually spent — a validator retry costs a full extra model
  // round-trip and must not vanish from the usage record.
  const accUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const mergeUsage = (u) => {
    if (!u || typeof u !== "object") return;
    for (const k of Object.keys(accUsage)) accUsage[k] += u[k] || 0;
  };

  // Style-only validator failures (length, answer-first, raw handle) are
  // fixable by REWRITING the existing draft — the data is already correct.
  // Re-running the full agentic loop (and its product searches) for those
  // is wasted money/latency, so the next attempt runs tools-off. Data
  // failures (ungrounded name, wrong price, missing lookup, false denial)
  // still re-run tools so the model can fetch what it's missing.
  const REWRITE_ONLY_KINDS = new Set(["too_long", "answer_first", "raw_handle_leak"]);
  let nextRewriteOnly = false;

  while (attempt <= maxRetries) {
    // `attempt` lets the caller route models per attempt — e.g. run
    // attempt 0 on Haiku and escalate retries to Sonnet so a validator
    // rejection gets the stronger model for the correction.
    const result = await runLoop({ messages: messages.slice(), attempt, rewriteOnly: nextRewriteOnly });
    last = result;
    mergeUsage(result?.totalUsage);
    const text = result?.fullResponseText || "";
    const pool = gatherPoolFromResult(result, messages);
    const validation = validateGrounding({
      text,
      pool,
      categoryGenderMap,
      userMessage,
      namedProductMentioned,
      searchAttempted: Boolean(result?.productSearchAttempted),
    });

    if (typeof onAttempt === "function") {
      onAttempt({ attempt, validation, textLen: text.length, poolSize: pool.length });
    }

    considerSubstantial(result, text, validation);

    if (validation.ok) {
      // Don't ship a gutted fragment when an earlier attempt produced a
      // real, substantial answer that was only soft-rejected (feature
      // false-positive). The fragment "passes" grounding precisely because
      // the scrubbers stripped it to nothing — that's a non-answer.
      if (text.trim().length < FRAGMENT_MAX && bestSubstantial) {
        console.log(
          `[grounding-retry] recovered substantial draft (${bestSubstantial.len} chars) over fragment (${text.trim().length} chars)`,
        );
        return {
          ...bestSubstantial.result,
          totalUsage: { ...accUsage },
          validation: { ok: true, errors: [], attempts: attempt + 1, recoveredSubstantial: true },
        };
      }
      return {
        ...result,
        totalUsage: { ...accUsage },
        validation: { ok: true, errors: [], attempts: attempt + 1 },
      };
    }

    lastErrors = validation.errors;

    // Fix #2: after the FIRST retry (attempt >= 1), demote pure style
    // failures (too long / not answer-first) to warnings and SHIP the
    // answer — a real reply that's a touch long beats looping to a third
    // attempt or collapsing to a fragment. Truth/safety errors never reach
    // here as "all soft", so they keep blocking.
    if (attempt >= 1 && validation.errors.every((e) => SOFT_STYLE_KINDS.has(e.kind))) {
      const tooLong = validation.errors.some((e) => e.kind === "too_long");
      const shipped = tooLong ? shortenToBudget(text) : text;
      console.log(
        `[grounding-retry] soft-accept after retry (${validation.errors.map((e) => e.kind).join(",")})` +
          (tooLong ? ` — shortened ${text.length}→${shipped.length} chars` : ""),
      );
      return {
        ...result,
        fullResponseText: shipped,
        totalUsage: { ...accUsage },
        validation: { ok: true, errors: [], attempts: attempt + 1, softWarnings: validation.errors.map((e) => e.kind) },
      };
    }

    // Don't retry if we've hit the cap.
    if (attempt >= maxRetries) break;

    // If EVERY failure is style-only, the next attempt rewrites the draft
    // with tools disabled. If even one is a data failure, keep tools on.
    nextRewriteOnly = validation.errors.length > 0
      && validation.errors.every((e) => REWRITE_ONLY_KINDS.has(e.kind));

    // Hand the errors back to the model. The retry instruction is
    // appended as a NEW user turn so the model treats it as a
    // correction request from the system, not a customer message.
    // Include the failed draft in the instruction: runAgenticLoop does
    // NOT return its messages array, so result?.messages is undefined
    // and the retry conversation would otherwise reference "your
    // previous reply" without the model ever seeing that reply.
    const retryInstruction = buildRetryInstruction(validation.errors, text, pool);
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

  // Retries exhausted. NEVER ship the failed draft (it may be a fragment, a
  // raw handle, a wrong price, or a "tell me more" non-answer).
  //
  // Fix #3: if we captured a real substantial answer earlier (only soft /
  // false-positive-prone errors), ship it — shortened to budget — instead
  // of discarding it.
  if (bestSubstantial) {
    const shortened = shortenToBudget(bestSubstantial.result?.fullResponseText || "");
    console.log(
      `[grounding-retry] exhausted; shipping recovered substantial answer (${bestSubstantial.len}→${shortened.length} chars)`,
    );
    return {
      ...bestSubstantial.result,
      fullResponseText: shortened,
      totalUsage: { ...accUsage },
      validation: { ok: false, errors: lastErrors, attempts: attempt + 1, recoveredSubstantial: true },
    };
  }

  // Fix #1: otherwise, ship an intent-aware safe fallback built on the last
  // attempt's cards — never the failed text, never a generic fragment.
  const lastPool = gatherPoolFromResult(last, messages);
  const fallbackText = buildSafeFallback(userMessage, lastPool.length > 0);
  console.log(
    `[grounding-retry] exhausted; shipping deterministic safe fallback (intent-aware, cards=${lastPool.length})`,
  );
  return {
    ...(last || {}),
    fullResponseText: fallbackText,
    totalUsage: { ...accUsage },
    validation: { ok: false, errors: lastErrors, attempts: attempt + 1, deterministicFallback: true },
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
