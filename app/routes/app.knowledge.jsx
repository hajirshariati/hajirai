import { useState } from "react";
import { useLoaderData, useActionData, useNavigation, useSubmit } from "react-router";
import { Page, Layout, Card, BlockStack, Text, Button, Banner, Box, DataTable, DropZone, InlineStack, Modal, Select, Thumbnail } from "@shopify/polaris";
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

export default function Knowledge() {
  const { files } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const saving = nav.state === "submitting";

  const [selectedType, setSelectedType] = useState("products");
  const [uploadFile, setUploadFile] = useState(null);

  const fileTypes = [
    { label: "Product Catalog", value: "products" },
    { label: "Orthotics / Insoles", value: "orthotics" },
    { label: "Fit & Sizing Data", value: "fit_data" },
    { label: "Technology Info", value: "technology" },
    { label: "Custom Knowledge", value: "custom" },
  ];

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
    f.fileName,
    fileTypes.find((t) => t.value === f.fileType)?.label || f.fileType,
    formatSize(f.fileSize),
    new Date(f.updatedAt).toLocaleDateString(),
    <Button tone="critical" variant="plain" onClick={() => handleDelete(f.id)}>Delete</Button>,
  ]);

  return (
    <Page title="Knowledge Base" backAction={{ url: "/app" }}>
      <TitleBar title="Knowledge Base" />
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner title={actionData.message} tone="success" onDismiss={() => {}} />
        )}
        {actionData?.error && (
          <Banner title={actionData.error} tone="critical" onDismiss={() => {}} />
        )}

        <Layout>
          <Layout.AnnotatedSection
            title="Upload Knowledge Files"
            description="Upload CSV files to train your AI assistant. Each file type can have one active file — uploading a new one replaces the previous."
          >
            <Card>
              <BlockStack gap="400">
                <Select
                  label="File Type"
                  options={fileTypes}
                  value={selectedType}
                  onChange={setSelectedType}
                />
                <DropZone
                  accept=".csv,.txt"
                  type="file"
                  onDropAccepted={handleDropAccepted}
                  allowMultiple={false}
                >
                  {uploadFile ? (
                    <Box padding="400">
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd">{uploadFile.name}</Text>
                        <Text as="p" tone="subdued">{formatSize(uploadFile.size)}</Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <DropZone.FileUpload actionHint="Accepts .csv and .txt files" />
                  )}
                </DropZone>
                {uploadFile && (
                  <InlineStack gap="300">
                    <Button variant="primary" onClick={handleUpload} loading={saving}>
                      Upload {fileTypes.find((t) => t.value === selectedType)?.label}
                    </Button>
                    <Button onClick={() => setUploadFile(null)}>Cancel</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Uploaded Files"
            description="These files are used by the AI to answer customer questions about your products."
          >
            <Card>
              {files.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">No files uploaded yet. Upload a CSV to get started.</Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["File Name", "Type", "Size", "Updated", ""]}
                  rows={rows}
                />
              )}
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">CSV Format Guide</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Product Catalog CSV should include columns: title, handle, description, price, compare_at_price, product_type, tags, gender, image_url, url
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Fit Data CSV should include columns: product_title, sizing_notes, return_reason, size_recommendation
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Technology and Custom files can be plain text (.txt) with free-form knowledge the AI should know.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
