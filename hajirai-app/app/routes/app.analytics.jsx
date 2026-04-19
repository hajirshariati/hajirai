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
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getUsageSummary } from "../models/ChatUsage.server";
import { getFeedbackSummary, cleanupOldFeedback } from "../models/ChatFeedback.server";

const MODEL_LABELS = {
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-opus-4-20250514": "Claude Opus 4",
};

function modelLabel(model) {
  return MODEL_LABELS[model] || model;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [usage, feedback] = await Promise.all([
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
  ]);
  cleanupOldFeedback().catch(() => {});
  return { usage, feedback };
};

function StatCard({ label, value, sublabel, tone }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel && <Badge tone={tone || "info"}>{sublabel}</Badge>}
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
  const { usage, feedback } = useLoaderData();
  const hasData = usage.totalMessages > 0;

  const modelRows = Object.entries(usage.byModel).map(([model, data]) => [
    modelLabel(model),
    String(data.messages),
    formatCost(data.cost),
    data.messages > 0 ? formatCost(data.cost / data.messages) : "—",
  ]);

  const dailyRows = Object.entries(usage.dailyCosts)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 14)
    .map(([day, data]) => [day, String(data.messages), formatCost(data.cost)]);

  const negativeRows = feedback.negativeFeedback.map((f) => [
    new Date(f.createdAt).toLocaleDateString(),
    f.userHash || "—",
    f.botResponse.slice(0, 80) + (f.botResponse.length > 80 ? "..." : ""),
    f.products.length > 0 ? f.products.join(", ").slice(0, 60) : "—",
  ]);

  return (
    <Page title="Analytics" backAction={{ url: "/app" }}>
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">Last 30 days</Text>
          {hasData ? <Badge tone="success">Live</Badge> : <Badge>No data yet</Badge>}
        </InlineStack>

        {/* ─── Engagement Metrics ─── */}
        <Text as="h2" variant="headingMd">Engagement</Text>
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <StatCard
            label="Conversations"
            value={String(usage.totalMessages)}
            sublabel="Messages handled"
          />
          <StatCard
            label="Satisfaction"
            value={feedback.total > 0 ? `${feedback.satisfactionRate}%` : "—"}
            sublabel={feedback.total > 0 ? `${feedback.up} helpful · ${feedback.down} not` : "No feedback yet"}
            tone={feedback.satisfactionRate >= 80 ? "success" : feedback.satisfactionRate >= 50 ? "warning" : "critical"}
          />
          <StatCard
            label="Tool Calls"
            value={String(usage.totalToolCalls)}
            sublabel="Product searches & lookups"
          />
          <StatCard
            label="Total Feedback"
            value={String(feedback.total)}
            sublabel={`${feedback.up} positive · ${feedback.down} negative`}
          />
        </InlineGrid>

        {/* ─── Negative Feedback Review ─── */}
        {negativeRows.length > 0 && (
          <>
            <Divider />
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">Negative feedback</Text>
                  <Badge tone="critical">{feedback.down} reports</Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  User data is hashed for privacy. Records auto-delete after 90 days.
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Date", "User (hashed)", "AI Response", "Products"]}
                  rows={negativeRows}
                />
              </BlockStack>
            </Card>
          </>
        )}

        {feedback.total > 0 && feedback.down === 0 && (
          <Banner tone="success" title="No negative feedback in the last 30 days" />
        )}

        <Divider />

        {/* ─── API Cost ─── */}
        <Text as="h2" variant="headingMd">API Cost</Text>
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <StatCard
            label="Total Cost"
            value={formatCost(usage.totalCost)}
            sublabel="Billed to your Anthropic account"
          />
          <StatCard
            label="Avg / Message"
            value={formatCost(usage.avgCostPerMessage)}
            sublabel={usage.totalMessages > 0 ? "Across all models" : "No data"}
          />
          <StatCard
            label="Input Tokens"
            value={formatTokens(usage.totalInputTokens)}
            sublabel="Prompts sent to AI"
          />
          <StatCard
            label="Output Tokens"
            value={formatTokens(usage.totalOutputTokens)}
            sublabel="Responses generated"
          />
        </InlineGrid>

        {modelRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Cost by model</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Smart routing uses Haiku for simple follow-ups and Sonnet for product questions.
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
                Once customers start chatting, you'll see engagement and cost data here.
              </Text>
            </BlockStack>
          </Card>
        )}

        <Box paddingBlockStart="100">
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            Cost estimates based on Anthropic pricing. User data hashed for privacy. Feedback auto-deleted after 90 days.
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}
