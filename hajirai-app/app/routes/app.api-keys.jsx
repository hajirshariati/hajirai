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
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    modelStrategy: config.modelStrategy || "smart",
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

  const strategy = formData.get("modelStrategy");
  if (strategy) data.modelStrategy = strategy;

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
    <Badge tone="attention">Not configured</Badge>
  );
}

const MODEL_OPTIONS = [
  { label: "Claude Sonnet 4 — recommended", value: "claude-sonnet-4-20250514" },
  { label: "Claude Haiku 4.5 — faster, cheaper", value: "claude-haiku-4-5-20251001" },
  { label: "Claude Opus 4 — most capable", value: "claude-opus-4-20250514" },
];

const STRATEGY_OPTIONS = [
  { label: "Smart routing (recommended)", value: "smart" },
  { label: "Always use Sonnet 4", value: "always-sonnet" },
  { label: "Always use Haiku 4.5", value: "always-haiku" },
  { label: "Always use Opus 4", value: "always-opus" },
];

const STRATEGY_HELP = {
  smart: "Uses Haiku ($1/M tokens) for simple follow-ups like \"thanks\" or \"ok\", and Sonnet ($3/M) for product questions and complex queries. Best balance of cost and quality.",
  "always-sonnet": "Every message uses Sonnet 4 ($3/M input, $15/M output). Consistent quality for all conversations.",
  "always-haiku": "Every message uses Haiku 4.5 ($1/M input, $5/M output). Lowest cost, good for high-volume stores with simple products.",
  "always-opus": "Every message uses Opus 4 ($15/M input, $75/M output). Maximum capability for complex product catalogs.",
};

export default function ApiKeys() {
  const { hasAnthropicKey, anthropicModel, modelStrategy, hasYotpoKey, hasAftershipKey } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [anthropicKey, setAnthropicKey] = useState("");
  const [model, setModel] = useState(anthropicModel || "claude-sonnet-4-20250514");
  const [strategy, setStrategy] = useState(modelStrategy);
  const [yotpoKey, setYotpoKey] = useState("");
  const [aftershipKey, setAftershipKey] = useState("");

  return (
    <Page title="API Keys & Model Settings" backAction={{ url: "/app" }}>
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
                    Powers the AI assistant. You pay Anthropic directly for usage — ShopAgent adds no markup.
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
                    <Text as="h3" variant="headingSm">API Key</Text>
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
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Model routing"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Control which Claude model handles customer messages. Smart routing saves money by using
                    a cheaper model for simple interactions.
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="Primary model"
                    options={MODEL_OPTIONS}
                    value={model}
                    onChange={setModel}
                    helpText="Used for product questions, first messages, and complex queries."
                  />

                  <Divider />

                  <Select
                    label="Routing strategy"
                    options={STRATEGY_OPTIONS}
                    value={strategy}
                    onChange={setStrategy}
                    helpText={STRATEGY_HELP[strategy]}
                  />

                  {strategy === "smart" && (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        <strong>How smart routing works:</strong> When a customer sends a simple follow-up
                        like "thanks", "ok", or "bye", ShopAgent uses Haiku 4.5 (up to 3x cheaper).
                        Product questions, first messages, and detailed queries always use your primary model.
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Integrations (optional)"
              description="Connect third-party services for richer AI context — product reviews, sizing data, and return insights."
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
          <input type="hidden" name="modelStrategy" value={strategy} />
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
