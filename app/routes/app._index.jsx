import { useLoaderData, useFetcher, Link } from "react-router";
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
import { getConversionSummary } from "../models/ChatConversion.server";
import { listDecisionTrees } from "../models/DecisionTree.server";
import seosLogo from "../assets/SEoS.png";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [config, files, syncState, enrichmentCount, usage, feedback, conversions, decisionTrees] = await Promise.all([
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    getCatalogSyncState(session.shop),
    countEnrichmentsByShop(session.shop),
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
    getConversionSummary(session.shop, 30),
    listDecisionTrees(session.shop).catch(() => []),
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

  // Catalog freshness: anything older than 7 days suggests the
  // merchant changed inventory but the sync didn't run. Surfaces in
  // the home banner status cluster as 'Stale' to prompt a manual
  // sync from Catalog → Refresh.
  const lastSyncedAt = syncState.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toISOString()
    : null;
  const hoursSinceSync = lastSyncedAt
    ? Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 3_600_000)
    : null;

  // Recommender status: master toggle ON + at least one enabled
  // recommender row. The toggle alone isn't enough — a shop with
  // no enabled trees yet should show 'Off' on the cluster.
  const enabledRecommenderCount = (decisionTrees || []).filter((t) => t?.enabled).length;
  const recommenderActive =
    config.decisionTreeEnabled === true && enabledRecommenderCount > 0;

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
    conversionCount: conversions.count,
    conversionRevenue: conversions.revenue,
    conversionCurrency: conversions.currency,
    modelStrategy: config.modelStrategy || "smart",
    rateLimitHits,
    semanticEnabled: !!(config.embeddingProvider && (
      (config.embeddingProvider === "voyage" && config.voyageApiKey) ||
      (config.embeddingProvider === "openai" && config.openaiApiKey)
    )),
    semanticProvider: config.embeddingProvider || "",
    categoryGroupsCount: (() => {
      try { return (JSON.parse(config.categoryGroups || "[]") || []).length; } catch { return 0; }
    })(),
    // Status-cluster fields
    catalogSyncStatus: syncState.status || "idle",
    lastSyncedAt,
    hoursSinceSync,
    recommenderActive,
    enabledRecommenderCount,
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

function formatRevenue(n, currency) {
  const code = (currency && String(currency).trim()) || "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    }).format(n || 0);
  } catch {
    return `${code} ${(n || 0).toFixed(2)}`;
  }
}

