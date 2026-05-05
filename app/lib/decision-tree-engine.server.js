import { resolveTree } from "./decision-tree-resolver.server.js";

// Engine is a pure state machine. Given a tree definition, the
// current state, and the customer's latest message, it returns the
// next state plus the response to send back. No DB writes, no LLM
// calls. The chat layer (Batch 4) is responsible for persisting
// state by leaving the question text in the assistant message —
// the same way the existing extractAnsweredChoices reconstructs
// gender/category from history. No new table for transient state.
//
// State shape (small, JSON-serializable):
//   {
//     treeId, intent,
//     currentNodeId,
//     answers: { attribute: value, ... },
//     completed: bool,
//     resolved: { masterSku, title, ... } | null
//   }
//
// step() returns:
//   {
//     nextState,
//     response: {
//       text,                  // assistant message
//       chips: [{label,value}],// chip buttons (empty when completed)
//       completed: bool,
//       resolved,              // master SKU + title when completed
//     }
//   }

function findNode(tree, id) {
  return (tree.definition?.nodes || []).find((n) => n.id === id) || null;
}

function rootState(tree) {
  return {
    treeId: tree.id,
    intent: tree.intent,
    currentNodeId: tree.definition?.rootNodeId || null,
    answers: {},
    completed: false,
    resolved: null,
  };
}

// Match a free-text user reply against the chips of the current
// node. Order:
//   1. Exact (case-insensitive) match on chip.value.
//   2. Exact match on chip.label.
//   3. Substring contains match on label or value.
//   4. None — caller asks the question again.
function matchChip(userText, chips) {
  if (!chips || chips.length === 0) return null;
  const t = String(userText || "").trim().toLowerCase();
  if (!t) return null;
  for (const c of chips) {
    if (t === String(c.value).toLowerCase() || t === String(c.label).toLowerCase()) return c;
  }
  for (const c of chips) {
    const lv = String(c.value).toLowerCase();
    const ll = String(c.label).toLowerCase();
    if (t.includes(lv) || lv.includes(t)) return c;
    if (t.includes(ll) || ll.includes(t)) return c;
  }
  return null;
}

function nextNodeId(node, chipValue) {
  if (!node?.next || typeof node.next !== "object") return null;
  return node.next[chipValue] || node.next._default || null;
}

function applyDerivedAnswers(answers, tree) {
  // Aetrex spec: posted = (arch == Flat) OR (overpronation == Yes).
  // Generic engines shouldn't bake this in, so each tree declares its
  // own derivation rules in definition.derivations:
  //   [{ set: "posted", value: true,
  //      when: { any: [{attr: "arch", eq: "Flat / Low Arch"},
  //                    {attr: "overpronation", eq: "yes"}] } }]
  const rules = tree.definition?.derivations;
  if (!Array.isArray(rules) || rules.length === 0) return answers;
  const out = { ...answers };
  for (const r of rules) {
    if (!r || !r.set || r.value === undefined || !r.when) continue;
    const matched = evalCondition(r.when, out);
    if (matched) out[r.set] = r.value;
  }
  return out;
}

function evalCondition(cond, answers) {
  if (!cond) return false;
  if (cond.any && Array.isArray(cond.any)) {
    return cond.any.some((c) => evalCondition(c, answers));
  }
  if (cond.all && Array.isArray(cond.all)) {
    return cond.all.every((c) => evalCondition(c, answers));
  }
  if (cond.attr && "eq" in cond) {
    return answers[cond.attr] === cond.eq;
  }
  if (cond.attr && Array.isArray(cond.in)) {
    return cond.in.includes(answers[cond.attr]);
  }
  return false;
}

