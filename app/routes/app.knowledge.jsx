import { useState, useCallback } from "react";
import { useLoaderData, useActionData, useNavigation, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
  DataTable,
  DropZone,
  Select,
  Badge,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getKnowledgeFiles, saveKnowledgeFile, deleteKnowledgeFile } from "../models/ShopConfig.server";
import {
  upsertEnrichmentsFromCsv,
  deleteEnrichmentsBySourceFile,
  countEnrichmentsBySourceFile,
} from "../models/ProductEnrichment.server";

function isCsv(fileName) {
  return typeof fileName === "string" && fileName.toLowerCase().endsWith(".csv");
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const files = await getKnowledgeFiles(session.shop);
  const enriched = await Promise.all(
    files.map((f) => countEnrichmentsBySourceFile(f.id))
  );
  const filesWithCounts = files.map((f, i) => ({ ...f, enrichedSkus: enriched[i] }));
  return { files: filesWithCounts, shop: session.shop };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upload") {
    const fileName = formData.get("fileName");
    const fileType = formData.get("fileType");
    const content = formData.get("content");
    const fileSize = parseInt(formData.get("fileSize"), 10);

    if (!content || !fileType) {
      return { error: "File and type are required" };
    }

    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    if (content.length > MAX_FILE_BYTES) {
      return { error: `File too large. Max ${MAX_FILE_BYTES / 1024 / 1024}MB.` };
    }

    const saved = await saveKnowledgeFile(session.shop, {
      fileName,
      fileType,
      fileSize,
      content,
    });

    // Wipe any enrichment rows from a prior upload at this file id. If the new
    // file is a CSV with a SKU column, the upsert below will re-populate it.
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

    return {
      success: true,
      skuWarning,
      message: `${fileName} uploaded successfully.${enrichmentMessage}`,
    };
  }

  if (intent === "delete") {
    const fileId = formData.get("fileId");
    await deleteEnrichmentsBySourceFile(fileId);
    await deleteKnowledgeFile(fileId);
    return { success: true, message: "File deleted" };
  }

  return { error: "Unknown action" };
};

const FILE_TYPES = [
  {
    label: "FAQs & Policies",
    value: "faqs",
    description: "Shipping, returns, warranty, common customer questions.",
    format: "csv",
    templateName: "faqs-template.csv",
    columns: "question, answer",
    template: `question,answer
"What is your return policy?","We accept returns within 30 days of purchase. Items must be unworn with original tags attached."
"How long does shipping take?","Standard shipping takes 5-7 business days. Express shipping takes 2-3 business days."
"Do you offer free shipping?","Yes, free standard shipping on all orders over $50."
"How do I track my order?","Once your order ships, you'll receive a tracking email. You can also check order status in your account."
"What payment methods do you accept?","We accept Visa, Mastercard, American Express, PayPal, and Apple Pay."`,
  },
  {
    label: "Brand / About",
    value: "brand",
    description: "Your story, values, voice, and tone.",
    format: "txt",
    templateName: "brand-voice-template.txt",
    template: `Brand Name: [Your Brand Name]

Our Story:
[Write 2-3 sentences about how your brand started and what drives you.]

Brand Voice:
- Tone: [e.g., friendly and approachable / premium and sophisticated / casual and fun]
- We always say: [e.g., "sustainable materials", "handcrafted quality"]
- We never say: [e.g., "cheap", "discount"]

Values:
- [e.g., Sustainability — we use recycled packaging and ethically sourced materials]
- [e.g., Quality — every product is inspected before shipping]
- [e.g., Community — 1% of sales go to local charities]

Key Differentiators:
- [What makes you different from competitors?]
- [Why should customers choose you?]`,
  },
  {
    label: "Product Details",
    value: "products",
    description: "Extra product info — materials, care, sizing. Include a SKU column to auto-link to your catalog.",
    format: "csv",
    templateName: "product-details-template.csv",
    columns: "sku, material, care_instructions, fit_notes, weight, made_in",
    template: `sku,material,care_instructions,fit_notes,weight,made_in
"SKU-001","100% organic cotton","Machine wash cold, tumble dry low","Runs true to size","200g","Portugal"
"SKU-002","Premium full-grain leather","Wipe clean with damp cloth","Order half size up","450g","Italy"
"SKU-003","Recycled polyester blend","Machine wash warm, hang dry","Relaxed fit — size down if between sizes","180g","Vietnam"`,
  },
  {
    label: "Rules & Guardrails",
    value: "rules",
    description: "Hard rules the AI must always follow — redirects, restrictions, required responses. These override all other knowledge.",
    format: "txt",
    templateName: "rules-template.txt",
    template: `# Rules & Guardrails
# The AI will follow these rules strictly — even if a customer asks it to ignore them.
# Use this file to control how the AI responds in specific situations.

# REDIRECT RULES — send customers to a specific page for certain topics:
When a customer asks about finding a physical store or retail location, always respond with:
"You can find our stores and authorized retailers on our store locator page: https://yourstore.com/pages/store-locator"

When a customer asks about custom orders or bulk pricing, always respond with:
"For custom and bulk orders, please reach out to our team directly: https://yourstore.com/pages/contact"

# RESTRICTION RULES — things the AI should never do:
Never mention, compare to, or recommend competitor brands or products.
Never discuss or speculate on upcoming product releases unless listed in the knowledge base.
Never offer discounts, coupon codes, or price adjustments — direct the customer to current promotions on the website.

# REQUIRED BEHAVIOR:
Always recommend consulting a healthcare professional before using products for medical purposes.
If a customer seems frustrated, offer to connect them with a human support agent.`,
  },
  {
    label: "Custom Knowledge",
    value: "custom",
    description: "Anything else the AI should know — promotions, seasonal info, store policies.",
    format: "csv",
    templateName: "custom-knowledge-template.csv",
    columns: "topic, details",
    template: `topic,details
"Current promotion","Buy 2 get 1 free on all t-shirts until end of month."
"Holiday hours","We're closed Dec 25-26 and Jan 1. Orders placed during this time ship on Jan 2."
"Loyalty program","Customers earn 1 point per dollar spent. 100 points = $10 off next order."
"Gift wrapping","We offer free gift wrapping on all orders. Just add a note at checkout."`,
  },
];

