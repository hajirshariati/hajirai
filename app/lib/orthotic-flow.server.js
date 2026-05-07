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

// ──────────────────────────────────────────────────────────────
// Layer 2 keyword tables — per-attribute paraphrase → enum value.
//
// Customer types free text instead of clicking a chip; we map it
// to an enum without an LLM call. Each entry's `patterns` are
// regex tested IN ORDER against the normalized answer; first
// match wins. Order matters when patterns could overlap (Kids
// is checked before Men/Women so "for my niece" hits Kids).
//
// These mirror the keyword enrichment regex already in
// recommender-tools.server.js (the band-aid we built today),
// reorganized here as the deterministic Layer-2 fallback for
// the state-machine answer mapper.
// ──────────────────────────────────────────────────────────────
const KEYWORD_PATTERNS = {
  gender: [
    {
      value: "Kids",
      patterns: [
        /\b(kid|kids|kid'?s|child|children|youth|grandkid|grandchild|nephew|niece|son\s+of|daughter\s+of)\b/i,
        // "boys" / "girls" plural defaults to Kids in Aetrex's
        // catalog (boys-line / girls-line products). Singular
        // "boy" / "girl" is ambiguous — falls through to Men/
        // Women for adults.
        /\b(boys|girls|boy'?s|girl'?s)\b/i,
      ],
    },
    {
      value: "Women",
      patterns: [
        /\b(women|womens|women'?s|woman|female|lady|ladies|girlfriend|sister|daughter|wife|mom|mother|grandma|grandmother|aunt|niece|her|hers|female|she'?s)\b/i,
      ],
    },
    {
      value: "Men",
      patterns: [
        /\b(men|mens|men'?s|man|male|guy|guys|gentleman|gentlemen|boyfriend|brother|son|husband|dad|father|grandpa|grandfather|uncle|nephew|him|his|he'?s)\b/i,
      ],
    },
  ],
  useCase: [
    {
      value: "athletic_running",
      patterns: [
        /\b(running|run\b|jog(?:ging)?|marathon|half[\s-]?marathon|5k|10k|sprint|track\b)\b/i,
      ],
    },
    {
      value: "athletic_training",
      patterns: [
        /\b(gym|training|workout|cross[\s-]?train|crossfit|weights?[\s-]?lift|strength[\s-]?train|pilates|barre|hiit)\b/i,
      ],
    },
    {
      value: "cleats",
      patterns: [
        /\b(cleats?|soccer|football|baseball|softball|lacrosse|rugby|spike[\s-]?shoes?|field[\s-]?sport)\b/i,
      ],
    },
    {
      value: "skates",
      patterns: [
        /\b(skates?|hockey|ice[\s-]?skate|figure[\s-]?skat)/i,
      ],
    },
    {
      value: "winter_boots",
      patterns: [
        /\b(winter[\s-]?boots?|snow[\s-]?boots?|cold[\s-]?weather[\s-]?boots?|ski[\s-]?boots?)\b/i,
      ],
    },
    {
      value: "work_all_day",
      patterns: [
        /\b(work[\s-]?boots?|work[\s-]?shoes?|standing[\s-]?all[\s-]?day|on\s+(?:my|her|his|their)\s+feet[\s-]?all[\s-]?day|warehouse|nursing|nurse|retail|server|waitress|waiter|restaurant|construction|all[\s-]?day[\s-]?on\s+feet)\b/i,
      ],
    },
    {
      value: "athletic_general",
      patterns: [
        /\b(athletic|active|sports?|sport[\s-]?shoes?|tennis|basketball|court[\s-]?shoes?|pickleball|volleyball)\b/i,
      ],
    },
    {
      value: "dress_no_removable",
      patterns: [
        /\b(no[\s-]?removable[\s-]?insole|without[\s-]?removable|fixed[\s-]?insole|built[\s-]?in[\s-]?insole|slim[\s-]?dress|low[\s-]?profile[\s-]?dress)\b/i,
      ],
    },
    {
      value: "dress_premium",
      patterns: [
        /\b(premium[\s-]?dress|high[\s-]?end[\s-]?dress|formal[\s-]?heels?|gala|wedding[\s-]?shoes?|evening[\s-]?(?:shoes?|wear))\b/i,
      ],
    },
    {
      value: "dress",
      patterns: [
        /\b(dress[\s-]?shoes?|dressy|formal|business[\s-]?(?:formal|attire|shoes?)|office[\s-]?shoes?|professional)\b/i,
      ],
    },
    {
      value: "casual",
      patterns: [
        /\b(casual|everyday[\s-]?shoes?|day[\s-]?to[\s-]?day|street[\s-]?shoes?|knockabout)\b/i,
      ],
    },
    {
      value: "comfort",
      patterns: [
        /\b(no[\s-]?(?:specific[\s-]?)?(?:pain|condition|issue)|just[\s-]?(?:want[\s-]?)?(?:comfort|support|relief)|general[\s-]?(?:comfort|support|relief)|everyday[\s-]?(?:comfort|support|wear|use)|walking[\s-]?around|walking[\s-]?shoes?|relief|nothing[\s-]?specific|comfort[\s-]?and[\s-]?support|comfort\s*&\s*support)\b/i,
      ],
    },
  ],
  condition: [
    {
      value: "plantar_fasciitis",
      // Catches "plantar fasciitis", "plantar fasciatis" (typo),
      // "plantarfaciitis" (no space common typo).
      patterns: [
        /\bplantar[\s-]?fasc(?:i|ii)tis\b/i,
        /\bplantar\s*fasciatis\b/i,
        /\bplantarfaciitis\b/i,
      ],
    },
    {
      value: "heel_spurs",
      patterns: [/\bheel[\s-]?spurs?\b/i],
    },
    {
      value: "metatarsalgia",
      patterns: [
        /\b(metatars(?:al|algia)|ball[\s-]?of[\s-]?(?:the[\s-]?)?foot|forefoot|fore[\s-]?foot|met[\s-]?pad|met[\s-]?head|toe[\s-]?box[\s-]?pain|under[\s-]?the[\s-]?ball)\b/i,
      ],
    },
    {
      value: "mortons_neuroma",
      patterns: [/\bmorton(?:'?s)?[\s-]?neuroma\b/i],
    },
    {
      value: "overpronation_flat_feet",
      patterns: [
        /\b(overpronat(?:e|ion|es|ing)|over[\s-]?pronat(?:e|ion|es|ing)|flat[\s-]?feet|flat[\s-]?foot|fallen[\s-]?arch(?:es)?|low[\s-]?arch(?:es)?|ankles?[\s-]?roll(?:ing)?[\s-]?in(?:ward)?|pronate[\s-]?inward|arch[\s-]?pain)\b/i,
      ],
    },
    {
      value: "diabetic",
      patterns: [/\bdiabet(?:ic|es)\b/i],
    },
    {
      value: "none",
      patterns: [
        /\b(?:no\s+(?:specific\s+)?(?:pain|condition|issue|concern|problems?)|just\s+(?:want\s+)?(?:comfort|support)|general\s+(?:comfort|support)|everyday\s+(?:comfort|support|wear)|just\s+looking\s+for\s+(?:comfort|support|something)|comfort\s*(?:&|and)\s*support|nothing\s+specific|no\s+issues?|none\s+(?:really|specifically)?|not\s+(?:really|specifically)|just\s+everyday|just\s+general)\b/i,
        /^(?:no|none|nope|nothing|n\/?a|not really|not sure)\.?$/i,
      ],
    },
  ],
  arch: [
    {
      value: "Flat / Low Arch",
      patterns: [
        /\b(flat[\s-]?(?:feet|foot|arch(?:es)?)|fallen[\s-]?arch(?:es)?|low[\s-]?arch(?:es)?|low\b)\b/i,
      ],
    },
    {
      value: "Medium / High Arch",
      patterns: [
        /\b(high[\s-]?arch(?:es|ed)?|medium[\s-]?arch(?:es)?|normal[\s-]?arch(?:es)?|standard[\s-]?arch|high\b|medium\b|normal\b|don'?t[\s-]?know|not[\s-]?sure|no[\s-]?idea|unsure|i[\s-]?dunno|i[\s-]?guess|i[\s-]?have[\s-]?no[\s-]?idea)\b/i,
      ],
    },
  ],
  overpronation: [
    {
      value: "yes",
      patterns: [
        /^(?:yes|yeah|yep|yup|sure|definitely|absolutely|correct|exactly|right|i\s+do|they\s+do|kind of|kinda|sometimes)\b/i,
        /\b(roll(?:ing)?[\s-]?in(?:ward)?|pronate|overpronate|flat[\s-]?feet|fallen[\s-]?arch)\b/i,
      ],
    },
    {
      value: "no",
      patterns: [
        /^(?:no|nope|not really|not sure|don'?t think so|not at all|i don'?t|they don'?t|negative|neither)\b/i,
        /\b(no[\s-]?rolling|no[\s-]?overpronation|don'?t[\s-]?roll|don'?t[\s-]?pronate)\b/i,
      ],
    },
  ],
};

/**
 * Layer 1 — exact chip-label match.
 * Returns the enum value, or undefined if no exact normalized match.
 */
function matchChipExact(rawAnswer, node) {
  const lookup = buildChipLookup(node);
  if (!lookup) return undefined;
  const norm = normalizeText(rawAnswer);
  if (!norm) return undefined;
  return lookup.get(norm); // undefined if no match
}

/**
 * Layer 2 — keyword enrichment.
 * Walks the per-attribute pattern table; first match wins.
 * Returns the enum value, or undefined if nothing matches.
 *
 * The matched value is also validated against the node's own
 * chip values: if a keyword pattern returns "athletic_running"
 * but the current node only has chips with values
 * ["dress", "casual"], we don't return the unrelated value.
 * Keeps the layer scoped to the question being asked.
 */
function matchKeyword(rawAnswer, node) {
  if (!node || !node.attribute) return undefined;
  const table = KEYWORD_PATTERNS[node.attribute];
  if (!Array.isArray(table)) return undefined;
  const text = String(rawAnswer || "");
  if (!text.trim()) return undefined;
  const allowedValues = new Set(
    Array.isArray(node.chips)
      ? node.chips.map((c) => c && c.value).filter((v) => v !== undefined && v !== null)
      : [],
  );
  for (const entry of table) {
    if (allowedValues.size > 0 && !allowedValues.has(entry.value)) continue;
    for (const re of entry.patterns) {
      if (re.test(text)) return entry.value;
    }
  }
  return undefined;
}

/**
 * Map the customer's raw answer (chip click or free text) to the
 * current question's enum value. Layered fallback:
 *   1. Exact chip-label match (case-/punct-insensitive).
 *   2. Keyword enrichment table.
 *   3. Constrained LLM call (caller passes via opts.askLLM).
 *      ← TO BE IMPLEMENTED IN BATCH A5.
 *   4. Null value return → caller re-asks the question.
 *
 * Returns:
 *   { value: <enum>, layer: 1|2|3 }  on success
 *   { value: null, layer: "unmapped" } on failure
 *
 * `opts.askLLM` is async (rawAnswer, node, tree) → {value} | null.
 * Wired in Batch A5.
 */
export async function mapAnswerToEnum(rawAnswer, node, tree, opts = {}) {
  if (!node || node.type !== "question") {
    return { value: null, layer: "no-question-node" };
  }

  // Layer 1 — exact chip-label match.
  const exact = matchChipExact(rawAnswer, node);
  if (exact !== undefined) return { value: exact, layer: 1 };

  // Layer 2 — keyword enrichment.
  const keyword = matchKeyword(rawAnswer, node);
  if (keyword !== undefined) return { value: keyword, layer: 2 };

  // Layer 3 — constrained LLM call. Wired in Batch A5; for now
  // the caller can pass opts.askLLM as a placeholder.
  if (typeof opts.askLLM === "function") {
    try {
      const llmResult = await opts.askLLM(rawAnswer, node, tree);
      if (llmResult && llmResult.value !== undefined && llmResult.value !== null) {
        const allowedValues = new Set(
          Array.isArray(node.chips)
            ? node.chips.map((c) => c && c.value).filter((v) => v !== undefined && v !== null)
            : [],
        );
        if (allowedValues.size === 0 || allowedValues.has(llmResult.value)) {
          return { value: llmResult.value, layer: 3 };
        }
      }
    } catch (err) {
      // LLM errors don't crash the flow — fall through to unmapped
      // and let the caller re-ask. The error is observable via the
      // returned shape.
      return { value: null, layer: "llm-error", error: err?.message || String(err) };
    }
  }

  return { value: null, layer: "unmapped" };
}
