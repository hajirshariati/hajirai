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
  Icon,
  Badge,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import {
  ConnectIcon,
  FileIcon,
  InfoIcon,
  DeleteIcon,
} from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getKnowledgeFiles, saveKnowledgeFile, deleteKnowledgeFile } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const files = await getKnowledgeFiles(session.shop);
  return { files, shop: session.shop };
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

    await saveKnowledgeFile(session.shop, { fileName, fileType, fileSize, content });
    return { success: true, message: `${fileName} uploaded successfully` };
  }

  if (intent === "delete") {
    const fileId = formData.get("fileId");
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
    <InlineStack gap="200" blockAlign="center">
      <Icon source={FileIcon} tone="subdued" />
      <Text as="span" variant="bodyMd">{f.fileName}</Text>
    </InlineStack>,
    <Badge>{FILE_TYPES.find((t) => t.value === f.fileType)?.label || f.fileType}</Badge>,
    formatSize(f.fileSize),
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
        <Banner title="Your Shopify store is already connected" tone="info" icon={ConnectIcon}>
          <Text as="p">
            The assistant has live access to your products, collections, pages, and policies via
            the Shopify API. Use this page only to upload <strong>extra</strong> context beyond
            what's already in your store — FAQs, brand voice, sizing guides, and more.
          </Text>
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
                      <InlineStack gap="300" blockAlign="center">
                        <Icon source={FileIcon} tone="base" />
                        <BlockStack gap="050">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">{uploadFile.name}</Text>
                          <Text as="p" tone="subdued" variant="bodySm">{formatSize(uploadFile.size)}</Text>
                        </BlockStack>
                      </InlineStack>
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
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["File", "Category", "Size", "Updated", ""]}
                  rows={rows}
                />
              )}
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Divider />

        <Card>
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Icon source={InfoIcon} tone="base" />
              <Text as="h2" variant="headingMd">What to upload</Text>
            </InlineStack>
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
                <code>question, answer</code> for FAQs or{" "}
                <code>product_title, details</code> for product data. Plain text works for any category.
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
