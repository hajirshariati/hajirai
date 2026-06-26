// Availability Truth — deterministic answer for workflow=availability.
//
// Exact availability questions ("Do you have the Jillian in black size 8?")
// must be answered from PRODUCT/VARIANT truth, not a generic semantic search.
// This module classifies a family + color/size/width request against the real
// variant inventory and produces one of four results plus the customer-facing
// answer text. It is PURE (imports only the pure variant-matcher) — the chat
// route fetches the family's products (with variants) from the DB and passes
// them in, so this whole module is unit-testable with fixtures.
//
// Results:
//   AVAILABLE   — product + requested color + size/width exists and is in stock
//   UNAVAILABLE — product exists, but the requested combo is known NOT available
//   UNKNOWN     — product exists, but variant inventory isn't exposed to verify
//   NOT_FOUND   — the named family/product isn't in the catalog

// Variant normalization/inventory helpers are INLINED (kept in lockstep with
// variant-matcher.server.js) so this module has ZERO imports — that keeps it a
// clean, directly-importable server module (like turn-plan.server.js) and
// fully unit-testable with fixtures.
function safeParseOpts(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function readBagCI(bag, key) {
  if (!bag || typeof bag !== "object") return undefined;
  const target = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  for (const [k, v] of Object.entries(bag)) {
    const norm = String(k).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (norm === target) return v;
  }
  return undefined;
}
function readVariantOption(variant, key) {
  const fromOptions = readBagCI(safeParseOpts(variant?.optionsJson), key);
  if (fromOptions != null && fromOptions !== "") return fromOptions;
  return readBagCI(safeParseOpts(variant?.attributesJson), key);
}
function normalizeVariantSize(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^size\s+/i, "").replace(/\s*½/g, ".5").replace(/\s+1\/2/g, ".5");
  const m = s.match(/^(\d{1,2}(?:\.\d)?)\s*[wnm](?:\b|$)/i);
  if (m) return m[1];
  s = s.replace(/\s*(wide|narrow|medium|regular|standard)\s*$/i, "").trim();
  if (/^\d{1,2}(?:\.\d)?$/.test(s)) return s;
  return s || null;
}
function normalizeVariantWidth(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  const combo = s.match(/^\d{1,2}(?:\.\d)?\s*([wnm])\b/i);
  if (combo) { const w = combo[1].toLowerCase(); return w === "w" ? "wide" : w === "n" ? "narrow" : "medium"; }
  if (/\b(extra[-\s]?wide|xw|wide|w)\b/.test(s) && !/medium/.test(s)) return "wide";
  if (/\b(narrow|slim|n)\b/.test(s)) return "narrow";
  if (/\b(medium|regular|standard|m|b)\b/.test(s)) return "medium";
  return null;
}
function variantIsAvailable(variant) {
  const q = variant?.inventoryQty;
  if (q == null) return true; // untracked → treated as available
  return Number(q) > 0;
}
function inStockSizes(product, { width = null } = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const wantedWidth = normalizeVariantWidth(width);
  const out = new Set();
  for (const v of variants) {
    if (!variantIsAvailable(v)) continue;
    if (wantedWidth) {
      const vWidth = normalizeVariantWidth(readVariantOption(v, "Width")) || normalizeVariantWidth(readVariantOption(v, "Fit"));
      if (vWidth && vWidth !== wantedWidth) continue;
    }
    const s = normalizeVariantSize(readVariantOption(v, "Size"));
    if (s) out.add(s);
  }
  return Array.from(out);
}
function inStockWidths(product, { size = null } = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const wantedSize = normalizeVariantSize(size);
  const out = new Set();
  for (const v of variants) {
    if (!variantIsAvailable(v)) continue;
    if (wantedSize) {
      const vSize = normalizeVariantSize(readVariantOption(v, "Size"));
      if (vSize !== wantedSize) continue;
    }
    const w = normalizeVariantWidth(readVariantOption(v, "Width")) || normalizeVariantWidth(readVariantOption(v, "Fit"));
    if (w) out.add(w);
  }
  return Array.from(out);
}
function isSizeAvailable(product, size, { width = null } = {}) {
  const canonicalSize = normalizeVariantSize(size);
  if (!canonicalSize) return false;
  return inStockSizes(product, { width }).includes(canonicalSize);
}

