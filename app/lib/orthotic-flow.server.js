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
 * Given the current state from detectFlowState, return the next
 * step the server should take:
 *   { type: "question", node }    ← ask this question + emit chips
 *   { type: "resolve",  attrs }   ← run the resolver, emit product
 *   { type: "done",     attrs }   ← terminal node with no resolve
 *
 * Honors the seed's skipIfKnown flag: if a question's attribute is
 * already in answers (collected from earlier turns or pre-seeded),
 * we transition past without asking again. Loops in case multiple
 * consecutive skips chain (with a hard 16-step ceiling to defend
 * against malformed trees with cyclic transitions).
 *
 * autoSkipIfSingle: if a node has only one chip after filtering by
 * answers, auto-pick it. Currently a no-op for the Aetrex seed
 * since chip lists are static, but kept for future flexibility.
 */
export function getNextStep(state, tree) {
  if (!state || !tree) {
    return { type: "done", attrs: {}, reason: "no-state-or-tree" };
  }
  const answers = (state && typeof state.answers === "object") ? { ...state.answers } : {};
  let currentId = state.currentNodeId;
  if (!currentId) {
    const root = getRootNode(tree);
    if (!root) return { type: "done", attrs: answers, reason: "no-root-node" };
    currentId = root.id;
  }

  let guard = 0;
  while (guard < 16) {
    guard += 1;
    const node = findNodeById(tree, currentId);
    if (!node) {
      return { type: "done", attrs: answers, reason: `node-not-found:${currentId}` };
    }

    // Resolve nodes terminate the question loop.
    if (node.type === "resolve") {
      return { type: "resolve", attrs: answers, nodeId: node.id };
    }

    if (node.type !== "question") {
      // Unknown node type — terminate cleanly so the caller doesn't
      // hang. The caller treats this like resolve.
      return { type: "done", attrs: answers, reason: `unknown-node-type:${node.type}` };
    }

    // skipIfKnown: if the customer already gave a value for this
    // attribute (via free-text earlier in the conversation, or
    // pre-seeded by the caller), skip ahead without re-asking.
    const attr = node.attribute;
    if (node.skipIfKnown === true && attr && answers[attr] !== undefined && answers[attr] !== null && answers[attr] !== "") {
      const nextId = nextNodeFromTransition(node, answers[attr]);
      if (nextId && nextId !== currentId) {
        currentId = nextId;
        continue;
      }
      // No transition / self-loop → fall through to ask the question.
    }

    // autoSkipIfSingle: kept for the seed's future use. If the
    // node lists only one chip we pick it automatically.
    if (
      node.autoSkipIfSingle === true &&
      Array.isArray(node.chips) &&
      node.chips.length === 1 &&
      node.chips[0] &&
      node.chips[0].value !== undefined
    ) {
      const onlyValue = node.chips[0].value;
      if (attr) answers[attr] = onlyValue;
      const nextId = nextNodeFromTransition(node, onlyValue);
      if (nextId && nextId !== currentId) {
        currentId = nextId;
        continue;
      }
    }

    // Normal question — caller asks this.
    return { type: "question", node, answers };
  }
  return { type: "done", attrs: answers, reason: "transition-ceiling-reached" };
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

// ──────────────────────────────────────────────────────────────
// Layer 3 — constrained LLM helper (Batch A5).
//
// Caller (chat.jsx) provides the actual Anthropic call; this
// module produces the prompt + parses the JSON response. Keeps
// orthotic-flow.server.js free of API SDK imports / config —
// pure logic.
// ──────────────────────────────────────────────────────────────

/**
 * Build the Layer-3 prompt for the constrained LLM call. The LLM
 * has ONE narrow job: given the customer's free text and the
 * current question's chip options, pick the closest match. JSON-
 * only response. Much smaller surface area than the full chat
 * LLM, so much harder for the model to mess up.
 *
 * Returns a string suitable as the `content` of a single user
 * message to a small/fast model (Haiku). Caller wraps with the
 * SDK call and parses the JSON.
 */
export function buildConstrainedAnswerPrompt(rawAnswer, node) {
  if (!node || node.type !== "question" || !Array.isArray(node.chips) || node.chips.length === 0) {
    return null;
  }
  const safeAnswer = String(rawAnswer || "").slice(0, 240).replace(/[\r\n]+/g, " ").trim();
  const optionsBlock = node.chips
    .filter((c) => c && c.value !== undefined && typeof c.label === "string")
    .map((c, i) => `  ${i + 1}. label: "${c.label}", value: "${c.value}"`)
    .join("\n");
  const questionText = String(node.question || node.attribute || "(question)").trim();
  return [
    `You are mapping a shopping-assistant customer's free-text answer to one of a fixed list of enum options. ONE job: pick the option whose meaning best matches the customer's reply.`,
    ``,
    `Question the customer was asked: ${questionText}`,
    ``,
    `Available options (use the EXACT value, not the label, in your response):`,
    optionsBlock,
    ``,
    `Customer's reply: "${safeAnswer}"`,
    ``,
    `Rules:`,
    `- Return ONLY a JSON object: {"value":"<one of the values above>"} or {"value":null} if the reply is too ambiguous to map confidently.`,
    `- Do NOT invent values not in the list above.`,
    `- Do NOT explain your reasoning. JSON only.`,
    `- Prefer null over a wrong guess. The system will re-ask if you return null.`,
    `- If the customer's reply is off-topic (asking about shipping, returns, etc), return {"value":null}.`,
  ].join("\n");
}

/**
 * Parse the constrained LLM's JSON response into a value or null.
 * Tolerant of leading/trailing whitespace, code fences, and the
 * occasional explanatory sentence the model might emit despite
 * being told not to.
 *
 * Returns the enum value string, or null if unparseable / not a
 * valid option for the node.
 */
export function parseConstrainedAnswerResponse(rawResponse, node) {
  if (!rawResponse) return null;
  const text = String(rawResponse);
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed.value;
  if (value === null || value === undefined || value === "") return null;
  // Validate against node chips — model may hallucinate enum names.
  const allowed = new Set(
    Array.isArray(node?.chips)
      ? node.chips.map((c) => c && c.value).filter((v) => v !== undefined && v !== null)
      : [],
  );
  if (allowed.size > 0 && !allowed.has(value)) return null;
  return value;
}

// ──────────────────────────────────────────────────────────────
// Off-topic detector (Batch A6).
//
// When the customer's reply mid-flow doesn't look like an answer
// to the current question, route it to the full LLM for that one
// turn (e.g. customer asks "what's your return policy?" while
// answering condition). The state machine resumes on the next
// turn.
// ──────────────────────────────────────────────────────────────

const OFF_TOPIC_KEYWORDS_RE = /\b(?:shipping|delivery|return|returns|exchange|refund|warranty|sizing|size[\s-]?chart|store[\s-]?(?:hours|location)|wholesale|coupon|discount|promo|sale\b|order\s+status|track(?:ing)?|cancel|payment|klarna|afterpay|gift[\s-]?card|how\s+(?:much|long|do|does)|where|when|why|who\s+is)\b/i;

/**
 * Heuristic: is the customer's reply NOT an answer to the current
 * question, but instead an off-topic ask we should hand to the
 * full LLM?
 *
 * Conservative — only fires when:
 *   1. The reply doesn't match Layer 1 (exact chip).
 *   2. The reply doesn't match Layer 2 (keyword enrichment).
 *   3. AND either (a) it ends with a question mark, or (b) it
 *      contains an off-topic keyword (shipping/return/warranty/etc).
 *
 * Returns true → caller should bypass the state machine for this
 * turn and let the full LLM handle the message normally. The
 * state machine resumes on the next user turn.
 *
 * False positives risk: customer says "yes?" — ends with ?, but
 * clearly affirmative. Mitigated by checking Layer 1+2 first; if
 * "yes" matched the overpronation chip set we never reach this.
 */
export function isOffTopicReply(rawAnswer, node) {
  if (!node || node.type !== "question") return false;
  const text = String(rawAnswer || "").trim();
  if (!text) return false;
  // Already mappable via Layer 1 — not off-topic.
  if (matchChipExact(text, node) !== undefined) return false;
  // Already mappable via Layer 2 — not off-topic.
  if (matchKeyword(text, node) !== undefined) return false;
  // Off-topic indicators.
  const endsWithQuestion = /\?\s*$/.test(text);
  const containsOffTopicKeyword = OFF_TOPIC_KEYWORDS_RE.test(text);
  return endsWithQuestion || containsOffTopicKeyword;
}

// ──────────────────────────────────────────────────────────────
// Orthotic-intent detector (Stage B+ bootstrap).
//
// Tells the gate whether the customer's first message expresses
// "I want an orthotic recommendation". When true, the gate
// initiates the state machine on this turn instead of waiting
// for the LLM to ask a chip question (which it would rephrase,
// breaking the seed-fingerprint match).
//
// Conservative by design — only fires on unambiguous intent.
// The negation guard prevents firing on "I don't want orthotics,
// just shoes". The footwear-with-feature guard prevents firing
// on "shoes with built-in arch support" (that's a footwear
// query). False negatives are fine here — the LLM still handles
// anything the gate skips.
// ──────────────────────────────────────────────────────────────

const ORTHOTIC_NEGATION_RE =
  /\b(?:not|no|without|don'?t\s+(?:want|need|like)|hate|never)\s+(?:any\s+)?(?:an?\s+)?(?:orthotics?|insoles?|footbeds?|arch[\s-]?support|inserts?)\b/i;
const FOOTWEAR_FEATURE_RE =
  /\b(?:orthotic[\s-]?friendly|orthotic[\s-]?compatible)\b|\bshoes?\s+(?:with|for|that\s+have)\s+(?:built[\s-]?in\s+)?(?:orthotics?|inserts?|arch[\s-]?support)\b/i;
const ORTHOTIC_PRODUCT_RE =
  /\b(?:orthotics?|insoles?|footbeds?|arch[\s-]?support|inserts?)\b/i;
const CONDITION_SIGNAL_RE =
  /\b(?:plantar\s*fasc(?:i|ii)tis|heel\s*spurs?|metatarsalg(?:ia|ic)|morton'?s?\s*neuroma|fallen\s*arch(?:es)?|flat\s*feet|flat\s*foot|over\s*pronat(?:e|ion|ing)|diabetic\s*(?:foot|feet))\b/i;

export function detectOrthoticIntent(rawText) {
  const t = String(rawText || "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .trim();
  if (!t) return false;
  if (ORTHOTIC_NEGATION_RE.test(t)) return false;
  if (FOOTWEAR_FEATURE_RE.test(t)) return false;
  if (ORTHOTIC_PRODUCT_RE.test(t)) return true;
  if (CONDITION_SIGNAL_RE.test(t)) return true;
  return false;
}

// Returns true when the message ACTIVELY rejects orthotics ("I don't
// want orthotics", "no insoles, just shoes"). The unified gate uses
// this as a hard veto — even if Layer 1/2 picks up a chip-shaped
// signal in the same message, an explicit rejection means the
// customer wants something else and the LLM should handle it.
export function hasOrthoticRejection(rawText) {
  const t = String(rawText || "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .trim();
  if (!t) return false;
  return ORTHOTIC_NEGATION_RE.test(t);
}

// Returns true when the message commits the customer to the FOOTWEAR-
// only path — they explicitly picked footwear over orthotics on a
// bifurcation question, or asked for footwear directly.
//
// Production trace: customer said "I have foot pain, what should I
// wear?", AI offered <<New Footwear>> | <<Orthotic Insert>>, customer
// clicked <<New Footwear>>, AI asked <<Men's>>|<<Women's>>, customer
// clicked <<Women's>>. Layer 2 extracted gender=Women from "Women's"
// → engagement rule fired → orthotic flow hijacked the footwear
// query. The customer had committed to footwear two turns ago.
//
// This veto runs BEFORE engagement, on every prior user message AND
// the latest. If any one is a footwear commitment AND the latest
// doesn't pivot back to orthotic, the gate falls through.
const FOOTWEAR_PATH_RE =
  /\b(?:new\s*footwear|just\s+(?:looking\s+for\s+)?(?:new\s+)?(?:shoes?|footwear|sneakers?|sandals?|boots?)|find\s+(?:me\s+)?(?:some\s+)?(?:men'?s?|women'?s?|kids?'?s?|new)?\s*(?:shoes?|footwear|sneakers?|sandals?|boots?|loafers?|wedges?|heels?|oxfords?|slippers?|clogs?|mary[\s-]?janes?)|show\s+(?:me\s+)?(?:some\s+)?(?:men'?s?|women'?s?|kids?'?s?|new)?\s*(?:shoes?|footwear|sneakers?|sandals?|boots?)|i\s+(?:want|need|am\s+looking\s+for)\s+(?:some\s+)?(?:new\s+)?(?:men'?s?|women'?s?|kids?'?s?)?\s*(?:shoes?|footwear|sneakers?|sandals?|boots?|loafers?|wedges?|heels?))\b/i;

export function looksLikeFootwearCommit(rawText) {
  // Production showed widget-emitted text using curly apostrophes
  // ('men's shoes' with U+2019) which made `men'?s?` patterns miss.
  // Normalize curly apostrophes/quotes to straight ASCII before
  // regex matching so the veto fires on widget output too.
  const t = String(rawText || "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .trim();
  if (!t) return false;
  // If the same message has clear orthotic intent, it's not a
  // footwear-only commit (could be "shoes for my orthotic" type).
  if (detectOrthoticIntent(t)) return false;
  return FOOTWEAR_PATH_RE.test(t);
}

// Catches the broader "this message names a non-orthotic product"
// case that looksLikeFootwearCommit misses — production showed
// "best summer sandal for a beach for my mom" hijacking into orthotic
// flow because none of the find/show/want/need/looking-for triggers
// matched. Any mention of a concrete footwear noun (sandals, sneakers,
// boots, loafers, wedges, heels, oxfords, slippers, clogs, mary janes,
// pumps, flats, mules) is enough to veto, UNLESS the same message also
// names an orthotic product noun (orthotic, insole, footbed, insert,
// arch support — caught by ORTHOTIC_PRODUCT_RE).
const FOOTWEAR_PRODUCT_NOUN_RE =
  /\b(?:sandals?|sneakers?|boots?|loafers?|wedges?|heels?|oxfords?|slippers?|clogs?|mary[\s-]?janes?|pumps?|flats?|mules?|trainers?|footwear)\b/i;

export function mentionsNonOrthoticFootwear(rawText) {
  const t = String(rawText || "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .trim();
  if (!t) return false;
  if (!FOOTWEAR_PRODUCT_NOUN_RE.test(t)) return false;
  // Latent orthotic mention — "orthotics for sneakers" etc. — defers
  // to the orthotic flow / sandal-incompatibility guard rather than
  // vetoing here.
  if (ORTHOTIC_PRODUCT_RE.test(t)) return false;
  return true;
}

/**
 * Run Layer 1 + 2 against EVERY question node in the tree to
 * pre-extract any answers the customer's bootstrap message
 * already contains. Lets the gate skip past questions the
 * customer implicitly answered ("I need running orthotics for
 * my dad" → useCase=athletic_running, gender=Men).
 *
 * Sync-only — no Layer 3 here. Bootstrap should be cheap and
 * deterministic; if a customer's first message is too ambiguous
 * for L1/L2, we just emit q_use_case and ask normally.
 */
export function preExtractAnswers(rawText, tree) {
  const out = {};
  if (!tree || !Array.isArray(tree.nodes)) return out;
  if (!rawText || typeof rawText !== "string") return out;
  for (const node of tree.nodes) {
    if (!node || node.type !== "question" || !node.attribute) continue;
    const exact = matchChipExact(rawText, node);
    if (exact !== undefined) {
      out[node.attribute] = exact;
      continue;
    }
    const kw = matchKeyword(rawText, node);
    if (kw !== undefined) {
      out[node.attribute] = kw;
    }
  }
  return out;
}

/**
 * Walk the WHOLE conversation history and accumulate every
 * Layer-1/Layer-2 answer signal across all user messages.
 *
 * Why this exists: detectFlowState only advances when it sees
 * user→assistant→user chip-mapped pairs, and findNodeByChipsInText
 * needs the assistant's `<<chip>>` markers to survive the widget's
 * history round-trip — which they apparently don't, judging by
 * production logs where bootstrap fires every turn but continuation
 * never does. accumulateAnswers sidesteps both problems by treating
 * the customer's history as a bag of clinical facts and harvesting
 * each with a per-node Layer-1/2 scan. Later turns merge over
 * earlier ones, so a chip click on turn 3 doesn't erase a condition
 * the customer named on turn 1.
 *
 * Pure function. Sync. The merge order is chronological — earliest
 * message first, latest user message last — so the latest signal
 * wins on conflict (matches "the customer just said X" semantics).
 */
export function accumulateAnswers(messages, tree) {
  const out = {};
  if (!tree || !Array.isArray(tree.nodes)) return out;
  if (!Array.isArray(messages)) return out;
  for (const msg of messages) {
    if (!msg || msg.role !== "user") continue;
    const text = typeof msg.content === "string" ? msg.content : "";
    if (!text) continue;
    const turn = preExtractAnswers(text, tree);
    Object.assign(out, turn);
  }
  return out;
}
