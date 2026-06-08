// Canonical catalog-query evidence helpers.
//
// Product concepts such as materials, technologies, construction details,
// and merchant-defined attributes must not depend on a code vocabulary.
// These helpers preserve the customer's concrete catalog requirement and
// verify it against the same searchable evidence everywhere.

const REQUEST_WORDS = new Set([
  "a", "an", "and", "any", "anything", "are", "best", "besides", "but", "can", "carry",
  "could", "do", "does", "find", "for", "from", "give", "has", "have",
  "hello", "hey", "hi", "i", "in", "is", "it", "like", "looking", "made", "me", "my", "need",
  "of", "on", "or", "other", "please", "recommend", "show", "some",
  "something", "that", "the", "these", "this", "those", "to", "use",
  "uses", "using", "try", "want", "what", "which", "with", "you", "your",
  "cheap", "cheaper", "budget", "affordable", "good", "great", "top",
  "except", "excluding", "instead", "without",
]);

const GENERIC_CATALOG_WORDS = new Set([
  "item", "items", "product", "products", "shoe", "shoes", "style", "styles",
  "footwear", "option", "options", "feature", "features", "featuring",
  "technology", "technologies", "material", "materials",
  "color", "colors",
]);

// These are conversational preferences, not objective catalog facts.
// Keep them in semantic retrieval, but never turn them into a hard
// evidence requirement that can erase otherwise useful results.
const SUBJECTIVE_PREFERENCE_WORDS = new Set([
  "attractive", "beautiful", "better", "casual", "comfy", "comfortable",
  "cool", "cute", "dressy", "elegant", "fashionable", "favorite", "formal",
  "lovely", "modern", "nice", "popular", "pretty", "professional", "stylish",
  "supportive", "trendy",
  // Meta-query words — "highest review", "best rated", "most returns",
  // "lowest price" are questions about ORDERING or AGGREGATES across
  // the result set, not features that should appear in a single
  // product's description. Treating them as catalog requirements
  // empties the pool ("I couldn't find sneakers that list 'highest
  // review' as a feature") which is exactly the wrong answer.
  "highest", "lowest", "best", "worst", "most", "least", "top", "bottom",
  "review", "reviews", "rating", "ratings", "rated", "reviewed",
  "star", "stars", "score", "scored",
  "return", "returns", "returned", "refund", "refunds",
  "price", "priced", "cheap", "cheapest", "expensive", "affordable",
]);

const ANAPHORA_RE =
  /\b(?:this|that|same|such)\s+(?:technology|material|feature|construction|fabric|foam|support|one|kind)\b|\b(?:with|using|featuring)\s+it\b/i;

const CONSTRUCTION_CONNECTOR_RE =
  /\b(?:made\s+(?:of|from|with)|built\s+with|uses?|using|features?|featuring|contains?|containing)\s+([^?.,;—]+)/gi;

const DEFINITION_RE =
  /^\s*(?:what|which)\s+(?:is|are)\s+(.+?)(?:\?|$)|^\s*(?:tell\s+me\s+about|explain)\s+(.+?)(?:\?|$)/i;

// Comparisons and named-anchor similarity requests need relational
// reasoning, not a literal evidence hard filter for the words between
// the product noun and "as X". Those turns are handled by the similar/
// compare paths.
const RELATIONAL_QUERY_RE =
  /\b(?:same\s+(?:support|cushioning|fit|feel|style|features?)\s+as|similar\s+to|compare\b|comparison\b|difference\s+between|which\s+of\s+(?:these|those|them)|\bvs\.?\b|\bversus\b)\b/i;

const PREFIX_BLOCKERS = new Set([
  "about", "after", "all", "any", "at", "besides", "except", "excluding",
  "for", "from", "into", "like", "more", "my", "of", "other", "some",
  "than", "the", "their", "these", "this", "those", "to", "your",
]);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valuesFrom(value, out = [], depth = 0) {
  if (value == null || depth > 4) return out;
  if (Array.isArray(value)) {
    for (const entry of value) valuesFrom(entry, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) valuesFrom(entry, out, depth + 1);
    return out;
  }
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) out.push(text);
  }
  return out;
}

