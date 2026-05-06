import { useEffect, useState } from "react";
import {
  useLoaderData,
  useActionData,
  useFetcher,
} from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Divider,
  FormLayout,
  TextField,
  Checkbox,
  DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import {
  listDecisionTrees,
  getDecisionTreeById,
  getDecisionTreeByIntent,
  saveDecisionTree,
  deleteDecisionTree,
} from "../models/DecisionTree.server";
import { validateDecisionTree } from "../lib/decision-tree-schema.server";
import {
  fetchActiveOrthoticProducts,
  discoverDistinctValues,
  buildSuggestedMapping,
  regenerateMasterIndex,
} from "../lib/regenerate-orthotic.server";
import prisma from "../db.server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [config, decisionTrees] = await Promise.all([
    getShopConfig(session.shop),
    listDecisionTrees(session.shop),
  ]);
  return {
    shop: session.shop,
    decisionTreeEnabled: config.decisionTreeEnabled === true,
    decisionTrees: decisionTrees.map((t) => ({
      ...t,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "toggle_decision_tree") {
    const value = formData.get("decisionTreeEnabled") === "true";
    await updateShopConfig(session.shop, { decisionTreeEnabled: value });
    return { saved: true };
  }

  if (intent === "save_decision_tree") {
    const id = String(formData.get("id") || "").trim() || null;
    const name = String(formData.get("name") || "").trim();
    const treeIntent = String(formData.get("treeIntent") || "").trim();
    const triggerCategoryGroup = String(formData.get("triggerCategoryGroup") || "").trim() || null;
    const triggerPhrasesRaw = String(formData.get("triggerPhrases") || "").trim();
    const definitionRaw = String(formData.get("definition") || "").trim();
    const enabled = formData.get("enabled") === "true";
    if (!name) return { error: "Tree name is required." };
    if (!treeIntent) return { error: "Intent slug is required (a-z, 0-9, _, -)." };
    let definition;
    try { definition = JSON.parse(definitionRaw); }
    catch { return { error: "Definition must be valid JSON." }; }
    const v = validateDecisionTree(definition);
    if (!v.ok) return { error: "Tree validation failed: " + v.errors.slice(0, 4).join("; ") };
    const phrases = triggerPhrasesRaw
      ? triggerPhrasesRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      : [];
    try {
      const saved = await saveDecisionTree(session.shop, {
        id,
        name,
        intent: treeIntent,
        triggerPhrases: JSON.stringify(phrases),
        triggerCategoryGroup,
        definition,
        enabled,
      });
      return { saved: true, treeId: saved.id };
    } catch (err) {
      return { error: err?.message || "Could not save tree." };
    }
  }

  if (intent === "delete_decision_tree") {
    const id = String(formData.get("id") || "").trim();
    if (id) await deleteDecisionTree(session.shop, id);
    return { saved: true };
  }

  if (intent === "seed_aetrex_orthotic_tree") {
    try {
      const seedPath = path.resolve(process.cwd(), "scripts/seeds/aetrex-orthotic-tree.json");
      const definition = JSON.parse(await readFile(seedPath, "utf8"));
      const v = validateDecisionTree(definition);
      if (!v.ok) return { error: "Bundled seed is invalid: " + v.errors.slice(0, 4).join("; ") };
      const existing = await getDecisionTreeByIntent(session.shop, "orthotic");
      const saved = await saveDecisionTree(session.shop, {
        id: existing?.id,
        name: "Aetrex Orthotic Finder",
        intent: "orthotic",
        triggerPhrases: JSON.stringify([
          "orthotic", "orthotics", "insole", "insoles", "arch support", "custom orthotic",
        ]),
        triggerCategoryGroup: "Orthotics",
        definition,
        enabled: false,
      });
      return { saved: true, seeded: true, treeId: saved.id };
    } catch (err) {
      return { error: "Seed failed: " + (err?.message || "unknown") };
    }
  }

  if (intent === "load_decision_tree") {
    const id = String(formData.get("id") || "").trim();
    if (!id) return { error: "tree id required" };
    const tree = await getDecisionTreeById(session.shop, id);
    if (!tree) return { error: "tree not found" };
    return {
      loadedTree: {
        id: tree.id,
        name: tree.name,
        intent: tree.intent,
        triggerPhrases: tree.triggerPhrases,
        triggerCategoryGroup: tree.triggerCategoryGroup,
        enabled: tree.enabled,
        definition: tree.definition,
      },
    };
  }

  // Discover what's in the live Shopify catalog so the merchant can
  // see distinct activity / helps_with metafield values BEFORE the
  // regen runs. Used the first time and any time new metafield values
  // appear that the saved mapping doesn't cover.
  if (intent === "regen_orthotic_discover") {
    try {
      const accessToken = await getOfflineToken(session.shop);
      if (!accessToken) return { error: "No offline session for this shop. Re-install the app to refresh the token." };
      const products = await fetchActiveOrthoticProducts({ shop: session.shop, accessToken });
      const distinct = discoverDistinctValues(products);
      const existing = await getDecisionTreeByIntent(session.shop, "orthotic");
      const savedMapping = existing?.definition?.vocabularyMapping || null;
      const suggestedMapping = buildSuggestedMapping(distinct);
      // If a saved mapping already exists, surface only the NEW values
      // (the ones the merchant hasn't mapped yet) so they aren't asked
      // to re-confirm everything they already approved.
      const newActivity = savedMapping?.activity
        ? distinct.distinctActivity.filter((v) => !(v in savedMapping.activity))
        : distinct.distinctActivity;
      const newHelpsWith = savedMapping?.helps_with
        ? distinct.distinctHelpsWith.filter((v) => !(v in savedMapping.helps_with))
        : distinct.distinctHelpsWith;
      return {
        discovery: {
          productCount: products.length,
          distinctActivity: distinct.distinctActivity,
          distinctHelpsWith: distinct.distinctHelpsWith,
          distinctGender: distinct.distinctGender,
          newActivity,
          newHelpsWith,
          suggestedMapping,
          savedMapping,
        },
      };
    } catch (err) {
      return { error: "Discovery failed: " + (err?.message || "unknown") };
    }
  }

  // Apply the merchant-reviewed mapping, regenerate the masterIndex
  // straight from live Shopify, and write it to the orthotic
  // DecisionTree row. The mapping is persisted inside
  // definition.vocabularyMapping so future regens reuse it.
  if (intent === "regen_orthotic_apply") {
    try {
      const accessToken = await getOfflineToken(session.shop);
      if (!accessToken) return { error: "No offline session for this shop." };
      let mapping;
      try {
        mapping = JSON.parse(formData.get("mapping") || "{}");
      } catch {
        return { error: "Invalid mapping JSON." };
      }
      const products = await fetchActiveOrthoticProducts({ shop: session.shop, accessToken });
      const result = regenerateMasterIndex({ products, mapping });

      const existing = await getDecisionTreeByIntent(session.shop, "orthotic");
      if (!existing) {
        return { error: "No orthotic recommender exists yet. Click 'Seed Aetrex Orthotic Finder' first to install the base structure." };
      }
      const oldDef = existing.definition || {};
      const newDef = {
        ...oldDef,
        resolver: {
          ...(oldDef.resolver || {}),
          masterIndex: result.masterIndex,
          fallback: result.fallback,
        },
        vocabularyMapping: mapping,
        _lastRegenAt: new Date().toISOString(),
        _lastRegenSource: "shopify-live",
      };
      const v = validateDecisionTree(newDef);
      if (!v.ok) return { error: "Generated tree is invalid: " + v.errors.slice(0, 4).join("; ") };
      await saveDecisionTree(session.shop, {
        id: existing.id,
        name: existing.name,
        intent: existing.intent,
        triggerPhrases: existing.triggerPhrases,
        triggerCategoryGroup: existing.triggerCategoryGroup,
        definition: newDef,
        enabled: existing.enabled,
      });
      return {
        regenerated: {
          productCount: products.length,
          masterIndexCount: result.masterIndex.length,
          skippedCount: result.skipped.length,
          skipped: result.skipped,
          fallback: result.fallback,
          unmappedActivity: result.unmappedActivity,
          unmappedHelpsWith: result.unmappedHelpsWith,
        },
      };
    } catch (err) {
      return { error: "Regeneration failed: " + (err?.message || "unknown") };
    }
  }

  return { error: "Unknown action" };
};

// Look up the most recent offline access token for a shop. The same
// pattern the chat layer uses — every Shopify-side call goes through
// the offline session so the token survives admin sign-out/in cycles.
async function getOfflineToken(shop) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false, accessToken: { not: "" } },
    orderBy: { expires: "desc" },
  });
  return session?.accessToken || null;
}

