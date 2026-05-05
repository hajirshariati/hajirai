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

// Hard-filter check: would picking `chip.value` for `node.attribute`
// (combined with what's already answered) leave at least one
// candidate in the resolver's masterIndex?
//
// This is "shop-aware" filtering — keeps the customer from being
// offered options that have zero inventory in the merchant's
// catalog. Examples on Aetrex's catalog:
//   - useCase=skates → only Unisex SKUs exist → gender chip filter
//     hides Men/Women/Kids → only Unisex remains → autoSkipIfSingle
//     fires and the gender question is never shown.
//   - useCase=cleats → same shape (Unisex-only family).
//   - gender=Kids → no athletic / cleats / skates / winter / work
//     SKUs → those use-case chips never appear if gender is asked
//     first.
//
// Hard-filter attrs we apply: gender (with Unisex acceptance), useCase.
// Soft attrs (arch, posted, metSupport, condition) are ignored for
// pruning — the resolver scores those, doesn't filter on them, so
// every candidate matches at the chip-pruning level.
const HARD_FILTER_ATTRS_FOR_PRUNE = ["gender", "useCase"];

// Strict equality for chip pruning. Without this, Aetrex's Unisex
// skate/cleat SKUs would satisfy every gender query and every gender
// chip would look viable — which is the opposite of what we want.
// The resolver's runtime gender filter keeps its Unisex fallback so
// once a customer picks "Men" + skates, they still get the Unisex
// skate SKU. Pruning is shop-aware, runtime is forgiving.
function genderMatchPrune(candidateGender, askedGender) {
  if (!askedGender) return true;
  return candidateGender === askedGender;
}

function chipHasCandidates(node, chip, answers, resolver) {
  if (!resolver || !Array.isArray(resolver.masterIndex)) return true;
  const projected = { ...answers, [node.attribute]: chip.value };
  for (const m of resolver.masterIndex) {
    let ok = true;
    for (const k of HARD_FILTER_ATTRS_FOR_PRUNE) {
      const v = projected[k];
      if (v === undefined || v === null || v === "") continue;
      if (k === "gender") { if (!genderMatchPrune(m.gender, v)) { ok = false; break; } continue; }
      if (m[k] !== v) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// Returns the subset of a node's chips that would lead to ≥1
// candidate in the catalog given the current answers. Pure.
export function availableChipsForNode(tree, node, answers) {
  if (!node || !Array.isArray(node.chips)) return [];
  const resolver = tree.definition?.resolver;
  if (!resolver) return node.chips;
  // Always allow chips for soft attributes (no hard-filter effect).
  if (!HARD_FILTER_ATTRS_FOR_PRUNE.includes(node.attribute)) return node.chips;
  return node.chips.filter((c) => chipHasCandidates(node, c, answers || {}, resolver));
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

// Walks question nodes, applying three skip rules in order:
//   1. resolve nodes terminate the walk and run the resolver.
//   2. skipIfKnown: if the node's attribute is already in answers
//      (pre-filled from outside, e.g. gender from a choice button),
//      fast-forward.
//   3. autoSkipIfSingle: if dynamic chip pruning leaves exactly one
//      viable chip given current answers, set the attribute to that
//      chip's value and fast-forward. This is what removes the
//      pointless "gender?" question after the customer says
//      "Hockey skates" — only Unisex is viable, so the engine
//      auto-picks it instead of asking.
//   4. autoFallback: if pruning leaves zero viable chips, use the
//      node's first chip as a deterministic fallback to avoid a
//      dead-end. Resolver's own fallback handles SKU mapping.
//
// Cap at 16 hops to prevent runaway on a misconfigured tree.
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
    if (node.autoSkipIfSingle && node.attribute) {
      const viable = availableChipsForNode(tree, node, state.answers);
      if (viable.length === 1) {
        const onlyChip = viable[0];
        const target = nextNodeId(node, onlyChip.value);
        if (!target) break;
        state = {
          ...state,
          answers: { ...state.answers, [node.attribute]: onlyChip.value },
          currentNodeId: target,
        };
        continue;
      }
      if (viable.length === 0) {
        // No catalog coverage at all — pick the first declared chip
        // as a deterministic fallback. The resolver's `fallback`
        // surfaces a sensible SKU.
        const fallbackChip = node.chips?.[0];
        if (!fallbackChip) break;
        const target = nextNodeId(node, fallbackChip.value);
        if (!target) break;
        state = {
          ...state,
          answers: { ...state.answers, [node.attribute]: fallbackChip.value },
          currentNodeId: target,
        };
        continue;
      }
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
  // Match against the FULL chip list — customer might have typed
  // an option we'd normally prune (rare). If they pick a pruned
  // chip, the resolver still finds a fallback or scores best-effort,
  // which is fine.
  const chip = matchChip(userMessage, node.chips);
  if (!chip) {
    const viable = availableChipsForNode(tree, node, state.answers);
    return {
      nextState: state,
      response: {
        text: `Pick one of the options below to continue:\n\n${node.question}`,
        chips: viable.length > 0 ? viable : node.chips,
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
  // Render only the chips that have catalog coverage given current
  // answers. advance() already auto-skipped the 0/1-viable cases —
  // by the time we render, this list is at least 2 entries for
  // hard-filter attrs, or unfiltered for soft attrs.
  const renderedChips = availableChipsForNode(tree, node, state.answers);
  const finalChips = renderedChips.length > 0 ? renderedChips : (node.chips || []);
  return {
    text: node.question,
    chips: finalChips,
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
