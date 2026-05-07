// Orthotic-flow gate: a thin orchestrator that decides whether the
// state machine in orthotic-flow.server.js should take this turn,
// and if so, emits the SSE response server-side instead of letting
// the LLM run.
//
// Gate fires when:
//   - A `recommend_orthotic` decision tree is configured for the
//     shop, AND
//   - The conversation is mid-orthotic-flow — i.e. detectFlowState
//     identifies a current question node from the chip fingerprint
//     of the most recent assistant turn, AND
//   - The latest user reply maps to an enum value via Layer 1
//     (exact chip click) or Layer 2 (keyword enrichment).
//
// When the gate fires, this function:
//   - Advances the state machine,
//   - For a "question" step: emits the seed's question text + chips
//     (server-authoritative, no drift) and ends the SSE stream,
//   - For a "resolve" step: runs executeRecommenderTool through the
//     existing resolver/derivation/enrichment pipeline, emits the
//     product card via the standard `products` chunk, optionally
//     emits a brief LLM-generated description, and ends the stream,
//   - For a "done" step (no-match): emits a graceful redirect text
//     and ends the stream.
//
// When the gate does NOT fire, this function returns
// `{ handled: false }` and the normal LLM-driven runAgenticLoop
// proceeds unchanged. That keeps the gate opt-in and safe — any
// drift, off-topic, or free-text reply that the state machine
// can't confidently advance just falls through to the LLM as
// before.

import {
  getNextStep,
  mapAnswerToEnum,
  findNodeByChipsInText,
  findNodeById,
  getRootNode,
  nextNodeFromTransition,
  buildConstrainedAnswerPrompt,
  parseConstrainedAnswerResponse,
  isOffTopicReply,
  detectOrthoticIntent,
  hasOrthoticRejection,
  preExtractAnswers,
  accumulateAnswers,
} from "./orthotic-flow.server.js";
import { executeRecommenderTool } from "./recommender-tools.server.js";

const ORTHOTIC_INTENT = "orthotic";

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Format a question node into customer-facing text with chip
 * markers. The widget's existing `<<Label>>` chip syntax is what
 * the renderer already understands.
 *
 * Chip labels come straight from the seed — no LLM rewrite, so the
 * customer's click on "None — just want comfort" maps cleanly back
 * to condition="none" via Layer 1 exact match next turn.
 */
function renderQuestionText(node) {
  if (!node || node.type !== "question") return "";
  const q = String(node.question || "").trim();
  const chipLabels = (node.chips || [])
    .map((c) => String(c?.label || "").trim())
    .filter(Boolean);
  if (chipLabels.length === 0) return q;
  const chipLine = chipLabels.map((l) => `<<${l}>>`).join(" ");
  return `${q}\n\n${chipLine}`;
}

/**
 * Apply skipIfKnown / autoSkipIfSingle node transitions to walk
 * past nodes whose answer is already known. The state machine's
 * getNextStep already does this once per call — but if a chain of
 * skippable nodes precedes a question, we need to keep walking.
 *
 * Returns the next step, possibly after multiple skips. Bounded at
 * 8 hops to defend against pathological cyclic transitions.
 */
function resolveSkippableSteps(state, tree) {
  let cur = state;
  for (let i = 0; i < 8; i++) {
    const step = getNextStep(cur, tree);
    if (step.type !== "question") return step;
    const node = step.node;
    if (node.skipIfKnown && cur.answers[node.attribute] !== undefined) {
      const nextId = nextNodeFromTransition(node, cur.answers[node.attribute]);
      if (!nextId) return step;
      cur = { ...cur, currentNodeId: nextId };
      continue;
    }
    return step;
  }
  return getNextStep(cur, tree);
}

/**
 * Main entry point. See module docstring for behavior contract.
 *
 * Parameters:
 *   - messages: full conversation history (last item is current user turn)
 *   - tree: the orthotic DecisionTree row (with .definition)
 *   - shop: shop domain (for resolver's catalog filter)
 *   - controller / encoder: SSE writer pair from chat.jsx
 *   - anthropic: Anthropic SDK client (used for Layer 3 fallback)
 *   - haikuModel: model id for the optional Layer 3 free-text mapper
 *
 * Returns:
 *   { handled: true }  if the gate took the turn (caller should not
 *                      run the LLM agentic loop)
 *   { handled: false } otherwise
 */