export default function Knowledge() {
  const { files } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const saving = nav.state === "submitting";

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);
  const [dismissedBanner, setDismissedBanner] = useState(null);

  const downloadTemplate = useCallback(() => {
    const type = FILE_TYPES.find((t) => t.value === selectedType);
    if (!type?.template) return;
    const blob = new Blob([type.template], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = type.templateName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [selectedType]);

  function handleDropAccepted(droppedFiles) {
    const file = droppedFiles[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadFile({ name: file.name, size: file.size, content: e.target.result });
    };
    reader.readAsText(file);
  }

  function handleUpload() {
    if (!uploadFile) return;
    const formData = new FormData();
    formData.set("intent", "upload");
    formData.set("fileName", uploadFile.name);
    formData.set("fileType", selectedType);
    formData.set("fileSize", uploadFile.size.toString());
    formData.set("content", uploadFile.content);
    submit(formData, { method: "post" });
    setUploadFile(null);
  }

  function handleDelete(fileId) {
    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("fileId", fileId);
    submit(formData, { method: "post" });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  const rows = files.map((f) => [
    <Text as="span" variant="bodyMd" fontWeight="medium">{f.fileName}</Text>,
    <Badge>{FILE_TYPES.find((t) => t.value === f.fileType)?.label || f.fileType}</Badge>,
    formatSize(f.fileSize),
    f.enrichedSkus > 0 ? (
      <Badge tone="success">{`${f.enrichedSkus} SKUs`}</Badge>
    ) : (
      <Text as="span" tone="subdued" variant="bodySm">—</Text>
    ),
    new Date(f.updatedAt).toLocaleDateString(),
    <Button
      icon={DeleteIcon}
      tone="critical"
      variant="plain"
      onClick={() => handleDelete(f.id)}
      accessibilityLabel="Delete file"
    />,
  ]);

  const currentType = FILE_TYPES.find((t) => t.value === selectedType);

  return (
    <Page title="Knowledge Base" backAction={{ url: "/app" }}>
      <TitleBar title="Knowledge Base" />
      <BlockStack gap="500">
        <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)" }} />
        <Banner title="Your Shopify catalog is already synced" tone="info">
          <Text as="p">
            ShopAgent automatically indexes your products, variants, and prices via Catalog Sync.
            Use this page to upload <strong>extra</strong> context the AI can't get from Shopify —
            FAQs, brand voice, sizing guides, product specs, and more.
          </Text>
          <Box paddingBlockStart="200">
            <Text as="p" variant="bodySm">
              <strong>SKU Matching:</strong> Upload a CSV with a <code>sku</code> column and each row
              is automatically linked to the matching product variant. The AI can then reference
              materials, care instructions, fit notes, and any other data you include — per product.
            </Text>
          </Box>
        </Banner>

        {actionData?.success && dismissedBanner !== actionData.message && (
          <Banner
            title={actionData.message}
            tone={actionData.skuWarning ? "warning" : "success"}
            onDismiss={() => setDismissedBanner(actionData.message)}
          />
        )}
        {actionData?.error && dismissedBanner !== actionData.error && (
          <Banner
            title={actionData.error}
            tone="critical"
            onDismiss={() => setDismissedBanner(actionData.error)}
          />
        )}

        <Layout>
          <Layout.AnnotatedSection
            title="Upload extra knowledge"
            description="Upload CSV or plain-text files with additional context for the AI. Each category keeps one active file — uploading a new file replaces the previous."
          >
            <Card>
              <BlockStack gap="400">
                <Select
                  label="Category"
                  options={FILE_TYPES.map((t) => ({ label: t.label, value: t.value }))}
                  value={selectedType}
                  onChange={setSelectedType}
                  helpText={currentType?.description}
                />
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        Template: {currentType?.templateName}
                      </Text>
                      <Button size="slim" onClick={downloadTemplate}>
                        Download template
                      </Button>
                    </InlineStack>
                    {currentType?.columns && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        Columns: <code>{currentType.columns}</code>
                      </Text>
                    )}
                    {currentType?.value === "products" && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        The <code>sku</code> column is required — rows are automatically matched to your Shopify products.
                      </Text>
                    )}
                  </BlockStack>
                </Box>
                <DropZone
                  accept=".csv,.txt"
                  type="file"
                  onDropAccepted={handleDropAccepted}
                  allowMultiple={false}
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
                    <Button variant="primary" onClick={handleUpload} loading={saving}>
                      Upload as {currentType?.label}
                    </Button>
                    <Button onClick={() => setUploadFile(null)}>Cancel</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Uploaded files"
            description="These files are sent to the AI alongside Shopify store data when answering customer questions."
          >
            <Card padding="0">
              {files.length === 0 ? (
                <EmptyState heading="No extra knowledge yet" image="">
                  <Text as="p" tone="subdued">
                    Upload a CSV or text file on the left to enrich the AI with your
                    unique store content.
                  </Text>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["File", "Category", "Size", "SKUs linked", "Updated", ""]}
                  rows={rows}
                />
              )}
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Divider />

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">How it works</Text>
            <BlockStack gap="300">
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">1. Download a template</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Select a category above and click "Download template" to get a pre-formatted file with example data.
                  </Text>
                </BlockStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">2. Fill in your data</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Open the template in Excel or Google Sheets, replace the sample data with your own, and save as CSV.
                  </Text>
                </BlockStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">3. Upload it</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Drag your file into the upload area above. If your CSV has a <code>sku</code> column, each row is automatically linked to the matching product in your Shopify catalog.
                  </Text>
                </BlockStack>
              </Box>
              <Divider />
              <Text as="p" variant="bodySm" tone="subdued">
                Each category keeps one active file — uploading a new file replaces the previous one.
                The AI reads these files alongside your Shopify catalog when answering customer questions.
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Data priority — what the AI trusts most</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              When the AI answers a question, it checks multiple data sources. If two sources
              conflict, the higher-priority source wins. Use this to fix wrong answers — upload
              the correction to the highest applicable source.
            </Text>
            <BlockStack gap="200">
              <Box padding="300" background="bg-surface-critical-subdued" borderRadius="200">
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="critical">1 — Highest</Badge>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Rules & Guardrails</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Hard rules the AI must always follow. Cannot be overridden by anything, not even the customer.
                      Use this for redirects, restrictions, and required behaviors.
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="info">2</Badge>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Live catalog data (tool results)</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Real-time product search, variant details, prices, and inventory from your Shopify catalog.
                      Automatically synced — no action needed.
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="info">3</Badge>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Knowledge files (FAQs, Brand, Products, Custom)</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      The files you upload on this page. Great for policies, sizing guides, brand voice, and extra product details not in Shopify.
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack gap="300" blockAlign="center">
                  <Badge>4</Badge>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Conversation context</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      What the customer said earlier in the current chat session.
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack gap="300" blockAlign="center">
                  <Badge>5 — Lowest</Badge>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold">AI general knowledge</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      The AI's training data. Used only when nothing above answers the question.
                      The AI is instructed to never invent policies, product details, or availability — it will
                      offer to connect the customer with your support team instead.
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Box>
            </BlockStack>
            <Banner tone="info">
              <Text as="p" variant="bodySm">
                <strong>Fixing a wrong answer?</strong> Upload the correction to the highest applicable source.
                For example, if the AI gives wrong return policy info, update your FAQs file.
                If it should always redirect a certain question to a specific page, add that as a Rules & Guardrails file.
              </Text>
            </Banner>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Tip: redirect customers to specific pages</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Want the AI to always send customers to a specific URL when they ask about a topic?
              Upload a <strong>Rules & Guardrails</strong> file with redirect instructions. For example:
            </Text>
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <Text as="p" variant="bodySm">
                <code>
                  When a customer asks about finding a store or retail location, always respond with:
                  "You can find our stores at https://yourstore.com/pages/store-locator"
                </code>
              </Text>
            </Box>
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <Text as="p" variant="bodySm">
                <code>
                  When a customer asks about custom orders, always respond with:
                  "For custom orders, please contact our team at https://yourstore.com/pages/contact"
                </code>
              </Text>
            </Box>
            <Text as="p" variant="bodySm" tone="subdued">
              Rules are the highest priority — the AI will follow them strictly, even if other
              knowledge says something different. Download the Rules template above to see more examples.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