export function normalizeCatalogText(value) {
  return String(value || "")
    // Remove presentation marks before Unicode normalization. NFKD expands
    // the trademark symbol into the literal letters "TM"; without this,
    // "BioRocker™" becomes "bio rockertm" and no longer matches the
    // customer's "BioRocker" requirement.
    .replace(/[\u00a9\u00ae\u2120\u2122]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCatalogSearchDocument(product = {}) {
  const sourceValues = {
    title: valuesFrom([product.title, product.productTitle, product.handle, product.productHandle]),
    description: valuesFrom([
      product.description,
      product.productDescription,
      product.descriptionSnippet,
      product._description,
      product._descriptionSnippet,
    ]),
    tags: valuesFrom([product.tags, product.productTags, product._tags]),
    attributes: valuesFrom([
      product.attributes,
      product.attributesJson,
      product.productAttributes,
      product._attributes,
    ]),
    variants: valuesFrom([
      product.variants,
      product.variantAttributes,
      product._variantAttributes,
      product.variantFacts,
      product._variantFacts,
    ]),
    enrichment: valuesFrom([product.enrichment, product._enrichment]),
    classification: valuesFrom([
      product.vendor,
      product._vendor,
      product.productType,
      product._productType,
      product.category,
      product._category,
    ]),
  };

  const sources = {};
  for (const [name, values] of Object.entries(sourceValues)) {
    const normalized = normalizeCatalogText(values.join(" "));
    if (normalized) sources[name] = normalized;
  }

  return {
    text: Object.values(sources).join(" ").trim(),
    sources,
  };
}

function requirementTokens(requirement) {
  return normalizeCatalogText(requirement)
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_CATALOG_WORDS.has(token));
}

function textHasTokens(text, tokens) {
  const words = new Set(String(text || "").split(" ").filter(Boolean));
  return tokens.every((token) => words.has(token));
}

export function matchCatalogRequirement(product, requirement) {
  const tokens = requirementTokens(requirement);
  if (tokens.length === 0) return { matched: false, source: null, tokens };

  const document = buildCatalogSearchDocument(product);
  // Prefer descriptive proof over a title match. A title may use a
  // material word as a colorway name ("- Cork"), while the description
  // or merchant attributes can prove the product is actually built with it.
  const sourcePriority = [
    "description",
    "attributes",
    "variants",
    "tags",
    "enrichment",
    "title",
    "classification",
  ];
  const exactSource = sourcePriority
    .filter((source) => document.sources[source])
    .map((source) => [source, document.sources[source]])
    .find(([, text]) => textHasTokens(text, tokens));
  if (!exactSource) {
    return { matched: false, source: null, tokens };
  }
  return {
    matched: true,
    source: exactSource[0],
    tokens,
  };
}

export function filterByCatalogRequirements(products = [], requirements = []) {
  const wanted = Array.from(new Set(
    (requirements || []).map((term) => String(term || "").trim()).filter(Boolean),
  ));
  if (wanted.length === 0) {
    return { products, matches: new Map(), requirements: [] };
  }

  const matches = new Map();
  const filtered = products.filter((product) => {
    const perTerm = wanted.map((term) => ({
      term,
      ...matchCatalogRequirement(product, term),
    }));
    const keep = perTerm.every((entry) => entry.matched);
    if (keep) matches.set(product.handle || product.productHandle || product.title, perTerm);
    return keep;
  });

  return { products: filtered, matches, requirements: wanted };
}

function knownCategoryPhrases({ claimConfig, knownCategories } = {}) {
  const out = new Set();
  for (const category of knownCategories || []) {
    const normalized = normalizeCatalogText(category);
    if (normalized) out.add(normalized);
  }
  for (const group of claimConfig?.categoryGroups || []) {
    for (const category of group?.categories || []) {
      const normalized = normalizeCatalogText(category);
      if (normalized) out.add(normalized);
    }
  }
  out.add("shoe");
  out.add("shoes");
  out.add("footwear");
  return Array.from(out).sort((a, b) => b.length - a.length);
}

function structuredTokenSet(scope = {}, categoryPhrases = []) {
  const out = new Set();
  const values = [
    ...categoryPhrases,
    scope.gender,
    scope.category,
    scope.color,
    scope.colorFamily,
    scope.condition,
    scope.useCase,
    scope.width,
    scope.size,
    scope.modifier,
    scope.badge,
    scope.requestedClaim?.tag,
    scope.requestedClaim?.want,
    scope.requestedClaim?.kind === "archSupport" ? "arch support" : null,
    scope.requestedClaim?.kind === "waterFriendly" ? "water friendly" : null,
    "arch support",
    "water friendly",
    "wide width",
    "narrow width",
  ];
  for (const value of values) {
    for (const token of normalizeCatalogText(value).split(" ")) {
      if (!token) continue;
      out.add(token);
      if (token.length > 2) {
        out.add(token.endsWith("s") ? token.slice(0, -1) : `${token}s`);
      }
    }
  }
  if (scope.onSale) {
    out.add("sale");
    out.add("clearance");
    out.add("discount");
  }
  return out;
}

function cleanCandidate(value, structuredTokens) {
  const normalized = normalizeCatalogText(
    String(value || "")
      .split(/\b(?:that|because|so|but|and\s+i|and\s+we|for\s+my|for\s+me)\b/i)[0],
  );
  if (!normalized) return "";
  const tokens = normalized
    .split(" ")
    .filter((token) =>
      token.length > 1
      && !REQUEST_WORDS.has(token)
      && !GENERIC_CATALOG_WORDS.has(token)
      && !SUBJECTIVE_PREFERENCE_WORDS.has(token)
      && !structuredTokens.has(token),
    )
    .slice(0, 6);
  return tokens.join(" ");
}

function categoryPattern(categories) {
  const phrases = Array.from(new Set([
    ...(categories || []),
    "item", "items", "product", "products", "shoe", "shoes", "footwear",
  ].map(normalizeCatalogText).filter(Boolean)));
  return phrases
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.split(" ").map(escapeRegex).join("\\s+"))
    .join("|");
}

