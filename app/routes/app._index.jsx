import { useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  InlineGrid,
  Box,
  Button,
  Icon,
  Badge,
  Banner,
  Divider,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles, updateShopConfig } from "../models/ShopConfig.server";
import { getCatalogSyncState, syncCatalogAsync } from "../models/Product.server";
import { countEnrichmentsByShop } from "../models/ProductEnrichment.server";
import { getUsageSummary } from "../models/ChatUsage.server";
import { getFeedbackSummary } from "../models/ChatFeedback.server";
import seosLogo from "../assets/SEoS.png";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [config, files, syncState, enrichmentCount, usage, feedback] = await Promise.all([
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    getCatalogSyncState(session.shop),
    countEnrichmentsByShop(session.shop),
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
  ]);

  if (!syncState.lastSyncedAt && syncState.status !== "running") {
    syncCatalogAsync(admin, session.shop);
  }

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rateLimitHits = config.rateLimitHitsMonth === currentMonth ? (config.rateLimitHits || 0) : 0;

  // The chat widget pings /widget-config on every storefront page load when
  // the app embed is enabled. If we've heard from it in the last 7 days, the
  // embed is currently active in the merchant's theme. 7 days tolerates a
  // store with very low traffic without flipping back to "undone" the moment
  // a quiet weekend passes.
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const widgetEnabled =
    Boolean(config.lastWidgetSeenAt) &&
    Date.now() - new Date(config.lastWidgetSeenAt).getTime() < SEVEN_DAYS;

  return {
    hasApiKey: config.anthropicApiKey !== "",
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
    widgetEnabled,
    productsCount: syncState.productsCount || 0,
    enrichmentCount,
    totalCost: usage.totalCost,
    totalMessages: usage.totalMessages,
    avgCostPerMessage: usage.avgCostPerMessage,
    feedbackTotal: feedback.total,
    satisfactionRate: feedback.satisfactionRate,
    modelStrategy: config.modelStrategy || "smart",
    rateLimitHits,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "dismiss_rate_limit") {
    await updateShopConfig(session.shop, { rateLimitHits: 0, rateLimitHitsMonth: "" });
    return { dismissed: true };
  }
  return null;
};

function StepCircle({ done, number }) {
  if (done) {
    return (
      <div style={{ width: "28px", height: "28px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#2D6B4F" }}>
        <Icon source={CheckCircleIcon} tone="success" />
      </div>
    );
  }
  return (
    <div style={{
      width: "28px", height: "28px", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: "50%", background: "var(--p-color-bg-surface-secondary)",
      border: "1px solid var(--p-color-border)",
    }}>
      <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
        {number}
      </Text>
    </div>
  );
}

function ChecklistItem({ done, number, title, description, actionLabel, actionUrl, external }) {
  return (
    <Box
      background={done ? "bg-surface-success-subdued" : "bg-surface"}
      borderRadius="300"
      borderWidth="025"
      borderColor={done ? "border-success-subdued" : "border"}
      padding="400"
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <StepCircle done={done} number={number} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{title}</Text>
              {done && <Badge tone="success">Done</Badge>}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
          </BlockStack>
        </div>
        <div style={{ flexShrink: 0 }}>
          <Button url={actionUrl} external={external} variant={done ? "plain" : "primary"}>
            {actionLabel}
          </Button>
        </div>
      </div>
    </Box>
  );
}

function FeatureCard({ icon, title, description, stat }) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <div style={{
            width: "36px", height: "36px", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: "10px", background: "rgba(45,107,79,0.1)",
            fontSize: "18px",
          }}>
            {icon}
          </div>
          <Text as="h3" variant="headingSm">{title}</Text>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
        {stat && (
          <Box paddingBlockStart="100">
            <Badge tone="info">{stat}</Badge>
          </Box>
        )}
      </BlockStack>
    </Card>
  );
}

function formatCost(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function MetricTile({ label, value, sublabel }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel ? <Text as="p" tone="subdued" variant="bodySm">{sublabel}</Text> : null}
      </BlockStack>
    </Card>
  );
}

