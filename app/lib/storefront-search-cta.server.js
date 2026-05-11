// Storefront search CTA builder.
//
// Takes the merchant's URL pattern (with a {q} placeholder) plus the
// conversation's resolved intent (gender, category, color, modifier),
// and produces a single auto-generated CTA pointing at the storefront's
// search results page. Replaces the older per-collection-link mapping
// for shops that opt in by setting `storefrontSearchUrlPattern` in
// ShopConfig.
//
// Pattern conventions:
//   "https://www.aetrex.com/collections/shop?q={q}&tab=products"
//   "https://my-store.com/search?q={q}"
//
// Keyword composition (in order):
//   1. modifier (new, sale, etc.) — only if detected in the latest
//      user message AND surfaces in real search results
//   2. gender (men/women/kids) — normalized
//   3. color — only if the customer explicitly mentioned it AND it
//      appears in the merchant's catalog colors (we don't fabricate)
//   4. category — the dominant card category, or the active group
//
// Output URL uses `+` between tokens, not %20, to match the Aetrex-style
// `?q=women+sandals` shape (Shopify storefronts accept both, but the
// merchant explicitly asked for plus-separated).
//
// Label is title-cased and human-readable:
//   "View All Women's Sandals"
//   "View All New Men's Sneakers"
//   "View All Pink Sandals"
//   "View All Men's Orthotics"

const MODIFIER_PATTERNS = [
  // Matches "new", "new arrivals", "new release", "brand-new", "latest".
  // Bare "new" is intentionally broad — false positives just add a
  // weak keyword to the URL search, which the storefront engine
  // handles. Better to over-trigger than miss legitimate "new" intent.
  { match: /\b(new(?:\s+arrivals?|\s+release)?|brand[- ]new|latest)\b/i, token: "new" },
  { match: /\b(on\s+sale|sale|clearance|discounted?|deals?|markdowns?|specials?)\b/i, token: "sale" },
  { match: /\b(bestsell(ers?|ing)|most\s+popular|top\s+rated|trending)\b/i, token: "bestseller" },
];

function detectModifier(text) {
  if (!text || typeof text !== "string") return null;
  for (const { match, token } of MODIFIER_PATTERNS) {
    if (match.test(text)) return token;
  }
  return null;
}

function normalizeGenderToken(g) {
  const lower = String(g || "").toLowerCase().trim();
  if (!lower) return null;
  if (lower.startsWith("men") || lower === "male") return "men";
  if (lower.startsWith("women") || lower === "female") return "women";
  if (
    lower.startsWith("kid") ||
    lower.startsWith("boy") ||
    lower.startsWith("girl") ||
    lower === "child" ||
    lower === "children" ||
    lower === "youth"
  ) {
    return "kids";
  }
  return null;
}

function titleCase(s) {
  return String(s || "")
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ")
    .trim();
}

// URL-encode while preserving + as the inter-token separator the
// merchant requested. Inside a token, internal spaces (e.g. "wedges
// heels") also become +.
function encodeToken(s) {
  return encodeURIComponent(String(s).toLowerCase().trim()).replace(/%20/g, "+");
}

// Match a user-defined override rule against the resolved intent.
// Rules are objects: { modifier?, gender?, category?, url, label? }.
// Blank fields are wildcards; populated fields must match the
// corresponding resolved-intent value (case-insensitive; gender
// uses normalized tokens). Rule with the most populated fields
// wins. Rules with no populated constraints are ignored — they'd
// otherwise match every turn.
function matchOverride(overrides, resolved) {
  if (!Array.isArray(overrides) || overrides.length === 0) return null;
  const { modifier, gender, category } = resolved;
  let best = null;
  let bestScore = -1;
  for (const rule of overrides) {
    if (!rule || typeof rule !== "object" || !rule.url) continue;
    const rMod = rule.modifier ? String(rule.modifier).toLowerCase().trim() : "";
    const rGen = rule.gender ? normalizeGenderToken(rule.gender) : "";
    const rCat = rule.category ? String(rule.category).toLowerCase().trim() : "";
    if (rMod && rMod !== (modifier || "")) continue;
    if (rGen && rGen !== (gender || "")) continue;
    if (rCat && rCat !== (category || "")) continue;
    const score = (rMod ? 1 : 0) + (rGen ? 1 : 0) + (rCat ? 1 : 0);
    if (score === 0) continue;
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Build an auto-generated storefront search CTA from conversation
 * intent. Returns { url, label } or null if there's nothing meaningful
 * to search for (and no override rule matched).
 *
 * @param {object} opts
 * @param {string} opts.pattern  - URL template with a {q} placeholder (used when no override matches)
 * @param {string} [opts.gender] - men | women | kids | mens | womens | male | female | boy | girl | …
 * @param {string} [opts.category] - dominant category (sneakers / orthotics / sandals / …)
 * @param {string} [opts.color]  - customer-mentioned color (must be in catalog)
 * @param {string} [opts.latestUserMessage] - for modifier detection (new/sale)
 * @param {string} [opts.intent] - "footwear" | "orthotic" — informational only
 * @param {Array}  [opts.overrides] - rules: [{modifier?, gender?, category?, url, label?}, ...]
 */
export function buildStorefrontSearchCTA(opts) {
  if (!opts || typeof opts !== "object") return null;
  const { pattern, gender, category, color, latestUserMessage, overrides } = opts;
  if (!gender && !category) return null; // nothing to search

  const genderToken = normalizeGenderToken(gender);
  const cat = category ? String(category).toLowerCase().trim() : "";
  const col = color ? String(color).toLowerCase().trim() : "";
  const modifier = detectModifier(latestUserMessage || "");

  // Build the human-friendly label parts up front — both the override
  // (when label is blank) and the auto-generated path want the same
  // "View All [Modifier] [Color] [Gender]'s [Category]" shape.
  const labelParts = ["View All"];
  if (modifier) labelParts.push(titleCase(modifier));
  if (col) labelParts.push(titleCase(col));
  if (genderToken) labelParts.push(`${titleCase(genderToken)}'s`);
  if (cat) labelParts.push(titleCase(cat));
  const autoLabel = labelParts.join(" ").replace(/\s+/g, " ").trim();

  // Overrides take precedence. Match against the resolved intent
  // (normalized modifier/gender/category). Custom label optional —
  // blank falls back to the auto-generated label so override rows
  // don't have to repeat the same labeling work.
  const override = matchOverride(overrides, { modifier, gender: genderToken, category: cat });
  if (override) {
    const ovrLabel = override.label && String(override.label).trim();
    return { url: String(override.url), label: ovrLabel || autoLabel };
  }

  // No override → fall back to the auto-generated search CTA.
  if (!pattern || typeof pattern !== "string") return null;
  if (!pattern.includes("{q}")) return null;

  const urlTokens = [];
  if (modifier) urlTokens.push(modifier);
  if (genderToken) urlTokens.push(genderToken);
  if (col) urlTokens.push(col);
  if (cat) urlTokens.push(cat);
  if (urlTokens.length === 0) return null;

  const q = urlTokens.map(encodeToken).join("+");
  const url = pattern.replace("{q}", q);
  return { url, label: autoLabel };
}
