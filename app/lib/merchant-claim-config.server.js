// Merchant claim configuration — the data-driven replacement for the
// hardcoded BRAND_RULES + FOOTWEAR_CATEGORIES + NON_FOOTWEAR_CATEGORIES
// constants that used to live in product-claim-facts.server.js.
//
// Three concepts:
//   • ClaimRule:     for THIS shop, claim X is proven when product
//                    belongs to category group GROUP and isn't in
//                    one of EXCLUSIONS.
//   • CategoryGroup: named bundle of canonical category strings.
//   • ColorFamily:   named bundle of canonical color strings.
//
// All three are merchant-editable rows. When a merchant adds a new
// category to a group, or a new color to "neutral," the bot picks
// it up on the next request — no deploy, no code change.
//
// Auto-seed on first request: when a shop has zero claim rules
// configured we seed DEFAULT_SEED_RULES and DEFAULT_SEED_GROUPS,
// which mirror the prior hardcoded behavior so existing installs
// (e.g. f031fc-3.myshopify.com) keep working without manual action.
// The seed is idempotent and scoped per shop.

import prisma from "../db.server.js";

// ─── default seed ────────────────────────────────────────────────
//
// These defaults preserve current production behavior. Anything
// merchant-specific belongs in DB rows, not here. The seed is
// best-effort and only runs when the shop has zero ClaimRule rows.
const DEFAULT_SEED_GROUPS = [
  {
    name: "Footwear",
    categories: [
      "sneakers", "sandals", "boots", "loafers", "oxfords",
      "clogs", "slip-ons", "slippers", "mary-janes", "wedges-heels",
    ],
  },
  { name: "Accessories", categories: ["accessories"] },
  { name: "Orthotics",   categories: ["orthotics"] },
];

const DEFAULT_SEED_CLAIM_RULES = [
  {
    claim: "archSupport",
    ruleType: "category_group",
    appliesToGroup: "Footwear",
    excludeGroups: ["Orthotics", "Accessories"],
  },
];

const DEFAULT_SEED_COLOR_FAMILIES = [
  {
    name: "neutral",
    members: ["black", "white", "tan", "brown", "gray", "taupe", "beige", "ivory", "navy"],
  },
];

// Per-shop in-memory cache of resolved config. Cleared via
// invalidateMerchantClaimConfigCache(shop) when admin changes a row.
const cache = new Map();

export function invalidateMerchantClaimConfigCache(shop) {
  if (shop) cache.delete(String(shop).toLowerCase());
  else cache.clear();
}

// Public entry. Resolves the merchant's claim config for a shop,
// seeding defaults the first time the shop is seen. Always returns
// a {rules, categoryGroups, colorFamilies} bag — never null.
export async function getMerchantClaimConfig(shop) {
  if (!shop) {
    return { rules: [], categoryGroups: [], colorFamilies: [] };
  }
  const key = String(shop).toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const config = await loadOrSeed(key);
  cache.set(key, config);
  return config;
}

async function loadOrSeed(shop) {
  const [rules, groups, families] = await Promise.all([
    prisma.claimRule.findMany({ where: { shop, active: true } }),
    prisma.categoryGroup.findMany({ where: { shop } }),
    prisma.colorFamily.findMany({ where: { shop } }),
  ]);

  if (rules.length === 0 && groups.length === 0 && families.length === 0) {
    await seedDefaults(shop);
    const [r2, g2, f2] = await Promise.all([
      prisma.claimRule.findMany({ where: { shop, active: true } }),
      prisma.categoryGroup.findMany({ where: { shop } }),
      prisma.colorFamily.findMany({ where: { shop } }),
    ]);
    return shape(r2, g2, f2);
  }

  return shape(rules, groups, families);
}

// Version stamp for the default seed. Bump when DEFAULT_SEED_* lists
// change in a way callers should observe — e.g. new claim categories
// or new color families. The seed itself stays idempotent: it ONLY
// fills missing-by-name rows (createMany + skipDuplicates against
// the (shop,name) uniques). Merchant edits to existing rows are
// never touched.
export const DEFAULT_SEED_VERSION = "2026-06-02.v1";