// At-a-glance health row in the hero banner. Each chip shows the
// state of one infrastructure piece (catalog sync, semantic search,
// chat widget, recommender, AI key, knowledge base) with a tone the
// merchant can scan in <5 seconds. A chip in 'critical' or 'warning'
// tone tells them where to click. Doesn't affect any runtime
// behavior — purely a status surface.
function StatusCluster({ items }) {
  const TONE_BG = {
    success: "rgba(76, 175, 80, 0.18)",
    warning: "rgba(255, 193, 7, 0.22)",
    critical: "rgba(229, 62, 62, 0.22)",
    subdued: "rgba(255, 255, 255, 0.14)",
  };
  const TONE_DOT = {
    success: "#4caf50",
    warning: "#ffc107",
    critical: "#ff5252",
    subdued: "rgba(255,255,255,0.55)",
  };
  return (
    <Box paddingBlockStart="200">
      <InlineStack gap="200" wrap>
        {items.map((it) => {
          const chip = (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                borderRadius: 999,
                background: TONE_BG[it.tone] || TONE_BG.subdued,
                color: "#fff",
                fontSize: 12.5,
                fontWeight: 500,
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                border: "1px solid rgba(255,255,255,0.18)",
              }}
              title={it.tooltip || ""}
            >
              <span
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: TONE_DOT[it.tone] || TONE_DOT.subdued,
                  flexShrink: 0,
                  boxShadow: it.tone === "success" ? "0 0 6px rgba(76,175,80,0.6)" : "none",
                }}
                aria-hidden="true"
              />
              <span>
                <strong>{it.label}:</strong> {it.value}
              </span>
            </span>
          );
          if (!it.url) return <span key={it.label}>{chip}</span>;
          // External URLs (themeEditor, console.anthropic.com) need
          // target=_blank so they escape the embedded-admin iframe.
          // INTERNAL admin paths must NOT be a raw <a href> — that
          // triggers a full-page navigation, drops the App Bridge
          // session token, and Shopify bounces the merchant to the
          // 'Install from a Shopify-owned surface' fallback. Use
          // react-router Link (client-side nav, session preserved).
          if (it.external) {
            return (
              <a
                key={it.label}
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none" }}
              >
                {chip}
              </a>
            );
          }
          return (
            <Link
              key={it.label}
              to={it.url}
              style={{ textDecoration: "none" }}
            >
              {chip}
            </Link>
          );
        })}
      </InlineStack>
    </Box>
  );
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
    semanticEnabled, semanticProvider, categoryGroupsCount,
    conversionCount, conversionRevenue, conversionCurrency,
    catalogSyncStatus, lastSyncedAt, hoursSinceSync,
    recommenderActive, enabledRecommenderCount,
  } = useLoaderData();

  // Build the status-cluster items shown in the hero banner. Each
  // item has tone (success/warning/critical/subdued), short value
  // text, optional tooltip, and a click target (URL). Order is from
  // most-likely-to-need-attention down to nice-to-have.
  const statusItems = (() => {
    const items = [];
    items.push(
      hasApiKey
        ? { label: "AI", value: "Connected", tone: "success", url: "/app/api-keys", tooltip: "Anthropic API key configured." }
        : { label: "AI", value: "Missing key", tone: "critical", url: "/app/api-keys", tooltip: "Add your Anthropic API key to enable the chat." }
    );
    items.push(
      widgetEnabled
        ? { label: "Widget", value: "Live", tone: "success", url: themeEditorUrl, external: true, tooltip: "Storefront chat widget is loading on your theme." }
        : { label: "Widget", value: "Not enabled", tone: "warning", url: themeEditorUrl, external: true, tooltip: "Enable the SEoS Assistant block in your active theme." }
    );
    if (catalogSyncStatus === "running") {
      items.push({ label: "Catalog", value: "Syncing…", tone: "warning", url: "/app/catalog", tooltip: "Catalog sync currently in progress." });
    } else if (productsCount === 0) {
      items.push({ label: "Catalog", value: "Not synced", tone: "critical", url: "/app/catalog", tooltip: "No products synced yet. Run a manual sync." });
    } else if (hoursSinceSync !== null && hoursSinceSync > 168) {
      items.push({ label: "Catalog", value: `Stale (${Math.round(hoursSinceSync / 24)}d)`, tone: "warning", url: "/app/catalog", tooltip: `Last sync ${Math.round(hoursSinceSync / 24)} days ago. Run a refresh from the Catalog page.` });
    } else {
      items.push({ label: "Catalog", value: `${productsCount} synced`, tone: "success", url: "/app/catalog", tooltip: lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : "Synced." });
    }
    items.push(
      semanticEnabled
        ? { label: "Semantic", value: semanticProvider === "voyage" ? "Voyage AI" : "OpenAI", tone: "success", url: "/app/api-keys", tooltip: "Semantic search active. Customers find products by meaning, not just keywords." }
        : { label: "Semantic", value: "Off", tone: "subdued", url: "/app/api-keys", tooltip: "Optional. Add a Voyage AI or OpenAI key to enable meaning-based product matching." }
    );
    items.push(
      recommenderActive
        ? { label: "Recommenders", value: `${enabledRecommenderCount} active`, tone: "success", url: "/app/recommenders", tooltip: "Smart Recommender flow is live for at least one intent." }
        : { label: "Recommenders", value: "Off", tone: "subdued", url: "/app/recommenders", tooltip: "Optional. Configure a guided product finder for orthotics, mattresses, etc." }
    );
    items.push(
      fileCount > 0
        ? { label: "Knowledge", value: `${fileCount} file${fileCount > 1 ? "s" : ""}`, tone: "success", url: "/app/knowledge", tooltip: "Custom FAQs / brand info available to the AI." }
        : { label: "Knowledge", value: "None", tone: "subdued", url: "/app/knowledge", tooltip: "Optional. Upload FAQs or product specs the AI can reference." }
    );
    return items;
  })();

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
                <StatusCluster items={statusItems} />
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
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <MetricTile
                label="Chat-driven orders"
                value={String(conversionCount || 0)}
                sublabel={conversionCount > 0 ? `Tagged "SEoS" in Shopify` : "Awaiting first chat-attributed order"}
              />
              <MetricTile
                label="Chat-driven revenue"
                value={conversionCount > 0 ? formatRevenue(conversionRevenue, conversionCurrency) : "—"}
                sublabel={conversionCount > 0 ? `${conversionCount} order${conversionCount === 1 ? "" : "s"} attributed to chat` : "Tracked via the SEoS order tag"}
              />
            </InlineGrid>
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
            <FeatureCard
              icon={"🧭"}
              title="Guided product finders"
              description="For categories where the right pick depends on a few specific answers (orthotics, mattresses, supplements), a short Q&A walks the customer through and returns one deterministic product. Configure it on the Smart Recommenders page."
            />
            <FeatureCard
              icon={"🛡️"}
              title="Stays on track"
              description="Built-in guardrails catch off-topic questions, customer pivots, and impossible requests gracefully — the assistant never loops or pushes the wrong product when someone has clearly asked for something else."
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
              actionUrl="/app/knowledge"
            />
            <ChecklistItem
              done={categoryGroupsCount > 0}
              number="4"
              title="Define category groups (optional)"
              description="Group your catalog (e.g. Footwear / Orthotics / Accessories) so the AI never offers irrelevant categories when a customer asks about one of them. Keeps choice buttons sharp and on-topic."
              actionLabel={categoryGroupsCount > 0 ? `Manage (${categoryGroupsCount})` : "Set up groups"}
              actionUrl="/app/catalog"
            />
            <ChecklistItem
              done={semanticEnabled}
              number="5"
              title="Enable semantic search (optional)"
              description="Match products by meaning, not just keywords. Customers asking for &quot;shoes for standing all day&quot; find arch-support styles even when descriptions don't contain those words. Bring your own Voyage AI or OpenAI key — typically under $1/month."
              actionLabel={semanticEnabled ? `Manage (${semanticProvider === "voyage" ? "Voyage AI" : "OpenAI"})` : "Add provider"}
              actionUrl="/app/api-keys"
            />
          </BlockStack>
        </BlockStack>

        {/* Setup guide quick-link — opens the public /onboarding page in a
            new tab so merchants can revisit the plan-by-plan walkthrough
            without leaving the embedded admin. */}
        <div
          style={{
            background: "linear-gradient(135deg, #2D6B4F 0%, #3a8a66 100%)",
            borderRadius: "12px",
            padding: "20px 24px",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              flexShrink: 0,
              width: 44,
              height: 44,
              borderRadius: 10,
              background: "rgba(255,255,255,0.18)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
            }}
            aria-hidden="true"
          >
            {"📘"}
          </div>

          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <Text as="h2" variant="headingMd">
              <span style={{ color: "#fff" }}>Setup guide</span>
            </Text>
            <Text as="p" variant="bodyMd">
              <span style={{ color: "rgba(255,255,255,0.92)" }}>
                Plan-by-plan walkthrough for installing, configuring, and going live. Open it any time to refresh on a step.
              </span>
            </Text>
          </div>

          <div style={{ flexShrink: 0 }}>
            <Button url="/onboarding" external variant="primary" tone="success">
              Open setup guide
            </Button>
          </div>
        </div>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">About SEoS Assistant</Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>Version:</strong> 1.0.0</Text>
                <Text as="p" variant="bodySm"><strong>AI Engine:</strong> Anthropic Claude</Text>
                <Text as="p" variant="bodySm"><strong>Semantic Search:</strong> {semanticEnabled ? `${semanticProvider === "voyage" ? "Voyage AI" : "OpenAI"} (active)` : "Optional — bring your own key"}</Text>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>Attribution:</strong> Chat-driven sales tagged "SEoS" on the order; product links carry utm_content=SEoS so other channel UTMs stay intact.</Text>
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
