// Product Turn Engine — canonical pipeline for claim-carrying
// product-shopping turns.
//
// Scope: turns where the customer named a category (or category+claim+gender)
// clearly enough that the engine can author the answer from merchant
// catalog data alone, without an LLM agent loop deciding which
// products to show or which claims to make.
//
// Pipeline:
//   1. resolveTurnScope — latest user message + memory (memory fills
//      blanks only; new explicit signals replace stale ones).
//   2. retrieveCandidates — Shopify/catalog search bounded by scope.
//   3. attachClaimFactsToCandidates — every card carries canonical
//      _claimFacts before display. Cards without facts are dropped
//      with a diagnostic log.
//   4. groupVariants — collapse same-base-style color variants into
//      one product family for compare/select purposes.
//   5. selectByProvenFacts — when a claim was requested (bunions,
//      arch support, water-friendly), prefer products with proof.
//      When no claim was requested, keep the full pool.
//   6. composeAnswer — deterministic seller-spirit copy from
//      verified facts only. No medical/comfort claims invented.
//
// Output:
//   { scope, products, facts, answerText, cta, diagnostics }
//
// Flag PRODUCT_TURN_ENGINE_ENABLED=true gates production use.
// Default OFF — this commit builds the architecture but does not
// change live chat behavior. See README in commit message for the
// enable checklist.

import {
  buildProductClaimFacts,
  attachClaimFactsToCard,
} from "./product-claim-facts.server.js";
import {
  getMerchantClaimConfig,
  resolveColorFamily,
  familiesContainingColor,
} from "./merchant-claim-config.server.js";

// Flag — feature gate for production wiring. Read at engine entry
// so flipping it at runtime (env update) takes effect without a
// process restart in dev.
export function productTurnEngineEnabled() {
  return String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true";
}

// Public entry. Returns a structured turn result OR null when the
// engine declines to handle the turn (caller falls back to the
// existing LLM agent path).
//
// Args:
//   ctx                  — { shop, sessionMemory, latestUserMessage, ... }
//   options.searchFn     — async (scope) => productCandidates[] (canonical
//                          product shape). Injected so eval mode can
//                          supply fixtures without a DB / Shopify call.
//   options.claimConfig  — pre-resolved merchant claim config. If absent,
//                          loaded via getMerchantClaimConfig(ctx.shop).
//   options.forceEnable  — bypass the env flag (eval mode only).
export async function runProductTurn(ctx = {}, options = {}) {
  const forceEnable = !!options.forceEnable;
  if (!forceEnable && !productTurnEngineEnabled()) {
    return null;
  }
  if (typeof options.searchFn !== "function") {
    return null;
  }

  const claimConfig = options.claimConfig
    || (ctx.shop ? await getMerchantClaimConfig(ctx.shop) : null);

  const diagnostics = { rungs: [], engineEnabled: true, claimConfigLoaded: !!claimConfig };

  // 1. Scope
  const scope = resolveTurnScope({
    latestUserMessage: ctx.latestUserMessage || "",
    sessionMemory: ctx.sessionMemory || null,
    claimConfig,
  });
  diagnostics.scope = scope;

  if (!engineWantsThisTurn(scope)) {
    diagnostics.rungs.push("declined:scope-too-thin");
    return { decline: true, diagnostics };
  }

  // 2. Retrieve
  const rawCandidates = await options.searchFn(scope);
  diagnostics.rungs.push(`retrieved:${rawCandidates.length}`);

  // 3. Attach facts. Cards without _claimFacts after this step are
  // a regression — log and drop.
  //
  // attachClaimFactsToCard returns ONLY the projected fact fields
  // (_conditionTags / _archSupport / _claimFacts / etc), not the
  // original UI fields (title, handle, image, url, price). The
  // engine output goes straight to the SSE emit and needs those
  // fields to render product cards — spread the candidate first,
  // then layer the fact fields on top.
  const cardsWithFacts = [];
  const droppedNoFacts = [];
  for (const cand of rawCandidates) {
    const card = { ...cand, ...attachClaimFactsToCard(cand, { shop: ctx.shop, claimConfig }) };
    if (!card._claimFacts) {
      droppedNoFacts.push(cand?.handle || cand?.title || "?");
      continue;
    }
    cardsWithFacts.push(card);
  }
  if (droppedNoFacts.length > 0) {
    console.warn(
      `[product-turn-engine] dropped ${droppedNoFacts.length} card(s) with no _claimFacts: ` +
        droppedNoFacts.slice(0, 5).join(", "),
    );
    diagnostics.rungs.push(`dropped_no_facts:${droppedNoFacts.length}`);
  }

  // 4. Group variants by base style. Same shoe in different colors
  // collapses to one product family. Original cards stay on the
  // family object for downstream display (we still SHOW each color
  // variant; we just don't COMPARE them as different products).
  const families = groupVariantsByBaseStyle(cardsWithFacts);
  diagnostics.rungs.push(`families:${families.length}`);

  // 5. Selection — prefer families that satisfy the requested claim.
  const { selected, deferred, selectionReason } = selectByProvenFacts({
    families,
    scope,
    claimConfig,
  });
  diagnostics.rungs.push(`selected:${selected.length}/deferred:${deferred.length}`);
  diagnostics.selectionReason = selectionReason;

  // 6. Compose deterministic seller-spirit copy.
  const composed = composeAnswer({
    scope,
    selected,
    deferred,
    selectionReason,
    claimConfig,
  });
  diagnostics.composer = composed.reason;

  // Flatten back to displayable cards (every variant of selected
  // families, in family-order). Deferred cards trail after selected
  // if the engine couldn't satisfy the claim exactly.
  const displayCards = familiesToCards([...selected, ...deferred]);

  return {
    decline: false,
    scope,
    products: displayCards,
    facts: displayCards.map((c) => c._claimFacts),
    answerText: composed.text,
    cta: composed.cta || null,
    diagnostics,
  };
}

