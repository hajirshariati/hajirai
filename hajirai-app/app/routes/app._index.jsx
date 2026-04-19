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
      <Box>
        <Icon source={CheckCircleIcon} tone="success" />
      </Box>
    );
  }
  return (
    <Box
      background="bg-surface-secondary"
      borderWidth="025"
      borderColor="border"
      borderRadius="full"
      padding="100"
      minWidth="32px"
      minHeight="32px"
    >
      <InlineStack align="center" blockAlign="center">
        <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
          {number}
        </Text>
      </InlineStack>
    </Box>
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
      <InlineStack gap="400" blockAlign="center" wrap={false}>
        <StepCircle done={done} number={number} />
        <Box minWidth="0" width="100%">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{title}</Text>
              {done && <Badge tone="success">Done</Badge>}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
          </BlockStack>
        </Box>
        <Box>
          <Button url={actionUrl} external={external} variant={done ? "plain" : "primary"}>
            {actionLabel}
          </Button>
        </Box>
      </InlineStack>
    </Box>
  );
}

function FeatureCard({ number, title, description, stat, items }) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <Box
            background="bg-surface-brand-subdued"
            borderRadius="full"
            padding="200"
            minWidth="28px"
            minHeight="28px"
          >
            <InlineStack align="center" blockAlign="center">
              <Text as="span" variant="bodySm" fontWeight="bold">{number}</Text>
            </InlineStack>
          </Box>
          <Text as="h3" variant="headingSm">{title}</Text>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
        {items && (
          <BlockStack gap="150">
            {items.map((item) => (
              <InlineStack key={item.name} gap="200" blockAlign="start" wrap={false}>
                <Box minWidth="6px">
                  <Text as="span" tone="subdued" variant="bodySm">•</Text>
                </Box>
                <Text as="p" variant="bodySm">
                  <strong>{item.name}</strong> — {item.desc}
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        )}
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
    <Page title="Home">
      <TitleBar title="ShopAgent" />
      <BlockStack gap="600">
        <Card padding="0">
          <Box background="bg-surface-brand" padding="800" borderRadius="300">
            <BlockStack gap="200">
              <Text as="h1" variant="headingXl">ShopAgent</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                AI-powered shopping assistant for your Shopify store.
              </Text>
              {totalMessages > 0 && (
                <Box paddingBlockStart="200">
                  <InlineStack gap="300">
                    <Badge>{totalMessages} conversations this month</Badge>
                  </InlineStack>
                </Box>
              )}
            </BlockStack>
          </Box>
        </Card>

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">How ShopAgent works</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Four systems work together to give your customers accurate, real-time answers.
          </Text>
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
            <FeatureCard
              number="1"
              title="Catalog Sync"
              description="Your Shopify products, variants, prices, and inventory are automatically indexed into a searchable database. Stays in sync via webhooks."
              stat={productsCount > 0 ? `${productsCount} products indexed` : null}
            />
            <FeatureCard
              number="2"
              title="SKU Matching Engine"
              description="When you upload a CSV with a SKU column, each row is automatically linked to the matching product variant. Materials, sizing, care instructions — all connected."
              stat={enrichmentCount > 0 ? `${enrichmentCount} SKUs enriched` : null}
            />
            <FeatureCard
              number="3"
              title="AI Tool Use"
              description="The AI doesn't see all your data at once. It calls these tools on demand — accurate, efficient, auto-activated on every chat."
              items={[
                { name: "search_products", desc: "Finds products by keyword, tag, or category." },
                { name: "get_product_details", desc: "Pulls variants, pricing, stock, and specs." },
                { name: "lookup_sku", desc: "Matches a SKU to uploaded CSV knowledge." },
              ]}
            />
            <FeatureCard
              number="4"
              title="Smart Model Routing"
              description="Simple follow-ups (thanks, ok, bye) use the faster, cheaper model. Product questions and complex queries use the more capable model. Saves you money automatically."
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
              actionUrl="/app/knowledge"
            />
          </BlockStack>
        </BlockStack>

        <Divider />

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Quick actions</Text>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <QuickActionCard
              title="Settings"
              description="AI engine and model routing strategy."
              actionLabel="Configure"
              actionUrl="/app/api-keys"
            />
            <QuickActionCard
              title="Knowledge Base"
              description="Upload CSVs and text files with extra context."
              actionLabel="Upload files"
              actionUrl="/app/knowledge"
            />
            <QuickActionCard
              title="Catalog"
              description="View synced products and trigger a resync."
              actionLabel="View catalog"
              actionUrl="/app/catalog"
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
