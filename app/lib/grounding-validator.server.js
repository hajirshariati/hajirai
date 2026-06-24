// Grounding validator. The architectural piece neither previous
// attempt had — checks that every load-bearing claim in the model's
// reply is supported by a tool result from THIS turn. On failure,
// returns a structured error the agent loop can hand BACK to the
// model with a retry instruction ("you said X; no evidence supports
// X; rewrite"). Never silently rewrites text — that's how the old
// pipeline produced answers no one wrote.
//
// What counts as "load-bearing":
//   - Named products (bolded **Product Name**)
//   - Specific prices ($X.XX)
//   - Feature claims tied to specific products
//     ("X has BioRocker", "Y has memory foam", "Z is waterproof")
//
// What we don't check (the model's natural language style is fine):
//   - General prose, voice, greetings
//   - Generic descriptions ("comfortable", "stylish")
//   - Customer-facing closings
//
// Returns:
//   { ok: true }                                   — text is grounded
//   { ok: false, errors: [{kind, claim, ...}] }    — feed back to model

// Token-level family extractor (same as the old guard so behavior
// matches the working parts of today's pipeline).
const FAMILY_STOP_WORDS = new Set([
  "the", "a", "an", "my", "our", "new", "your",
  "men", "men's", "women", "women's", "kids", "unisex",
]);
function titleFamily(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    if (w.length > 2 && !FAMILY_STOP_WORDS.has(w)) return w;
  }
  return "";
}