function SectionHeading({ eyebrow, title, description }) {
  return (
    <BlockStack gap="100">
      {eyebrow && (
        <Text as="p" variant="bodySm" tone="subdued" fontWeight="semibold">
          {eyebrow.toUpperCase()}
        </Text>
      )}
      <Text as="h2" variant="headingLg">{title}</Text>
      {description && <Text as="p" tone="subdued">{description}</Text>}
    </BlockStack>
  );
}
function DecisionTreesCard({ enabled, trees }) {
  const fetcher = useFetcher();
  const loadFetcher = useFetcher();
  const regenFetcher = useFetcher();
  const [editing, setEditing] = useState(null);  // { id?, name, intent, ... }
  const [showCreate, setShowCreate] = useState(false);
  // Regenerate-from-Shopify modal state. When discovery returns
  // unmapped values (or this is the first run), show the merchant
  // the suggested mapping in a textarea so they can review/tweak
  // before applying. Saved mappings hide the textarea by default.
  const [regenStep, setRegenStep] = useState("idle"); // idle | review | done
  const [mappingDraft, setMappingDraft] = useState("");

  useEffect(() => {
    if (regenFetcher.data?.discovery) {
      const d = regenFetcher.data.discovery;
      const merged = d.savedMapping
        ? {
            ...d.savedMapping,
            activity: { ...d.suggestedMapping.activity, ...d.savedMapping.activity },
            helps_with: { ...d.suggestedMapping.helps_with, ...d.savedMapping.helps_with },
            gender: { ...d.suggestedMapping.gender, ...d.savedMapping.gender },
            specialtyOverrides: d.savedMapping.specialtyOverrides || d.suggestedMapping.specialtyOverrides,
          }
        : d.suggestedMapping;
      setMappingDraft(JSON.stringify(merged, null, 2));
      setRegenStep("review");
    }
    if (regenFetcher.data?.regenerated) {
      setRegenStep("done");
    }
  }, [regenFetcher.data]);

  // When the load fetcher returns, hydrate the editor with the full
  // tree (definition included). Kept out of the loader to avoid
  // shipping every tree's full JSON on every page render.
  useEffect(() => {
    const t = loadFetcher.data?.loadedTree;
    if (t) {
      let triggerPhrasesText = "";
      try {
        const arr = JSON.parse(t.triggerPhrases || "[]");
        triggerPhrasesText = Array.isArray(arr) ? arr.join(", ") : "";
      } catch { triggerPhrasesText = String(t.triggerPhrases || ""); }
      setEditing({
        id: t.id,
        name: t.name,
        intent: t.intent,
        triggerPhrases: triggerPhrasesText,
        triggerCategoryGroup: t.triggerCategoryGroup || "",
        enabled: Boolean(t.enabled),
        definition: JSON.stringify(t.definition || {}, null, 2),
      });
      setShowCreate(false);
    }
  }, [loadFetcher.data]);

  const seedAetrex = () => {
    const fd = new FormData();
    fd.set("intent", "seed_aetrex_orthotic_tree");
    fetcher.submit(fd, { method: "post" });
  };

  const startRegen = () => {
    setRegenStep("discovering");
    const fd = new FormData();
    fd.set("intent", "regen_orthotic_discover");
    regenFetcher.submit(fd, { method: "post" });
  };

  const applyRegen = () => {
    const fd = new FormData();
    fd.set("intent", "regen_orthotic_apply");
    fd.set("mapping", mappingDraft);
    regenFetcher.submit(fd, { method: "post" });
  };

  const closeRegen = () => {
    setRegenStep("idle");
    setMappingDraft("");
  };

  const toggleMaster = (next) => {
    const fd = new FormData();
    fd.set("intent", "toggle_decision_tree");
    fd.set("decisionTreeEnabled", next ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };

  const toggleTree = (tree, next) => {
    // Reuse save_decision_tree to flip just the enabled flag.
    const fd = new FormData();
    fd.set("intent", "load_decision_tree");
    fd.set("id", tree.id);
    loadFetcher.submit(fd, { method: "post" });
    // Pending: once load returns, immediately submit with the new
    // enabled flag. To keep this simple-but-honest, ask the merchant
    // to use the editor for now if they want to flip enabled.
    // Quick path: send a thin save with just the enabled change
    // alongside the existing fields would require refetching the
    // definition first — done via load + a second submit.
    // Implementation note: keeping a single round trip here would
    // be cleaner. For v1, we open the editor with the loaded tree
    // and let the merchant flip the checkbox + Save.
  };

  const startNew = () => {
    setEditing({
      id: null,
      name: "",
      intent: "",
      triggerPhrases: "",
      triggerCategoryGroup: "",
      enabled: false,
      // Minimal valid recommender shape. Only resolver.masterIndex
      // is read by the runtime; the nodes array is preserved for
      // back-compat with rows authored under the previous
      // funnel-based design and for the schema validator (which
      // still requires a rootNodeId pointing at a node — easy to
      // satisfy with a single resolve node).
      definition: JSON.stringify({
        rootNodeId: "q_resolve",
        nodes: [{ id: "q_resolve", type: "resolve" }],
        resolver: {
          defaults: {},
          masterIndex: [
            { masterSku: "EXAMPLE-1", title: "Example product", gender: "Unisex", useCase: "example" },
          ],
        },
      }, null, 2),
    });
    setShowCreate(true);
  };

  const onChange = (field) => (val) => {
    setEditing((prev) => ({ ...prev, [field]: typeof val === "string" ? val : val.target.value }));
  };

  const saveEditor = () => {
    if (!editing) return;
    const fd = new FormData();
    fd.set("intent", "save_decision_tree");
    if (editing.id) fd.set("id", editing.id);
    fd.set("name", editing.name);
    fd.set("treeIntent", editing.intent);
    fd.set("triggerPhrases", editing.triggerPhrases);
    fd.set("triggerCategoryGroup", editing.triggerCategoryGroup);
    fd.set("definition", editing.definition);
    fd.set("enabled", editing.enabled ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };

  const deleteEditing = () => {
    if (!editing?.id) { setEditing(null); return; }
    if (!confirm("Delete this decision tree? This cannot be undone.")) return;
    const fd = new FormData();
    fd.set("intent", "delete_decision_tree");
    fd.set("id", editing.id);
    fetcher.submit(fd, { method: "post" });
    setEditing(null);
  };

  // Close editor after successful save (fetcher data has saved=true
  // and includes treeId — only after a save_decision_tree action).
  useEffect(() => {
    if (fetcher.data?.saved && fetcher.data?.treeId && editing) {
      setEditing(null);
      setShowCreate(false);
    }
  }, [fetcher.data]);

  const masterToggleSubmitting =
    fetcher.state === "submitting" &&
    fetcher.formData?.get?.("intent") === "toggle_decision_tree";

  return (
    <Card>
      <BlockStack gap="500">
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">Smart Recommenders</Text>
            <Checkbox
              label={enabled ? "Recommenders ON" : "Recommenders OFF"}
              checked={enabled}
              disabled={masterToggleSubmitting}
              onChange={(next) => toggleMaster(next)}
            />
          </InlineStack>
          <Text as="p" tone="subdued">
            Master switch. When ON, every enabled recommender below is
            registered as a tool the AI can call when it judges the
            customer needs a structured pick. The AI is always in
            charge — recommenders never hijack a conversation. Same
            attributes in always yield the same SKU out (no
            hallucinated products). When OFF (default), no
            recommender tools are exposed and the chat is unchanged.
          </Text>
        </BlockStack>

        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        {fetcher.data?.seeded && (
          <Banner tone="success">Aetrex Orthotic Finder seeded. Review it below, then enable.</Banner>
        )}

        <Divider />

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h4" variant="headingSm">Your recommenders</Text>
            <InlineStack gap="200">
              <Button onClick={startNew}>+ New recommender</Button>
              <Button onClick={seedAetrex}>
                Seed Aetrex Orthotic Finder
              </Button>
              <Button
                onClick={startRegen}
                variant="primary"
                loading={regenFetcher.state !== "idle" && regenStep === "discovering"}
              >
                Regenerate from Shopify
              </Button>
            </InlineStack>
          </InlineStack>

          {(!trees || trees.length === 0) && (
            <Text as="p" tone="subdued">
              No recommenders yet. Click "Seed Aetrex Orthotic Finder" to install
              the bundled lookup table that maps clinical attributes to one of
              Aetrex's 183 orthotic SKUs, or build your own (mattress, pillow,
              supplement — any vertical with a typed attribute → SKU mapping).
            </Text>
          )}

          {trees && trees.length > 0 && (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "text"]}
              headings={["Name", "Intent", "Calls", ""]}
              rows={trees.map((t) => [
                <Text key={`n-${t.id}`} as="span" fontWeight="semibold">{t.name}</Text>,
                <Text key={`i-${t.id}`} as="span">{t.intent}</Text>,
                t.completedCount,
                <InlineStack key={`a-${t.id}`} gap="200">
                  <Badge tone={t.enabled ? "success" : undefined}>
                    {t.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button size="slim" onClick={() => {
                    const fd = new FormData();
                    fd.set("intent", "load_decision_tree");
                    fd.set("id", t.id);
                    loadFetcher.submit(fd, { method: "post" });
                  }}>Edit</Button>
                </InlineStack>,
              ])}
            />
          )}
        </BlockStack>

        {regenFetcher.data?.error && (
          <Banner tone="critical">{regenFetcher.data.error}</Banner>
        )}

        {regenStep === "review" && regenFetcher.data?.discovery && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text as="h4" variant="headingSm">Review mapping (Step 2 of 2)</Text>
              <Text as="p" tone="subdued">
                Pulled <strong>{regenFetcher.data.discovery.productCount}</strong> active orthotic products from Shopify.
                Found {regenFetcher.data.discovery.distinctActivity.length} activity values, {regenFetcher.data.discovery.distinctHelpsWith.length} helps_with values, and {regenFetcher.data.discovery.distinctGender.length} gender values.
              </Text>
              {(regenFetcher.data.discovery.newActivity?.length > 0 ||
                regenFetcher.data.discovery.newHelpsWith?.length > 0) && (
                <Banner tone="info">
                  New metafield values found that weren't in your saved mapping. They've been merged with sensible-guess defaults below — review before applying.
                  {regenFetcher.data.discovery.newActivity?.length > 0 && (
                    <Text as="p" variant="bodySm">New activity: {regenFetcher.data.discovery.newActivity.join(", ")}</Text>
                  )}
                  {regenFetcher.data.discovery.newHelpsWith?.length > 0 && (
                    <Text as="p" variant="bodySm">New helps_with: {regenFetcher.data.discovery.newHelpsWith.join(", ")}</Text>
                  )}
                </Banner>
              )}
              <TextField
                label="Mapping (edit any guess that's wrong, then Apply)"
                helpText="The mapping is saved with the recommender so future regenerations reuse it. Only edit values you know are wrong."
                value={mappingDraft}
                onChange={(v) => setMappingDraft(v)}
                multiline={20}
                autoComplete="off"
              />
              <InlineStack gap="200" align="end">
                <Button onClick={closeRegen}>Cancel</Button>
                <Button
                  onClick={applyRegen}
                  variant="primary"
                  loading={regenFetcher.state !== "idle" && regenStep === "review"}
                >
                  Apply mapping & regenerate
                </Button>
              </InlineStack>
            </BlockStack>
          </>
        )}

        {regenStep === "done" && regenFetcher.data?.regenerated && (
          <>
            <Divider />
            <Banner tone="success">
              <BlockStack gap="200">
                <Text as="p" fontWeight="semibold">
                  Regenerated {regenFetcher.data.regenerated.masterIndexCount} entries from {regenFetcher.data.regenerated.productCount} active Shopify products.
                </Text>
                {regenFetcher.data.regenerated.fallback && (
                  <Text as="p" variant="bodySm">
                    Fallback: <code>{regenFetcher.data.regenerated.fallback.masterSku}</code> — {regenFetcher.data.regenerated.fallback.title}
                  </Text>
                )}
                {regenFetcher.data.regenerated.skippedCount > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {regenFetcher.data.regenerated.skippedCount} product{regenFetcher.data.regenerated.skippedCount === 1 ? "" : "s"} skipped — usually missing gender or activity metafield. Open the tree to review.
                  </Text>
                )}
                <InlineStack>
                  <Button onClick={closeRegen}>Close</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </>
        )}

        {editing && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text as="h4" variant="headingSm">
                {editing.id ? "Edit recommender" : "New recommender"}
              </Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Name"
                    helpText="Shown in the admin and in the AI's tool description (e.g. Aetrex Orthotic Finder)."
                    value={editing.name}
                    onChange={onChange("name")}
                    autoComplete="off"
                  />
                  <TextField
                    label="Intent slug"
                    helpText="a-z, 0-9, _, - — becomes the tool name (recommend_<intent>) the AI can call. e.g. orthotic, mattress, supplement."
                    value={editing.intent}
                    onChange={onChange("intent")}
                    autoComplete="off"
                  />
                </FormLayout.Group>
                <Checkbox
                  label="Recommender enabled"
                  checked={Boolean(editing.enabled)}
                  onChange={(v) => setEditing((p) => ({ ...p, enabled: v }))}
                />
                <TextField
                  label="Lookup table (JSON)"
                  value={editing.definition}
                  onChange={onChange("definition")}
                  multiline={20}
                  monospaced
                  autoComplete="off"
                  helpText="The resolver.masterIndex array drives the recommendation: each entry maps an attribute set (gender, useCase, condition, etc.) to a master SKU. Validated server-side; bad JSON is rejected. The Aetrex seed is the canonical example."
                />
              </FormLayout>
              <InlineStack gap="200">
                <Button onClick={saveEditor} variant="primary"
                  loading={fetcher.state === "submitting" && fetcher.formData?.get?.("intent") === "save_decision_tree"}
                >
                  Save
                </Button>
                <Button onClick={() => setEditing(null)}>Cancel</Button>
                {editing.id && (
                  <Button onClick={deleteEditing} tone="critical" variant="plain">
                    Delete
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

export default function SmartRecommenders() {
  const data = useLoaderData();
  return (
    <Page>
      <TitleBar title="Smart Recommenders" />
      <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)", marginBottom: "20px" }} />
      <BlockStack gap="800">
        <BlockStack gap="400">
          <SectionHeading
            eyebrow="Smart Recommenders"
            title="Deterministic product finders the AI can call"
            description="Define a typed lookup table — given a set of attributes the customer mentions (gender, condition, use-case, etc.), it returns exactly one master SKU. Each recommender becomes a tool the AI can call when it judges the customer needs a structured pick. Same answers in always yield the same SKU out — no hallucinated products. Multiple recommenders per shop (orthotic, mattress, supplement, etc.). Off by default."
          />
          <DecisionTreesCard
            enabled={data.decisionTreeEnabled}
            trees={data.decisionTrees}
          />
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
