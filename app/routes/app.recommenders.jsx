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

  return { error: "Unknown action" };
};

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
  const [editing, setEditing] = useState(null);  // { id?, name, intent, ... }
  const [showCreate, setShowCreate] = useState(false);

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
              <Button onClick={seedAetrex} variant="primary">
                Seed Aetrex Orthotic Finder
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
