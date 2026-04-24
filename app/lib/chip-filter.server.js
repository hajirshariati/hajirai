// Known product-category words the model tends to hallucinate as choice chips
// (<<Boots>>, <<Sneakers>>, etc). If a chip's text normalizes to one of these
// words AND the shop's catalog allow-list does NOT contain it, we strip the
// chip. Non-category chips (gender, yes/no, use-case phrases) never match and
// pass through untouched.
const KNOWN_CATEGORY_SINGULARS = new Set([
  "sneaker", "shoe", "sandal", "boot", "loafer", "slipper", "heel", "flat",
  "wedge", "clog", "mule", "oxford", "moccasin", "slide", "pump", "espadrille",
  "bootie", "sock", "trainer", "runner", "cleats",
  "orthotic", "insole", "insert", "footbed", "arch support",
]);

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/s$/, "");
}

const SPECIFIC_CATEGORY_RE = /\b(sneakers?|sandals?|boots?|booties?|loafers?|slippers?|heels?|flats?|clogs?|mules?|oxfords?|moccasins?|slides?|pumps?|espadrilles?|wedges?|trainers?|runners?|cleats?|orthotics?|insoles?|inserts?|footbeds?)\b/i;
const GENERIC_SHOE_RE = /\b(shoes?|footwear)\b/i;

export function isGenericShoeQuery(userMessage) {
  const s = String(userMessage || "");
  if (!GENERIC_SHOE_RE.test(s)) return false;
  if (SPECIFIC_CATEGORY_RE.test(s)) return false;
  return true;
}

function chipIsFromCategories(chipText, allowSet) {
  const tokens = String(chipText || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map((w) => w.replace(/s$/, ""));
  return tokens.some((t) => allowSet.has(t));
}

export function enforceCategoryChipsForShoeQueries(text, catalogCategories, userMessage) {
  if (!text || typeof text !== "string") return { text: text || "", replaced: false };
  if (!catalogCategories || catalogCategories.length < 2) return { text, replaced: false };
  if (!isGenericShoeQuery(userMessage)) return { text, replaced: false };

  const chipMatches = [...text.matchAll(/<<([^<>|]+)>>/g)];
  if (chipMatches.length === 0) return { text, replaced: false };

  const allowSet = new Set(catalogCategories.map(normalize).filter(Boolean));
  const categoryChipCount = chipMatches.filter((m) => chipIsFromCategories(m[1], allowSet)).length;
  if (categoryChipCount >= 2) return { text, replaced: false };

  const categoryChips = catalogCategories.slice(0, 5).map((c) => `<<${c}>>`).join("");
  const question = "What type of shoes are you looking for?";
  return {
    text: `${question}\n${categoryChips}`,
    replaced: true,
    replacedCount: chipMatches.length,
    newChips: catalogCategories.slice(0, 5),
  };
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

export function filterForbiddenCategoryChips(text, catalogCategories) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };

  const allow = new Set((catalogCategories || []).map(normalize).filter(Boolean));
  const stripped = [];

  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const tokens = chipTokens(inner);
    if (tokens.size === 0) return match;

    let hasForbiddenCategory = false;
    let allCategoryTokensAllowed = true;
    let hasAnyCategoryToken = false;

    for (const t of tokens) {
      if (KNOWN_CATEGORY_SINGULARS.has(t)) {
        hasAnyCategoryToken = true;
        if (allow.has(t)) continue;
        hasForbiddenCategory = true;
        allCategoryTokensAllowed = false;
      }
    }

    if (!hasAnyCategoryToken) return match;
    if (hasForbiddenCategory && !allCategoryTokensAllowed) {
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
