import { useState } from "react";
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
    if (isCsv(fileName)) {
      const result = await upsertEnrichmentsFromCsv(session.shop, saved, content);
      if (result.noSkuColumn) {
        enrichmentMessage = " No SKU column detected — stored as raw context.";
      } else if (result.total > 0) {
        enrichmentMessage = ` Linked ${result.total} SKUs (${result.matched} matched your catalog).`;
      }
    }

    return {
      success: true,
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
  { label: "FAQs & Policies", value: "faqs", description: "Shipping, returns, warranty, common customer questions." },
  { label: "Brand / About", value: "brand", description: "Your story, values, voice, and tone." },
  { label: "Product Details", value: "products", description: "Extra product info — materials, care, sizing charts." },
  { label: "Custom Knowledge", value: "custom", description: "Anything else the AI should know." },
];

export default function Knowledge() {
  const { files } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const saving = nav.state === "submitting";

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);

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

        {actionData?.success && (
          <Banner title={actionData.message} tone="success" onDismiss={() => {}} />
        )}
        {actionData?.error && (
          <Banner title={actionData.error} tone="critical" onDismiss={() => {}} />
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
            <Text as="h2" variant="headingMd">What to upload</Text>
            <BlockStack gap="300">
              {FILE_TYPES.map((t) => (
                <BlockStack key={t.value} gap="100">
                  <Text as="h3" variant="headingSm">{t.label}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{t.description}</Text>
                </BlockStack>
              ))}
              <Divider />
              <Text as="p" variant="bodySm" tone="subdued">
                <strong>Format tip:</strong> For CSVs, include headers like{" "}
                <code>question, answer</code> for FAQs. For product data, include a{" "}
                <code>sku</code> column — rows will be automatically linked to matching
                products in your catalog. Plain text works for any category.
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
