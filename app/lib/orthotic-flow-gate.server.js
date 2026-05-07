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
  detectFlowState,
  getNextStep,
  mapAnswerToEnum,
  findNodeByChipsInText,
  nextNodeFromTransition,
  buildConstrainedAnswerPrompt,
  parseConstrainedAnswerResponse,
  isOffTopicReply,
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

  // Detect state from the FULL history excluding the current user
  // turn — detectFlowState walks past assistant questions and the
  // user's prior answers to determine where we are. The current
  // turn is what we're about to map.
  const priorMessages = messages.slice(0, -1);
  const state = detectFlowState(priorMessages, tree.definition);

  // Gate condition: state must already be on a question node whose
  // chip fingerprint was matched in the most recent assistant turn.
  // If detectFlowState landed on the root because no prior assistant
  // turn looked like a tree question, fall through — the LLM is
  // still in charge of opening the flow.
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return { handled: false };
  const lastAssistantText = typeof lastAssistant.content === "string"
    ? lastAssistant.content
    : "";
  // Quick reject: assistant turn must contain chip syntax for us to
  // even consider this a state-machine continuation.
  if (!/<<[^<>]+>>/.test(lastAssistantText)) return { handled: false };

  // The CURRENT node — what the assistant just asked — is read
  // directly from the last assistant turn's chip fingerprint.
  // Requiring a recognized seed-tree fingerprint (not just any
  // chips) is what makes the gate safe and opt-in: if the LLM
  // asked a side question with non-tree chips (e.g. "compare or
  // similar?"), the gate stays out of the way and the LLM stays
  // in charge.
  const currentNode = findNodeByChipsInText(lastAssistantText, tree.definition);
  if (!currentNode || currentNode.type !== "question") {
    return { handled: false };
  }

  // Off-topic interrupt — customer asked about shipping/returns
  // mid-flow. Yield to the LLM so it can answer the policy
  // question naturally. The LLM may rephrase the next chip
  // question on resume; that's acceptable trade-off — the
  // alternative is the gate blocking off-topic replies, which
  // is worse customer experience.
  if (isOffTopicReply(rawUserText, currentNode)) {
    console.log(
      `[orthotic-flow] off-topic reply on ${currentNode.id} ("${rawUserText.slice(0, 40)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Map the latest user reply through Layer 1 → 2 → 3.
  // Layer 3 calls Haiku with a tightly-constrained JSON-only
  // prompt that's much harder to mess up than the full chat LLM.
  // If Anthropic is unavailable or the call fails, the layer
  // returns null and the gate falls through to the agentic loop.
  const askLLM = anthropic && haikuModel
    ? makeLayer3Hook(anthropic, haikuModel)
    : null;
  const mapped = await mapAnswerToEnum(
    rawUserText,
    currentNode,
    tree.definition,
    askLLM ? { askLLM } : {},
  );
  if (!mapped || mapped.value === null || mapped.value === undefined) {
    console.log(
      `[orthotic-flow] reply on node ${currentNode.id} didn't map (layer=${mapped?.layer || "n/a"}); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  console.log(
    `[orthotic-flow] mapped reply on ${currentNode.id} → ${currentNode.attribute}=${mapped.value} ` +
      `(layer ${mapped.layer})`,
  );

  // Apply the answer + advance via the node's transition table.
  const nextNodeId = nextNodeFromTransition(currentNode, mapped.value);
  if (!nextNodeId) {
    console.log(
      `[orthotic-flow] no transition from ${currentNode.id} for value ${mapped.value}; falling through`,
    );
    return { handled: false };
  }
  const advancedAnswers = { ...state.answers, [currentNode.attribute]: mapped.value };
  const advancedState = { currentNodeId: nextNodeId, answers: advancedAnswers, unmappedTurns: 0 };

  const step = resolveSkippableSteps(advancedState, tree.definition);

  if (step.type === "question") {
    const text = renderQuestionText(step.node);
    if (!text) return { handled: false };
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] emitted seed question ${step.node.id} (${step.node.attribute}); ` +
        `bypassed LLM`,
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
    });

    if (result?.error || !result?.product) {
      // Resolver bailed (no SKU, sandal-incompatibility, no kids
      // SKU, etc). Fall through to the LLM so it can craft an
      // honest reply with the resolver's reason. The LLM has the
      // recommend_orthotic tool registered and will get the same
      // error path. Better than the gate emitting a half-formed
      // text reply server-side.
      console.log(
        `[orthotic-flow] resolve failed (${result?.error || "no product"}); falling through to LLM`,
      );
      return { handled: false };
    }

    // Emit the product card immediately. The text portion is a
    // brief, deterministic line — not LLM-generated — to keep the
    // gate path fully predictable. The customer's next turn will
    // be a free-text question ("does it fit my shoe?", "what
    // size?") which the LLM handles via the normal agentic loop
    // (gate won't fire on that turn — no question chips upstream).
    const intro = buildResolveIntro(result, step.attrs);
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text: intro })));
    controller.enqueue(encoder.encode(sseChunk({
      type: "products",
      products: [result.product],
    })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] resolved → ${result.masterSku} (${result.title}); ` +
        `emitted card; bypassed LLM`,
    );
    return { handled: true };
  }

  // step.type === "done" — no question and no resolve (shouldn't
  // happen on a well-formed seed but defended). Fall through to LLM.
  console.log(`[orthotic-flow] unexpected step type=${step.type}; falling through`);
  return { handled: false };
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
