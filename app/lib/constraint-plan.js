// ConstraintPlan / EvidencePlan — the structured layer between TurnPlan and
// search. A complex shopper request ("one sandal, one sneaker, and one slipper
// for heel pain", "can I put orthotics in the Jillian?") should NOT be flattened
// into one workflow + one broad query. This module decomposes the LATEST message
// into slots/constraints deterministically; chat.jsx then searches each slot and
// hands the selected evidence to the LLM for concise answer writing.
//
// PURE (no DB, no imports) so it's unit-testable and client-safe. The catalog
// resolver supplies namedFamilies / catalogCategories; this module never invents
// a product family from a category noun.

// ── Category nouns. These are CATEGORIES, never product families. ──────
// (Requirement: sandal(s), sneaker(s), slipper(s), boot(s), wedge(s), loafer(s),
// orthotic(s), shoe(s) — plus the rest of the Aetrex category vocabulary.)
const CATEGORY_NOUNS = {
  sandal: "sandals", sandals: "sandals",
  sneaker: "sneakers", sneakers: "sneakers",
  slipper: "slippers", slippers: "slippers",
  boot: "boots", boots: "boots", bootie: "boots", booties: "boots",
  wedge: "wedges", wedges: "wedges",
  loafer: "loafers", loafers: "loafers",
  orthotic: "orthotics", orthotics: "orthotics", insole: "orthotics", insoles: "orthotics",
  shoe: "shoes", shoes: "shoes", footwear: "shoes",
  clog: "clogs", clogs: "clogs",
  oxford: "oxfords", oxfords: "oxfords",
  mule: "mules", mules: "mules",
  flat: "flats", flats: "flats",
  slide: "slides", slides: "slides",
  heel: "heels", heels: "heels",
  slipon: "slip ons", "slip-on": "slip ons", "slip ons": "slip ons",
  "mary jane": "mary janes", "mary janes": "mary janes",
};
export const CATEGORY_NOUN_SET = new Set(Object.keys(CATEGORY_NOUNS));

// Order matters for display/slots — keep the order the customer listed them.
// "heel pain" / "heel spur" and "flat feet" are CONDITIONS, not the Heels/Flats
// categories — negative lookaheads keep them out of category detection.
const CATEGORY_NOUN_RE = new RegExp(
  "\\b(mary\\s+janes?|slip[-\\s]?ons?|sandals?|sneakers?|slippers?|booties?|boots?|wedges?|loafers?|orthotics?|insoles?|clogs?|oxfords?|mules?|slides?|footwear|shoes?|heels?(?!\\s*(?:pain|spur))|flats?(?!\\s*(?:feet|foot)))\\b",
  "ig",
);
function canonicalCategory(raw) {
  const k = String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (CATEGORY_NOUNS[k]) return CATEGORY_NOUNS[k];
  // singularize a trailing s as a fallback
  const sing = k.replace(/s$/, "");
  return CATEGORY_NOUNS[sing] || CATEGORY_NOUNS[k] || k;
}

// Distinct categories in the order the customer mentioned them.
export function detectCategoryNouns(message) {
  const m = String(message || "");
  const out = [];
  const seen = new Set();
  let mm;
  CATEGORY_NOUN_RE.lastIndex = 0;
  while ((mm = CATEGORY_NOUN_RE.exec(m)) !== null) {
    const cat = canonicalCategory(mm[1]);
    if (cat && !seen.has(cat)) { seen.add(cat); out.push(cat); }
  }
  return out;
}

// ── Conditions / use-cases (kept in lockstep with turn-plan) ───────────
const CONDITION_RE =
  /\b(plantar|fasciitis|bunion|bunions|neuroma|metatarsal|metatarsalgia|overpronat\w*|supinat\w*|sesamoid|capsulitis|fallen\s+arch\w*|flat\s+feet|high\s+arch\w*|heel\s+(?:pain|spur)|arch\s+pain|achilles|neuropathy|diabetic|foot\s+pain|ball\s+of\s+foot)\b/i;
const USECASE_RE =
  /\b(walking|standing|all[-\s]?day|on\s+my\s+feet|vacation|travel|trip|hiking|running|gym|workout|wedding|work|nurse|nursing|teacher|tourism|sightseeing|theme\s+park|disney|cruise)\b/i;
