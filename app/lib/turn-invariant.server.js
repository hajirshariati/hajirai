// Turn-invariant violation sink (audit #7).
//
// Ownership / evidence invariants used to be raw `console.warn` calls — visible
// in logs but with no counter, no assertable surface, and nothing a test or a
// health route could read. Route every VIOLATION through here: it still logs
// (same operator-visible line) AND increments an in-process counter keyed by a
// stable code, so evals can assert "zero violations over the corpus" and a
// health route can expose the totals.
//
// In-process only (resets on deploy) — that's the right scope for "did THIS
// build start emitting a new class of violation?". For long-term trends, ship
// the codes to your metrics pipeline from here.

const counters = new Map();

// Canonical END-OF-TURN log. EVERY customer turn must emit exactly one of these
// — whether the agentic LLM loop owned it or a deterministic dispatcher
// (orthotic gate, variant-facts, policy, resolver-no-match, product-engine, …)
// answered and returned BEFORE the loop. Without it, a turn that exits through a
// legacy dispatcher leaves no "who owned this, and how did it end?" record, so a
// silently-wrong owner is invisible in PRD logs. `answerOwner` = who produced the
// text; `cardOwner` = who produced the cards ("none" when suppressed); `path` =
// the code path that owned the turn (e.g. "policy-engine", "agentic-loop").
export function logTurnInvariant({ workflow = "-", answerOwner = "-", cardOwner = "-", finalCards = "-", path = "-", extra = "" } = {}) {
  const tail = extra ? ` ${extra}` : "";
  console.log(
    `[turn-invariant] workflow=${workflow} answerOwner=${answerOwner} cardOwner=${cardOwner} ` +
    `finalCards=${finalCards} path=${path}${tail}`,
  );
}

// Record (and log) a turn-invariant violation. `code` is a stable, low-cardinality
// identifier (e.g. "card_not_in_evidence_pool"); `fields` is structured context.
export function recordTurnInvariantViolation(code, fields = {}) {
  const key = String(code || "unknown");
  counters.set(key, (counters.get(key) || 0) + 1);
  const detail = fields && Object.keys(fields).length ? " " + safeJson(fields) : "";
  console.warn(`[turn-invariant] VIOLATION ${key}${detail}`);
}

// Snapshot of all violation counts since process start (or last reset).
export function getTurnInvariantCounters() {
  return Object.fromEntries(counters);
}

// Total across all codes.
export function totalTurnInvariantViolations() {
  let n = 0;
  for (const v of counters.values()) n += v;
  return n;
}

// Test/maintenance helper — clear the counters.
export function resetTurnInvariantCounters() {
  counters.clear();
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch { return "{…}"; }
}