// Bolded product mentions in the reply. Mirrors detectNamedProductMismatch
// in response-contract.server.js but is non-mutating — we only collect
// claims, never rewrite. Trademark/technology-name bolds are filtered
// the same way as the existing mismatch guard so we don't double-count
// "**BioRocker™ Technology**" as a product family.
function extractBoldedProductFamilies(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(/\*\*([^*]{3,80})\*\*/g) || [];
  const out = [];
  for (const m of matches) {
    const inner = m.replace(/^\*\*|\*\*$/g, "").trim();
    if (inner.length < 5 || !/[A-Z]/.test(inner)) continue;
    // Generic emphasis bolds, headings, or tech/feature labels.
    if (/^(?:yes|no|note|important|warning|tip|here|now|today|great)\b/i.test(inner)) continue;
    if (/[™®©]/.test(inner)) continue;
    // Tech/feature/section vocabulary — plural-tolerant ((?:s)?\b).
    // Live trace 2026-06-10 evening: "**Style & Materials**" burned
    // TWO retries (~25s) because "Materials" didn't match \bMaterial\b
    // (no word boundary before the plural 's') and "Style" wasn't in
    // the list at all. Section headings the model naturally writes in
    // spec answers — Style, Comfort, Fit, Sizing, Details, Specs,
    // Design, Construction, Overview, Summary, Verdict — are now
    // recognized.
    if (/\b(?:Technolog(?:y|ies)|System|Method|Approach|Feature|Series|Collection|Platform|Footbed|Midsole|Outsole|Insole|Foam|Material|Lining|Upper|Mission|HQ|Headquarters|Bottom\s+line|Style|Comfort|Fit|Sizing|Detail|Spec(?:ification)?|Design|Construction|Overview|Summar(?:y|ies)|Verdict|Pro|Con|Difference|Highlight|Takeaway|Heel\s+Height|Removable\s+Insole|Closure|Best\s+for|Vibe|Category|Price\s+Range|Weight|Cushioning)s?\b/i.test(inner)) continue;
    // Ampersand bolds are section headings ("Style & Materials",
    // "Fit & Sizing") — no product title in this catalog contains "&".
    if (inner.includes("&")) continue;
    // Brand-prefixed tech phrases ("Aetrex Signature Arch Support",
    // "Aetrex Orthotic System") are brand/technology references —
    // product titles never start with the brand name. Live trace
    // 2026-06-10: "**Aetrex Signature Arch Support**" was flagged as
    // an ungrounded product and burned a retry on a grounded answer.
    if (/^Aetrex\b/i.test(inner)) continue;
    // Feature/spec phrases the model bolds as compare/section headers
    // ("Built-in Arch Support", "Memory Foam", "Heel Cup", "Removable
    // Insole") are FEATURES, not product names. Prod trace 2026-06-24:
    // "**Built-in Arch Support**" was extracted as a product (family
    // "built") and burned 3 Sonnet retries on an otherwise-grounded
    // comparison. Match the phrase as a whole so real product titles that
    // merely contain these words (e.g. "Danika Arch Support Sneaker") still
    // extract — those have a leading name token before the feature.
    if (/^(?:built[\s-]?in\s+|with\s+|genuine\s+|true\s+)?(?:arch\s+support|memory\s+foam|heel\s+cup|metatarsal(?:\s+support|\s+pad)?|cork\s+(?:footbed|midsole)|biorocker|ultra[\s-]?sky|lynco|removable\s+insoles?|rocker[\s-]?bottom|orthotic\s+support)\b\s*$/i.test(inner)) continue;
    // Heading-style bolds end in punctuation (colon, em/en dash) —
    // "**The key difference:**", "**Quick take —**", "**Bottom line:**".
    // These are sentence headings, not product names. Live trace
    // 2026-06-10: BioRocker compare retry burned 10s because the
    // validator extracted "key" from "**The key difference:**".
    if (/[:!?—–]$/.test(inner)) continue;
    // Product names don't end with verbs/closers like "is" or "and".
    if (/\b(?:is|are|was|were|and|or|but|the|a|an)$/i.test(inner)) continue;
    // Size ranges / measurements the model bolds in fit & sizing answers
    // ("**7 US through 15 US**", "**sizes 6–11**", "**9.5 wide**") are
    // facts from variant data, NOT product names. Prod trace 2026-06-24:
    // "**7 US through 15 US**" burned 3 attempts (Haiku + 2 Sonnet) on a
    // correctly-grounded orthotic sizing answer.
    if (/\b(?:US|UK|EU|EUR)\b/.test(inner) && /\d/.test(inner)) continue;
    if (/^\s*(?:sizes?\s+)?\d+(?:\.\d+)?\s*(?:[-–—]|to|through|thru)\s*\d/i.test(inner)) continue;
    if (/\b\d+(?:\.\d+)?\s*(?:cm|mm|in(?:ch(?:es)?)?|narrow|wide|medium)\b/i.test(inner)) continue;
    // Quoted phrases the model bolds (definitions, translations, or a
    // customer quote — '**"one who has completed the Hajj"**') are not
    // product names. Prod trace 2026-06-24: a Farsi definition answer
    // burned a Sonnet retry because the bolded gloss was read as a product.
    if (/^["'“”‘’]/.test(inner) && /["'“”‘’]$/.test(inner)) continue;
    const family = titleFamily(inner);
    if (family) out.push({ phrase: inner, family });
  }
  return out;
}

// Extract dollar-figure claims with the product they're attached to.
// "Noelle is $90.97" or "Noelle Arch Support Wedge - Black - $90.97".
function extractPriceClaims(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  // Bolded product followed by price within ~80 chars, common shapes
  // the synthesizer emits.
  const re = /\*\*([^*]{3,80})\*\*[^.\n]{0,80}?\$([0-9]{1,4}(?:\.[0-9]{2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const family = titleFamily(m[1]);
    if (family) {
      out.push({ phrase: m[1].trim(), family, price: parseFloat(m[2]) });
    }
  }
  return out;
}

// Feature/material claim tied to a specific product. Patterns:
//   "Noelle has BioRocker"
//   "the Reagan has memory foam"
//   "Maui features waterproof"
const FEATURE_KEYWORDS = [
  "biorocker", "ultrasky", "ultra sky", "ultra-sky",
  "lynco", "aetrex orthotic",
  "memory foam", "cork", "leather", "mesh", "suede",
  "waterproof", "vegan", "merino", "wool",
  "arch support", "metatarsal", "heel cup",
];
function extractFeatureClaims(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const boldFamilies = extractBoldedProductFamilies(text);
  if (boldFamilies.length === 0) return out;
  const lower = text.toLowerCase();
  for (const { phrase, family } of boldFamilies) {
    // Find this product's name in lower text, then look at the next
    // ~140 chars (typical clause + sentence end) for feature words.
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx < 0) continue;
    const window = lower.slice(idx, idx + phrase.length + 140);
    for (const feature of FEATURE_KEYWORDS) {
      if (window.includes(feature)) {
        out.push({ family, productPhrase: phrase, feature });
      }
    }
  }
  return out;
}

// Check whether a card supports a feature claim. Looks at description,
// tags, attributes, and any claim-facts the engine attached. The
// existing product-claim-facts pipeline already builds verified facts —
// we just consult the same evidence.
function cardSupportsFeature(card, feature) {
  if (!card) return false;
  // Scan everything the search/lookup tools attach to a card. Live trace
  // 2026-06-10: "the Jillian has memory foam" was rejected because
  // `_description` was empty on the card (the product's spec lives in
  // a metafield/variant-attribute JSON, not in shopify's description
  // field). The model had seen the value through variantFacts and
  // attributes; the validator was looking at fewer fields than the
  // model did. Now we scan the same surfaces the tool result exposes.
  const variantFactsStr =
    typeof card._variantFacts === "object" && card._variantFacts
      ? JSON.stringify(card._variantFacts)
      : "";
  const variantsStr =
    Array.isArray(card._variants)
      ? card._variants.map((v) => JSON.stringify(v?.attributesJson || {})).join(" ")
      : "";
  const haystack = [
    card._description,
    card._descriptionSnippet,
    Array.isArray(card._tags) ? card._tags.join(" ") : "",
    typeof card._attributes === "object" ? JSON.stringify(card._attributes) : "",
    card.title,
    card._productType,
    variantFactsStr,
    variantsStr,
  ].join(" ").toLowerCase();
  if (haystack.includes(feature)) return true;
  // Also match common spelling variants without requiring per-feature
  // patching ("memory foam" ↔ "memory-foam", "memoryfoam").
  const collapsed = haystack.replace(/[-\s]+/g, "");
  const featureCollapsed = feature.replace(/[-\s]+/g, "");
  if (featureCollapsed && collapsed.includes(featureCollapsed)) return true;
  // Claim facts (provenance-tagged) — preferred evidence.
  const claimFacts = card._claimFacts || {};
  // Map feature words to fact keys the claim builder maintains.
  const featureKey = {
    "arch support": "archSupport",
    "memory foam": "memoryFoam",
    "cork": "cork",
    "leather": "leather",
    "waterproof": "waterproof",
    "vegan": "vegan",
    "mesh": "mesh",
    "suede": "suede",
    "metatarsal": "metatarsalSupport",
    "heel cup": "heelCup",
  }[feature];
  if (featureKey && claimFacts[featureKey]?.value === true) return true;
  return false;
}

// Main entry point. Inputs:
//   text   — the model's reply text
//   pool   — the product cards the model had access to this turn
//            (from search_products / lookup_sku / find_similar tool results)
// Returns:
//   { ok, errors }
//
// Errors describe what to tell the model on retry. Each error is
// self-explanatory enough that the model can fix it without seeing
// the validator's source.
// Rule-4 helper. Detect a FALSE catalog denial: the model claims we don't
// carry a GENDER+CATEGORY that the catalog actually has (prod trace
// 2026-06-24: "I couldn't find men's footwear" when men's footwear exists).
// Conservative on purpose — only GENDERED denials ("men's <cat>") are
// flagged, never bare-category denials, so honest color/size relaxation
// ("no red sandals") is never touched. "footwear"/"shoes" is an umbrella
// over any real footwear category. categoryGenderMap: { [cat]: { genders } }.
function detectFalseCatalogDenial(text, categoryGenderMap) {
  if (!text || !categoryGenderMap || typeof categoryGenderMap !== "object") return null;
  const lower = String(text).toLowerCase();
  const DENY =
    "(?:don'?t|do not|doesn'?t|does not)\\s+(?:currently\\s+)?(?:carry|have|stock|sell|offer)|" +
    "couldn'?t\\s+find|could\\s*not\\s+find|can'?t\\s+find|cannot\\s+find|no\\s+longer\\s+(?:carry|offer|stock)";
  const GENDER_TOKENS = { men: ["men's", "mens", "men"], women: ["women's", "womens", "women"] };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entries = Object.entries(categoryGenderMap).filter(
    ([k, v]) => k && k.length >= 3 && v && Array.isArray(v.genders) && v.genders.length > 0,
  );
  // Footwear umbrella: a real footwear category (not orthotics/accessories).
  const NON_FOOTWEAR = new Set(["orthotics", "orthotic", "insoles", "insole", "accessories", "accessory"]);
  const genderHasAnyFootwear = (g) =>
    entries.some(([k, v]) =>
      !NON_FOOTWEAR.has(String(k).toLowerCase()) &&
      v.genders.map((x) => String(x).toLowerCase()).some((x) => x === g || x === "unisex"),
    );

  for (const g of ["men", "women"]) {
    const toks = GENDER_TOKENS[g].map(esc).join("|");
    // Umbrella ("men's footwear" / "men's shoes") — flag if ANY footwear exists.
    const umbrellaRe = new RegExp(`\\b(?:${DENY})\\b[^.?!\\n]{0,25}?\\b(?:${toks})\\s+(?:footwear|shoes?)\\b`, "i");
    if (umbrellaRe.test(lower) && genderHasAnyFootwear(g)) {
      return { gender: g, category: "footwear" };
    }
    // Specific category ("men's <cat>") — flag if that gender genuinely has it.
    for (const [catKey, entry] of entries) {
      const supported = new Set(entry.genders.map((x) => String(x).toLowerCase()));
      if (!supported.has(g) && !supported.has("unisex")) continue;
      const c = String(catKey).toLowerCase().trim();
      const stem = c.endsWith("s") ? c.slice(0, -1) : c;
      const catAlt = [...new Set([c, stem])].map((v) => `${esc(v)}s?`).join("|");
      const re = new RegExp(`\\b(?:${DENY})\\b[^.?!\\n]{0,25}?\\b(?:${toks})\\s+(?:${catAlt})\\b`, "i");
      if (re.test(lower)) return { gender: g, category: catKey };
    }
  }
  return null;
}

// Rule-5 helpers. A FALSE color denial: the model tells the customer a
// product doesn't come in a color it actually offers ("the Jillian doesn't
// come in black" when black is a stocked variant). Customer-harm identical
// to rule 4 (lost sale + wrong answer), one level down at the variant.
//
// Conservative by construction — fires ONLY when BOTH hold:
//   (a) the model used a recognized color word inside a denial construction, and
//   (b) the matched card's own variant/colour/title evidence contains that
//       exact color (word-boundary match, so "tan" never matches "Titanium").
// An HONEST denial ("no red Jillian" when there truly is no red) finds no
// matching evidence and is never flagged. We only ever test a SPECIFIC color
// the model named, so no global color taxonomy / normalization is needed —
// keeping this module import-free (the eval harness runs without Prisma).
const COLOR_WORDS = [
  "black", "white", "navy", "blue", "red", "green", "tan", "brown", "grey", "gray",
  "pink", "purple", "beige", "ivory", "cream", "gold", "silver", "bronze", "burgundy",
  "charcoal", "khaki", "olive", "coral", "teal", "maroon", "mauve", "taupe", "camel",
  "cognac", "oat", "oatmeal", "blush", "nude", "wine", "rust", "mustard", "lavender",
  "mint", "peach", "yellow", "orange", "plum", "stone", "sand", "chestnut", "mocha",
];
const COLOR_ALT = COLOR_WORDS.join("|");
// "...doesn't come in black", "isn't available in red", "no longer made in tan".
const COLOR_DENY_IN_RE = new RegExp(
  "(?:don'?t|do not|doesn'?t|does not|isn'?t|is not|aren'?t|are not|wasn'?t|" +
  "no\\s+longer|not)\\s+(?:currently\\s+)?(?:come|comes|coming|have|has|offer|" +
  "offered|stock|stocked|carry|carried|available|made|make|sold)\\b" +
  "[^.?!\\n]{0,40}?\\bin\\s+(" + COLOR_ALT + ")\\b",
  "ig",
);
// "no black option", "no red colorway", "no white version".
const COLOR_DENY_NO_RE = new RegExp(
  "\\bno\\s+(" + COLOR_ALT + ")\\s+(?:option|version|colou?rway|colou?r|variant)\\b",
  "ig",
);

// Equivalence so "grey" denial matches "Gray" evidence (and vice versa).
function colorEquivalents(color) {
  const c = String(color).toLowerCase();
  if (c === "grey") return ["grey", "gray"];
  if (c === "gray") return ["gray", "grey"];
  return [c];
}

// The color strings a card actually offers, from the same surfaces the
// search/lookup tools attach (variant facts authoritative, then attributes,
// then title suffix + tags). Lower-cased haystack; callers word-boundary test.
function cardColorHaystack(card) {
  if (!card || typeof card !== "object") return "";
  const parts = [];
  const vf = card._variantFacts && typeof card._variantFacts === "object" ? card._variantFacts : {};
  for (const k of ["availableColors", "colors", "productAvailableColors"]) {
    if (Array.isArray(vf[k])) parts.push(vf[k].join(" "));
  }
  if (Array.isArray(vf.byColor)) parts.push(vf.byColor.map((b) => (b && b.color) || "").join(" "));
  const attr = card._attributes && typeof card._attributes === "object" ? card._attributes : {};
  for (const k of ["color", "colour", "Color", "Colour", "Color Family", "colorFamily"]) {
    const v = attr[k];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.join(" "));
  }
  parts.push(String(card.title || ""));
  if (Array.isArray(card._tags)) parts.push(card._tags.join(" "));
  return parts.join(" ").toLowerCase();
}

function cardOffersColor(card, color) {
  const hay = cardColorHaystack(card);
  if (!hay) return false;
  return colorEquivalents(color).some((c) => {
    try {
      return new RegExp(`\\b${c}\\b`, "i").test(hay);
    } catch {
      return false;
    }
  });
}

// Find false color denials. For each denial match, resolve WHICH product it's
// about: the nearest bolded product family appearing before the match (the
// product under discussion), else — when the pool holds exactly one card —
// that card. Returns [{ productPhrase, color, card }].
function detectFalseColorDenials(text, pool, poolByFamily) {
  if (!text || typeof text !== "string") return [];
  const cards = Array.isArray(pool) ? pool : [];
  if (cards.length === 0) return [];
  const bolds = extractBoldedProductFamilies(text);
  const lower = text.toLowerCase();
  // Pre-index bold family positions for "nearest bold before the denial".
  const boldPositions = bolds
    .map((b) => ({ ...b, idx: lower.indexOf(b.phrase.toLowerCase()) }))
    .filter((b) => b.idx >= 0 && poolByFamily.has(b.family))
    .sort((a, b) => a.idx - b.idx);

  const resolveCard = (matchIdx) => {
    let chosen = null;
    for (const b of boldPositions) {
      if (b.idx <= matchIdx) chosen = b;
      else break;
    }
    if (chosen) return { card: poolByFamily.get(chosen.family), phrase: chosen.phrase };
    if (cards.length === 1) return { card: cards[0], phrase: String(cards[0]?.title || "this product") };
    return null;
  };

  const out = [];
  const seen = new Set();
  for (const re of [COLOR_DENY_IN_RE, COLOR_DENY_NO_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const color = String(m[1] || "").toLowerCase();
      if (!color) continue;
      const resolved = resolveCard(m.index);
      if (!resolved || !resolved.card) continue;
      if (!cardOffersColor(resolved.card, color)) continue; // honest denial — leave it
      const key = `${titleFamily(resolved.phrase)}|${color}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ productPhrase: resolved.phrase, color, card: resolved.card });
    }
  }
  return out;
}

export function validateGrounding({ text, pool = [], categoryGenderMap = null } = {}) {
  const errors = [];
  if (!text || typeof text !== "string") return { ok: true, errors };

  const poolByFamily = new Map();
  for (const card of pool || []) {
    const family = titleFamily(card?.title || "");
    if (family && !poolByFamily.has(family)) poolByFamily.set(family, card);
  }

  // 1. Named-product grounding.
  // Every bolded product family must correspond to a card in the pool.
  // (Tech/feature bolds were already filtered by extractBoldedProductFamilies.)
  const boldFamilies = extractBoldedProductFamilies(text);
  const seenFamilies = new Set();
  for (const { phrase, family } of boldFamilies) {
    if (seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    if (!poolByFamily.has(family)) {
      errors.push({
        kind: "ungrounded_product_name",
        claim: phrase,
        message:
          `You wrote "${phrase}" as a product but no tool result this turn ` +
          `contains a product whose title starts with "${family}". ` +
          `Either remove that product mention or call a tool to surface it first.`,
      });
    }
  }

  // 2. Price grounding.
  // A quoted dollar figure attached to a named product must match the
  // card's price (within reasonable rounding).
  const priceClaims = extractPriceClaims(text);
  for (const { phrase, family, price } of priceClaims) {
    const card = poolByFamily.get(family);
    if (!card) continue; // covered by rule 1
    const cardPriceStr = String(card.price_formatted || card.price || "").replace(/[^0-9.]/g, "");
    const cardPrice = parseFloat(cardPriceStr);
    if (!isFinite(cardPrice)) continue;
    if (Math.abs(cardPrice - price) > 0.5) {
      errors.push({
        kind: "wrong_price",
        claim: `${phrase} at $${price.toFixed(2)}`,
        actual: `$${cardPrice.toFixed(2)}`,
        message:
          `You wrote "${phrase}" at $${price.toFixed(2)} but the tool result ` +
          `shows that product at $${cardPrice.toFixed(2)}. Use the tool's price.`,
      });
    }
  }

  // 3. Feature grounding.
  // A feature/material claim tied to a specific product must be
  // supported by that card's description, tags, attributes, or claim
  // facts. This is the rule that catches "Noelle has both technologies
  // built in" — Noelle's card has no BioRocker/UltraSky evidence.
  const featureClaims = extractFeatureClaims(text);
  const seenFeatureClaims = new Set();
  for (const { family, productPhrase, feature } of featureClaims) {
    const key = `${family}|${feature}`;
    if (seenFeatureClaims.has(key)) continue;
    seenFeatureClaims.add(key);
    const card = poolByFamily.get(family);
    if (!card) continue; // already errored under rule 1
    if (!cardSupportsFeature(card, feature)) {
      errors.push({
        kind: "unsupported_feature_claim",
        claim: `${productPhrase} has ${feature}`,
        message:
          `You wrote that "${productPhrase}" has ${feature}, but the tool result ` +
          `for that product has no evidence of ${feature} (not in description, ` +
          `tags, attributes, or claim facts). Either drop that feature claim, ` +
          `pick a different product whose facts support it, or be honest that ` +
          `you're not certain.`,
      });
    }
  }

  // 4. False catalog denial. The model denied carrying a gender+category the
  // catalog actually has — reject so it corrects itself instead of misleading
  // the customer (and the response-contract having to silently rewrite it).
  if (categoryGenderMap) {
    const denial = detectFalseCatalogDenial(text, categoryGenderMap);
    if (denial) {
      const label = `${denial.gender === "men" ? "men's" : "women's"} ${String(denial.category).toLowerCase()}`;
      errors.push({
        kind: "false_catalog_denial",
        claim: `we don't carry ${label}`,
        message:
          `You wrote that we don't carry ${label}, but the catalog DOES carry ` +
          `${label}. Don't deny a category we stock. If a specific attribute ` +
          `(a color, size, or width) wasn't available, name THAT honestly — but ` +
          `present the ${label} we do have.`,
      });
    }
  }

  // 5. False color denial. The model told the customer a product doesn't
  // come in a color it actually offers — reject so it corrects itself
  // instead of suppressing a stocked variant (and costing a sale). Checked
  // against the card's own variant/colour evidence; honest denials of
  // genuinely-absent colors find no evidence and never fire.
  const colorDenials = detectFalseColorDenials(text, pool, poolByFamily);
  for (const { productPhrase, color } of colorDenials) {
    errors.push({
      kind: "false_color_denial",
      claim: `${productPhrase} doesn't come in ${color}`,
      message:
        `You wrote that "${productPhrase}" doesn't come in ${color}, but that ` +
        `product's own variant data lists ${color} as an available color. Don't ` +
        `deny a color we stock — present the ${color} option. If a different ` +
        `attribute (a size or width) was unavailable, name THAT honestly instead.`,
    });
  }

  return { ok: errors.length === 0, errors };
}