// ─── 1. Scope resolution ────────────────────────────────────────
//
// "Latest user message wins. Memory only fills blanks."
// resolveTurnIntent + session-memory already implement the
// pivot/stale logic. The engine's job is to read the cleaned
// memory and surface the scope it'll use for retrieval/selection,
// not to redo that logic.
export function resolveTurnScope({ latestUserMessage, sessionMemory, claimConfig }) {
  const explicit = sessionMemory?.explicit || {};
  const scope = {
    rawMessage: String(latestUserMessage || "").trim(),
    gender: explicit.gender || null,
    category: explicit.category || null,
    color: explicit.color || null,
    colorFamily: null,
    condition: explicit.condition || null,
    useCase: explicit.useCase || null,
    width: explicit.width || null,
    size: explicit.size || null,
    requestedClaim: null,
    namedProduct: explicit.specificProduct || null,
  };

  // Map condition / use-case mentions into a "requested claim" the
  // selector understands. Per spec: claim semantics come from
  // merchant claim rules; the engine just routes the request.
  if (scope.condition) {
    // Any condition tag is a claim the merchant has structured for.
    scope.requestedClaim = { kind: "condition", tag: scope.condition };
  } else if (/\barch\s+support\b/i.test(scope.rawMessage)) {
    scope.requestedClaim = { kind: "archSupport" };
  } else if (/\bwater[\s-]?friendly\b/i.test(scope.rawMessage)) {
    scope.requestedClaim = { kind: "waterFriendly" };
  }

  // Color family resolution. "black or neutral" → color=black AND
  // colorFamily=neutral. Retrieval can union the family; selection
  // can prefer the explicit color first.
  if (claimConfig && scope.rawMessage) {
    const lc = scope.rawMessage.toLowerCase();
    for (const fam of claimConfig.colorFamilies || []) {
      if (new RegExp(`\\b${escapeRegex(fam.name)}\\b`, "i").test(lc)) {
        scope.colorFamily = fam.name;
        break;
      }
    }
  }

  return scope;
}

// Compare / similar-to / named-anchor phrasing. When the customer
// says "like the X" / "similar to X" / "same support as X", the
// turn is a named-product lookup — the LLM agent's catalog-resolver
// path handles this in v1 (the engine declines).
const NAMED_PRODUCT_ANCHOR_RE =
  /\b(?:like|same\s+(?:as|support\s+as|cushioning\s+as)|similar\s+to|other(?:\s+shoes)?\s+(?:like|with\s+the\s+same))\s+(?:the\s+)?[A-Za-z][\w'-]{2,}\b/i;

// Compare-shape phrasing ("which of these", "compare the first
// two") — engine declines and the agent path handles the compare.
const COMPARE_SHAPE_RE =
  /\b(?:which\s+(?:of\s+(?:these|those|them)|one|is\s+(?:better|more|the\s+most))|compare\s+(?:the\s+)?(?:first|top|two|these)|side[\s-]?by[\s-]?side)\b/i;

function engineWantsThisTurn(scope) {
  // V1 gate: handle clear claim-carrying retrieval shapes only.
  // Decline named-product lookups (compare/similar/specific-product)
  // and turns missing a category — those still go through the LLM
  // agent so it can ask clarifying questions or run catalog-
  // resolver paths the engine doesn't own yet.
  if (!scope.category) return false;
  if (scope.namedProduct) return false;
  const raw = scope.rawMessage || "";
  if (NAMED_PRODUCT_ANCHOR_RE.test(raw)) return false;
  if (COMPARE_SHAPE_RE.test(raw)) return false;
  return true;
}

// ─── 4. Variant family grouping ─────────────────────────────────
//
// Same shoe in different colors must collapse into one product
// family for comparison and selection. Family key is:
//   1. merchant productLine attribute (best signal when present)
//   2. canonical first-meaningful-title-token (e.g. "jillian")
// Cards that share a key collapse to one family; the family
// carries every variant card for later display.
export function groupVariantsByBaseStyle(cards = []) {
  const byKey = new Map();
  const orderedKeys = [];
  for (const c of cards) {
    const key = familyKey(c);
    if (!byKey.has(key)) {
      byKey.set(key, { key, primary: c, variants: [c] });
      orderedKeys.push(key);
    } else {
      byKey.get(key).variants.push(c);
    }
  }
  return orderedKeys.map((k) => byKey.get(k));
}

function familyKey(card) {
  // Prefer merchant productLine attribute (canonical, set during
  // catalog sync). Fallback: first meaningful title token before
  // any " - " color suffix.
  const productLine = card?._claimFacts?.productLine?.value
    || card?._productLine
    || null;
  if (productLine) return `pl:${String(productLine).toLowerCase().trim()}`;

  const title = String(card?.title || "");
  const beforeDash = title.split(/\s[-–—]\s/)[0];
  const tokens = beforeDash
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) {
    if (t.length >= 4 && !FAMILY_STOPWORDS.has(t)) return `t:${t}`;
  }
  return `h:${card?.handle || title}`;
}

