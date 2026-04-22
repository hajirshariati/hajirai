import { useEffect, useState, useCallback } from "react";
import {
  useLoaderData,
  useActionData,
  useFetcher,
  useRevalidator,
  useNavigation,
  useSubmit,
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
  Box,
  Divider,
  FormLayout,
  TextField,
  Select,
  Tag,
  Checkbox,
  DataTable,
  DropZone,
  EmptyState,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getCatalogSyncState,
  getProductCount,
  syncCatalogAsync,
  stopCatalogSync,
} from "../models/Product.server";
import {
  getAttributeMappings,
  upsertAttributeMapping,
  deleteAttributeMapping,
} from "../models/AttributeMapping.server";
import {
  getShopConfig,
  updateShopConfig,
  getKnowledgeFiles,
  saveKnowledgeFile,
  deleteKnowledgeFile,
} from "../models/ShopConfig.server";
import {
  upsertEnrichmentsFromCsv,
  deleteEnrichmentsBySourceFile,
  countEnrichmentsBySourceFile,
} from "../models/ProductEnrichment.server";

function isCsv(fileName) {
  return typeof fileName === "string" && fileName.toLowerCase().endsWith(".csv");
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || "");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [state, count, mappings, config, files] = await Promise.all([
    getCatalogSyncState(session.shop),
    getProductCount(session.shop),
    getAttributeMappings(session.shop),
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
  ]);
  const enrichedCounts = await Promise.all(files.map((f) => countEnrichmentsBySourceFile(f.id)));
  const filesWithCounts = files.map((f, i) => ({ ...f, enrichedSkus: enrichedCounts[i] }));

  return {
    shop: session.shop,
    status: state.status,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
    productsCount: count,
    syncedSoFar: state.syncedSoFar || 0,
    mappings,
    categoryExclusions: safeParse(config.categoryExclusions, []),
    querySynonyms: safeParse(config.querySynonyms, []),
    deduplicateColors: config.deduplicateColors,
    files: filesWithCounts,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "resync") {
    syncCatalogAsync(admin, session.shop);
    return { started: true };
  }

  if (intent === "stop_sync") {
    await stopCatalogSync(session.shop);
    return { stopped: true };
  }

  if (intent === "save_mapping") {
    const attribute = String(formData.get("attribute") || "").trim().toLowerCase();
    const sourceType = String(formData.get("sourceType") || "metafield");
    const target = String(formData.get("target") || "product");
    const namespace = String(formData.get("namespace") || "").trim();
    const key = String(formData.get("key") || "").trim();
    const prefix = String(formData.get("prefix") || "").trim();

    if (!attribute) return { error: "Attribute name is required." };
    if (sourceType === "metafield") {
      if (!namespace || !key) return { error: "Namespace and key are required for metafield mappings." };
    } else if (sourceType === "tag_prefix") {
      if (!prefix) return { error: "Prefix is required for tag prefix mappings." };
    } else {
      return { error: "Unknown source type." };
    }

    await upsertAttributeMapping(session.shop, {
      attribute,
      sourceType,
      target,
      namespace: sourceType === "metafield" ? namespace : null,
      key: sourceType === "metafield" ? key : null,
      prefix: sourceType === "tag_prefix" ? prefix : null,
    });
    return { saved: true };
  }

  if (intent === "delete_mapping") {
    const attribute = String(formData.get("attribute") || "").trim();
    if (attribute) await deleteAttributeMapping(session.shop, attribute);
    return { deleted: true };
  }

  if (intent === "toggle_dedup") {
    const value = formData.get("deduplicateColors") === "true";
    await updateShopConfig(session.shop, { deduplicateColors: value });
    return { saved: true };
  }

  if (intent === "save_exclusions") {
    const raw = formData.get("categoryExclusions");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        await updateShopConfig(session.shop, { categoryExclusions: JSON.stringify(parsed) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid search rules." };
  }

  if (intent === "save_synonyms") {
    const raw = formData.get("querySynonyms");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        await updateShopConfig(session.shop, { querySynonyms: JSON.stringify(parsed) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid synonyms." };
  }

  if (intent === "upload") {
    const fileName = formData.get("fileName");
    const fileType = formData.get("fileType");
    const content = formData.get("content");
    const fileSize = parseInt(formData.get("fileSize"), 10);

    if (!content || !fileType) return { error: "File and type are required" };

    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    if (content.length > MAX_FILE_BYTES) {
      return { error: `File too large. Max ${MAX_FILE_BYTES / 1024 / 1024}MB.` };
    }

    const saved = await saveKnowledgeFile(session.shop, { fileName, fileType, fileSize, content });
    await deleteEnrichmentsBySourceFile(saved.id);

    let enrichmentMessage = "";
    let skuWarning = false;
    if (isCsv(fileName)) {
      const result = await upsertEnrichmentsFromCsv(session.shop, saved, content);
      if (result.noSkuColumn) {
        enrichmentMessage = " No SKU column detected — stored as raw context.";
      } else if (result.total > 0) {
        enrichmentMessage = ` Linked ${result.total} SKUs (${result.matched} matched your catalog).`;
        if (result.matched === 0) skuWarning = true;
      }
    }

    return { uploaded: true, skuWarning, message: `${fileName} uploaded successfully.${enrichmentMessage}` };
  }

  if (intent === "delete_file") {
    const fileId = formData.get("fileId");
    await deleteEnrichmentsBySourceFile(fileId);
    await deleteKnowledgeFile(fileId);
    return { deleted: true };
  }

  return { error: "unknown intent" };
};

const FILE_TYPES = [
  {
    label: "FAQs & Policies",
    value: "faqs",
    description: "Shipping, returns, warranty, common customer questions.",
    templateName: "faqs-template.csv",
    columns: "question, answer",
    template: `question,answer
"What is your return policy?","We accept returns within 30 days."
"How long does shipping take?","Standard shipping takes 5-7 business days."`,
  },
  {
    label: "Rules & Guidelines",
    value: "rules",
    description: "Things the AI must always/never do — tone, routing rules, banned phrases, escalation paths.",
    templateName: "rules-template.txt",
    template: `ALWAYS:
- Keep replies to 1-2 sentences.
- Use the customer's first name sparingly when logged in.

NEVER:
- Invent product codes or make up details.
- Claim items are out of stock.

ROUTING:
- Returns, refunds, billing, damaged items → support team.`,
  },
  {
    label: "Brand / About",
    value: "brand",
    description: "Your story, values, voice, and tone.",
    templateName: "brand-voice-template.txt",
    template: `Brand Name: [Your Brand Name]

Our Story:
[Write 2-3 sentences about how your brand started.]

Brand Voice:
- Tone: [e.g., friendly / premium / casual]

Values:
- [e.g., Sustainability]`,
  },
  {
    label: "Product Details",
    value: "products",
    description: "Extra product info — materials, care, sizing. Include a SKU column to auto-link.",
    templateName: "product-details-template.csv",
    columns: "sku, material, care_instructions, fit_notes, weight, made_in",
    template: `sku,material,care_instructions,fit_notes,weight,made_in
"SKU-001","100% organic cotton","Machine wash cold","Runs true to size","200g","Portugal"`,
  },
  {
    label: "Custom Knowledge",
    value: "custom",
    description: "Anything else the AI should know — promotions, seasonal info, store policies.",
    templateName: "custom-knowledge-template.csv",
    columns: "topic, details",
    template: `topic,details
"Current promotion","Buy 2 get 1 free on all t-shirts until end of month."`,
  },
];

function formatTime(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function statusBadge(status) {
  if (status === "running") return <Badge tone="info">Syncing</Badge>;
  if (status === "error") return <Badge tone="critical">Error</Badge>;
  return <Badge tone="success">Idle</Badge>;
}

function KnowledgeFilesCard({ files }) {
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const saving = nav.state === "submitting" &&
    (nav.formData?.get("intent") === "upload" || nav.formData?.get("intent") === "delete_file");

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);
  const [dismissed, setDismissed] = useState(null);

  const currentType = FILE_TYPES.find((t) => t.value === selectedType);

  const downloadTemplate = useCallback(() => {
    if (!currentType?.template) return;
    const blob = new Blob([currentType.template], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentType.templateName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [currentType]);

  const handleDropAccepted = (droppedFiles) => {
    const file = droppedFiles[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadFile({ name: file.name, size: file.size, content: e.target.result });
    };
    reader.readAsText(file);
  };

  const handleUpload = () => {
    if (!uploadFile) return;
    const fd = new FormData();
    fd.set("intent", "upload");
    fd.set("fileName", uploadFile.name);
    fd.set("fileType", selectedType);
    fd.set("fileSize", uploadFile.size.toString());
    fd.set("content", uploadFile.content);
    submit(fd, { method: "post" });
    setUploadFile(null);
  };

  const handleDelete = (fileId) => {
    const fd = new FormData();
    fd.set("intent", "delete_file");
    fd.set("fileId", fileId);
    submit(fd, { method: "post" });
  };

  const rows = files.map((f) => [
    <Text as="span" variant="bodyMd" fontWeight="medium">{f.fileName}</Text>,
    <Badge>{FILE_TYPES.find((t) => t.value === f.fileType)?.label || f.fileType}</Badge>,
    formatSize(f.fileSize),
    f.enrichedSkus > 0 ? <Badge tone="success">{`${f.enrichedSkus} SKUs`}</Badge> : <Text as="span" tone="subdued" variant="bodySm">—</Text>,
    new Date(f.updatedAt).toLocaleDateString(),
    <Button icon={DeleteIcon} tone="critical" variant="plain" onClick={() => handleDelete(f.id)} accessibilityLabel="Delete file" />,
  ]);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Knowledge files</Text>
            <Badge>Soft context</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Upload extra context the AI can't get from Shopify — FAQs, brand voice, sizing guides, product details. One file per category; re-uploading replaces the previous. CSVs with a <code>sku</code> column auto-link to matching variants.
          </Text>
        </BlockStack>

        {actionData?.uploaded && dismissed !== actionData.message && (
          <Banner title={actionData.message} tone={actionData.skuWarning ? "warning" : "success"} onDismiss={() => setDismissed(actionData.message)} />
        )}
        {actionData?.error && dismissed !== actionData.error && (
          <Banner title={actionData.error} tone="critical" onDismiss={() => setDismissed(actionData.error)} />
        )}

        <Layout>
          <Layout.Section variant="oneHalf">
            <BlockStack gap="300">
              <Select label="Category" options={FILE_TYPES.map((t) => ({ label: t.label, value: t.value }))}
                value={selectedType} onChange={setSelectedType} helpText={currentType?.description} />
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Template: {currentType?.templateName}</Text>
                    <Button size="slim" onClick={downloadTemplate}>Download</Button>
                  </InlineStack>
                  {currentType?.columns && <Text as="p" tone="subdued" variant="bodySm">Columns: <code>{currentType.columns}</code></Text>}
                </BlockStack>
              </Box>
              <DropZone
                accept=".csv,.txt,text/plain,text/csv"
                type="file"
                onDropAccepted={handleDropAccepted}
                allowMultiple={false}
                customValidator={(file) => /\.(csv|txt)$/i.test(file.name)}
              >
                {uploadFile ? (
                  <Box padding="400">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{uploadFile.name}</Text>
                      <Text as="p" tone="subdued" variant="bodySm">{formatSize(uploadFile.size)}</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <DropZone.FileUpload actionHint="Accepts .csv and .txt files" />
                )}
              </DropZone>
              {uploadFile && (
                <InlineStack gap="300">
                  <Button variant="primary" onClick={handleUpload} loading={saving}>Upload as {currentType?.label}</Button>
                  <Button onClick={() => setUploadFile(null)}>Cancel</Button>
                </InlineStack>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            {files.length === 0 ? (
              <EmptyState heading="No knowledge files yet" image="">
                <Text as="p" tone="subdued">Upload a CSV or text file to enrich the AI with store-specific context.</Text>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                headings={["File", "Category", "Size", "SKUs linked", "Updated", ""]}
                rows={rows}
              />
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Card>
  );
}

function DisplayCard({ deduplicateColors }) {
  const fetcher = useFetcher();
  const handleDedup = (checked) => {
    const fd = new FormData();
    fd.set("intent", "toggle_dedup");
    fd.set("deduplicateColors", String(checked));
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Display</Text>
        <Checkbox label="Deduplicate colors in search results"
          helpText="When enabled, products that differ only by color show a single card instead of one per color variant. Useful when each color is a separate Shopify product."
          checked={deduplicateColors} onChange={handleDedup} />
        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          <BlockStack gap="150">
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>How it works:</strong> the app groups products by everything before the last dash in the title. For this to work, your product titles must follow this format:
            </Text>
            <Text as="p" variant="bodySm">
              <code>Product Name - Color</code>
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Examples: <code>Chase Arch Support Sneaker - Black</code>, <code>Chase Arch Support Sneaker - White</code> → shown as one card. If your titles don't use this pattern, leave this off.
            </Text>
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}

function QuerySynonymsCard({ initial }) {
  const fetcher = useFetcher();
  const [entries, setEntries] = useState(initial || []);
  const [term, setTerm] = useState("");
  const [expandsTo, setExpandsTo] = useState("");

  const save = (list) => {
    const fd = new FormData();
    fd.set("intent", "save_synonyms");
    fd.set("querySynonyms", JSON.stringify(list));
    fetcher.submit(fd, { method: "post" });
  };

  const add = () => {
    const t = term.trim().toLowerCase();
    const list = expandsTo.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!t || list.length === 0) return;
    const updated = [...entries.filter((e) => e.term !== t), { term: t, expandsTo: list }];
    setEntries(updated);
    setTerm("");
    setExpandsTo("");
    save(updated);
  };

  const remove = (idx) => {
    const updated = entries.filter((_, i) => i !== idx);
    setEntries(updated);
    save(updated);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Query synonyms</Text>
            <Badge tone="info">Broadens searches</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            When the customer uses a broad term, also search for related narrower terms — so "shoe" matches sneakers, sandals, boots, and anything else you list. Purely additive; doesn't hide anything.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Tip: leave this empty and the AI searches exactly what the customer typed. Add entries only when you want a word to cast a wider net.
          </Text>
        </BlockStack>

        {entries.length > 0 && (
          <BlockStack gap="150">
            {entries.map((e, i) => (
              <InlineStack key={i} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodyMd" fontWeight="semibold"><code>{e.term}</code></Text>
                  <Text as="span" tone="subdued" variant="bodySm">also searches</Text>
                  {(e.expandsTo || []).map((x, j) => <Tag key={j}>{x}</Tag>)}
                </InlineStack>
                <Button variant="plain" tone="critical" onClick={() => remove(i)}>Remove</Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add a synonym</Text>
          <FormLayout>
            <FormLayout.Group>
              <TextField label="When searching for" value={term} onChange={setTerm}
                placeholder="shoe" autoComplete="off"
                helpText="Single word or short phrase." />
              <TextField label="Also search for" value={expandsTo} onChange={setExpandsTo}
                placeholder="sneaker, sandal, boot, slipper" autoComplete="off"
                helpText="Comma-separated related terms." />
            </FormLayout.Group>
            <Button onClick={add} disabled={!term.trim() || !expandsTo.trim()}>Add synonym</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function SearchRulesCard({ initial }) {
  const fetcher = useFetcher();
  const [rules, setRules] = useState(initial || []);
  const [whenQuery, setWhenQuery] = useState("");
  const [excludeTerms, setExcludeTerms] = useState("");
  const [overrideTriggers, setOverrideTriggers] = useState("");

  const saveRules = (r) => {
    const fd = new FormData();
    fd.set("intent", "save_exclusions");
    fd.set("categoryExclusions", JSON.stringify(r));
    fetcher.submit(fd, { method: "post" });
  };

  const addRule = () => {
    const w = whenQuery.trim();
    const e = excludeTerms.trim();
    const o = overrideTriggers.trim();
    if (!w || !e) return;
    const rule = { whenQuery: w, excludeTerms: e };
    if (o) rule.overrideTriggers = o;
    const updated = [...rules, rule];
    setRules(updated);
    setWhenQuery("");
    setExcludeTerms("");
    setOverrideTriggers("");
    saveRules(updated);
  };

  const removeRule = (idx) => {
    const updated = rules.filter((_, i) => i !== idx);
    setRules(updated);
    saveRules(updated);
  };

  const moveRule = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= rules.length) return;
    const updated = [...rules];
    [updated[idx], updated[target]] = [updated[target], updated[idx]];
    setRules(updated);
    saveRules(updated);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Search rules</Text>
            <Badge tone="critical">Hard filter — highest priority</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            When a trigger keyword appears in the conversation, matching products are hidden from search results before the AI sees them. Rules are evaluated top-to-bottom — first match wins.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Example: trigger <code>foot pain, plantar</code> → exclude <code>sneaker, sandal, boot</code>. The customer sees only relief products like orthotics. Add an <em>override</em> like <code>new footwear, new shoes</code> to let the rule be skipped when the customer explicitly asks for shoes.
          </Text>
        </BlockStack>

        {rules.length > 0 && (
          <BlockStack gap="200">
            {rules.map((r, i) => (
              <Box key={i} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="150">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="150" blockAlign="center">
                      <Badge>{String(i + 1)}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">Priority</Text>
                    </InlineStack>
                    <InlineStack gap="100">
                      <Button size="slim" disabled={i === 0} onClick={() => moveRule(i, -1)}>↑</Button>
                      <Button size="slim" disabled={i === rules.length - 1} onClick={() => moveRule(i, 1)}>↓</Button>
                      <Button variant="plain" tone="critical" onClick={() => removeRule(i)}>Remove</Button>
                    </InlineStack>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Badge tone="info">When</Badge>
                    <Text as="span" variant="bodySm"><code>{r.whenQuery}</code></Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Badge tone="critical">Exclude</Badge>
                    <Text as="span" variant="bodySm"><code>{r.excludeTerms}</code></Text>
                  </InlineStack>
                  {r.overrideTriggers && (
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Badge tone="success">Override</Badge>
                      <Text as="span" variant="bodySm"><code>{r.overrideTriggers}</code></Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add a rule</Text>
          <FormLayout>
            <TextField label="When conversation mentions" value={whenQuery} onChange={setWhenQuery}
              placeholder="foot pain, plantar, heel pain" autoComplete="off"
              helpText="Comma-separated triggers. Matched as substrings against the full conversation." />
            <TextField label="Hide products containing" value={excludeTerms} onChange={setExcludeTerms}
              placeholder="sneaker, sandal, boot" autoComplete="off"
              helpText="Comma-separated. Matches product title or product type." />
            <TextField label="Unless customer also says (optional)" value={overrideTriggers} onChange={setOverrideTriggers}
              placeholder="new footwear, new shoes, browse shoes" autoComplete="off"
              helpText="Comma-separated. If any of these appears in the customer's latest message, the rule is skipped for this turn." />
            <Button onClick={addRule} disabled={!whenQuery.trim() || !excludeTerms.trim()}>Add rule</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function AttributeMappingsCard({ mappings }) {
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save_mapping";
  const lastError = fetcher.data?.error;
  const lastSaved = fetcher.data?.saved;

  const [attribute, setAttribute] = useState("");
  const [sourceType, setSourceType] = useState("metafield");
  const [target, setTarget] = useState("product");
  const [namespace, setNamespace] = useState("");
  const [key, setKey] = useState("");
  const [prefix, setPrefix] = useState("");

  useEffect(() => {
    if (lastSaved) {
      setAttribute("");
      setNamespace("");
      setKey("");
      setPrefix("");
    }
  }, [lastSaved]);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("intent", "save_mapping");
    fd.set("attribute", attribute);
    fd.set("sourceType", sourceType);
    fd.set("target", target);
    fd.set("namespace", namespace);
    fd.set("key", key);
    fd.set("prefix", prefix);
    fetcher.submit(fd, { method: "post" });
  };

  const handleDelete = (attr) => {
    const fd = new FormData();
    fd.set("intent", "delete_mapping");
    fd.set("attribute", attr);
    fetcher.submit(fd, { method: "post" });
  };

  const canSave =
    attribute.trim().length > 0 &&
    ((sourceType === "metafield" && namespace.trim() && key.trim()) ||
      (sourceType === "tag_prefix" && prefix.trim()));

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Product attributes</Text>
            <Badge tone="warning">Enables filtering</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Map your Shopify metafields or tag prefixes to shared attribute names so the AI can filter results ("show me men's running shoes" → <code>gender: men</code>). Supports product- and variant-level metafields, including Metaobject references.
          </Text>
        </BlockStack>

        {mappings.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="200">
              {mappings.map((m) => (
                <InlineStack key={m.id} align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">{m.attribute}</Text>
                    <Badge tone={m.target === "variant" ? "attention" : "info"}>
                      {m.target === "variant" ? "Variant" : "Product"}
                    </Badge>
                    {m.sourceType === "metafield" ? (
                      <Tag>{`metafield: ${m.namespace}.${m.key}`}</Tag>
                    ) : (
                      <Tag>{`tag prefix: ${m.prefix}`}</Tag>
                    )}
                  </InlineStack>
                  <Button variant="tertiary" tone="critical" onClick={() => handleDelete(m.attribute)}>
                    Remove
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          </>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add mapping</Text>
          {lastError && <Banner tone="critical"><p>{lastError}</p></Banner>}
          <FormLayout>
            <FormLayout.Group>
              <TextField label="Attribute name" value={attribute} onChange={setAttribute}
                helpText="Shared name the AI will use (e.g. gender, color, category, material, size)." autoComplete="off" />
              <Select label="Source"
                options={[{ label: "Metafield", value: "metafield" }, { label: "Tag prefix", value: "tag_prefix" }]}
                value={sourceType} onChange={setSourceType} />
              <Select label="Target"
                options={[{ label: "Product", value: "product" }, { label: "Variant", value: "variant" }]}
                value={target} onChange={setTarget}
                disabled={sourceType === "tag_prefix"}
                helpText={sourceType === "tag_prefix" ? "Tags live on products only" : undefined} />
            </FormLayout.Group>

            {sourceType === "metafield" ? (
              <FormLayout.Group>
                <TextField label="Namespace" value={namespace} onChange={setNamespace} placeholder="custom" autoComplete="off" />
                <TextField label="Key" value={key} onChange={setKey} placeholder="gender" autoComplete="off" />
              </FormLayout.Group>
            ) : (
              <TextField label="Tag prefix" value={prefix} onChange={setPrefix} placeholder="gender:"
                helpText="Tags starting with this prefix become the attribute value (e.g. tag 'gender:men' → gender=men)." autoComplete="off" />
            )}

            <Button variant="primary" loading={saving} disabled={!canSave} onClick={handleSave}>
              Save mapping
            </Button>
          </FormLayout>
        </BlockStack>

        <Banner tone="info">
          <p>After adding or changing mappings, click <strong>Resync now</strong> above so new attributes get pulled into every product.</p>
        </Banner>
      </BlockStack>
    </Card>
  );
}

function CatalogSyncCard({ data }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const isStopping = data.status === "stopping" ||
    (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "stop_sync");
  const isRunning = (data.status === "running" || data.status === "stopping" ||
    (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "resync")) && !isStopping;

  useEffect(() => {
    if (data.status !== "running" && data.status !== "stopping") return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [data.status, revalidator]);

  const handleResync = () => {
    fetcher.submit({ intent: "resync" }, { method: "post" });
  };
  const handleStop = () => {
    fetcher.submit({ intent: "stop_sync" }, { method: "post" });
  };

  const syncedSoFar = data.syncedSoFar || 0;
  const estimate = data.productsCount || 0;
  const pct = estimate > 0 && syncedSoFar > 0 ? Math.min(100, Math.round((syncedSoFar / estimate) * 100)) : null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Catalog sync</Text>
            <Text as="p" tone="subdued">
              Indexes your Shopify products, variants, prices, and inventory. The AI searches this database in real time instead of guessing.
            </Text>
          </BlockStack>
          {statusBadge(data.status === "stopping" ? "running" : data.status)}
        </InlineStack>
        <Divider />
        <InlineStack gap="800">
          <Box>
            <Text as="p" tone="subdued" variant="bodySm">Products indexed</Text>
            <Text as="p" variant="headingLg">{data.productsCount}</Text>
          </Box>
          <Box>
            <Text as="p" tone="subdued" variant="bodySm">Last sync</Text>
            <Text as="p" variant="bodyMd">{formatTime(data.lastSyncedAt)}</Text>
          </Box>
        </InlineStack>
        {(data.status === "running" || data.status === "stopping") && syncedSoFar > 0 && (
          <BlockStack gap="200">
            <InlineStack align="space-between">
              <Text as="p" variant="bodySm" tone="subdued">
                {isStopping ? "Stopping..." : `${syncedSoFar} products synced${pct !== null ? ` (${pct}%)` : ""}...`}
              </Text>
            </InlineStack>
            {pct !== null && (
              <div style={{ height: "6px", borderRadius: "3px", background: "#e4e5e7", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, borderRadius: "3px", background: "#2D6B4F", transition: "width 0.5s ease" }} />
              </div>
            )}
          </BlockStack>
        )}
        {data.lastError && (
          <Banner tone="critical" title="Last sync failed"><p>{data.lastError}</p></Banner>
        )}
        <InlineStack gap="200">
          {data.status !== "running" && data.status !== "stopping" && (
            <Button variant="primary" loading={isRunning} onClick={handleResync}>
              Resync now
            </Button>
          )}
          {(data.status === "running" || data.status === "stopping") && (
            <Button variant="plain" tone="critical" loading={isStopping} onClick={handleStop}>
              {isStopping ? "Stopping..." : "Stop sync"}
            </Button>
          )}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function PriorityExplainer() {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">How the AI uses these rules</Text>
        <Text as="p" tone="subdued">
          Everything on this page controls how the AI answers customer questions. Rules are applied in this order — higher = stronger. Lower sections add context; higher sections override it.
        </Text>
        <BlockStack gap="150">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="critical">1</Badge>
            <Text as="p"><strong>Search Rules</strong> — hard filters applied at the database level. The AI cannot override these.</Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="warning">2</Badge>
            <Text as="p"><strong>Product Attributes</strong> — what the AI can filter by (gender, color, category…).</Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="info">3</Badge>
            <Text as="p"><strong>Query Synonyms</strong> — broaden searches so "shoe" also finds "sneaker, sandal…".</Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge>4</Badge>
            <Text as="p"><strong>Knowledge Files</strong> — soft context (FAQs, brand voice, product details).</Text>
          </InlineStack>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

export default function RulesKnowledge() {
  const data = useLoaderData();

  return (
    <Page>
      <TitleBar title="Rules & Knowledge" />
      <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)", marginBottom: "20px" }} />
      <BlockStack gap="500">
        <PriorityExplainer />
        <CatalogSyncCard data={data} />
        <AttributeMappingsCard mappings={data.mappings} />
        <SearchRulesCard initial={data.categoryExclusions} />
        <QuerySynonymsCard initial={data.querySynonyms} />
        <KnowledgeFilesCard files={data.files} />
        <DisplayCard deduplicateColors={data.deduplicateColors} />
      </BlockStack>
    </Page>
  );
}
