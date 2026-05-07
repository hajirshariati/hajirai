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

// ──────────────────────────────────────────────────────────────
// State machine functions — to be implemented in subsequent
// batches. Skeletons only, so the module loads and exports
// cleanly without crashing if accidentally imported early.
// ──────────────────────────────────────────────────────────────

/**
 * Walk the message history and determine the customer's current
 * position in the flow. Returns { currentNodeId, answers } where
 * answers is a map of attribute → value collected so far.
 *
 * NOT YET IMPLEMENTED — Batch A2.
 */
export function detectFlowState(_messages, _tree) {
  return { currentNodeId: null, answers: {}, _stub: true };
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
