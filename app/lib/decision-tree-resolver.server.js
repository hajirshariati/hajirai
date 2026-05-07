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

const HARD_FILTER_ATTRS = ["useCase"];

// Gender filter is special: customer says "Men" but the only SKU
// in that use-case is Unisex (e.g. cleats, skates) — we want to
// surface the Unisex one rather than fall back to a wrong-gender
// SKU. So adult genders (Men/Women) accept {asked, "Unisex"}.
//
// Kids are different. A child's foot is anatomically different from
// an adult's, and merchant policy is: a Kids customer must ONLY get
// a Kids-tagged product. Unisex (which means "adult unisex" in this
// catalog) is NOT a valid substitute for a child. If no Kids SKU
// exists for the asked use-case, the resolver returns no match and
// lets the caller surface a clean "we don't carry a kids product
// for that use-case" message rather than ship a wrong-fit Unisex.
const KIDS_GENDERS = new Set(["Kids", "Boys", "Girls", "Kid", "Child"]);
function isKidsGender(g) {
  return typeof g === "string" && KIDS_GENDERS.has(g);
}
function genderMatch(candidateGender, askedGender) {
  if (!askedGender) return true;
  if (candidateGender === askedGender) return true;
  // Strict Kids: a Kids customer must ONLY get a Kids-tagged
  // product. Unisex (which means "adult unisex" in this catalog)
  // is NOT acceptable for a child. The gate hides the Kids chip
  // from q_gender if the merchant's masterIndex has no Kids items,
  // so in the golden path this strict guard never fires — but
  // when it does (e.g. customer says "for my kid" in free text),
  // returning null is correct: the bot tells them honestly we
  // don't carry a kids product.
  if (isKidsGender(askedGender)) return false;
  if (candidateGender === "Unisex") return true;
  return false;
}

// Specialty conditions that have dedicated SKUs in the Aetrex
// catalog. The engine sets `attrs.condition` from the condition
// question; the resolver maps it to a candidate-set filter.
//
// metatarsalgia / mortons_neuroma also accept any SKU with
// metSupport=true — that's the merchant's clinical signal for
// "this product addresses ball-of-foot conditions". The seed's
// titles often say "Metatarsal Support" (not "Metatarsalgia") so a
// pure regex match misses the right SKU. metSupport=true bridges
// the two.
const CONDITION_TARGETS = {
  heel_spurs:        (m) => /heel\s*spurs?/i.test(m.title || "") || m.condition === "heel_spurs",
  mortons_neuroma:   (m) => /morton/i.test(m.title || "")        || m.condition === "mortons_neuroma" || m.metSupport === true,
  metatarsalgia:     (m) => /metatars/i.test(m.title || "")      || m.condition === "metatarsalgia"   || m.metSupport === true,
  diabetic:          (m) => /conform|diabet/i.test(m.title||"")  || m.condition === "diabetic",
  plantar_fasciitis: (m) => /plantar\s*fasciitis\s*kit/i.test(m.title||"") || m.condition === "plantar_fasciitis",
};

function score(candidate, attrs) {
  let s = 0;
  if (attrs.arch && candidate.arch === attrs.arch) s += 8;
  if (attrs.gender && candidate.gender === attrs.gender) s += 4;  // exact > Unisex
  if (attrs.posted !== undefined && candidate.posted === attrs.posted) s += 2;
  if (attrs.metSupport !== undefined && candidate.metSupport === attrs.metSupport) s += 1;
  // Tie-break preference: when the customer's useCase is "comfort"
  // (the broadest casual/everyday bucket) and the candidate's own
  // useCase ALSO matches comfort, give it a small bonus over
  // candidates from athletic / dress / specialty buckets that
  // happened to score equally on arch/gender/posted/metSupport.
  // Without this, the resolver tie-broke to athletic-line SKUs
  // (L1920W Active) for "no pain just support" queries because
  // they share the same arch/posted profile and L19xx beats L100
  // on lex order. Tiny bonus (0.5) only fires when useCase already
  // matches — so it never overrides an arch/gender mismatch.
  if (
    attrs.useCase === "comfort" &&
    candidate.useCase === "comfort"
  ) {
    s += 0.5;
  }
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

  // Specialty condition takes priority over use-case. If the
  // customer reports e.g. heel_spurs and a heel-spur-specific SKU
  // exists in the catalog, that SKU wins regardless of whether
  // useCase is "casual", "dress", or "comfort" — the clinical
  // condition is the load-bearing fact. Exception: shoe-context-
  // critical use cases (cleats, skates, winter_boots, athletic_*)
  // keep their family SKU because the specialty insole won't fit
  // the shoe shape.
  const SHOE_CONTEXT_LOCKS = new Set([
    "cleats", "skates", "winter_boots",
    "athletic_running", "athletic_training", "athletic_general",
    "dress_no_removable",
  ]);

  let candidates;
  const specialtyTest =
    attrs.condition && attrs.condition !== "none" ? CONDITION_TARGETS[attrs.condition] : null;

  if (specialtyTest && !SHOE_CONTEXT_LOCKS.has(attrs.useCase)) {
    candidates = resolver.masterIndex.filter(
      (m) => genderMatch(m.gender, attrs.gender) && specialtyTest(m),
    );
    if (candidates.length === 0) {
      // The customer named a specific clinical condition (e.g. heel
      // spurs) but no specialty SKU exists for that condition+gender
      // in this shop's catalog (might be missing from the merchant's
      // recommender data, or not yet synced from Shopify). Returning
      // a generic comfort SKU here is misleading — the AI's text
      // would say "for heel spurs" but the card would show a
      // diabetic / generic comfort orthotic. Bail out with a clear
      // reason so the caller can tell the customer truthfully.
      return {
        resolved: null,
        reason: `no SKU available for condition=${attrs.condition} and gender=${attrs.gender || "any"}`,
        attrs,
        missingSpecialty: { condition: attrs.condition, gender: attrs.gender || null },
      };
    }
  } else {
    candidates = resolver.masterIndex.filter((m) => {
      if (!genderMatch(m.gender, attrs.gender)) return false;
      for (const k of HARD_FILTER_ATTRS) {
        if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== "" && m[k] !== attrs[k]) {
          return false;
        }
      }
      return true;
    });
  }

  // Score also rewards exact gender match so a Men's SKU is preferred
  // over a Unisex one when both exist. Bump is smaller than arch but
  // ahead of metSupport.

  if (candidates.length === 0) {
    // Refuse the global fallback for Kids unless the fallback itself
    // is Kids-tagged. The merchant's universal default is typically a
    // Unisex SKU — fine for adults, wrong for children.
    const fallback = resolver.fallback || null;
    const fallbackGender = fallback?.gender;
    const fallbackOk =
      !fallback ||
      !isKidsGender(attrs.gender) ||
      isKidsGender(fallbackGender);
    return {
      resolved: fallbackOk ? fallback : null,
      reason: fallbackOk
        ? "no candidates after hard filter"
        : "no kids-specific product for this use-case; not falling back to a non-kids SKU",
      attrs,
    };
  }

  // Within-bucket condition refinement (after the priority logic
  // above). If we're in shoe-context-locked mode but the family
  // happens to contain a condition-specific variant, prefer it.
  if (specialtyTest && SHOE_CONTEXT_LOCKS.has(attrs.useCase)) {
    const refined = candidates.filter(specialtyTest);
    if (refined.length > 0) candidates = refined;
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