const FAMILY_STOPWORDS = new Set([
  "the", "and", "with", "for", "from", "shoe", "shoes", "footwear",
  "support", "arch", "insole", "insoles", "orthotic", "orthotics",
  "men", "women", "mens", "womens", "kids", "unisex", "size",
]);

// ─── 5. Selection by proven facts ───────────────────────────────
export function selectByProvenFacts({ families, scope, claimConfig }) {
  if (families.length === 0) {
    return { selected: [], deferred: [], selectionReason: "empty_pool" };
  }
  if (!scope.requestedClaim) {
    return { selected: families, deferred: [], selectionReason: "no_claim_requested" };
  }

  const supports = (family) => familySupportsClaim(family, scope.requestedClaim, claimConfig);

  const proven = families.filter(supports);
  const partial = families.filter((f) => !supports(f));

  if (proven.length === families.length) {
    return { selected: proven, deferred: [], selectionReason: "all_proven" };
  }
  if (proven.length > 0) {
    return { selected: proven, deferred: partial, selectionReason: "proven_preferred" };
  }
  // No proven candidates — engine surfaces all as "closest matches"
  // and the composer phrases honestly. NEVER says "all of these
  // have X" when none do.
  return { selected: families, deferred: [], selectionReason: "closest_matches_no_proof" };
}

function familySupportsClaim(family, claim, claimConfig) {
  const cards = family?.variants || [];
  if (claim.kind === "condition") {
    return cards.some((c) =>
      Array.isArray(c?._conditionTags) && c._conditionTags.includes(claim.tag),
    );
  }
  if (claim.kind === "archSupport") {
    return cards.some((c) => c?._archSupport === true);
  }
  if (claim.kind === "waterFriendly") {
    return cards.some((c) => c?._waterFriendly === true);
  }
  return false;
}

// ─── 6. Compose ─────────────────────────────────────────────────
//
// Deterministic seller-spirit copy. Pattern:
//   1. acknowledgment (echoes the scope: gender + category)
//   2. why-these (uses ONLY verified facts: claim coverage, sale,
//      adjustable hint, color hint — never medical/comfort
//      generalizations)
//   3. soft CTA (open a card / start with the first / ...)
//
// Composer NEVER says "all of these have X" unless every selected
// card actually has X. NEVER invents support/comfort/medical
// claims. The verifier-side strip becomes redundant for engine
// output because the copy is true by construction.
export function composeAnswer({ scope, selected, deferred, selectionReason }) {
  if (selected.length === 0 && deferred.length === 0) {
    return {
      text: `I couldn't find ${scopeLabel(scope, { fallback: "matching styles" })} in our current catalog. Try a different style or color?`,
      reason: "empty_pool",
      cta: null,
    };
  }

  const allFamilies = [...selected, ...deferred];
  const allCards = familiesToCards(allFamilies);
  const n = allCards.length;
  const familyCount = allFamilies.length;

  // 1. Acknowledgment
  const label = scopeLabel(scope, { fallback: "styles" });
  let acknowledgment;
  if (selectionReason === "closest_matches_no_proof") {
    acknowledgment = `These ${label} are the closest matches I have.`;
  } else if (selectionReason === "proven_preferred") {
    acknowledgment = `I found ${selected.length === 1 ? "one" : selected.length} ${label}`
      + (familyCount > selected.length ? ` — plus ${familyCount - selected.length} close runner-up${familyCount - selected.length > 1 ? "s" : ""}` : "")
      + ` that match your request.`;
  } else if (selectionReason === "all_proven") {
    acknowledgment = `I found ${selected.length === 1 ? "one" : selected.length} ${label} that match your request.`;
  } else {
    // no_claim_requested / fallback
    acknowledgment = `I found ${familyCount === 1 ? "one" : familyCount} ${label}.`;
  }

  // 2. Why-these
  const why = buildWhyLine({ scope, selected, deferred, selectionReason });

  // 3. CTA — soft, action-oriented, no link inventing
  const cta = familyCount === 1
    ? `Open the card to check size and color availability.`
    : `Open a card to check size and color availability${familyCount > 3 ? `, or start with the first few if you want the closest match` : ""}.`;

  const text = [acknowledgment, why, cta].filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();

  return {
    text,
    reason: `${selectionReason}/n=${n}/families=${familyCount}`,
    cta: null,
  };
}

