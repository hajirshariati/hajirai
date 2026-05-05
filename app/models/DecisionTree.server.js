import prisma from "../db.server.js";

// CRUD for DecisionTree rows. Pure data layer — does NOT validate
// the shape of `definition`. Validation lives in
// app/lib/decision-tree-schema.server.js (Batch 2) so save-time and
// runtime checks share one source of truth.
//
// Multi-tree per shop: a merchant can have N DecisionTree rows, each
// keyed by a unique `intent` slug. Aetrex's first instance is
// intent="orthotic"; future instances might be "footwear",
// "athletic_shoe", etc. The chat layer activates at most one tree
// per turn based on category-intent detection.

export async function listDecisionTrees(shop) {
  if (!shop) return [];
  return prisma.decisionTree.findMany({
    where: { shop },
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      intent: true,
      triggerPhrases: true,
      triggerCategoryGroup: true,
      enabled: true,
      startedCount: true,
      completedCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// Fetch including the full `definition`. Use this from runtime paths
// (chat.jsx) — listDecisionTrees omits `definition` because the admin
// list view doesn't need it and it can be large.
export async function getDecisionTreeById(shop, id) {
  if (!shop || !id) return null;
  return prisma.decisionTree.findFirst({ where: { shop, id } });
}

export async function getDecisionTreeByIntent(shop, intent) {
  if (!shop || !intent) return null;
  return prisma.decisionTree.findUnique({ where: { shop_intent: { shop, intent } } });
}

// Returns enabled trees only. Hot path: called per-turn from
// chat.jsx when ShopConfig.decisionTreeEnabled is true. Keep the
// shape narrow — the engine reads the full `definition` and trigger
// fields; nothing else is needed.
export async function getEnabledDecisionTrees(shop) {
  if (!shop) return [];
  return prisma.decisionTree.findMany({
    where: { shop, enabled: true },
    select: {
      id: true,
      name: true,
      intent: true,
      triggerPhrases: true,
      triggerCategoryGroup: true,
      definition: true,
    },
  });
}

// Caller-supplied fields are validated at the route layer; we only
// enforce required keys + length caps here so the DB never gets
// degenerate rows. `definition` is JSON — pass an object, Prisma
// serializes it to JSONB.
export async function saveDecisionTree(shop, { id, name, intent, triggerPhrases, triggerCategoryGroup, definition, enabled }) {
  if (!shop) throw new Error("shop required");
  const data = {
    name: String(name || "").trim().slice(0, 200),
    intent: String(intent || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 50),
    triggerPhrases: typeof triggerPhrases === "string" ? triggerPhrases : JSON.stringify(triggerPhrases || []),
    triggerCategoryGroup: triggerCategoryGroup ? String(triggerCategoryGroup).trim().slice(0, 100) : null,
    definition: definition ?? {},
    enabled: Boolean(enabled),
  };
  if (!data.name) throw new Error("name required");
  if (!data.intent) throw new Error("intent required (a-z, 0-9, _, -)");

  if (id) {
    return prisma.decisionTree.update({ where: { id }, data });
  }
  return prisma.decisionTree.create({ data: { ...data, shop } });
}

export async function deleteDecisionTree(shop, id) {
  if (!shop || !id) return;
  await prisma.decisionTree.deleteMany({ where: { id, shop } });
}

// Atomic counter bumps. Called from the chat layer when a tree
// session starts (first question shown) and again when it completes
// (resolver returns a SKU). Failures are swallowed — analytics
// counters must never break a customer turn.
export async function incrementStartedCount(shop, id) {
  if (!shop || !id) return;
  try {
    await prisma.decisionTree.update({
      where: { id },
      data: { startedCount: { increment: 1 } },
    });
  } catch {
    /* ignore */
  }
}

export async function incrementCompletedCount(shop, id) {
  if (!shop || !id) return;
  try {
    await prisma.decisionTree.update({
      where: { id },
      data: { completedCount: { increment: 1 } },
    });
  } catch {
    /* ignore */
  }
}
