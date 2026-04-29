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