// Build the retry instruction text the agent loop hands back to the
// model when validation fails. Phrased as a clear correction request,
// not a rebuke — the model needs the facts to fix its answer.
//
// previousText: the failed draft. Included because runAgenticLoop does
// not return its internal messages array, so the retry conversation
// would otherwise reference "your previous reply" the model can't see.
export function buildRetryInstruction(errors = [], previousText = "") {
  if (!errors || errors.length === 0) return "";
  const lines = errors.slice(0, 4).map((e, i) => `${i + 1}. ${e.message}`);
  const draftBlock = previousText
    ? [
        "Your previous draft (never shown to the customer):",
        '"""',
        String(previousText).slice(0, 1500),
        '"""',
        "",
      ]
    : [];
  return [
    ...draftBlock,
    "That draft has factual issues that need correcting before it can go to the customer:",
    ...lines,
    "",
    "Rewrite the reply. If the only honest answer is that you can't verify the requested claim, say that plainly — that's a correct answer, not a failure.",
  ].join("\n");
}

// Test-only exports (named for clarity in eval files).
export const __TEST__ = {
  titleFamily,
  extractBoldedProductFamilies,
  extractPriceClaims,
  extractFeatureClaims,
  cardSupportsFeature,
  detectFalseCatalogDenial,
  detectFalseColorDenials,
  cardOffersColor,
};
