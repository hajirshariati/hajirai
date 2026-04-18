import { useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  InlineGrid,
  Badge,
  Icon,
} from "@shopify/polaris";
import {
  ChatIcon,
  PersonIcon,
  ClockIcon,
  ProductIcon,
} from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  return { hasApiKey: config.anthropicApiKey !== "" };
};

function StatCard({ icon, label, value, sublabel }) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Icon source={icon} tone="subdued" />
          <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        </InlineStack>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel && <Text as="p" tone="subdued" variant="bodySm">{sublabel}</Text>}
      </BlockStack>
    </Card>
  );
}

export default function Analytics() {
  const { hasApiKey } = useLoaderData();

  return (
    <Page title="Analytics" backAction={{ url: "/app" }}>
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        {!hasApiKey && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">No data yet</Text>
              <Text as="p" tone="subdued">
                Finish setup and start receiving conversations to see analytics here.
              </Text>
            </BlockStack>
          </Card>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard icon={ChatIcon} label="Conversations" value="—" sublabel="Last 30 days" />
          <StatCard icon={PersonIcon} label="Messages" value="—" sublabel="Last 30 days" />
          <StatCard icon={ClockIcon} label="Avg. response time" value="—" sublabel="Seconds" />
          <StatCard icon={ProductIcon} label="Product mentions" value="—" sublabel="Click-throughs to PDP" />
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Top customer questions</Text>
              <Badge tone="info">Coming soon</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              A ranked list of what customers ask most will appear here once conversations start logging.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Conversion & engagement</Text>
              <Badge tone="info">Coming soon</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Track how chat drives clicks to product pages, add-to-carts, and completed orders.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