// Skip-if-known: if the next node's attribute is already in answers
// (e.g. gender pre-filled from a choice button outside the tree),
// fast-forward through it. Caps at 16 hops to prevent runaway.
function advance(tree, fromState) {
  let state = fromState;
  for (let i = 0; i < 16; i++) {
    const node = findNode(tree, state.currentNodeId);
    if (!node) break;
    if (node.type === "resolve") {
      const finalAnswers = applyDerivedAnswers(state.answers, tree);
      const result = resolveTree(finalAnswers, tree.definition.resolver);
      return {
        ...state,
        answers: finalAnswers,
        completed: true,
        resolved: result.resolved,
      };
    }
    if (node.skipIfKnown && node.attribute && state.answers[node.attribute] !== undefined) {
      const chipValue = state.answers[node.attribute];
      const target = nextNodeId(node, chipValue);
      if (!target) break;
      state = { ...state, currentNodeId: target };
      continue;
    }
    break;
  }
  return state;
}

// Entry point. Pass the customer's latest message; get back next
// state + response. If `prefill` is provided (e.g. gender already
// answered via the existing choice-button system), seeds the
// answers map and advances through skipIfKnown nodes.
export function startTree(tree, { prefill = {} } = {}) {
  const seeded = { ...rootState(tree), answers: { ...prefill } };
  const advanced = advance(tree, seeded);
  return { nextState: advanced, response: stateToResponse(tree, advanced) };
}

export function stepTree(tree, state, userMessage) {
  if (!state || state.completed) {
    return { nextState: state, response: stateToResponse(tree, state) };
  }
  const node = findNode(tree, state.currentNodeId);
  if (!node || node.type !== "question") {
    const advanced = advance(tree, state);
    return { nextState: advanced, response: stateToResponse(tree, advanced) };
  }
  const chip = matchChip(userMessage, node.chips);
  if (!chip) {
    return {
      nextState: state,
      response: {
        text: `Pick one of the options below to continue:\n\n${node.question}`,
        chips: node.chips,
        completed: false,
        resolved: null,
        unmatched: true,
      },
    };
  }
  const answers = { ...state.answers, [node.attribute]: chip.value };
  const targetId = nextNodeId(node, chip.value);
  let nextState = { ...state, answers, currentNodeId: targetId };
  nextState = advance(tree, nextState);
  return { nextState, response: stateToResponse(tree, nextState) };
}

function stateToResponse(tree, state) {
  if (!state) return { text: "", chips: [], completed: false, resolved: null };
  if (state.completed) {
    return {
      text: "",
      chips: [],
      completed: true,
      resolved: state.resolved,
    };
  }
  const node = findNode(tree, state.currentNodeId);
  if (!node) return { text: "", chips: [], completed: false, resolved: null };
  return {
    text: node.question,
    chips: node.chips || [],
    completed: false,
    resolved: null,
  };
}

// State reconstruction from message history. Mirrors the
// extractAnsweredChoices pattern (conversation-memory.server.js).
// Walks forward; for each assistant message containing a tree
// question, finds the user's reply, matches a chip, advances.
//
// The marker we use to recognize a tree-emitted question is the
// node's full question text appearing as a substring of the
// assistant message. This is robust because:
//   (a) tree questions are emitted verbatim from definition.question
//       (no LLM rewriting),
//   (b) the question texts are distinctive sentences, not common
//       boilerplate.
// If the merchant later edits a question text, in-flight sessions
// fall back to "no match found" → engine restarts the funnel from
// root, which is the safe default.
export function extractTreeStateFromHistory(tree, messages, prefill = {}) {
  let state = { ...rootState(tree), answers: { ...prefill } };
  state = advance(tree, state);
  if (!Array.isArray(messages) || messages.length === 0) return state;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.map((c) => c?.text || "").join(" ") : "";
    if (!text) continue;
    const node = findNode(tree, state.currentNodeId);
    if (!node || node.type !== "question") continue;
    if (!text.includes(node.question)) continue;
    const userMsg = messages[i + 1];
    if (!userMsg || userMsg.role !== "user") continue;
    const userText = typeof userMsg.content === "string"
      ? userMsg.content
      : Array.isArray(userMsg.content) ? userMsg.content.map((c) => c?.text || "").join(" ") : "";
    const chip = matchChip(userText, node.chips);
    if (!chip) continue;
    const answers = { ...state.answers, [node.attribute]: chip.value };
    const target = nextNodeId(node, chip.value);
    state = advance(tree, { ...state, answers, currentNodeId: target });
    if (state.completed) break;
  }
  return state;
}
