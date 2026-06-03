const KID_GENDERS = new Set(["kid", "kids", "boy", "boys", "girl", "girls", "child", "children", "youth"]);

const NON_FOOTWEAR_CATEGORY_PATTERNS = [
  { key: "orthotics", label: "Orthotics", re: /\b(?:orthotics?|insoles?|inserts?)\b/i },
  { key: "accessories", label: "Accessories", re: /\baccessor(?:y|ies)\b/i },
  { key: "socks", label: "Socks", re: /\bsocks?\b/i },
  { key: "giftCards", label: "Gift Cards", re: /\bgift\s+cards?\b/i },
];

function normalizeCategory(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyNonFootwearCategory(category) {
  const normalized = normalizeCategory(category);
  if (!normalized) return null;
  return NON_FOOTWEAR_CATEGORY_PATTERNS.find((entry) => entry.re.test(normalized)) || null;
}

export function buildKidsCoveragePrompt({ sessionGender, catalogProductTypes } = {}) {
  const gender = normalizeCategory(sessionGender);
  if (!KID_GENDERS.has(gender)) {
    return { prompt: "", diagnostics: { applies: false, reason: "not_kids_gender" } };
  }

  const categories = Array.isArray(catalogProductTypes)
    ? catalogProductTypes.map((c) => String(c || "").trim()).filter(Boolean)
    : [];

  const availableNonFootwear = new Map();
  const kidsFootwear = [];
  for (const category of categories) {
    const nonFootwear = classifyNonFootwearCategory(category);
    if (nonFootwear) {
      availableNonFootwear.set(nonFootwear.key, nonFootwear.label);
    } else {
      kidsFootwear.push(category);
    }
  }

  if (kidsFootwear.length > 0) {
    return {
      prompt: "",
      diagnostics: {
        applies: false,
        reason: "kids_footwear_available",
        kidsFootwear,
        availableNonFootwear: [...availableNonFootwear.values()],
      },
    };
  }

  const alternatives = [...availableNonFootwear.values()];
  const alternativesText = alternatives.join(", ");

  let prompt =
    "\n\n=== Kids coverage (turn-scoped) ===\n" +
    "The live kids-scoped catalog does NOT include children's / kids' footwear (shoes). " +
    "Do not recommend kids' shoes unless the live catalog includes kids footwear categories. ";

  if (alternatives.length > 0) {
    prompt +=
      `The live kids-scoped catalog DOES include these non-shoe kid-eligible categories: ${alternativesText}. ` +
      "If the customer simply chose Kids or asks what kids products/styles are available, say plainly that the store does not carry kids' shoes, then offer the available kids categories above and ask which they want to see. " +
      "If the customer specifically asks for kids' shoes, sneakers, sandals, boots, or other footwear, say the store does not carry kids' shoes and then offer the available kids non-shoe categories as alternatives when relevant. " +
      "Do not imply kids orthotics, insoles, or accessories are absent when they are listed above.\n";
  } else {
    prompt +=
      "The live kids-scoped catalog also does not include kid-eligible non-shoe categories. " +
      "If the customer is shopping for a child, tell them plainly and up front that the store doesn't carry kids' shoes or kids-specific products, then offer adult lines only if appropriate.\n";
  }

  return {
    prompt,
    diagnostics: {
      applies: true,
      kidsFootwear,
      availableNonFootwear: alternatives,
    },
  };
}