const SUPPORT_RE =
  /\b(supportive|support|arch\s*support|cushion(?:ed|ing)?|stability|orthopedic|comfort(?:able)?)\b/i;

function allMatches(re, m) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let mm;
  while ((mm = g.exec(m)) !== null) { out.push(mm[0].toLowerCase().replace(/\s+/g, " ").trim()); if (mm.index === g.lastIndex) g.lastIndex++; }
  return Array.from(new Set(out));
}

// ── Orthotic-compatibility detection ───────────────────────────────────
// "Can I put orthotics inside the Jillian sandal?" — a question about whether an
// orthotic/insole fits INSIDE a shoe. Requires the insert noun AND a containment
// relationship (put/fit/use/wear … in/inside/into/with). Mentioning orthotics in
// a SHOPPING ask ("I need orthotics and sandals") is NOT compatibility.
const INSERT_NOUN_RE = /\b(orthotics?|insoles?|inserts?|footbeds?|arch\s+support\s+inserts?)\b/i;
const CONTAIN_REL_RE = /\b(put|place[ds]?|placing|fit[s]?|insert|use|wear|go(?:es)?|slip|add|stick|combine|pair)\b[^.?!\n]{0,40}\b(in|into|inside|within|with)\b/i;
const COMPAT_QWORD_RE = /\b(can|could|will|would|do|does|is\s+it\s+possible|are\s+(?:they|these)\s+compatible|work\s+with|fit\s+(?:in|inside))\b/i;
export function isCompatibilityAsk(message) {
  const m = String(message || "");
  if (!INSERT_NOUN_RE.test(m)) return false;
  return CONTAIN_REL_RE.test(m) || /\bfit\s+(?:in|inside|into)\b/i.test(m) || (COMPAT_QWORD_RE.test(m) && /\b(in|inside|into|with)\b/i.test(m));
}

// ── Multi-recommendation detection ─────────────────────────────────────
// Two or more DISTINCT categories ENUMERATED in one ask ("one sandal, one
// sneaker, and one slipper for heel pain", "orthotics AND supportive sandals").
// An adjacent compound ("slip-on sneakers", "wedge sandals") is ONE category,
// not two — so we require an explicit enumeration connector between the
// categories, plus a recommend/condition framing.
const RECO_FRAME_RE = /\b(give\s+me|show\s+me|recommend|suggest|i\s+(?:need|want)|looking\s+for|what\s+should|pick|find\s+me|best)\b/i;
const CAT_ALT = "mary\\s+janes?|slip[-\\s]?ons?|sandals?|sneakers?|slippers?|booties?|boots?|wedges?|loafers?|orthotics?|insoles?|clogs?|oxfords?|mules?|slides?|shoes?|heels?(?!\\s*(?:pain|spur))|flats?(?!\\s*(?:feet|foot))";
const ONE_CAT_RE = new RegExp(`\\b(?:one|a|an)\\s+(?:\\w+\\s+){0,2}?(?:${CAT_ALT})\\b`, "ig");
const SEP_CATS_RE = new RegExp(`\\b(${CAT_ALT})\\b[^.?!\\n]{0,25}?\\b(?:and|or|plus|&)\\b[^.?!\\n]{0,25}?\\b(${CAT_ALT})\\b`, "i");
export function isMultiRecommendationAsk(message) {
  const m = String(message || "");
  const cats = detectCategoryNouns(m);
  if (cats.length < 2) return false;
  const oneEnum = (m.match(ONE_CAT_RE) || []).length;
  const sep = SEP_CATS_RE.test(m);
  // Distinct categories separated by an enumeration connector (and/or/plus/&)
  // OR two-plus "one X" enumerations — an adjacent compound never qualifies.
  const enumerated = oneEnum >= 2 || (sep && (() => {
    const mm = m.match(SEP_CATS_RE);
    return mm && canonicalCategory(mm[1]) !== canonicalCategory(mm[2]);
  })());
  if (!enumerated) return false;
  return oneEnum >= 2 || RECO_FRAME_RE.test(m) || CONDITION_RE.test(m) || USECASE_RE.test(m);
}

