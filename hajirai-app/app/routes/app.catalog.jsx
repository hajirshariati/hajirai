import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getCatalogSyncState,
  getProductCount,
  syncCatalogAsync,
} from "../models/Product.server";
import {
  getAttributeMappings,
  upsertAttributeMapping,
  deleteAttributeMapping,
} from "../models/AttributeMapping.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [state, count, mappings, config] = await Promise.all([
    getCatalogSyncState(session.shop),
    getProductCount(session.shop),
    getAttributeMappings(session.shop),
    getShopConfig(session.shop),
  ]);
  let categoryExclusions = [];
  try { categoryExclusions = JSON.parse(config.categoryExclusions || "[]"); } catch { /* */ }

  return {
    shop: session.shop,
    status: state.status,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
    productsCount: count,
    mappings,
    categoryExclusions,
    deduplicateColors: config.deduplicateColors,
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

  if (intent === "save_mapping") {
    const attribute = String(formData.get("attribute") || "").trim().toLowerCase();
    const sourceType = String(formData.get("sourceType") || "metafield");
    const target = String(formData.get("target") || "product");
    const namespace = String(formData.get("namespace") || "").trim();
    const key = String(formData.get("key") || "").trim();
    const prefix = String(formData.get("prefix") || "").trim();

    if (!attribute) return { error: "Attribute name is required." };
    if (sourceType === "metafield") {
      if (!namespace || !key) {
        return { error: "Namespace and key are required for metafield mappings." };
      }
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
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          await updateShopConfig(session.shop, { categoryExclusions: JSON.stringify(parsed) });
          return { saved: true };
        }
      } catch { /* */ }
    }
    return { error: "Invalid exclusion rules." };
  }

  return { error: "unknown intent" };
};

function formatTime(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString();
}

function statusBadge(status) {
  if (status === "running") return <Badge tone="info">Syncing</Badge>;
  if (status === "error") return <Badge tone="critical">Error</Badge>;
  return <Badge tone="success">Idle</Badge>;
}

function MappingsPanel({ mappings }) {
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
          <Text as="h2" variant="headingMd">Product attributes</Text>
          <Text as="p" tone="subdued">
            Map your Shopify metafields or tag prefixes to shared attribute names so the AI can
            filter results ("show me men's running shoes" → <code>gender: men</code>). Supports
            both product-level and variant-level metafields, including Metaobject references.
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
                  <Button
                    variant="tertiary"
                    tone="critical"
                    onClick={() => handleDelete(m.attribute)}
                  >
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
              <TextField
                label="Attribute name"
                value={attribute}
                onChange={setAttribute}
                helpText="Shared name the AI will use (e.g. gender, color, material, size)."
                autoComplete="off"
              />
              <Select
                label="Source"
                options={[
                  { label: "Metafield", value: "metafield" },
                  { label: "Tag prefix", value: "tag_prefix" },
                ]}
                value={sourceType}
                onChange={setSourceType}
              />
              <Select
                label="Target"
                options={[
                  { label: "Product", value: "product" },
                  { label: "Variant", value: "variant" },
                ]}
                value={target}
                onChange={setTarget}
                disabled={sourceType === "tag_prefix"}
                helpText={sourceType === "tag_prefix" ? "Tags live on products only" : undefined}
              />
            </FormLayout.Group>

            {sourceType === "metafield" ? (
              <FormLayout.Group>
                <TextField
                  label="Namespace"
                  value={namespace}
                  onChange={setNamespace}
                  placeholder="custom"
                  autoComplete="off"
                />
                <TextField
                  label="Key"
                  value={key}
                  onChange={setKey}
                  placeholder="gender"
                  autoComplete="off"
                />
              </FormLayout.Group>
            ) : (
              <TextField
                label="Tag prefix"
                value={prefix}
                onChange={setPrefix}
                placeholder="gender:"
                helpText="Tags starting with this prefix become the attribute value (e.g. tag 'gender:men' → gender=men)."
                autoComplete="off"
              />
            )}

            <Button variant="primary" loading={saving} disabled={!canSave} onClick={handleSave}>
              Save mapping
            </Button>
          </FormLayout>
        </BlockStack>

        <Banner tone="info">
          <p>After adding or changing mappings, click <strong>Resync now</strong> above so the new attributes get pulled into every product.</p>
        </Banner>
      </BlockStack>
    </Card>
  );
}

