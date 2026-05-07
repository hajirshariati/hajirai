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
  InlineGrid,
  Box,
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

// Plain-language walkthrough of the conversational flow the
// recommender drives. Sits at the top of the page so merchants can
// understand WHY their customers are seeing chip-button questions
// before they see the JSON editor below. Each step maps to a real
// piece of code — but the copy is intentionally non-technical.
function HowItWorksCard() {
  const Step = ({ n, title, body }) => (
    <Box
      padding="400"
      background="bg-surface-secondary"
      borderRadius="300"
      borderWidth="025"
      borderColor="border"
    >
      <InlineStack gap="400" blockAlign="start" wrap={false}>
        <div
          style={{
            flexShrink: 0,
            width: 32, height: 32,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #2D6B4F, #3a8a66)",
            color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 600, fontSize: 14,
          }}
        >
          {n}
        </div>
        <BlockStack gap="100">
          <Text as="h4" variant="headingSm">{title}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{body}</Text>
        </BlockStack>
      </InlineStack>
    </Box>
  );
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h3" variant="headingMd">How the conversation flows</Text>
          <Text as="p" tone="subdued">
            When a customer asks for an orthotic recommendation, the assistant runs a
            short, deterministic Q&amp;A on top of your lookup table. The questions and
            answer choices come straight from your saved data — the AI doesn't
            paraphrase them, so a customer's click on "Plantar fasciitis" always maps
            to the same product every time.
          </Text>
        </BlockStack>
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Step
            n={1}
            title="Customer expresses orthotic intent"
            body="The assistant detects clear orthotic-finder intent — phrases like 'I need orthotics', 'plantar fasciitis', 'flat feet', or condition signals. Generic shopping questions like 'find me men's shoes' are left to the regular product search."
          />
          <Step
            n={2}
            title="Server emits the next question"
            body="Your saved questions and choice-button labels are sent to the customer exactly as you wrote them. No AI rephrasing means the customer's reply maps cleanly back to a known answer on the very next turn."
          />
          <Step
            n={3}
            title="Answer is captured (3 ways)"
            body="A clicked button maps directly. Free-text replies are matched against keyword patterns ('for my mom' → Women, 'flat feet' → Flat / Low Arch). Anything still ambiguous goes through a tightly-scoped AI call that picks one of your defined options or hands back to the open chat."
          />
          <Step
            n={4}
            title="Answers accumulate across turns"
            body="Each answer is remembered for the rest of the conversation. The customer can pivot mid-flow and the assistant won't forget what they already shared. Questions whose answers are already known get skipped automatically."
          />
          <Step
            n={5}
            title="Resolver picks one product"
            body="Once enough attributes are collected, your lookup table runs and returns exactly one master SKU. The product card is shown immediately with no further AI generation in the loop — same answers in always yield the same SKU out."
          />
          <Step
            n={6}
            title="Follow-ups go back to the AI"
            body="After the product is shown, normal chat takes over for follow-up questions ('does it fit my shoe?', 'what size?', 'can I see something cheaper?'). The recommender stays out of the way until another orthotic intent comes up."
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

// Each row maps to a specific guardrail in the live code. The copy
// stays product-friendly — no internal function names — so a non-
// technical merchant can read the page and trust what's happening
// without needing the source code open.
function BuiltInSafeguardsCard() {
  const Row = ({ icon, title, body }) => (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <div
        style={{
          flexShrink: 0,
          width: 28, height: 28,
          borderRadius: 8,
          background: "rgba(45,107,79,0.1)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 14,
        }}
        aria-hidden="true"
      >
        {icon}
      </div>
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" fontWeight="semibold">{title}</Text>
        <Text as="span" tone="subdued" variant="bodySm">{body}</Text>
      </BlockStack>
    </InlineStack>
  );
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h3" variant="headingMd">Built-in safeguards</Text>
          <Text as="p" tone="subdued">
            The recommender has guardrails that protect the customer experience. You
            don't have to configure these — they're always on when the recommender is
            enabled.
          </Text>
        </BlockStack>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
          <Row
            icon={"👟"}
            title="Footwear pivot is respected"
            body="If a customer asks for shoes, sandals, sneakers, etc. — or explicitly picks the footwear path on a 'shoes vs orthotics' question — the orthotic flow stays out of the way and a normal product search runs."
          />
          <Row
            icon={"✖️"}
            title="Explicit rejections honored"
            body="Replies like 'I don't want orthotics, just shoes' immediately exit the orthotic flow. The customer is never trapped."
          />
          <Row
            icon={"❓"}
            title="Off-topic interrupts handled"
            body="Mid-flow questions about shipping, returns, sizing, or store policy hand off to the regular chat so the customer gets a real answer instead of being asked another product question."
          />
          <Row
            icon={"🔁"}
            title="No looping on impossible matches"
            body="If a customer asks for an orthotic that physically can't work (e.g. an insert for open sandals), the assistant says so once and pivots to suggest arch-supportive sandals — instead of trying the same lookup three times."
          />
          <Row
            icon={"📝"}
            title="Latest message wins"
            body="Clinical signals are read from the customer's most recent reply, not stale phrases from earlier turns. Saying 'plantar fasciitis' on turn 5 doesn't get mixed up with 'ball-of-foot pain' from turn 1."
          />
          <Row
            icon={"✍️"}
            title="Smart-quote tolerance"
            body="Mobile keyboards and chat clients often replace straight apostrophes with curly ones (men's vs men’s). The recommender treats both forms the same so phrasing differences never break the flow."
          />
          <Row
            icon={"🎯"}
            title="No hallucinated SKUs"
            body="The product shown at the end always exists in your live Shopify catalog — the recommender filters its lookup table against your actual synced inventory before resolving."
          />
          <Row
            icon={"👶"}
            title="Kids never get an adult product"
            body="When a customer says the orthotic is for a child, the recommender never falls back to a unisex adult SKU — if no kids' product matches, it tells the customer honestly instead."
          />
        </InlineGrid>
      </BlockStack>
    </Card>
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
            <Text as="h3" variant="headingMd">Manage recommenders</Text>
            <Checkbox
              label={enabled ? "Recommenders ON" : "Recommenders OFF"}
              checked={enabled}
              disabled={masterToggleSubmitting}
              onChange={(next) => toggleMaster(next)}
            />
          </InlineStack>
          <Text as="p" tone="subdued">
            Master switch. When ON, every enabled recommender below becomes a
            guided flow the AI can hand off to when it sees a clear orthotic-finder
            intent. The customer answers a few choice-button questions, the
            lookup runs, and one specific product is shown. When OFF (default),
            the recommender stays out of the way completely and the chat behaves
            like a standard product-search assistant.
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
            title="Guided product finders the AI can call"
            description="A short, deterministic Q&A on top of your lookup table. The customer answers a handful of questions (use-case, gender, condition, arch type, etc.) using the exact button labels you define — and the recommender returns one specific master SKU. Same answers in always yield the same product out, so what you test is exactly what your customers see. Multiple recommenders per shop (orthotic, mattress, supplement, anything with a typed attribute → SKU mapping). Off by default."
          />
          <HowItWorksCard />
          <BuiltInSafeguardsCard />
          <DecisionTreesCard
            enabled={data.decisionTreeEnabled}
            trees={data.decisionTrees}
          />
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