// ── Constraints (color / size / width / priceMax / gender) ─────────────
const COLOR_RE = /\b(black|white|ivory|cream|navy|blue|red|burgundy|wine|maroon|pink|blush|rose|fuchsia|coral|green|olive|sage|tan|beige|nude|taupe|khaki|brown|chocolate|cognac|camel|bronze|copper|gold|silver|pewter|grey|gray|charcoal|slate|champagne|mauve|lavender|purple|plum|yellow|mustard|orange)\b/i;
function parseConstraints(message) {
  const m = String(message || "");
  const out = { color: null, size: null, width: null, priceMax: null, gender: null };
  const c = m.match(COLOR_RE); if (c) out.color = c[1].toLowerCase();
  const size = m.match(/\bsize\s+(\d{1,2}(?:\.5)?)\b/i) || m.match(/\b(?:in|a|an)\s+(?:a\s+)?(\d{1,2}(?:\.5)?)\b/i);
  if (size) { const n = parseFloat(size[1]); if (n >= 4 && n <= 14) out.size = size[1]; }
  if (/\b(extra[-\s]?wide|x-?wide|xw)\b/i.test(m)) out.width = "wide";
  else if (/\bwide\b/i.test(m)) out.width = "wide";
  else if (/\bnarrow\b/i.test(m)) out.width = "narrow";
  const price = m.match(/\b(?:under|below|less\s+than|up\s+to|max(?:imum)?)\s+\$?\s*(\d{2,4})\b/i);
  if (price) out.priceMax = Number(price[1]);
  // gender — kids is explicit and must NEVER silently fall back to adult lines.
  if (/\b(kid|kids|child|children|toddler|youth|boys?|girls?)\b/i.test(m)) out.gender = "kids";
  else if (/\b(men'?s?|man|male|him|his|husband|dad|father|son|guy)\b/i.test(m)) out.gender = "men";
  else if (/\b(women'?s?|woman|female|her|wife|mom|mother|daughter|lady|ladies)\b/i.test(m)) out.gender = "women";
  return out;
}

// Build a clean per-slot search query: support adjective + condition/use-case +
// category — never the raw sentence.
function slotQuery(category, { conditions, useCases, support }) {
  const cond = conditions[0] || useCases[0] || "";
  const parts = [support ? "supportive" : "", cond, category].filter(Boolean);
  return parts.join(" ").trim() || category;
}

// ── Slot ↔ card category guard ─────────────────────────────────────────
// A multi_recommendation slot search ("supportive foot pain shoes") can return
// an off-category product first (the scorer surfaced an insole). The slot's
// selected card MUST match the slot category before it can be pinned — otherwise
// the "shoes" slot ships an orthotic and the carousel contradicts the answer
// (live trace 2026-06-30: shoes slot picked l1300u-m / Thinsoles).
const ORTHOTIC_TITLE_RE = /\b(orthotic|orthotics|insole|insoles|inserts?|footbed|footbeds|thinsole|thinsoles|arch\s*support\s*insert)\b/i;
const ACCESSORY_TITLE_RE = /\b(roller|sock|socks|shoe\s*lace|laces|cleaner|spray|freshener|brush|shoe\s*horn|deodor\w*|protector|kit)\b/i;
const SLOT_FOOTWEAR_RE = {
  sandals: /\b(sandal|sandals|slide|slides)\b/i,
  sneakers: /\b(sneaker|sneakers|trainer|trainers)\b/i,
  slippers: /\b(slipper|slippers)\b/i,
  boots: /\b(boot|boots|bootie|booties)\b/i,
  wedges: /\b(wedge|wedges)\b/i,
  loafers: /\b(loafer|loafers)\b/i,
  clogs: /\b(clog|clogs)\b/i,
  oxfords: /\b(oxford|oxfords)\b/i,
  mules: /\b(mule|mules)\b/i,
  flats: /\b(flat|flats|ballet)\b/i,
  heels: /\b(heel|heels|pump|pumps)\b/i,
  slides: /\b(slide|slides)\b/i,
};
function cardCategoryText(card) {
  return [card?.title, card?.product_title, card?.category, card?.product_type, card?.productType, card?.type]
    .filter(Boolean).join(" ");
}
// The category VALUE a slot search must filter on. The umbrella "shoes"/
// "footwear" is NOT a catalog category value — products carry
// productType="Footwear" plus a narrow category (Sandals/Sneakers/…). Filtering
// on category="shoes" matches nothing by productType, so a condition-heavy slot
// query ("supportive foot pain shoes") surfaces orthotics, which the slot guard
// then rejects — leaving the slot EMPTY (live trace 2026-06-29: "shoes or
// orthotics" showed only an orthotic). Map the umbrella to "footwear" (the
// productType real footwear shares); every other category passes through.
export function slotSearchCategory(slotCategory) {
  const c = String(slotCategory || "").toLowerCase().trim();
  if (c === "shoes" || c === "footwear") return "footwear";
  return slotCategory;
}

export function cardMatchesSlotCategory(card, slotCategory) {
  const text = cardCategoryText(card);
  const cat = String(slotCategory || "").toLowerCase().trim();
  if (!text) return true;           // can't classify → don't over-filter
  const isOrthotic = ORTHOTIC_TITLE_RE.test(text);
  if (cat === "orthotics") return isOrthotic;            // orthotics slot ⟹ only orthotic/insole
  // Any footwear slot (umbrella "shoes" or a specific category) must NOT ship an
  // orthotic/insole/accessory.
  if (isOrthotic || ACCESSORY_TITLE_RE.test(text)) return false;
  if (cat === "shoes" || cat === "footwear" || !cat) return true; // umbrella ⟹ any real footwear
  const re = SLOT_FOOTWEAR_RE[cat];
  return re ? re.test(text) : true; // unknown specific category → don't block
}

// INVARIANT: a multi_recommendation answer that PROMISES both footwear and
// orthotics must actually show at least one of each. Returns true on mismatch
// (promised both, but the cards are not one-of-each) so the caller can either
// correct the text or log a violation. Never promise both while showing one.
const PROMISES_BOTH_RE =
  /\b(both|one\s+of\s+each|best\s+of\s+each|shoes?\s+and\s+(?:an?\s+)?(?:orthotic|insole)|(?:orthotic|insole)s?\s+and\s+(?:an?\s+)?shoe)\b/i;
export function multiRecoTextCardMismatch({ text = "", cards = [] } = {}) {
  if (!PROMISES_BOTH_RE.test(String(text || ""))) return false;
  let hasFootwear = false, hasOrthotic = false;
  for (const c of cards || []) {
    if (cardMatchesSlotCategory(c, "orthotics")) hasOrthotic = true;
    else if (cardMatchesSlotCategory(c, "shoes")) hasFootwear = true;
  }
  return !(hasFootwear && hasOrthotic);
}

// ── The plan ───────────────────────────────────────────────────────────
// askType ∈ compatibility | multi_recommendation | condition_recommendation |
//           browse | other
export function extractConstraintPlan({ message = "", catalogCategories = [], namedFamilies = [] } = {}) {
  const m = String(message || "");
  const categories = detectCategoryNouns(m);
  const conditions = allMatches(CONDITION_RE, m);
  const useCases = allMatches(USECASE_RE, m);
  const support = SUPPORT_RE.test(m) || conditions.length > 0;
  const constraints = parseConstraints(m);

  // Product families: ONLY real catalog families the caller resolved, with any
  // category noun defensively stripped (a category is never a family).
  const productFamilies = (Array.isArray(namedFamilies) ? namedFamilies : [])
    .map((f) => String(f || "").toLowerCase().trim())
    .filter((f) => f && !CATEGORY_NOUN_SET.has(f));

  let askType;
  if (isCompatibilityAsk(m)) askType = "compatibility";
  else if (categories.length >= 2 && isMultiRecommendationAsk(m)) askType = "multi_recommendation";
  else if (conditions.length > 0 || useCases.length > 0) askType = "condition_recommendation";
  else if (categories.length > 0 || constraints.color || constraints.priceMax || productFamilies.length > 0) askType = "browse";
  else askType = "other";

  // Slots: one per category for a multi-recommendation; otherwise a single slot
  // (the dominant category, or whatever the customer constrained).
  let slots = [];
  if (askType === "multi_recommendation") {
    slots = categories.map((category) => ({
      category,
      query: slotQuery(category, { conditions, useCases, support }),
      limit: 1,
      constraints: { ...constraints },
    }));
  } else if (askType === "condition_recommendation" || askType === "browse") {
    const category = categories[0] || null;
    slots = [{
      category,
      query: slotQuery(category || "shoes", { conditions, useCases, support }),
      limit: 6,
      constraints: { ...constraints },
    }];
  }

  return {
    askType,
    productFamilies,
    categories,
    conditions,
    useCases,
    support,
    constraints,
    slots,
  };
}
