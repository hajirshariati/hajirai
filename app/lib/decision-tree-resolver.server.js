// Pure deterministic resolver: collected attributes + tree.resolver
// → exactly one master SKU. Same inputs always produce the same
// output. No LLM. No randomness. No "maybe / IF".
//
// Algorithm:
//   1. Apply resolver.defaults to fill any unanswered attributes.
//   2. Hard-filter masterIndex on (gender, useCase). These are the
//      load-bearing attributes — a customer who said "Men" + "Dress"
//      will never see a Women's Athletic SKU.
//   3. If a specific clinical condition was reported AND a
//      condition-specific SKU exists in the candidate set, prefer
//      it (e.g. heel_spurs → L2460 wins over a generic dress SKU).
//   4. Score remaining candidates on (arch, posted, metSupport).
//      Higher score = closer fit. Ties broken by masterSku
//      lexicographic order — guarantees determinism.
//   5. If no candidates survived hard-filter, return resolver.fallback.
//
// The "OR" rule for posted: a Yes from EITHER flat-arch OR
// self-reported overpronation sets posted=true (Aetrex spec). The
// engine sets the answer flag accordingly before calling resolve();
// the resolver itself just consumes whatever boolean it's given.

const HARD_FILTER_ATTRS = ["gender", "useCase"];

// Specialty conditions that have dedicated SKUs in the Aetrex
// catalog. The engine sets `attrs.condition` from the condition
// question; the resolver maps it to a candidate-set filter.
const CONDITION_TARGETS = {
  heel_spurs:        (m) => /heel spurs?/i.test(m.title || "") || m.condition === "heel_spurs",
  mortons_neuroma:   (m) => /morton/i.test(m.title || "")      || m.condition === "mortons_neuroma",
  metatarsalgia:     (m) => /metatarsalgia/i.test(m.title||"") || m.condition === "metatarsalgia",
  diabetic:          (m) => /conform|diabet/i.test(m.title||"")|| m.condition === "diabetic",
  plantar_fasciitis: (m) => /plantar fasciitis kit/i.test(m.title||"") || m.condition === "plantar_fasciitis",
};

function score(candidate, attrs) {
  let s = 0;
  if (attrs.arch && candidate.arch === attrs.arch) s += 4;
  if (attrs.posted !== undefined && candidate.posted === attrs.posted) s += 2;
  if (attrs.metSupport !== undefined && candidate.metSupport === attrs.metSupport) s += 1;
  return s;
}

function applyDefaults(attrs, defaults) {
  const out = { ...attrs };
  if (defaults && typeof defaults === "object") {
    for (const [k, v] of Object.entries(defaults)) {
      if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
    }
  }
  return out;
}

export function resolveTree(answers, resolver) {
  if (!resolver || !Array.isArray(resolver.masterIndex)) {
    return { resolved: null, reason: "resolver missing or empty" };
  }

  const attrs = applyDefaults(answers || {}, resolver.defaults);

  // Hard filter
  let candidates = resolver.masterIndex.filter((m) => {
    for (const k of HARD_FILTER_ATTRS) {
      if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== "" && m[k] !== attrs[k]) {
        return false;
      }
    }
    return true;
  });

  if (candidates.length === 0) {
    return {
      resolved: resolver.fallback || null,
      reason: "no candidates after hard filter",
      attrs,
    };
  }

  // Condition override
  if (attrs.condition && attrs.condition !== "none") {
    const test = CONDITION_TARGETS[attrs.condition];
    if (test) {
      const conditional = candidates.filter(test);
      if (conditional.length > 0) candidates = conditional;
    }
  }

  // Score + deterministic tiebreak
  const scored = candidates
    .map((c) => ({ c, s: score(c, attrs) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      return String(a.c.masterSku).localeCompare(String(b.c.masterSku));
    });

  const winner = scored[0]?.c || null;
  return {
    resolved: winner,
    reason: winner ? "matched" : "no winner",
    attrs,
    runnerUp: scored[1]?.c || null,
  };
}