export async function maybeRunOrthoticFlow({
  messages,
  tree,
  shop,
  controller,
  encoder,
  anthropic,
  haikuModel,
}) {
  if (!tree || tree.intent !== ORTHOTIC_INTENT) return { handled: false };
  if (!tree.definition || !Array.isArray(tree.definition.nodes)) {
    return { handled: false };
  }
  if (!Array.isArray(messages) || messages.length === 0) return { handled: false };

  // The latest message must be from the user — that's what we're
  // mapping. If the last turn is somehow assistant-tail or empty,
  // fall through to the normal flow.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { handled: false };
  const rawUserText = typeof last.content === "string" ? last.content : "";
  if (!rawUserText.trim()) return { handled: false };

  // Unified gate: accumulate every Layer-1/2 answer signal across
  // the whole conversation, then walk the seed tree from root and
  // emit the next unanswered question. Replaces the old bootstrap-
  // vs-continuation split, which was broken in production because
  // the chip `<<>>` markers don't survive the widget's history
  // round-trip — so findNodeByChipsInText returned null on every
  // turn and the chip-fingerprint continuation never engaged.
  //
  // Engagement rule: the gate is "active" if ANY of these hold:
  //   1. detectOrthoticIntent matches the latest message (fresh
  //      bootstrap), OR
  //   2. detectOrthoticIntent matches anywhere in history (mid-flow
  //      pivot back into the orthotic flow), OR
  //   3. accumulateAnswers found ≥1 prior answer (we're already
  //      mid-flow even if intent words have faded from history).
  //
  // Otherwise the LLM stays in charge — same fall-through behavior
  // as before. Anything the gate emits uses seed-byte-exact chips.
  const priorMessages = messages.slice(0, -1);
  const accumulated = accumulateAnswers(priorMessages, tree.definition);
  const latestExtracted = preExtractAnswers(rawUserText, tree.definition);
  const answers = { ...accumulated, ...latestExtracted };

  // Hard veto: customer explicitly rejected orthotics in their
  // latest message ("I don't want orthotics, just sneakers"). The
  // LLM should handle this; the gate must not press on with the
  // orthotic flow even if Layer 2 picked up an incidental chip.
  if (hasOrthoticRejection(rawUserText)) {
    return { handled: false };
  }

  // Off-topic + chip-fingerprint detection upfront — both are used
  // by the engagement rule below.
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
  const lastAssistantText = lastAssistant && typeof lastAssistant.content === "string"
    ? lastAssistant.content
    : "";
  const fingerprintNode = lastAssistantText && /<<[^<>]+>>/.test(lastAssistantText)
    ? findNodeByChipsInText(lastAssistantText, tree.definition)
    : null;

  const intentInLatest = detectOrthoticIntent(rawUserText);
  const intentInHistory =
    intentInLatest ||
    priorMessages.some(
      (m) =>
        m &&
        m.role === "user" &&
        typeof m.content === "string" &&
        detectOrthoticIntent(m.content),
    );
  const haveAccumulated = Object.keys(accumulated).length > 0;

  // Engagement rule. We deliberately do NOT engage on a Layer-1/2
  // hit in the LATEST message alone — production showed that
  // 'Find men's shoes for my needs' extracts gender=Men via the
  // pronoun pattern and would otherwise hijack a footwear request
  // into the orthotic flow. The customer must have actually
  // expressed orthotic intent (now or earlier), or be already
  // mid-flow (accumulated answers from prior turns), or be in the
  // middle of answering a recognized seed question (fingerprintNode).
  if (!intentInHistory && !haveAccumulated && !fingerprintNode) {
    return { handled: false };
  }
  if (fingerprintNode && isOffTopicReply(rawUserText, fingerprintNode)) {
    console.log(
      `[orthotic-flow] off-topic reply on ${fingerprintNode.id} ("${rawUserText.slice(0, 40)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // If the latest message didn't already give us the current
  // node's answer via Layer 1/2, try Layer 3 (constrained Haiku
  // call) as a last sync-mappable resort. Only worth doing when we
  // have a reliable currentNode handle from the chip fingerprint.
  let layer3Attempted = false;
  let layer3Mapped = false;
  if (
    fingerprintNode &&
    fingerprintNode.attribute &&
    answers[fingerprintNode.attribute] === undefined
  ) {
    const askLLM = anthropic && haikuModel ? makeLayer3Hook(anthropic, haikuModel) : null;
    layer3Attempted = true;
    const mapped = await mapAnswerToEnum(
      rawUserText,
      fingerprintNode,
      tree.definition,
      askLLM ? { askLLM } : {},
    );
    if (mapped && mapped.value !== null && mapped.value !== undefined) {
      answers[fingerprintNode.attribute] = mapped.value;
      layer3Mapped = true;
      console.log(
        `[orthotic-flow] layer-${mapped.layer} mapped ${fingerprintNode.id} → ` +
          `${fingerprintNode.attribute}=${mapped.value}`,
      );
    }
  }

  // If the chip fingerprint was the ONLY engagement signal (no
  // prior intent, no prior accumulated answers, no Layer-1/2 hit
  // on the latest message) AND mapping the latest reply to that
  // current node failed across all layers, the customer's reply is
  // off-topic / unmappable for that question. Yield to the LLM —
  // emitting the next seed question would feel like a non-sequitur.
  if (
    fingerprintNode &&
    !intentInHistory &&
    !haveAccumulated &&
    Object.keys(latestExtracted).length === 0 &&
    layer3Attempted &&
    !layer3Mapped
  ) {
    console.log(
      `[orthotic-flow] reply on ${fingerprintNode.id} unmappable across layers; falling through to LLM`,
    );
    return { handled: false };
  }

  // Walk forward from root, transitioning past every node whose
  // attribute is already in `answers`. Bounded at 16 hops to defend
  // against malformed seeds with cyclic transitions.
  const root = getRootNode(tree.definition);
  if (!root) return { handled: false };
  let currentNodeId = root.id;
  for (let i = 0; i < 16; i++) {
    const node = findNodeById(tree.definition, currentNodeId);
    if (!node || node.type !== "question") break;
    if (!node.attribute || answers[node.attribute] === undefined) break;
    const nextId = nextNodeFromTransition(node, answers[node.attribute]);
    if (!nextId) break;
    currentNodeId = nextId;
  }

  const state = { currentNodeId, answers, unmappedTurns: 0 };
  const step = resolveSkippableSteps(state, tree.definition);

  if (step.type === "question") {
    const text = renderQuestionText(step.node);
    if (!text) return { handled: false };
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] emitted seed question ${step.node.id} (${step.node.attribute}); ` +
        `answers=${Object.keys(answers).length} (${describeAnswers(answers)}); bypassed LLM`,
    );
    return { handled: true };
  }

  if (step.type === "resolve") {
    const conversationText = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const result = await executeRecommenderTool({
      toolName: `recommend_${ORTHOTIC_INTENT}`,
      input: step.attrs,
      shop,
      trees: [tree],
      conversationText,
      latestUserText: rawUserText,
    });
    if (result?.error || !result?.product) {
      console.log(
        `[orthotic-flow] resolve failed (${result?.error || "no product"}); falling through to LLM`,
      );
      return { handled: false };
    }
    const intro = buildResolveIntro(result, step.attrs);
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text: intro })));
    controller.enqueue(encoder.encode(sseChunk({
      type: "products",
      products: [result.product],
    })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] resolved → ${result.masterSku} (${result.title}); ` +
        `answers=${describeAnswers(answers)}; emitted card; bypassed LLM`,
    );
    return { handled: true };
  }

  console.log(`[orthotic-flow] unexpected step type=${step.type}; falling through`);
  return { handled: false };
}

function describeAnswers(answers) {
  const entries = Object.entries(answers || {});
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function buildResolveIntro(result, attrs) {
  const title = String(result?.title || "this orthotic").trim();
  const reasonBits = [];
  if (attrs?.condition && attrs.condition !== "none") {
    reasonBits.push(humanizeCondition(attrs.condition));
  }
  if (attrs?.useCase) {
    reasonBits.push(humanizeUseCase(attrs.useCase));
  }
  if (attrs?.arch) {
    reasonBits.push(`${attrs.arch.toLowerCase()}`);
  }
  if (reasonBits.length === 0) {
    return `Based on what you've shared, **${title}** is the best match.`;
  }
  return `Based on what you've shared (${reasonBits.join(", ")}), **${title}** is the best match.`;
}

