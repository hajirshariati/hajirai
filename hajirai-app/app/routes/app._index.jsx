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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  const files = await getKnowledgeFiles(session.shop);

  return {
    hasApiKey: config.anthropicApiKey !== "",
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
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

function QuickActionCard({ emoji, title, description, actionLabel, actionUrl, external }) {
  return (
    <Card>
      <BlockStack gap="300">
        <Box
          background="bg-surface-brand-subdued"
          borderRadius="200"
          padding="300"
          width="fit-content"
        >
          <Text as="span" variant="headingLg">{emoji}</Text>
        </Box>
        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">{title}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
        </BlockStack>
        <Box paddingBlockStart="200">
          <Button url={actionUrl} external={external} variant="plain">
            {actionLabel}
          </Button>
        </Box>
      </BlockStack>
    </Card>
  );
}

export default function Home() {
  const { hasApiKey, fileCount, shop, themeEditorUrl } = useLoaderData();

  const allSetup = hasApiKey;

  return (
    <Page title="Home">
      <TitleBar title="Home" />
      <BlockStack gap="600">
        <Card padding="0">
          <Box background="bg-surface-brand" padding="800" borderRadius="300">
            <InlineStack gap="400" blockAlign="center" wrap={false}>
              <Box background="bg-surface" borderRadius="full" padding="400">
                <Text as="span" variant="heading2xl">💬</Text>
              </Box>
              <BlockStack gap="100">
                <Text as="h1" variant="headingLg">Welcome to Hajirai</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Your AI shopping assistant — ready to help customers find what they need, 24/7.
                </Text>
              </BlockStack>
            </InlineStack>
          </Box>
        </Card>

        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="center">
            <Text as="h2" variant="headingMd">Setup checklist</Text>
            {allSetup ? (
              <Badge tone="success">Complete</Badge>
            ) : (
              <Badge tone="attention">Action needed</Badge>
            )}
          </InlineStack>

          <BlockStack gap="300">
            <ChecklistItem
              done={hasApiKey}
              number="1"
              title="Add your Anthropic API key"
              description="Required. Powers the AI assistant that answers customer questions."
              actionLabel={hasApiKey ? "Manage" : "Add key"}
              actionUrl="/app/api-keys"
            />
            <ChecklistItem
              done={false}
              number="2"
              title="Enable the chat widget in your theme"
              description="Turn on the Hajirai AI Chat app embed in your active theme so customers can see it."
              actionLabel="Open theme editor"
              actionUrl={themeEditorUrl}
              external
            />
            <ChecklistItem
              done={fileCount > 0}
              number="3"
              title="Upload extra knowledge (optional)"
              description="FAQs, brand voice, sizing guides — anything beyond what's in Shopify already."
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
              emoji="🔑"
              title="API Keys"
              description="Anthropic, Yotpo, Aftership."
              actionLabel="Configure"
              actionUrl="/app/api-keys"
            />
            <QuickActionCard
              emoji="📚"
              title="Knowledge Base"
              description="Train the AI with extra context."
              actionLabel="Upload files"
              actionUrl="/app/knowledge"
            />
            <QuickActionCard
              emoji="🎨"
              title="Customize widget"
              description="Colors, greetings, CTAs."
              actionLabel="Theme editor"
              actionUrl={themeEditorUrl}
              external
            />
            <QuickActionCard
              emoji="📊"
              title="Analytics"
              description="Conversations & usage."
              actionLabel="View stats"
              actionUrl="/app/analytics"
            />
          </InlineGrid>
        </BlockStack>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Getting started</Text>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">1. Connect AI</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Paste your Anthropic API key to power the assistant.
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">2. Enable widget</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Turn on the Hajirai chat block in your active theme.
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">3. Customize</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Set colors, CTAs, and upload extra knowledge your way.
                </Text>
              </BlockStack>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Box paddingBlockStart="300">
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            Installed on {shop}
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}