function explicitCandidates(message, categories) {
  const out = [];
  const definition = String(message || "").match(DEFINITION_RE);
  if (definition) out.push(definition[1] || definition[2]);

  if (RELATIONAL_QUERY_RE.test(String(message || ""))) return out;

  CONSTRUCTION_CONNECTOR_RE.lastIndex = 0;
  let connector;
  while ((connector = CONSTRUCTION_CONNECTOR_RE.exec(String(message || ""))) !== null) {
    out.push(connector[1]);
  }

  // "Shoes with removable insoles" / "which sandals have BioRocker".
  // Requiring a merchant-derived product/category noun before broad
  // connectors keeps ordinary language ("I have bunions", "do I have
  // to cancel") from becoming a destructive catalog hard filter.
  const products = [categoryPattern(categories), "one", "ones"].filter(Boolean).join("|");
  if (products) {
    const productConnectorRe = new RegExp(
      `\\b(?:${products})\\b(?:\\s+(?:that|which))?\\s+` +
        `(?:with|has|have|had|uses?|using|features?|featuring|contains?|containing|` +
        `made\\s+(?:of|from|with)|built\\s+with)\\s+([^?.,;—]+)`,
      "gi",
    );
    let productConnector;
    while ((productConnector = productConnectorRe.exec(String(message || ""))) !== null) {
      out.push(productConnector[1]);
    }
  }
  return out;
}

function prefixBeforeCategory(message, categories) {
  const normalized = normalizeCatalogText(message);
  let best = "";
  for (const category of categories) {
    const match = normalized.match(new RegExp(`\\b${category.replace(/\s+/g, "\\s+")}\\b`, "i"));
    if (!match || match.index == null) continue;
    const before = normalized.slice(0, match.index).trim();
    const words = before.split(" ").filter(Boolean);
    const immediate = words[words.length - 1] || "";
    if (!immediate || PREFIX_BLOCKERS.has(immediate)) continue;
    const candidate = words.slice(-4).join(" ");
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

function previousUserMessage(messages = [], latestUserMessage = "") {
  const users = (messages || [])
    .filter((message) => message?.role === "user" && typeof message.content === "string")
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (users.length === 0) return "";
  if (normalizeCatalogText(users[users.length - 1]) === normalizeCatalogText(latestUserMessage)) {
    users.pop();
  }
  return users[users.length - 1] || "";
}

export function deriveCatalogRequirements({
  latestUserMessage,
  messages = [],
  scope = {},
  claimConfig = null,
  knownCategories = [],
  allowCategoryPrefix = true,
} = {}) {
  const message = String(latestUserMessage || "").trim();
  const categories = knownCategoryPhrases({
    claimConfig,
    knownCategories: [...knownCategories, scope?.category].filter(Boolean),
  });
  const structuredTokens = structuredTokenSet(scope, categories);
  const candidates = explicitCandidates(message, categories);

  const prefix = allowCategoryPrefix ? prefixBeforeCategory(message, categories) : "";
  if (prefix) candidates.push(prefix);

  let requirements = candidates
    .map((candidate) => cleanCandidate(candidate, structuredTokens))
    .filter(Boolean);

  let continuedFromPrior = false;
  if (requirements.length === 0 && ANAPHORA_RE.test(message)) {
    const prior = previousUserMessage(messages, message);
    if (prior) {
      const priorRequirements = deriveCatalogRequirements({
        latestUserMessage: prior,
        messages: [],
        scope: {},
        claimConfig,
        knownCategories,
        allowCategoryPrefix: false,
      }).requiredTerms;
      if (priorRequirements.length > 0) {
        requirements = priorRequirements;
        continuedFromPrior = true;
      }
    }
  }

  requirements = Array.from(new Set(requirements)).slice(0, 3);
  return {
    requiredTerms: requirements,
    catalogQuery: requirements.join(" "),
    continuedFromPrior,
  };
}