export const AVAILABILITY_RESULT = {
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
  NOT_FOUND: "NOT_FOUND",
};

// Minimal family token (kept consistent with titleStyleFamily): the first
// meaningful word before a " - color" suffix. Inlined so this module stays
// prisma-free and the eval runs in any repo.
const FAMILY_STOPWORDS = new Set([
  "the", "aetrex", "womens", "women", "mens", "men", "kids", "unisex",
  "new", "classic", "comfort", "premium", "pro",
]);
export function familyOfTitle(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w.length > 2 && !FAMILY_STOPWORDS.has(w)) return w;
  }
  return "";
}

// Resolve the availability REQUEST from current-turn signals only. Constraints
// come from the LATEST message (passed in pre-extracted); a deictic / "what
// about" follow-up inherits the family — and unstated color — from the
// anchored focus product. Stale session memory is NEVER consulted, so a prior
// Disney/sneakers or black/under-$100 turn can't leak in.
export function resolveAvailabilityRequest({ namedFamilies = [], latestConstraints = {}, focusProduct = null, isFollowUp = false } = {}) {
  let family = (namedFamilies && namedFamilies[0]) || null;
  let color = latestConstraints.color || null;
  const size = latestConstraints.size || null;
  let width = latestConstraints.width || null;
  if (focusProduct && isFollowUp) {
    const focusFam = familyOfTitle(focusProduct.title || "");
    if (!family && focusFam) family = focusFam;
    if (family && family === focusFam) {
      const focusColor = String(focusProduct.title || "").split(/\s[-–—]\s/).slice(1).join(" ").trim().toLowerCase();
      if (!color && focusColor) color = focusColor;
    }
  }
  return { family, color, size, width };
}

const FOLLOWUP_RE = /\b(this one|that one|these|those|\bit\b|\bthis\b|\bthat\b|what\s+about|how\s+about)\b/i;
export function isAvailabilityFollowUp(message) {
  return FOLLOWUP_RE.test(String(message || ""));
}

function parseBag(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}
function variantColor(v) {
  for (const bag of [parseBag(v?.optionsJson), parseBag(v?.attributesJson)]) {
    for (const [k, val] of Object.entries(bag)) {
      if (/colou?r/i.test(k) && val) return String(val).toLowerCase().trim();
    }
  }
  return "";
}
function productColors(product) {
  const set = new Set();
  const dash = String(product?.title || "").split(/\s[-–—]\s/);
  if (dash.length > 1) set.add(dash[dash.length - 1].trim().toLowerCase());
  for (const v of product?.variants || []) {
    const c = variantColor(v);
    if (c) set.add(c);
  }
  return set;
}
function productMatchesColor(product, color) {
  if (!color) return true;
  const want = String(color).toLowerCase().trim();
  for (const c of productColors(product)) {
    if (c === want || c.includes(want) || want.includes(c)) return true;
  }
  return String(product?.title || "").toLowerCase().includes(want);
}
function productHasInStockVariant(product) {
  return (product?.variants || []).some((v) => {
    const q = v?.inventoryQty;
    return q == null || Number(q) > 0;
  });
}