async function seedDefaults(shop) {
  let createdGroups = 0;
  let createdRules = 0;
  let createdFamilies = 0;
  try {
    // createMany + skipDuplicates: any existing (shop,name) row
    // wins. We add only the names the merchant doesn't have yet.
    // Effect on a shop that already configured "Footwear" with a
    // custom category list: zero rows touched.
    const g = await prisma.categoryGroup.createMany({
      data: DEFAULT_SEED_GROUPS.map((x) => ({ shop, name: x.name, categories: x.categories })),
      skipDuplicates: true,
    });
    createdGroups = g.count ?? 0;

    const r = await prisma.claimRule.createMany({
      data: DEFAULT_SEED_CLAIM_RULES.map((x) => ({
        shop,
        claim: x.claim,
        ruleType: x.ruleType,
        appliesToGroup: x.appliesToGroup,
        excludeGroups: x.excludeGroups,
      })),
      skipDuplicates: true,
    });
    createdRules = r.count ?? 0;

    const f = await prisma.colorFamily.createMany({
      data: DEFAULT_SEED_COLOR_FAMILIES.map((x) => ({
        shop, name: x.name, members: x.members,
      })),
      skipDuplicates: true,
    });
    createdFamilies = f.count ?? 0;

    console.log(
      `[merchant-claim-config] seeded defaults shop=${shop} version=${DEFAULT_SEED_VERSION} ` +
        `created={categoryGroups:${createdGroups},claimRules:${createdRules},colorFamilies:${createdFamilies}}`,
    );
  } catch (err) {
    // Seed failures shouldn't break a request. Log and continue —
    // buildArchSupport() will degrade to "no rule" if rows still
    // aren't present, falling back to the title/description/footbed
    // scan. Existing merchant rows remain untouched.
    console.warn(
      `[merchant-claim-config] seed failed shop=${shop} version=${DEFAULT_SEED_VERSION}: ${err?.message || err}`,
    );
  }
}

function shape(rules, groups, families) {
  return {
    rules: rules.map((r) => ({
      claim: r.claim,
      ruleType: r.ruleType,
      appliesToGroup: r.appliesToGroup,
      excludeGroups: Array.isArray(r.excludeGroups) ? r.excludeGroups : [],
      ruleConfig: r.ruleConfig || null,
    })),
    categoryGroups: groups.map((g) => ({
      name: g.name,
      categories: Array.isArray(g.categories) ? g.categories.map(canonical) : [],
    })),
    colorFamilies: families.map((f) => ({
      name: String(f.name || "").toLowerCase().trim(),
      members: Array.isArray(f.members) ? f.members.map(canonical) : [],
    })),
  };
}

function canonical(s) {
  return String(s || "").toLowerCase().trim();
}

// ─── lookup helpers (pure) ───────────────────────────────────────
//
// Tests pass synthetic `{rules, categoryGroups, colorFamilies}` bags
// to these directly without touching the DB. The chat path uses
// getMerchantClaimConfig(shop) and feeds the result in.

export function findRule(config, claim) {
  if (!config || !Array.isArray(config.rules)) return null;
  return config.rules.find((r) => r.claim === claim) || null;
}

export function isCategoryInGroup(config, category, groupName) {
  if (!category || !groupName || !config) return false;
  const groups = Array.isArray(config.categoryGroups) ? config.categoryGroups : [];
  const group = groups.find((g) => g.name === groupName);
  if (!group) return false;
  return group.categories.includes(canonical(category));
}

export function isCategoryInAnyGroup(config, category, groupNames) {
  if (!Array.isArray(groupNames) || groupNames.length === 0) return false;
  return groupNames.some((name) => isCategoryInGroup(config, category, name));
}

// Resolve a color FAMILY name (e.g. "neutral") to its canonical
// member colors. Returns null when no such family is configured.
export function resolveColorFamily(config, familyName) {
  if (!familyName || !config) return null;
  const name = canonical(familyName);
  const fam = (config.colorFamilies || []).find((f) => f.name === name);
  if (!fam) return null;
  return [...fam.members];
}

// Reverse lookup: which family names contain this color?
export function familiesContainingColor(config, color) {
  if (!color || !config) return [];
  const c = canonical(color);
  return (config.colorFamilies || [])
    .filter((f) => f.members.includes(c))
    .map((f) => f.name);
}

// Exported for tests + future admin UI / seed CLI.
export const __defaults = {
  DEFAULT_SEED_GROUPS,
  DEFAULT_SEED_CLAIM_RULES,
  DEFAULT_SEED_COLOR_FAMILIES,
};
