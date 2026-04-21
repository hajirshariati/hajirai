import { useLoaderData } from "react-router";
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
  Divider,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles } from "../models/ShopConfig.server";
import { getCatalogSyncState, syncCatalogAsync } from "../models/Product.server";
import { countEnrichmentsByShop } from "../models/ProductEnrichment.server";
import { getUsageSummary } from "../models/ChatUsage.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [config, files, syncState, enrichmentCount, usage] = await Promise.all([
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    getCatalogSyncState(session.shop),
    countEnrichmentsByShop(session.shop),
    getUsageSummary(session.shop, 30),
  ]);

  if (!syncState.lastSyncedAt && syncState.status !== "running") {
    syncCatalogAsync(admin, session.shop);
  }

  return {
    hasApiKey: config.anthropicApiKey !== "",
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
    productsCount: syncState.productsCount || 0,
    enrichmentCount,
    totalCost: usage.totalCost,
    totalMessages: usage.totalMessages,
    modelStrategy: config.modelStrategy || "smart",
  };
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

function QuickActionCard({ title, description, actionLabel, actionUrl, external }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">{title}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
        <Box paddingBlockStart="100">
          <Button url={actionUrl} external={external} variant="plain">
            {actionLabel}
          </Button>
        </Box>
      </BlockStack>
    </Card>
  );
}

export default function Home() {
  const {
    hasApiKey, fileCount, shop, themeEditorUrl,
    productsCount, enrichmentCount, totalCost, totalMessages, modelStrategy,
  } = useLoaderData();

  const strategyLabel = modelStrategy === "smart"
    ? "Smart routing"
    : modelStrategy === "always-haiku"
      ? "Always Fast"
      : modelStrategy === "always-opus"
        ? "Always Advanced"
        : "Always Standard";

  return (
    <Page>
      <TitleBar title="ShopAgent" />
      <BlockStack gap="600">
        <div style={{
          background: "linear-gradient(135deg, #2D6B4F 0%, #3a8a66 100%)",
          borderRadius: "12px", padding: "32px", marginTop: "-8px",
        }}>
          <BlockStack gap="200">
            <Text as="h1" variant="headingXl">
              <span style={{ color: "#fff" }}>ShopAgent</span>
            </Text>
            <Text as="p" variant="bodyMd">
              <span style={{ color: "rgba(255,255,255,0.85)" }}>AI-powered shopping assistant for your Shopify store.</span>
            </Text>
            {totalMessages > 0 && (
              <Box paddingBlockStart="200">
                <Badge tone="info">{totalMessages} conversations this month</Badge>
              </Box>
            )}
          </BlockStack>
        </div>

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">What ShopAgent does for you</Text>
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
              done={false}
              number="2"
              title="Enable the chat widget"
              description="Turn on the ShopAgent chat block in your active Shopify theme so customers see it on your storefront."
              actionLabel="Open theme editor"
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

        <Divider />

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Quick actions</Text>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
            <QuickActionCard
              title="Settings"
              description="AI engine and model routing strategy."
              actionLabel="Configure"
              actionUrl="/app/api-keys"
            />
            <QuickActionCard
              title="Rules & Knowledge"
              description="Search rules, synonyms, attributes, files, and catalog sync — all in one place."
              actionLabel="Open"
              actionUrl="/app/rules-knowledge"
            />
            <QuickActionCard
              title="Analytics"
              description="API usage, cost breakdown, and conversations."
              actionLabel="View stats"
              actionUrl="/app/analytics"
            />
          </InlineGrid>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">About ShopAgent</Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>Version:</strong> 1.0.0</Text>
                <Text as="p" variant="bodySm"><strong>AI Engine:</strong> ShopAgent AI</Text>
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
