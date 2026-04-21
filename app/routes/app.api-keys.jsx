import { useLoaderData, useActionData, useNavigation, Form, useFetcher } from "react-router";
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
  Checkbox,
  Tag,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  let hideOnUrls = [];
  try { hideOnUrls = JSON.parse(config.hideOnUrls || "[]"); } catch { hideOnUrls = []; }
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    modelStrategy: config.modelStrategy || "smart",
    showFollowUps: config.showFollowUps !== false,
    showFeedback: config.showFeedback !== false,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
    hideOnUrls,
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

  const hideUrlsRaw = formData.get("hideOnUrls");
  if (hideUrlsRaw !== null) {
    try {
      const parsed = JSON.parse(hideUrlsRaw);
      if (Array.isArray(parsed)) data.hideOnUrls = JSON.stringify(parsed);
    } catch { /* ignore invalid JSON */ }
  }

  const followUps = formData.get("showFollowUps");
  if (followUps !== null) data.showFollowUps = followUps === "true";

  const feedbackToggle = formData.get("showFeedback");
  if (feedbackToggle !== null) data.showFeedback = feedbackToggle === "true";

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
  { label: "Standard — recommended", value: "claude-sonnet-4-6" },
  { label: "Fast — lower cost", value: "claude-haiku-4-5-20251001" },
  { label: "Advanced — most capable", value: "claude-opus-4-20250514" },
];

const STRATEGY_OPTIONS = [
  { label: "Smart routing (recommended)", value: "smart" },
  { label: "Always use Standard", value: "always-sonnet" },
  { label: "Always use Fast", value: "always-haiku" },
  { label: "Always use Advanced", value: "always-opus" },
];

const STRATEGY_HELP = {
  smart: "Uses the Fast model for simple follow-ups like \"thanks\" or \"ok\", and the Standard model for product questions and complex queries. Best balance of cost and quality.",
  "always-sonnet": "Every message uses the Standard model. Consistent quality for all conversations.",
  "always-haiku": "Every message uses the Fast model. Lowest cost, good for high-volume stores with simple products.",
  "always-opus": "Every message uses the Advanced model. Maximum capability for complex product catalogs.",
};

function HideUrlsPanel({ initial }) {
  const [rules, setRules] = useState(initial || []);
  const [matchType, setMatchType] = useState("equals");
  const [pattern, setPattern] = useState("");

  const addRule = () => {
    const p = pattern.trim();
    if (!p) return;
    const exists = rules.some((r) => r.matchType === matchType && r.pattern === p);
    if (exists) return;
    setRules([...rules, { matchType, pattern: p }]);
    setPattern("");
  };

  const removeRule = (idx) => {
    setRules(rules.filter((_, i) => i !== idx));
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Hide widget on specific pages</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            The chat widget will be hidden on pages matching any of these rules. Use "equals" for exact path matches or "contains" for substring matches (e.g. all pages starting with a prefix).
          </Text>
        </BlockStack>

        {rules.length > 0 && (
          <BlockStack gap="200">
            {rules.map((r, i) => (
              <InlineStack key={i} gap="200" blockAlign="center">
                <Badge tone={r.matchType === "contains" ? "attention" : "info"}>
                  {r.matchType === "contains" ? "Contains" : "Equals"}
                </Badge>
                <Text as="span" variant="bodyMd"><code>{r.pattern}</code></Text>
                <Button variant="plain" tone="critical" onClick={() => removeRule(i)}>Remove</Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        <Divider />

        <InlineStack gap="200" blockAlign="end" wrap={false}>
          <div style={{ minWidth: 130 }}>
            <Select
              label="Match type"
              options={[
                { label: "URL equals", value: "equals" },
                { label: "URL contains", value: "contains" },
              ]}
              value={matchType}
              onChange={setMatchType}
            />
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="URL pattern"
              value={pattern}
              onChange={setPattern}
              placeholder="/pages/technology"
              autoComplete="off"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRule(); } }}
            />
          </div>
          <Button onClick={addRule} disabled={!pattern.trim()}>Add</Button>
        </InlineStack>

        <input type="hidden" name="hideOnUrls" value={JSON.stringify(rules)} />
      </BlockStack>
    </Card>
  );
}

export default function ApiKeys() {
  const { hasAnthropicKey, anthropicModel, modelStrategy, showFollowUps: initFollowUps, showFeedback: initFeedback, hasYotpoKey, hasAftershipKey, hideOnUrls } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [anthropicKey, setAnthropicKey] = useState("");
  const [model, setModel] = useState(anthropicModel || "claude-sonnet-4-6");
  const [strategy, setStrategy] = useState(modelStrategy);
  const [followUps, setFollowUps] = useState(initFollowUps);
  const [feedbackOn, setFeedbackOn] = useState(initFeedback);
  const [yotpoKey, setYotpoKey] = useState("");
  const [aftershipKey, setAftershipKey] = useState("");

  return (
    <Page title="Settings" backAction={{ url: "/app" }}>
      <TitleBar title="Settings" />
      <Form method="post">
        <BlockStack gap="500">
          <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)" }} />
          {actionData?.success && (
            <Banner title="Settings saved" tone="success" onDismiss={() => {}} />
          )}

          <Layout>
            <Layout.AnnotatedSection
              title="AI Engine (required)"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Powers the AI assistant. Pay-as-you-go usage — ShopAgent adds no markup.
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
                      Get your API key here
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
                    placeholder={hasAnthropicKey ? "••••••••••••••••" : "Paste API key"}
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
                    Control which AI model handles customer messages. Smart routing saves money by using
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
                        like "thanks", "ok", or "bye", ShopAgent uses the Fast model (up to 3x cheaper).
                        Product questions, first messages, and detailed queries always use your primary model.
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Chat features"
              description="Toggle AI behaviors for the storefront chat widget."
            >
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label="Follow-up questions"
                    checked={followUps}
                    onChange={setFollowUps}
                    helpText="AI suggests 2-3 clickable follow-up questions after each response. Only suggests questions it can answer."
                  />
                  <Divider />
                  <Checkbox
                    label="Helpful / Not helpful feedback"
                    checked={feedbackOn}
                    onChange={setFeedbackOn}
                    helpText="Shows thumbs up/down on product responses. Negative feedback appears in Analytics with hashed user data."
                  />
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

            <Layout.AnnotatedSection
              title="Widget visibility"
              description="Control which pages the chat widget appears on. Add URL rules to hide the widget on specific pages."
            >
              <HideUrlsPanel initial={hideOnUrls} />
            </Layout.AnnotatedSection>
          </Layout>

          <input type="hidden" name="anthropicApiKey" value={anthropicKey} />
          <input type="hidden" name="anthropicModel" value={model} />
          <input type="hidden" name="modelStrategy" value={strategy} />
          <input type="hidden" name="showFollowUps" value={String(followUps)} />
          <input type="hidden" name="showFeedback" value={String(feedbackOn)} />
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
