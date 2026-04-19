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
import { getTopProducts, cleanupOldMentions } from "../models/ChatProductMention.server";

const MODEL_LABELS = {
  "claude-sonnet-4-20250514": "Standard",
  "claude-haiku-4-5-20251001": "Fast",
  "claude-opus-4-20250514": "Advanced",
};

function modelLabel(model) {
  return MODEL_LABELS[model] || model;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [usage, feedback, topProducts] = await Promise.all([
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
    getTopProducts(session.shop, 30, 10),
  ]);
  cleanupOldFeedback().catch(() => {});
  cleanupOldMentions().catch(() => {});
  return { usage, feedback, topProducts };
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

function computeInsights(usage) {
  const entries = Object.entries(usage.dailyCosts || {});
  const activeDays = entries.length;
  let peakDay = null;
  let peakMessages = 0;
  for (const [day, data] of entries) {
    if ((data.messages || 0) > peakMessages) {
      peakMessages = data.messages;
      peakDay = day;
    }
  }
  const avgPerDay = activeDays > 0 ? Math.round(usage.totalMessages / activeDays) : 0;
  return { activeDays, peakDay, peakMessages, avgPerDay };
}

export default function Analytics() {
  const { usage, feedback, topProducts } = useLoaderData();
  const hasData = usage.totalMessages > 0;
  const { activeDays, peakDay, peakMessages, avgPerDay } = computeInsights(usage);

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

  const topProductRows = (topProducts || []).map((p, i) => [
    String(i + 1),
    p.title,
    p.handle,
    String(p.mentions),
  ]);

  return (
    <Page title="Analytics" backAction={{ url: "/app" }}>
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)" }} />
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">Last 30 days</Text>
          {hasData ? <Badge tone="success">Live</Badge> : <Badge>No data yet</Badge>}
        </InlineStack>

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

        <Text as="h2" variant="headingMd">Activity</Text>
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <StatCard
            label="Active Days"
            value={`${activeDays}/30`}
            sublabel={activeDays > 0 ? `${Math.round((activeDays / 30) * 100)}% of the month` : "No activity yet"}
          />
          <StatCard
            label="Peak Day"
            value={peakDay || "—"}
            sublabel={peakMessages > 0 ? `${peakMessages} messages` : "No data"}
          />
          <StatCard
            label="Avg / Active Day"
            value={String(avgPerDay)}
            sublabel="Messages per day"
          />
          <StatCard
            label="Products Shown"
            value={String(topProductRows.length)}
            sublabel={topProductRows.length > 0 ? "Unique products in chat" : "No products yet"}
          />
        </InlineGrid>

        {topProductRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Top recommended products</Text>
                <Badge tone="info">Last 30 days</Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Products the AI surfaced most often in chat. Use this to spot catalog winners and gaps.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric"]}
                headings={["#", "Product", "Handle", "Mentions"]}
                rows={topProductRows}
              />
            </BlockStack>
          </Card>
        )}

        {negativeRows.length > 0 && (
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
        )}

        {feedback.total > 0 && feedback.down === 0 && (
          <Banner tone="success" title="No negative feedback in the last 30 days" />
        )}

        <Divider />

        <Text as="h2" variant="headingMd">API Cost</Text>
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <StatCard
            label="Total Cost"
            value={formatCost(usage.totalCost)}
            sublabel="AI engine usage cost"
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
                Smart routing uses the Fast model for simple follow-ups and the Standard model for product questions.
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
            Cost estimates based on AI engine pricing. User data hashed for privacy. Feedback auto-deleted after 90 days.
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}
