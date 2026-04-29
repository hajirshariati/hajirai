function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/s$/, "");
}

const SPECIFIC_CATEGORY_RE = /\b(sneakers?|sandals?|boots?|booties?|loafers?|slippers?|heels?|flats?|clogs?|mules?|oxfords?|moccasins?|slides?|pumps?|espadrilles?|wedges?|trainers?|runners?|cleats?|orthotics?|insoles?|inserts?|footbeds?)\b/i;
const GENERIC_SHOE_RE = /\b(shoes?|footwear)\b/i;
// "Running shoes", "training shoes", "casual shoes" etc. are NOT generic
// catalog-disambiguation queries — they're activity-specific. Customers
// reach these phrases either by typing them or by clicking a chip the AI
// just offered (e.g. <<Running Shoes>><<Gym/Training Shoes>> in an
// orthotic flow). Treat any shoe-word that is qualified by an activity as
// specific, so the chip enforcer doesn't blow away the AI's contextual
// response.
const ACTIVITY_QUALIFIER_RE = /\b(running|training|gym|workout|athletic|tennis|basketball|hiking|walking|casual|formal|dress|work|orthotic|insole|insert)\b/i;

// Substring matches against any common footwear keyword. Used to filter the
// catalog category list to only shoe-style options when a customer asks a
// generic "what shoe should I wear?" question. Matches multi-word categories
// like "slip ons", "mary janes", "ballet flats" via substring (not word
// boundary) so plurals and joined forms work.
const FOOTWEAR_KEYWORDS = [
  "sneaker", "sandal", "boot", "loafer", "slipper", "heel", "flat",
  "clog", "mule", "oxford", "moccasin", "slide", "pump", "espadrille",
  "wedge", "trainer", "runner", "cleat", "slip on", "slip-on",
  "mary jane", "ballet",
];

export function isFootwearCategory(category) {
  const lower = String(category || "").toLowerCase();
  return FOOTWEAR_KEYWORDS.some((kw) => lower.includes(kw));
}

export function isGenericShoeQuery(userMessage) {
  const s = String(userMessage || "");
  if (!GENERIC_SHOE_RE.test(s)) return false;
  if (SPECIFIC_CATEGORY_RE.test(s)) return false;
  if (ACTIVITY_QUALIFIER_RE.test(s)) return false;
  return true;
}

function chipTokens(inner) {
  const whole = normalize(inner);
  const tokens = new Set();
  if (whole) tokens.add(whole);
  for (const w of String(inner || "").toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const n = w.replace(/s$/, "");
    if (n) tokens.add(n);
  }
  return tokens;
}

// A chip is considered a "category chip" only if one of its tokens matches
// a category that exists somewhere in THIS shop's catalog (fullKnownCategories).
// This is fully data-driven — no hardcoded shoe/footwear vocabulary. Works for
// any store: a jewelry store's categories populate fullKnownCategories, a
// clothing store's do the same, etc.
//
// Rule: strip a chip if any of its tokens matches a known catalog category
// that is NOT in the current gender-scoped allow-list. Example: if the shop
// has women's boots but no men's boots, "boot" is in fullKnownCategories
// (because women's boots exist) but not in the men's allow-list — so
// <<Boots>> gets stripped when the customer asked for men's shoes.
export function filterForbiddenCategoryChips(text, catalogCategories, fullKnownCategories) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };

  const allow = new Set((catalogCategories || []).map(normalize).filter(Boolean));
  const known = new Set(((fullKnownCategories && fullKnownCategories.length > 0) ? fullKnownCategories : catalogCategories || []).map(normalize).filter(Boolean));
  const stripped = [];

  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const tokens = chipTokens(inner);
    if (tokens.size === 0) return match;

    let hasForbiddenCategory = false;
    let hasAnyCategoryToken = false;

    for (const t of tokens) {
      if (known.has(t)) {
        hasAnyCategoryToken = true;
        if (allow.has(t)) continue;
        hasForbiddenCategory = true;
      }
    }

    if (!hasAnyCategoryToken) return match;
    if (hasForbiddenCategory) {
      stripped.push(inner.trim());
      return "";
    }
    return match;
  });

  return {
    text: out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    stripped,
  };
}
