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
    supportUrl: config.supportUrl || "",
    supportLabel: config.supportLabel || "",
    trackingPageUrl: config.trackingPageUrl || "",
    promptCaching: config.promptCaching === true,
    klaviyoFormId: config.klaviyoFormId || "",
    klaviyoCompanyId: config.klaviyoCompanyId || "",
    klaviyoListId: config.klaviyoListId || "",
    vipModeEnabled: config.vipModeEnabled === true,
    showLoginPill: config.showLoginPill !== false,
    hasKlaviyoPrivateKey: config.klaviyoPrivateKey !== "",
    hasYotpoLoyaltyKey: config.yotpoLoyaltyApiKey !== "",
    yotpoLoyaltyGuid: config.yotpoLoyaltyGuid || "",
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

  const supportUrl = formData.get("supportUrl");
  if (supportUrl !== null) data.supportUrl = supportUrl.trim();

  const supportLabel = formData.get("supportLabel");
  if (supportLabel !== null) data.supportLabel = supportLabel.trim();

  const trackingPageUrl = formData.get("trackingPageUrl");
  if (trackingPageUrl !== null) data.trackingPageUrl = trackingPageUrl.trim();

  const klaviyoFormId = formData.get("klaviyoFormId");
  if (klaviyoFormId !== null) data.klaviyoFormId = klaviyoFormId.trim();
  const klaviyoCompanyId = formData.get("klaviyoCompanyId");
  if (klaviyoCompanyId !== null) data.klaviyoCompanyId = klaviyoCompanyId.trim();
  const klaviyoListId = formData.get("klaviyoListId");
  if (klaviyoListId !== null) data.klaviyoListId = klaviyoListId.trim();

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

  const cachingToggle = formData.get("promptCaching");
  if (cachingToggle !== null) data.promptCaching = cachingToggle === "true";

  const vipToggle = formData.get("vipModeEnabled");
  if (vipToggle !== null) data.vipModeEnabled = vipToggle === "true";

  const loginPillToggle = formData.get("showLoginPill");
  if (loginPillToggle !== null) data.showLoginPill = loginPillToggle === "true";

  const klaviyoPrivateKey = formData.get("klaviyoPrivateKey");
  if (klaviyoPrivateKey !== null && klaviyoPrivateKey !== "") {
    data.klaviyoPrivateKey = klaviyoPrivateKey;
  }

  const yotpoLoyaltyKey = formData.get("yotpoLoyaltyApiKey");
  if (yotpoLoyaltyKey !== null && yotpoLoyaltyKey !== "") {
    data.yotpoLoyaltyApiKey = yotpoLoyaltyKey;
  }

  const yotpoLoyaltyGuid = formData.get("yotpoLoyaltyGuid");
  if (yotpoLoyaltyGuid !== null) data.yotpoLoyaltyGuid = yotpoLoyaltyGuid.trim();

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
  const { hasAnthropicKey, anthropicModel, modelStrategy, showFollowUps: initFollowUps, showFeedback: initFeedback, hasYotpoKey, hasAftershipKey, hideOnUrls, supportUrl: initSupportUrl, supportLabel: initSupportLabel, trackingPageUrl: initTrackingPageUrl, promptCaching: initCaching, klaviyoFormId: initKlaviyoFormId, klaviyoCompanyId: initKlaviyoCompanyId, klaviyoListId: initKlaviyoListId, vipModeEnabled: initVipMode, showLoginPill: initShowLoginPill, hasKlaviyoPrivateKey, hasYotpoLoyaltyKey, yotpoLoyaltyGuid: initYotpoLoyaltyGuid } = useLoaderData();
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
  const [supportUrl, setSupportUrl] = useState(initSupportUrl);
  const [supportLabel, setSupportLabel] = useState(initSupportLabel);
  const [trackingPageUrl, setTrackingPageUrl] = useState(initTrackingPageUrl);
  const [caching, setCaching] = useState(initCaching);
  const [klaviyoFormId, setKlaviyoFormId] = useState(initKlaviyoFormId);
  const [klaviyoCompanyId, setKlaviyoCompanyId] = useState(initKlaviyoCompanyId);
  const [klaviyoListId, setKlaviyoListId] = useState(initKlaviyoListId);
  const [vipMode, setVipMode] = useState(initVipMode);
  const [showLoginPill, setShowLoginPill] = useState(initShowLoginPill);
  const [klaviyoPrivateKey, setKlaviyoPrivateKey] = useState("");
  const [yotpoLoyaltyKey, setYotpoLoyaltyKey] = useState("");
  const [yotpoLoyaltyGuidState, setYotpoLoyaltyGuidState] = useState(initYotpoLoyaltyGuid);

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
                  <Divider />
                  <Checkbox
                    label="Prompt caching"
                    checked={caching}
                    onChange={setCaching}
                    helpText="Caches the system prompt across requests so repeat messages cost up to 90% less on input tokens. Recommended for stores with 1,000+ monthly conversations."
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Support link"
              description="When a customer asks for help or customer service, the AI shows a 'Visit Support Hub' button linking to this URL."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Support page URL"
                    value={supportUrl}
                    onChange={setSupportUrl}
                    placeholder="https://yourstore.com/pages/contact"
                    autoComplete="off"
                    helpText="Leave blank to disable the support button."
                  />
                  <TextField
                    label="Button label (optional)"
                    value={supportLabel}
                    onChange={setSupportLabel}
                    placeholder="Visit Support Hub"
                    autoComplete="off"
                    helpText="Defaults to 'Visit Support Hub' if left blank."
                  />
                  <TextField
                    label="Order tracking page URL"
                    value={trackingPageUrl}
                    onChange={setTrackingPageUrl}
                    placeholder="https://orders.yourstore.com"
                    autoComplete="off"
                    helpText="AfterShip, Parcel Panel, or any branded tracking page. When set, logged-in customers get a tracking link to this page instead of the raw carrier URL. The AI appends the tracking number automatically."
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
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm">Yotpo Loyalty &amp; Referrals</Text>
                      <Badge tone={hasYotpoLoyaltyKey ? "success" : undefined}>
                        {hasYotpoLoyaltyKey ? "Connected" : "Not set"}
                      </Badge>
                    </InlineStack>
                    <TextField
                      label="Yotpo Loyalty API key"
                      type="password"
                      value={yotpoLoyaltyKey}
                      onChange={setYotpoLoyaltyKey}
                      placeholder={hasYotpoLoyaltyKey ? "••••••••••••••••" : "Paste key to enable loyalty VIP perks"}
                      autoComplete="off"
                      helpText="From Yotpo Loyalty admin → Program Settings → API Key. Lets the AI reference the customer's points, tier, and referral link when VIP mode is on."
                    />
                    <TextField
                      label="Yotpo Loyalty GUID"
                      value={yotpoLoyaltyGuidState}
                      onChange={setYotpoLoyaltyGuidState}
                      placeholder="Optional — GUID from Program Settings"
                      autoComplete="off"
                      helpText="Optional. Some Yotpo accounts require the GUID alongside the API key. Leave blank if your API key works alone."
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

                  <Divider />

                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Klaviyo</Text>
                      <Badge tone={hasKlaviyoPrivateKey ? "success" : undefined}>
                        {hasKlaviyoPrivateKey ? "Enrichment on" : "Signup only"}
                      </Badge>
                    </InlineStack>
                    <TextField
                      label="Company ID (public API key)"
                      value={klaviyoCompanyId}
                      onChange={setKlaviyoCompanyId}
                      placeholder="AbC123"
                      autoComplete="off"
                      helpText="Found in Klaviyo → Settings → API Keys → Public API Key. Used for the in-chat signup form."
                    />
                    <TextField
                      label="List ID"
                      value={klaviyoListId}
                      onChange={setKlaviyoListId}
                      placeholder="XyZ789"
                      autoComplete="off"
                      helpText="The list to subscribe to. Found in Klaviyo → Audience → Lists → click your list → ID in the URL."
                    />
                    <TextField
                      label="Private API key"
                      type="password"
                      value={klaviyoPrivateKey}
                      onChange={setKlaviyoPrivateKey}
                      placeholder={hasKlaviyoPrivateKey ? "••••••••••••••••" : "pk_..."}
                      autoComplete="off"
                      helpText="Optional. Required for VIP mode enrichment — lets the AI see logged-in customers' Klaviyo segments (e.g. VIP, Winback). Klaviyo → Settings → API Keys → Create Private API Key (scopes: profiles:read, segments:read)."
                    />
                  </BlockStack>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="VIP customer experience"
              description="Personalize the chat for logged-in customers using their order history and profile."
            >
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label="Show login pill in chat header"
                    checked={showLoginPill}
                    onChange={setShowLoginPill}
                    helpText="Adds a 'Login' button next to the menu for anonymous visitors, and 'Hi [name]!' for logged-in customers."
                  />
                  <Checkbox
                    label="Enable VIP mode for logged-in customers"
                    checked={vipMode}
                    onChange={setVipMode}
                    helpText="Gives the AI access to the customer's order history, lifetime spend, and tags so it can deliver a more personalized experience. No PII (email, address, payment) is ever exposed in chat."
                  />
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
          <input type="hidden" name="supportUrl" value={supportUrl} />
          <input type="hidden" name="supportLabel" value={supportLabel} />
          <input type="hidden" name="trackingPageUrl" value={trackingPageUrl} />
          <input type="hidden" name="promptCaching" value={String(caching)} />
          <input type="hidden" name="klaviyoFormId" value={klaviyoFormId} />
          <input type="hidden" name="klaviyoCompanyId" value={klaviyoCompanyId} />
          <input type="hidden" name="klaviyoListId" value={klaviyoListId} />
          <input type="hidden" name="vipModeEnabled" value={String(vipMode)} />
          <input type="hidden" name="showLoginPill" value={String(showLoginPill)} />
          <input type="hidden" name="klaviyoPrivateKey" value={klaviyoPrivateKey} />
          <input type="hidden" name="yotpoLoyaltyApiKey" value={yotpoLoyaltyKey} />
          <input type="hidden" name="yotpoLoyaltyGuid" value={yotpoLoyaltyGuidState} />

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