export default function Home() {
  const {
    hasApiKey, fileCount, shop, themeEditorUrl, widgetEnabled,
    productsCount, enrichmentCount, totalCost, totalMessages, avgCostPerMessage,
    feedbackTotal, satisfactionRate, modelStrategy, rateLimitHits,
  } = useLoaderData();

  const rateFetcher = useFetcher();
  const rateDismissed = rateFetcher.state !== "idle" || rateFetcher.data?.dismissed;
  const showRateLimit = rateLimitHits > 0 && !rateDismissed;

  const strategyLabel = modelStrategy === "smart"
    ? "Smart routing"
    : modelStrategy === "always-haiku"
      ? "Always Fast"
      : modelStrategy === "always-opus"
        ? "Always Advanced"
        : "Always Standard";

  return (
    <Page>
      <TitleBar title="SEoS Assistant" />
      <BlockStack gap="600">
        <div style={{
          background: "linear-gradient(135deg, #2D6B4F 0%, #3a8a66 100%)",
          borderRadius: "12px", padding: "24px 28px", marginTop: "-8px",
        }}>
          <InlineStack align="start" blockAlign="center" wrap gap="500">
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <BlockStack gap="200">
                <Text as="h1" variant="headingXl">
                  <span style={{ color: "#fff" }}>SEoS Assistant</span>
                </Text>
                <Text as="p" variant="bodyMd">
                  <span style={{ color: "rgba(255,255,255,0.85)" }}>Search Engine on Steroids</span>
                </Text>
                {(totalMessages > 0 || showRateLimit) && (
                  <Box paddingBlockStart="100">
                    <InlineStack align="start" gap="200" wrap>
                      {totalMessages > 0 && (
                        <Badge tone="info">{totalMessages} conversations this month</Badge>
                      )}
                      {showRateLimit && (
                        <Badge tone={rateLimitHits >= 10 ? "critical" : "attention"}>
                          {rateLimitHits} rate-limited {rateLimitHits === 1 ? "request" : "requests"}
                        </Badge>
                      )}
                    </InlineStack>
                  </Box>
                )}
              </BlockStack>
            </div>
            <div style={{ flex: "0 0 auto", marginLeft: "auto", display: "flex", alignItems: "center" }}>
              <img
                src={seosLogo}
                alt="SEoS"
                style={{ display: "block", maxWidth: "180px", maxHeight: "140px", width: "auto", height: "auto" }}
              />
            </div>
          </InlineStack>
        </div>

        {showRateLimit && (
          <Banner
            title={rateLimitHits >= 10 ? "Customers are being turned away" : "Some customers hit the AI rate limit"}
            tone={rateLimitHits >= 10 ? "critical" : "warning"}
            action={{ content: "Increase limits", url: "https://console.anthropic.com/settings/limits", external: true }}
            secondaryAction={{ content: "Dismiss", onAction: () => rateFetcher.submit({ intent: "dismiss_rate_limit" }, { method: "post" }) }}
            onDismiss={() => rateFetcher.submit({ intent: "dismiss_rate_limit" }, { method: "post" })}
          >
            <Text as="p" variant="bodySm">
              {rateLimitHits} {rateLimitHits === 1 ? "request was" : "requests were"} rate-limited this month.
              {rateLimitHits >= 10
                ? " Your Anthropic API tier is too low for your traffic. Add credits at console.anthropic.com to auto-upgrade."
                : " This happens when many customers chat simultaneously. If this keeps growing, consider upgrading your Anthropic API tier."}
            </Text>
          </Banner>
        )}

        {hasApiKey ? (
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">Last 30 days</Text>
              <Button url="/app/analytics" variant="plain">View detailed analytics</Button>
            </InlineStack>
            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              <MetricTile
                label="Conversations"
                value={String(totalMessages)}
                sublabel={totalMessages > 0 ? `Avg ${formatCost(avgCostPerMessage)} / msg` : "Awaiting first chat"}
              />
              <MetricTile
                label="Satisfaction"
                value={feedbackTotal > 0 ? `${satisfactionRate}%` : "—"}
                sublabel={feedbackTotal > 0 ? `${feedbackTotal} ratings` : "Awaiting feedback"}
              />
              <MetricTile
                label="AI cost"
                value={formatCost(totalCost)}
                sublabel="Anthropic API spend"
              />
              <MetricTile
                label="Rate-limit hits"
                value={String(rateLimitHits)}
                sublabel={rateLimitHits > 0 ? "Increase your Anthropic tier" : "Within limits"}
              />
            </InlineGrid>
          </BlockStack>
        ) : null}

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">What SEoS Assistant does for you</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Everything runs automatically — just connect your account and let the AI handle customer questions.
          </Text>
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
            <FeatureCard
              icon={"\uD83D\uDCE6"}
              title="Knows your products"
              description="Your entire catalog — products, prices, sizes, and availability — is always up to date. Any changes you make in Shopify are reflected instantly."
              stat={productsCount > 0 ? `${productsCount} products synced` : null}
            />
            <FeatureCard
              icon={"\uD83D\uDCCB"}
              title="Learns your extra info"
              description="Upload files with FAQs, sizing guides, care instructions, or brand info. The AI uses this to give more detailed, personalized answers."
              stat={enrichmentCount > 0 ? `${enrichmentCount} products enriched` : null}
            />
            <FeatureCard
              icon={"\uD83D\uDD0D"}
              title="Finds the right products"
              description="When a customer asks about a product, the AI searches your catalog in real time — by name, category, price, or any detail you've uploaded."
            />
            <FeatureCard
              icon={"\u26A1"}
              title="Keeps costs low"
              description="Quick replies like 'thanks' or 'okay' use a faster, cheaper model. Detailed product questions use the full-powered model. You save without lifting a finger."
              stat={strategyLabel}
            />
          </InlineGrid>
        </BlockStack>

        <Divider />

        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="center">
            <Text as="h2" variant="headingMd">Setup checklist</Text>
            {hasApiKey ? (
              <Badge tone="success">Ready</Badge>
            ) : (
              <Badge tone="attention">Action needed</Badge>
            )}
          </InlineStack>

          <BlockStack gap="300">
            <ChecklistItem
              done={hasApiKey}
              number="1"
              title="Connect the AI engine"
              description="Paste your API key to power the AI assistant. Pay-as-you-go — you only pay for what you use."
              actionLabel={hasApiKey ? "Manage" : "Add key"}
              actionUrl="/app/api-keys"
            />
            <ChecklistItem
              done={widgetEnabled}
              number="2"
              title="Enable the chat widget"
              description={
                widgetEnabled
                  ? "Your storefront is loading the chat widget. Use the theme editor to adjust appearance and content."
                  : "Turn on the SEoS Assistant chat block in your active Shopify theme so customers see it on your storefront."
              }
              actionLabel={widgetEnabled ? "Customize" : "Open theme editor"}
              actionUrl={themeEditorUrl}
              external
            />
            <ChecklistItem
              done={fileCount > 0}
              number="3"
              title="Upload extra knowledge (optional)"
              description="FAQs, brand voice, sizing guides, product specs — CSV files with a SKU column are automatically linked to your catalog."
              actionLabel={fileCount > 0 ? "Manage files" : "Upload"}
              actionUrl="/app/rules-knowledge"
            />
          </BlockStack>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">About SEoS Assistant</Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>Version:</strong> 1.0.0</Text>
                <Text as="p" variant="bodySm"><strong>AI Engine:</strong> Anthropic Claude</Text>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>UTM Tracking:</strong> All product links include utm_source=shopagent</Text>
                <Text as="p" variant="bodySm"><strong>Privacy:</strong> Feedback data hashed, auto-deleted after 90 days</Text>
                <Text as="p" variant="bodySm"><strong>Billing:</strong> Pay-as-you-go AI usage — no markup</Text>
              </BlockStack>
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