function CategoryExclusionsPanel({ initial }) {
  const fetcher = useFetcher();
  const [rules, setRules] = useState(initial || []);
  const [whenQuery, setWhenQuery] = useState("");
  const [excludeTerms, setExcludeTerms] = useState("");

  const addRule = () => {
    const w = whenQuery.trim();
    const e = excludeTerms.trim();
    if (!w || !e) return;
    const updated = [...rules, { whenQuery: w, excludeTerms: e }];
    setRules(updated);
    setWhenQuery("");
    setExcludeTerms("");
    saveRules(updated);
  };

  const removeRule = (idx) => {
    const updated = rules.filter((_, i) => i !== idx);
    setRules(updated);
    saveRules(updated);
  };

  const saveRules = (r) => {
    const fd = new FormData();
    fd.set("intent", "save_exclusions");
    fd.set("categoryExclusions", JSON.stringify(r));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <BlockStack gap="300">
      <BlockStack gap="100">
        <Text as="h3" variant="headingSm">Category exclusion rules</Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Prevent product categories from mixing. When a keyword from the "trigger" column appears in the conversation, products matching the "exclude" column are hidden. Uses substring matching — shorter triggers match more broadly (e.g. "ortho" matches "orthotic", "orthotics", "orthopedic").
        </Text>
      </BlockStack>

      {rules.length > 0 && (
        <BlockStack gap="200">
          {rules.map((r, i) => (
            <InlineStack key={i} gap="200" blockAlign="center" wrap={false}>
              <Badge tone="info">When</Badge>
              <Text as="span" variant="bodySm"><code>{r.whenQuery}</code></Text>
              <Badge tone="critical">Exclude</Badge>
              <Text as="span" variant="bodySm"><code>{r.excludeTerms}</code></Text>
              <Button variant="plain" tone="critical" onClick={() => removeRule(i)}>Remove</Button>
            </InlineStack>
          ))}
        </BlockStack>
      )}

      <InlineStack gap="200" blockAlign="end" wrap={false}>
        <div style={{ flex: 1 }}>
          <TextField
            label="When conversation mentions"
            value={whenQuery}
            onChange={setWhenQuery}
            placeholder="ortho, insole, arch support"
            autoComplete="off"
            helpText="Comma-separated trigger keywords"
          />
        </div>
        <div style={{ flex: 1 }}>
          <TextField
            label="Exclude products containing"
            value={excludeTerms}
            onChange={setExcludeTerms}
            placeholder="sneaker, sandal, boot, shoe"
            autoComplete="off"
            helpText="Comma-separated — matching products are hidden"
          />
        </div>
        <Button onClick={addRule} disabled={!whenQuery.trim() || !excludeTerms.trim()}>Add</Button>
      </InlineStack>
    </BlockStack>
  );
}

export default function Catalog() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const dedupFetcher = useFetcher();
  const revalidator = useRevalidator();

  const isRunning = data.status === "running" ||
    (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "resync");

  const handleDedup = (checked) => {
    const fd = new FormData();
    fd.set("intent", "toggle_dedup");
    fd.set("deduplicateColors", String(checked));
    dedupFetcher.submit(fd, { method: "post" });
  };

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [isRunning, revalidator]);

  const handleResync = () => {
    fetcher.submit({ intent: "resync" }, { method: "post" });
  };

  return (
    <Page backAction={{ url: "/app" }}>
      <TitleBar title="Catalog" />
      <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)", marginBottom: "20px" }} />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Catalog sync</Text>
                  <Text as="p" tone="subdued">
                    ShopAgent indexes your Shopify products, variants, prices, and inventory into a
                    searchable database. The AI uses this to search your catalog, look up product
                    details, and check SKUs in real time — instead of guessing.
                  </Text>
                </BlockStack>
                {statusBadge(data.status)}
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

              {data.lastError && (
                <Banner tone="critical" title="Last sync failed">
                  <p>{data.lastError}</p>
                </Banner>
              )}

              <InlineStack>
                <Button variant="primary" loading={isRunning} onClick={handleResync}>
                  {isRunning ? "Syncing..." : "Resync now"}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Search & display</Text>
              <Checkbox
                label="Deduplicate colors in search results"
                helpText="When enabled, products that differ only by color show a single card instead of one per color variant. Useful when each color is a separate Shopify product."
                checked={data.deduplicateColors}
                onChange={handleDedup}
              />
              <Divider />
              <CategoryExclusionsPanel initial={data.categoryExclusions} />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <MappingsPanel mappings={data.mappings} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
