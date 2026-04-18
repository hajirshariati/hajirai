import { useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  InlineGrid,
  Box,
  Banner,
  Button,
  Link as PolarisLink,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  const files = await getKnowledgeFiles(session.shop);

  return {
    hasApiKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
  };
};

function StatCard({ label, value, sublabel }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel && <Text as="p" tone="subdued" variant="bodySm">{sublabel}</Text>}
      </BlockStack>
    </Card>
  );
}

export default function Dashboard() {
  const { hasApiKey, anthropicModel, fileCount, shop, themeEditorUrl } = useLoaderData();

  return (
    <Page title="Analytics">
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        {!hasApiKey && (
          <Banner title="Finish setup to activate the chat assistant" tone="warning">
            <p>Add your Anthropic API key in <PolarisLink url="/app/api-keys">API Keys</PolarisLink> to activate the chat assistant.</p>
          </Banner>
        )}

        {hasApiKey && (
          <Banner title="Chat assistant is live" tone="success">
            <p>Customers on your storefront can now chat with the AI. Customize appearance and messaging in the theme editor.</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard label="Conversations" value="—" sublabel="Last 30 days" />
          <StatCard label="Messages" value="—" sublabel="Last 30 days" />
          <StatCard label="Avg. response time" value="—" sublabel="Seconds" />
          <StatCard label="Product mentions" value="—" sublabel="Click-throughs to PDP" />
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Top customer questions</Text>
              <Badge tone="info">Coming soon</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              A ranked list of what customers ask most will appear here once the chat server starts logging conversations.
            </Text>
          </BlockStack>
        </Card>

        <Divider />

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">AI Model</Text>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={hasApiKey ? "success" : "critical"}>
                  {hasApiKey ? "Connected" : "Not set"}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">{anthropicModel}</Text>
              <Button url="/app/api-keys" variant="plain">Configure</Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Knowledge Base</Text>
              <Text as="p" variant="headingLg">{fileCount}</Text>
              <Text as="p" tone="subdued" variant="bodySm">CSV files uploaded</Text>
              <Button url="/app/knowledge" variant="plain">Manage</Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Appearance & Content</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Branding, colors, greetings, and CTAs live in the theme editor.
              </Text>
              <Button url={themeEditorUrl} external variant="plain">
                Open theme editor
              </Button>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Box paddingBlockStart="300">
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            Installed on {shop}
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}
