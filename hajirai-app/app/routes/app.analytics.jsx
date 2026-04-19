import { useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  InlineGrid,
  Badge,
  Box,
  Divider,
  DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getUsageSummary } from "../models/ChatUsage.server";
import { getModelLabel } from "../lib/pricing.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const usage = await getUsageSummary(session.shop, 30);
  return { usage };
};

function StatCard({ label, value, sublabel, tone }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel && (
          <Badge tone={tone || "info"}>{sublabel}</Badge>
        )}
      </BlockStack>
    </Card>
  );
}

function formatCost(n) {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function formatTokens(n) {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export default function Analytics() {
  const { usage } = useLoaderData();
  const hasData = usage.totalMessages > 0;

  const modelRows = Object.entries(usage.byModel).map(([model, data]) => [
    getModelLabel(model),
    String(data.messages),
    formatCost(data.cost),
    data.messages > 0 ? formatCost(data.cost / data.messages) : "—",
  ]);

  const dailyRows = Object.entries(usage.dailyCosts)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 14)
    .map(([day, data]) => [
      day,
      String(data.messages),
      formatCost(data.cost),
    ]);

  return (
    <Page title="Analytics" backAction={{ url: "/app" }}>
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">Last 30 days</Text>
          {hasData ? (
            <Badge tone="success">Live</Badge>
          ) : (
            <Badge>No data yet</Badge>
          )}
        </InlineStack>

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <StatCard
            label="API Cost"
            value={formatCost(usage.totalCost)}
            sublabel="Billed to your Anthropic account"
          />
          <StatCard
            label="Conversations"
            value={String(usage.totalMessages)}
            sublabel="Customer messages handled"
          />
          <StatCard
            label="Avg. Cost / Message"
            value={formatCost(usage.avgCostPerMessage)}
            sublabel={usage.totalMessages > 0 ? "Across all models" : "No data"}
          />
          <StatCard
            label="Tool Calls"
            value={String(usage.totalToolCalls)}
            sublabel="Product searches, lookups"
          />
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <StatCard
            label="Input Tokens"
            value={formatTokens(usage.totalInputTokens)}
            sublabel="Prompts + context sent to AI"
          />
          <StatCard
            label="Output Tokens"
            value={formatTokens(usage.totalOutputTokens)}
            sublabel="AI responses generated"
          />
        </InlineGrid>

        <Divider />

        {modelRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Cost by model</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Smart routing automatically uses Haiku for simple follow-ups and Sonnet for product questions,
                reducing your costs without sacrificing quality.
              </Text>
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                headings={["Model", "Messages", "Total Cost", "Avg / Msg"]}
                rows={modelRows}
              />
            </BlockStack>
          </Card>
        )}

        {dailyRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Daily breakdown</Text>
              <DataTable
                columnContentTypes={["text", "numeric", "numeric"]}
                headings={["Date", "Messages", "Cost"]}
                rows={dailyRows}
              />
            </BlockStack>
          </Card>
        )}

        {!hasData && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Waiting for first conversation</Text>
              <Text as="p" tone="subdued">
                Once customers start chatting with your ShopAgent, you'll see real-time cost and usage
                data here. Every API call is tracked with exact token counts and cost per model.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Costs are billed directly to your Anthropic account — ShopAgent doesn't add any markup.
              </Text>
            </BlockStack>
          </Card>
        )}

        <Box paddingBlockStart="100">
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            Cost estimates based on published Anthropic pricing. Actual billing may vary slightly.
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}
