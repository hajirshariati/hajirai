import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Banner,
  Box,
  Text,
  Icon,
  Badge,
  Divider,
} from "@shopify/polaris";
import { KeyIcon, CheckCircleIcon, AlertTriangleIcon } from "@shopify/polaris-icons";
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

  if (Object.keys(data).length > 0) {
    await updateShopConfig(session.shop, data);
  }

  return { success: true };
};

function ConnectionStatus({ connected }) {
  return connected ? (
    <InlineStack gap="150" blockAlign="center">
      <Icon source={CheckCircleIcon} tone="success" />
      <Text as="span" variant="bodySm" tone="success">Connected</Text>
    </InlineStack>
  ) : (
    <InlineStack gap="150" blockAlign="center">
      <Icon source={AlertTriangleIcon} tone="caution" />
      <Text as="span" variant="bodySm" tone="caution">Not configured</Text>
    </InlineStack>
  );
}

export default function ApiKeys() {
  const { hasAnthropicKey, anthropicModel, hasYotpoKey, hasAftershipKey } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [anthropicKey, setAnthropicKey] = useState("");
  const [model, setModel] = useState(anthropicModel || "claude-sonnet-4-20250514");
  const [yotpoKey, setYotpoKey] = useState("");
  const [aftershipKey, setAftershipKey] = useState("");

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
              title="Anthropic (required)"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Powers the AI chat assistant. Without this key, the widget won't respond to customers.
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Get your key from{" "}
                    <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
                      console.anthropic.com
                    </a>
                    .
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={KeyIcon} tone="base" />
                      <Text as="h3" variant="headingSm">Anthropic API Key</Text>
                    </InlineStack>
                    <ConnectionStatus connected={hasAnthropicKey} />
                  </InlineStack>

                  <TextField
                    label="API key"
                    type="password"
                    value={anthropicKey}
                    onChange={setAnthropicKey}
                    placeholder={hasAnthropicKey ? "••••••••••••••••" : "sk-ant-api03-..."}
                    autoComplete="off"
                    helpText="Encrypted at rest. Leave blank to keep your existing key."
                  />

                  <Divider />

                  <Select
                    label="Claude model"
                    options={[
                      { label: "Claude Sonnet 4 — recommended", value: "claude-sonnet-4-20250514" },
                      { label: "Claude Haiku 4.5 — faster, cheaper", value: "claude-haiku-4-5-20251001" },
                      { label: "Claude Opus 4 — most capable", value: "claude-opus-4-20250514" },
                    ]}
                    value={model}
                    onChange={setModel}
                    helpText="Sonnet is the sweet spot of quality, speed, and cost."
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Integrations (optional)"
              description="Connect third-party services to unlock richer context — product reviews, sizing feedback, and return-reason data."
            >
              <Card>
                <BlockStack gap="500">
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Yotpo</Text>
                      <Badge tone={hasYotpoKey ? "success" : undefined}>
                        {hasYotpoKey ? "Connected" : "Not set"}
                      </Badge>
                    </InlineStack>
                    <TextField
                      label="Yotpo API key"
                      labelHidden
                      type="password"
                      value={yotpoKey}
                      onChange={setYotpoKey}
                      placeholder={hasYotpoKey ? "••••••••••••••••" : "Paste key to enable"}
                      autoComplete="off"
                      helpText="Lets the AI reference product reviews and customer sizing feedback."
                    />
                  </BlockStack>

                  <Divider />

                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Aftership</Text>
                      <Badge tone={hasAftershipKey ? "success" : undefined}>
                        {hasAftershipKey ? "Connected" : "Not set"}
                      </Badge>
                    </InlineStack>
                    <TextField
                      label="Aftership API key"
                      labelHidden
                      type="password"
                      value={aftershipKey}
                      onChange={setAftershipKey}
                      placeholder={hasAftershipKey ? "••••••••••••••••" : "Paste key to enable"}
                      autoComplete="off"
                      helpText="Enables fit intelligence and sizing guidance from return-reason data."
                    />
                  </BlockStack>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <input type="hidden" name="anthropicApiKey" value={anthropicKey} />
          <input type="hidden" name="anthropicModel" value={model} />
          <input type="hidden" name="yotpoApiKey" value={yotpoKey} />
          <input type="hidden" name="aftershipApiKey" value={aftershipKey} />

          <Box paddingBlockEnd="800">
            <InlineStack align="end">
              <Button variant="primary" submit loading={saving}>
                Save changes
              </Button>
            </InlineStack>
          </Box>
        </BlockStack>
      </Form>
    </Page>
  );
}