// Classify availability for a single family request. `products` is the set of
// catalog products (any family) — we filter to the named family ourselves so
// the caller can pass a broad fetch.
export function classifyAvailability({ products = [], family = "", color = null, size = null, width = null } = {}) {
  const fam = String(family || "").toLowerCase();
  const reqColor = color ? String(color).toLowerCase().trim() : null;
  const sz = normalizeVariantSize(size);
  const wd = normalizeVariantWidth(width);

  const famProducts = (products || []).filter((p) => familyOfTitle(p?.title || "") === fam);
  if (famProducts.length === 0) {
    return { result: AVAILABILITY_RESULT.NOT_FOUND, product: null, family: fam, color: reqColor, size: sz, width: wd, reason: "family_not_found" };
  }

  // Color filter — the family exists; is the requested color carried?
  let candidates = famProducts;
  if (reqColor) {
    const colorMatched = famProducts.filter((p) => productMatchesColor(p, reqColor));
    if (colorMatched.length === 0) {
      return { result: AVAILABILITY_RESULT.UNAVAILABLE, product: famProducts[0], family: fam, color: reqColor, size: sz, width: wd, reason: "color_not_carried" };
    }
    candidates = colorMatched;
  }

  // Color/family only (no size/width) — is any candidate in stock?
  if (!sz && !wd) {
    const available = candidates.some(productHasInStockVariant);
    return {
      result: available ? AVAILABILITY_RESULT.AVAILABLE : AVAILABILITY_RESULT.UNAVAILABLE,
      product: candidates[0], family: fam, color: reqColor, size: sz, width: wd,
      reason: available ? null : "out_of_stock",
    };
  }

  // Size/width — find a satisfying in-stock variant across the candidates.
  for (const p of candidates) {
    const okSize = sz ? isSizeAvailable(p, sz, { width: wd }) : true;
    const okWidth = wd && !sz ? inStockWidths(p).includes(wd) : true;
    if (okSize && okWidth) {
      return { result: AVAILABILITY_RESULT.AVAILABLE, product: p, family: fam, color: reqColor, size: sz, width: wd, reason: null };
    }
  }
  // Not found in stock. UNKNOWN when NO variant inventory is exposed at all
  // (untracked / unsynced) — we genuinely can't verify; UNAVAILABLE when the
  // product DOES expose sizes/widths but the requested combo isn't among them.
  const anyVariantData = candidates.some((p) => inStockSizes(p).length > 0 || inStockWidths(p).length > 0);
  const product = candidates[0];
  if (!anyVariantData) {
    return { result: AVAILABILITY_RESULT.UNKNOWN, product, family: fam, color: reqColor, size: sz, width: wd, reason: "no_variant_inventory" };
  }
  return { result: AVAILABILITY_RESULT.UNAVAILABLE, product, family: fam, color: reqColor, size: sz, width: wd, reason: "variant_not_carried" };
}

function titleCase(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
function familyName(verdict) {
  // Prefer the real product's family token, title-cased ("jillian" → "Jillian").
  return titleCase(verdict?.family || familyOfTitle(verdict?.product?.title || "") || "");
}
function comboPhrase({ color, size, width }) {
  const parts = [];
  if (color) parts.push(titleCase(color));
  if (size) parts.push(`size ${size}`);
  if (width) parts.push(`${width} width`);
  return parts.join(", ");
}
function sizeWidthPhrase({ size, width }) {
  const parts = [];
  if (size) parts.push(`size ${size}`);
  if (width) parts.push(width);
  return parts.join(" ") || "that exact option";
}

// Customer-facing answer text per the availability contract. No "take a look",
// no "tell me more", no alternatives.
export function buildAvailabilityAnswer(verdict) {
  const name = familyName(verdict);
  const combo = comboPhrase(verdict);
  switch (verdict.result) {
    case AVAILABILITY_RESULT.AVAILABLE:
      return `Yes — the ${name} is available${combo ? ` in ${combo}` : ""}.`;
    case AVAILABILITY_RESULT.UNAVAILABLE:
      return `I'm not seeing the ${name} available${combo ? ` in ${combo}` : ""} right now.`;
    case AVAILABILITY_RESULT.UNKNOWN:
      return (
        `I can find the ${name}${verdict.color ? ` in ${titleCase(verdict.color)}` : ""}, ` +
        `but I can't verify ${sizeWidthPhrase(verdict)} from the data I have here. ` +
        `Open the product page to confirm current size availability.`
      );
    case AVAILABILITY_RESULT.NOT_FOUND:
    default:
      return `I'm not finding that exact ${name || "product"} style in the catalog right now.`;
  }
}
