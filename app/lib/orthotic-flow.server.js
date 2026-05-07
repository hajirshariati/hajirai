// Server-side state machine that drives the orthotic recommender
// conversation deterministically. The seed JSON's decision tree
// (nodes, chips, transitions) becomes load-bearing infrastructure
// instead of mere reference data the LLM may paraphrase.
//
// Why this exists:
//   The LLM-improvised orthotic flow had a fundamental drift
//   problem — the model rephrased the seed's chip labels at
//   each turn ("Just Comfort & Support" instead of the seed's
//   "None — just want comfort"), then couldn't map the
//   customer's answer back to an enum value. Server-side state
//   machine fixes that by being the source of truth for both
//   the question text AND the chip→enum mapping.
//
// What this module does:
//   1. detectFlowState(messages, tree) — walks the message
//      history, identifies which seed-tree node the customer is
//      currently on, plus the attributes they've already answered.
//   2. mapAnswerToEnum(rawAnswer, node, tree) — turns the
//      customer's free text or chip click into an enum value
//      (4-layer pipeline: exact chip match → keyword enrichment
//      → constrained LLM → re-ask).
//   3. getNextStep(state, tree) — returns the next question node
//      to ask, or a "resolve" signal when all required attrs are
//      collected.
//
// What this module does NOT do:
//   - Run the resolver itself (decision-tree-resolver.server.js
//     does that).
//   - Talk to Anthropic directly (chat.jsx orchestrates).
//   - Touch non-orthotic flows (footwear/FAQ/comparisons stay
//     LLM-driven).
//
// Aetrex-specific by design — locked-in domain decision per the
// architectural agreement. Tree structure is generic so a
// future orthotic merchant could re-use without code changes,
// but the chip vocabulary and clinical concepts are Aetrex's.

// ──────────────────────────────────────────────────────────────
// Pure helpers — no I/O, no LLM, no DB. Used by the higher-level
// state-machine functions.
// ──────────────────────────────────────────────────────────────

/**
 * Normalize a chip label or customer answer for comparison.
 * Lowercase, collapse whitespace, strip surrounding punctuation,
 * normalize curly apostrophes to straight, normalize em/en dashes
 * to hyphens. Used for case-insensitive exact-match comparisons.
 *
 * Example: "Athletic — gym / training" → "athletic - gym / training"
 *          "What about <<Women's>>?"   → "what about <<women's>>?"
 */
