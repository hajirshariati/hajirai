import { useLoaderData } from "react-router";
import { Page, Layout, Card, BlockStack, Text, InlineGrid, Box, Icon, Banner, Button } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles } from "../models/ShopConfig.server";
import { ChatIcon, PersonIcon, DataTableIcon, KeyIcon } from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  const files = await getKnowledgeFiles(session.shop);

  const steps = [
    { label: "Set up branding", done: config.assistantName !== "AI Shopping Assistant", link: "/app/branding" },
    { label: "Configure greetings & CTAs", done: config.cta1Label !== "", link: "/app/greetings" },
    { label: "Upload product knowledge", done: files.length > 0, link: "/app/knowledge" },
    { label: "Add API key", done: config.anthropicApiKey !== "", link: "/app/api-keys" },
  ];
  const completed = steps.filter((s) => s.done).length;

  return { config, files, steps, completed, shop: session.shop };
};

export default function Dashboard() {
  const { config, files, steps, completed, shop } = useLoaderData();

  return (
    <Page>
      <TitleBar title="Dashboard" />
      <BlockStack gap="500">
        {completed < 4 && (
          <Banner title="Complete your setup" tone="info">
            <p>You've completed {completed} of 4 setup steps. Finish all steps to activate your AI chat assistant.</p>
          </Banner>
        )}

        {completed === 4 && (
          <Banner title="Your AI assistant is ready!" tone="success">
            <p>All setup steps are complete. The chat widget is active on your storefront.</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="500">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Setup Progress</Text>
              {steps.map((step, i) => (
                <Box key={i} paddingBlockStart="100">
                  <InlineGrid columns="auto 1fr auto" gap="200" alignItems="center">
                    <Box width="24px">
                      <Text as="span" tone={step.done ? "success" : "subdued"}>
                        {step.done ? "\u2713" : "\u25CB"}
                      </Text>
                    </Box>
                    <Text as="span" tone={step.done ? "success" : undefined}>
                      {step.label}
                    </Text>
                    {!step.done && (
                      <Button url={step.link} size="slim">Set up</Button>
                    )}
                  </InlineGrid>
                </Box>
              ))}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Assistant Preview</Text>
              <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="p" variant="headingSm">{config.assistantName}</Text>
                  <Text as="p" tone="subdued">{config.assistantTagline}</Text>
                  <Text as="p" variant="bodySm">{config.greeting}</Text>
                </BlockStack>
              </Box>
            </BlockStack>
          </Card>
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="500">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Knowledge Files</Text>
              <Text as="p" variant="headingXl">{files.length}</Text>
              <Text as="p" tone="subdued">CSV files uploaded</Text>
              <Button url="/app/knowledge" size="slim">Manage</Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">AI Model</Text>
              <Text as="p" variant="headingXl">
                {config.anthropicApiKey ? "Connected" : "Not set"}
              </Text>
              <Text as="p" tone="subdued">{config.anthropicModel}</Text>
              <Button url="/app/api-keys" size="slim">Configure</Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Store</Text>
              <Text as="p" variant="bodyMd">{shop}</Text>
              <Text as="p" tone="subdued">Widget position: {config.widgetPosition}</Text>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
