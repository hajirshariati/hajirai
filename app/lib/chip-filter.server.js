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

export function filterForbiddenCategoryChips(text, catalogCategories) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };

  const allow = new Set((catalogCategories || []).map(normalize).filter(Boolean));
  const stripped = [];

  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const n = normalize(inner);
    if (!n) return match;
    if (allow.has(n)) return match;
    if (KNOWN_CATEGORY_SINGULARS.has(n)) {
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
