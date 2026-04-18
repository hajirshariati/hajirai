import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { Page, Layout, Card, BlockStack, TextField, Select, Button, Banner, Text, Box, Link } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
    chatServerUrl: config.chatServerUrl,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const data = {};

  const anthropicKey = formData.get("anthropicApiKey");
  if (anthropicKey !== null && anthropicKey !== "") {
    data.anthropicApiKey = anthropicKey;
  }

  const model = formData.get("anthropicModel");
  if (model) data.anthropicModel = model;

  const yotpoKey = formData.get("yotpoApiKey");
  if (yotpoKey !== null && yotpoKey !== "") {
    data.yotpoApiKey = yotpoKey;
  }

  const aftershipKey = formData.get("aftershipApiKey");
  if (aftershipKey !== null && aftershipKey !== "") {
    data.aftershipApiKey = aftershipKey;
  }

  const chatUrl = formData.get("chatServerUrl");
  if (chatUrl !== null) {
    data.chatServerUrl = chatUrl;
  }

  if (Object.keys(data).length > 0) {
    await updateShopConfig(session.shop, data);
  }

  return { success: true };
};

export default function ApiKeys() {
  const { hasAnthropicKey, anthropicModel, hasYotpoKey, hasAftershipKey, chatServerUrl } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <Page title="API Keys" backAction={{ url: "/app" }}>
      <TitleBar title="API Keys" />
      <Form method="post">
        <BlockStack gap="500">
          {actionData?.success && (
            <Banner title="Settings saved" tone="success" onDismiss={() => {}} />
          )}

          <Layout>
            <Layout.AnnotatedSection
              title="Anthropic API Key"
              description="Required. Powers the AI chat assistant. Get your key from console.anthropic.com"
            >
              <Card>
                <BlockStack gap="400">
                  <Banner tone={hasAnthropicKey ? "success" : "warning"}>
                    <p>{hasAnthropicKey ? "API key is configured" : "No API key set — the chat assistant won't work until you add one"}</p>
                  </Banner>
                  <TextField
                    label="Anthropic API Key"
                    name="anthropicApiKey"
                    type="password"
                    placeholder={hasAnthropicKey ? "••••••••••••••••" : "sk-ant-api03-..."}
                    autoComplete="off"
                    helpText="Your key is encrypted and stored securely. Leave blank to keep the existing key."
                  />
                  <Select
                    label="Claude Model"
                    name="anthropicModel"
                    options={[
                      { label: "Claude Sonnet 4 (recommended)", value: "claude-sonnet-4-20250514" },
                      { label: "Claude Haiku 4.5 (faster, cheaper)", value: "claude-haiku-4-5-20251001" },
                      { label: "Claude Opus 4 (most capable)", value: "claude-opus-4-20250514" },
                    ]}
                    value={anthropicModel}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Chat Server URL"
              description="The URL of your deployed chat server. This handles AI conversations."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Chat Server URL"
                    name="chatServerUrl"
                    defaultValue={chatServerUrl}
                    autoComplete="off"
                    placeholder="https://your-server.railway.app"
                    helpText="Your Express.js chat server URL (deployed on Railway, Fly.io, etc.)"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Integrations (Optional)"
              description="Connect third-party services for enhanced features like product reviews and return data."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Yotpo API Key"
                    name="yotpoApiKey"
                    type="password"
                    placeholder={hasYotpoKey ? "••••••••••••••••" : "Optional — for product reviews"}
                    autoComplete="off"
                    helpText="Enables the AI to reference product reviews and sizing feedback"
                  />
                  <TextField
                    label="Aftership API Key"
                    name="aftershipApiKey"
                    type="password"
                    placeholder={hasAftershipKey ? "••••••••••••••••" : "Optional — for return/fit data"}
                    autoComplete="off"
                    helpText="Enables fit intelligence from return reason data"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <Box paddingBlockEnd="800">
            <Button variant="primary" submit loading={saving}>
              Save API Keys
            </Button>
          </Box>
        </BlockStack>
      </Form>
    </Page>
  );
}