function humanizeCondition(c) {
  switch (c) {
    case "plantar_fasciitis": return "plantar fasciitis";
    case "heel_spurs":        return "heel spurs";
    case "metatarsalgia":     return "ball-of-foot pain";
    case "mortons_neuroma":   return "Morton's neuroma";
    case "diabetic":          return "diabetic foot care";
    default: return c;
  }
}

// Build a Layer 3 LLM hook bound to the given Anthropic client +
// model id. The hook signature matches what mapAnswerToEnum expects:
// `async (rawAnswer, node, tree) => { value }`. Returns null on
// errors so the orchestrator can fall through cleanly.
function makeLayer3Hook(anthropic, model) {
  return async function askLLM(rawAnswer, node /* , tree */) {
    const prompt = buildConstrainedAnswerPrompt(rawAnswer, node);
    if (!prompt) return { value: null };
    try {
      const res = await anthropic.messages.create({
        model,
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      });
      const text = res?.content?.[0]?.text || "";
      const value = parseConstrainedAnswerResponse(text, node);
      return { value };
    } catch (err) {
      // Re-throw so mapAnswerToEnum's catch records it as
      // layer="llm-error" — caller (gate) treats that as unmapped.
      throw err;
    }
  };
}

function humanizeUseCase(u) {
  switch (u) {
    case "casual":             return "everyday casual shoes";
    case "comfort":            return "general comfort";
    case "athletic_running":   return "running";
    case "athletic_training":  return "gym / training";
    case "athletic_general":   return "athletic / court";
    case "cleats":             return "cleats";
    case "skates":             return "hockey skates";
    case "winter_boots":       return "winter boots";
    case "work_all_day":       return "long days on your feet";
    case "dress":              return "dress shoes";
    case "dress_no_removable": return "dress shoes (no removable insole)";
    case "dress_premium":      return "premium dress shoes";
    default: return u;
  }
}
