function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/s$/, "");
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
//
// `extraAllowCategories` extends the allow-list. Used when the active
// category group declares a containment relationship via `goesInsideOf`
// (e.g. Orthotics goesInside Footwear, Cases goesInside Phones, Lenses
// goesInside Cameras). In that flow the AI naturally generates chips for
// the CONTAINER's categories (the "what shoes will the orthotic go inside?"
// question), and stripping those would damage the assistant text the
// downstream intent analyzer relies on. Pure data — pulled from the
// merchant's group config, no hardcoded vocabulary.
export function filterForbiddenCategoryChips(
  text,
  catalogCategories,
  fullKnownCategories,
  extraAllowCategories,
) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };

  const allow = new Set((catalogCategories || []).map(normalize).filter(Boolean));
  for (const c of extraAllowCategories || []) {
    const n = normalize(c);
    if (n) allow.add(n);
  }
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

// Strip gender chips that contradict the catalog given the user's
// mentioned categories. Example:
//   User said "boots" → only women's boots stocked → strip <<Men's>> chip
//
// Pure data, no hardcoded shoe vocabulary. Catalog drives both the
// category recognition (categoryGenderMap keys) and the gender split.
//
// Decision rule for each gender chip in the AI's reply:
//   1. Detect categories the user has mentioned in the conversation
//      (whole-word match against keys of categoryGenderMap).
//   2. If the user mentioned NO categories → keep the chip (no signal).
//   3. For each mentioned category, check its gender set:
//      - If the chip's gender (or "unisex") appears → that category
//        supports this chip → keep it.
//      - If NO mentioned category supports this chip's gender → strip.
//
// Unisex categories support both men's and women's chips (because
// unisex products work for either request).

const GENDER_CHIP_TOKENS = {
  men: ["men", "mens", "men's", "male", "boy", "boys", "boy's", "guys"],
  women: ["women", "womens", "women's", "female", "girl", "girls", "girl's", "ladies"],
};

function chipGender(inner) {
  const norm = String(inner || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (norm.some((t) => GENDER_CHIP_TOKENS.men.includes(t))) return "men";
  if (norm.some((t) => GENDER_CHIP_TOKENS.women.includes(t))) return "women";
  return null;
}

function detectCategoriesInText(text, categoryKeys) {
  if (!text || !categoryKeys || categoryKeys.length === 0) return [];
  const lower = String(text).toLowerCase();
  const found = new Set();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const k of categoryKeys) {
    // 1. Try the whole multi-word key first ("wedges heels").
    const fullRe = new RegExp(`\\b${escapeRe(k)}(?:s|es)?\\b`, "i");
    if (fullRe.test(lower)) {
      found.add(k);
      continue;
    }
    // 2. For multi-word keys, try each significant word (>=4 chars) so
    //    "wedges" alone matches the "wedges heels" key. Single-word keys
    //    skip this loop because step 1 already covered them.
    const words = k.split(/\s+/).filter((w) => w.length >= 4);
    if (words.length <= 1) continue;
    for (const w of words) {
      const re = new RegExp(`\\b${escapeRe(w)}(?:s|es)?\\b`, "i");
      if (re.test(lower)) {
        found.add(k);
        break;
      }
    }
  }
  return Array.from(found);
}

export function filterContradictingGenderChips(text, conversationText, categoryGenderMap) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };
  if (!categoryGenderMap || typeof categoryGenderMap !== "object") return { text, stripped: [] };
  const keys = Object.keys(categoryGenderMap);
  if (keys.length === 0) return { text, stripped: [] };

  const mentioned = detectCategoriesInText(conversationText || "", keys);
  if (mentioned.length === 0) return { text, stripped: [] };

  // Genders that ANY mentioned category supports.
  const supportedGenders = new Set();
  for (const cat of mentioned) {
    const entry = categoryGenderMap[cat];
    if (!entry?.genders) continue;
    for (const g of entry.genders) supportedGenders.add(g);
  }
  // Unisex products satisfy both men's and women's queries.
  if (supportedGenders.has("unisex")) {
    supportedGenders.add("men");
    supportedGenders.add("women");
  }

  const stripped = [];
  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const g = chipGender(inner);
    if (!g) return match; // not a gender chip
    if (supportedGenders.has(g)) return match;
    stripped.push(inner.trim());
    return "";
  });

  return {
    text: out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    stripped,
  };
}