export function normalizeText(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a chip-label → chip-value lookup for one tree node.
 * Returns a Map keyed by normalized label, valued by the raw
 * enum value the resolver expects.
 *
 * Multiple chip labels can map to the same value (the seed's
 * arch question maps both "Medium" and "High" to the same
 * "Medium / High Arch" enum). Both go in the map.
 *
 * Returns null if the node isn't a question or has no chips —
 * the caller decides what to do (resolve nodes have no chips).
 */
export function buildChipLookup(node) {
  if (!node || node.type !== "question") return null;
  if (!Array.isArray(node.chips) || node.chips.length === 0) return null;
  const map = new Map();
  for (const chip of node.chips) {
    if (!chip || typeof chip.label !== "string" || chip.value === undefined) continue;
    const key = normalizeText(chip.label);
    if (key && !map.has(key)) {
      map.set(key, chip.value);
    }
  }
  return map.size > 0 ? map : null;
}

/**
 * Find a node by ID in the tree. O(n) scan — trees are small
 * (the Aetrex seed has 6 nodes), so no need to index. Returns
 * the node object or null.
 */
export function findNodeById(tree, nodeId) {
  if (!tree || !Array.isArray(tree.nodes) || !nodeId) return null;
  return tree.nodes.find((n) => n && n.id === nodeId) || null;
}

/**
 * Get the root node of the tree. The seed has rootNodeId =
 * "q_use_case" but we don't hardcode it — read it from the tree.
 */
export function getRootNode(tree) {
  if (!tree || !tree.rootNodeId) return null;
  return findNodeById(tree, tree.rootNodeId);
}

/**
 * Extract every <<Chip>> label from a piece of text. Returns an
 * array of normalized labels (in order, with duplicates dropped).
 * Used to identify which tree node a previous assistant turn
 * was asking about — chip labels are unique enough that the
 * intersection with a node's `chips` array reliably identifies
 * the source question.
 */
export function extractChipLabelsFromText(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  const re = /<<\s*([^<>]+?)\s*>>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const norm = normalizeText(m[1]);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Given an assistant message's text and the tree, identify which
 * question node was being asked. Strategy: extract all <<Chip>>
 * labels from the message and find the question node whose chip
 * set has the most label overlap. Ties broken by node order in
 * the tree (earlier nodes win — typical conversational order).
 *
 * Returns the matched node, or null if nothing in the message
 * looks like a tree question.
 */
export function findNodeByChipsInText(text, tree) {
  const labels = extractChipLabelsFromText(text);
  if (labels.length === 0 || !tree || !Array.isArray(tree.nodes)) return null;
  const labelSet = new Set(labels);
  let best = null;
  let bestOverlap = 0;
  for (const node of tree.nodes) {
    const lookup = buildChipLookup(node);
    if (!lookup) continue;
    let overlap = 0;
    for (const key of lookup.keys()) {
      if (labelSet.has(key)) overlap += 1;
    }
    // Require at least 2 chips overlap to call it a match (avoids
    // false positives where a single common word like <<Yes>>
    // appears in multiple node's chip sets). For nodes with only
    // one chip total, allow overlap=1.
    const minRequired = Math.min(2, lookup.size);
    if (overlap >= minRequired && overlap > bestOverlap) {
      best = node;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Given a node and the answer value the customer provided,
 * return the next node ID to transition to. Looks at node.next:
 *   - { _default: "nodeId" } → always go to nodeId
 *   - { "value-A": "nodeIdA", "value-B": "nodeIdB" } → branch by value
 *   - { "value-A": "nodeIdA", _default: "nodeIdDefault" } → branch with fallback
 *
 * Returns null if the node has no next or the value doesn't match
 * any branch and there's no _default. The caller treats null as
 * "this branch terminates" (e.g. resolve nodes have no `next`).
 */
export function nextNodeFromTransition(node, answerValue) {
  if (!node || !node.next || typeof node.next !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(node.next, answerValue)) {
    return node.next[answerValue];
  }
  if (Object.prototype.hasOwnProperty.call(node.next, "_default")) {
    return node.next._default;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// State machine functions — to be implemented in subsequent
// batches. Skeletons only, so the module loads and exports
// cleanly without crashing if accidentally imported early.
// ──────────────────────────────────────────────────────────────

/**
 * Walk the message history and determine the customer's current
 * position in the flow. Returns:
 *   {
 *     currentNodeId,  // node ID the customer should be on now
 *     answers,        // map of attribute → enum value collected
 *     unmappedTurns,  // count of user messages we couldn't map
 *                     // back to a chip (for observability)
 *   }
 *
 * Algorithm:
 *   1. Start at the tree's root node.
 *   2. Walk messages in order. For each user message, look at the
 *      preceding assistant message's chips to identify which
 *      question was being asked.
 *   3. If that question matches a tree node and the user's answer
 *      maps to one of the chip values (exact normalized match for
 *      now — Batch A3 adds keyword + LLM fallbacks), record the
 *      answer in `answers` and advance currentNodeId via
 *      nextNodeFromTransition.
 *   4. If we can't map the user's answer (free text we don't
 *      recognize yet), leave state unchanged — the caller will
 *      re-ask or fall through to LLM. Increment unmappedTurns.
 *   5. Stop when messages are exhausted. currentNodeId is the
 *      node the customer should answer next (or a resolve node
 *      if all attrs collected).
 */
export function detectFlowState(messages, tree) {
  if (!tree || !Array.isArray(tree.nodes) || tree.nodes.length === 0) {
    return { currentNodeId: null, answers: {}, unmappedTurns: 0 };
  }
  const root = getRootNode(tree);
  if (!root) {
    return { currentNodeId: null, answers: {}, unmappedTurns: 0 };
  }

  let currentNodeId = root.id;
  const answers = {};
  let unmappedTurns = 0;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { currentNodeId, answers, unmappedTurns };
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "user" || typeof msg.content !== "string") continue;
    // Find the most recent prior assistant message (skip any
    // injected system/tool messages between).
    let prevAssistant = null;
    for (let j = i - 1; j >= 0; j--) {
      const m = messages[j];
      if (m && m.role === "assistant" && typeof m.content === "string") {
        prevAssistant = m;
        break;
      }
    }
    if (!prevAssistant) continue; // first user message has no prior question

    const askedNode = findNodeByChipsInText(prevAssistant.content, tree);
    if (!askedNode) continue; // assistant message wasn't a tree question turn

    const chipLookup = buildChipLookup(askedNode);
    if (!chipLookup) continue;
    const normalizedAnswer = normalizeText(msg.content);
    const enumValue = chipLookup.get(normalizedAnswer);
    if (enumValue === undefined) {
      // Layer 1 (exact chip match) failed. Layers 2+3 (keyword +
      // constrained LLM) live in mapAnswerToEnum (Batch A3/A5);
      // detectFlowState stays pure here. Mark unmapped and
      // continue — the caller decides whether to re-ask or run
      // the richer mapper.
      unmappedTurns += 1;
      continue;
    }

    // Record answer + advance state. The seed's q_arch node
    // branches by value (Flat → q_resolve, Medium/High →
    // q_overpronation), so we use the answer value as the
    // transition key.
    if (askedNode.attribute) {
      answers[askedNode.attribute] = enumValue;
    }
    const nextId = nextNodeFromTransition(askedNode, enumValue);
    if (nextId) currentNodeId = nextId;
  }

  return { currentNodeId, answers, unmappedTurns };
}

/**
 * Given the current state, return the next step to take:
 *   { type: "question", node }  ← server should ask this question
 *   { type: "resolve", attrs }  ← server should run the resolver
 *
 * NOT YET IMPLEMENTED — Batch A4.
 */
export function getNextStep(_state, _tree) {
  return { type: "stub", _stub: true };
}

/**
 * Map the customer's raw answer (chip click or free text) to the
 * current question's enum value. Layered fallback:
 *   1. Exact chip-label match.
 *   2. Keyword enrichment.
 *   3. Constrained LLM call (caller passes the function).
 *   4. Null return → caller re-asks the question.
 *
 * NOT YET IMPLEMENTED — Batches A3 + A5.
 */
export async function mapAnswerToEnum(_rawAnswer, _node, _tree, _opts) {
  return { value: null, layer: "stub", _stub: true };
}