function buildWhyLine({ scope, selected, deferred, selectionReason }) {
  const all = [...selected, ...deferred];
  const cards = familiesToCards(all);
  if (cards.length === 0) return "";

  // Verified-only signals.
  const allOnSale = cards.every((c) => c?._onSale === true);
  const allArchSupport = cards.every((c) => c?._archSupport === true);
  const allWaterFriendly = cards.every((c) => c?._waterFriendly === true);
  const adjustableInTitle = cards.filter((c) => /\badjust/i.test(c?.title || "")).length;
  const allAdjustable = adjustableInTitle === cards.length && cards.length >= 2;
  const someAdjustable = adjustableInTitle > 0 && adjustableInTitle < cards.length;

  const bits = [];

  if (selectionReason === "closest_matches_no_proof") {
    // Be honest. The requested claim isn't proven on any card.
    if (scope.requestedClaim?.kind === "condition") {
      bits.push(`None are tagged specifically for ${humanizeCondition(scope.requestedClaim.tag)}, so check the card details before deciding.`);
    } else if (scope.requestedClaim?.kind === "archSupport") {
      bits.push(`Arch-support details vary by style — open a card to confirm.`);
    } else if (scope.requestedClaim?.kind === "waterFriendly") {
      bits.push(`Water-friendly details vary by style — open a card to confirm.`);
    }
  } else if (selectionReason === "proven_preferred" || selectionReason === "all_proven") {
    if (scope.requestedClaim?.kind === "condition") {
      bits.push(`The selected styles are tagged for ${humanizeCondition(scope.requestedClaim.tag)}.`);
    } else if (scope.requestedClaim?.kind === "archSupport" && allArchSupport) {
      bits.push(`All carry built-in arch support.`);
    } else if (scope.requestedClaim?.kind === "waterFriendly" && allWaterFriendly) {
      bits.push(`All are water-friendly.`);
    }
  }

  if (allOnSale && cards.length >= 2) {
    bits.push(`All are currently on sale.`);
  } else if (allOnSale && cards.length === 1) {
    bits.push(`It's currently on sale.`);
  }

  if (allAdjustable) {
    bits.push(`They all have adjustable straps for easier fit control.`);
  } else if (someAdjustable && selectionReason !== "closest_matches_no_proof") {
    bits.push(`Start with the adjustable styles if you want easier fit control.`);
  }

  return bits.join(" ");
}

function humanizeCondition(tag) {
  const map = {
    plantar_fasciitis: "plantar fasciitis",
    bunions: "bunions",
    flat_feet: "flat feet",
    high_arch: "high arches",
    metatarsalgia: "ball-of-foot pain",
    mortons_neuroma: "Morton's neuroma",
    diabetic: "diabetic foot care",
    arthritis: "arthritis",
    heel_spur: "heel spurs",
    heel_pain: "heel pain",
  };
  return map[tag] || String(tag || "").replace(/_/g, " ");
}

function scopeLabel(scope, { fallback = "styles" } = {}) {
  const parts = [];
  if (scope.gender) parts.push(genderPossessive(scope.gender));
  if (scope.color) parts.push(scope.color);
  if (scope.category) parts.push(scope.category);
  return parts.length ? parts.join(" ") : fallback;
}

function genderPossessive(g) {
  if (g === "men") return "men's";
  if (g === "women") return "women's";
  if (g === "kids") return "kids'";
  return g;
}

function familiesToCards(families) {
  const out = [];
  for (const f of families) {
    for (const v of f.variants || []) out.push(v);
  }
  return out;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exported for tests + the offline transcript harness.
export const __internals = {
  engineWantsThisTurn,
  familyKey,
  familySupportsClaim,
  scopeLabel,
};
