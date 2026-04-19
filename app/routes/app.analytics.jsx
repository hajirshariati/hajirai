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
import { getFeedbackSummary, cleanupOldFeedback, getRecentQuestions } from "../models/ChatFeedback.server";
import {
  getTopProducts,
  getProductsByTool,
  getInterestBreakdown,
  cleanupOldMentions,
} from "../models/ChatProductMention.server";

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
  const [usage, feedback, topProducts, productsByTool, interest, recentQuestions] = await Promise.all([
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
    getTopProducts(session.shop, 30, 10),
    getProductsByTool(session.shop, 30, 10),
    getInterestBreakdown(session.shop, 30),
    getRecentQuestions(session.shop, 30, 15),
  ]);
  cleanupOldFeedback().catch(() => {});
  cleanupOldMentions().catch(() => {});
  return { usage, feedback, topProducts, productsByTool, interest, recentQuestions };
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
  const { usage, feedback, topProducts, productsByTool, interest, recentQuestions } = useLoaderData();
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

  const searchedRows = (productsByTool?.searched || []).map((p, i) => [
    String(i + 1),
    p.title,
    String(p.count),
  ]);

  const viewedRows = (productsByTool?.viewed || []).map((p, i) => [
    String(i + 1),
    p.title,
    String(p.count),
  ]);

  const questionRows = (recentQuestions || []).map((q) => [
    new Date(q.date).toLocaleDateString(),
    q.question + (q.question.length >= 150 ? "..." : ""),
    q.vote === "up" ? "Helpful" : q.vote === "down" ? "Not helpful" : "—",
    q.products.length > 0 ? q.products.slice(0, 2).join(", ") : "—",
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
            label="AI Actions"
            value={String(usage.totalToolCalls)}
            sublabel="Product searches & lookups"
          />
          <StatCard
            label="Customer Feedback"
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
            sublabel={topProductRows.length > 0 ? "Unique products surfaced" : "No products yet"}
          />
        </InlineGrid>

        {interest.total > 0 && (
          <>
            <Divider />
            <Text as="h2" variant="headingMd">How the AI helps customers</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Breakdown of what the AI does when customers ask questions.
            </Text>
            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              <StatCard
                label="Product Searches"
                value={String(interest.searches)}
                sublabel="Customers looking for products"
                tone="info"
              />
              <StatCard
                label="Product Views"
                value={String(interest.views)}
                sublabel="Detailed info requested"
                tone="success"
              />
              <StatCard
                label="SKU Lookups"
                value={String(interest.skuLookups)}
                sublabel="Matched to your uploaded data"
              />
              <StatCard
                label="Total AI Actions"
                value={String(interest.total)}
                sublabel="Across all product interactions"
              />
            </InlineGrid>
          </>
        )}

        {searchedRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">What customers are searching for</Text>
                <Badge tone="info">Last 30 days</Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Products customers asked the AI to find. High-demand items you may want to promote or keep in stock.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "numeric"]}
                headings={["#", "Product", "Searches"]}
                rows={searchedRows}
              />
            </BlockStack>
          </Card>
        )}

        {viewedRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Products customers wanted details on</Text>
                <Badge tone="success">Purchase intent</Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Customers asked for pricing, sizes, or availability on these products. These are your strongest purchase signals.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "numeric"]}
                headings={["#", "Product", "Detail views"]}
                rows={viewedRows}
              />
            </BlockStack>
          </Card>
        )}

        {topProductRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Most popular products overall</Text>
                <Badge>Combined activity</Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                All product interactions combined — searches, detail views, and SKU lookups.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric"]}
                headings={["#", "Product", "Handle", "Total mentions"]}
                rows={topProductRows}
              />
            </BlockStack>
          </Card>
        )}

        {questionRows.length > 0 && (
          <>
            <Divider />
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">What customers are asking</Text>
                  <Badge tone="info">{questionRows.length} recent questions</Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Real questions from your customers. Use these to improve your product descriptions, FAQs, or knowledge base.
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Date", "Customer question", "Rating", "Products mentioned"]}
                  rows={questionRows}
                />
              </BlockStack>
            </Card>
          </>
        )}

        {negativeRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Responses that need improvement</Text>
                <Badge tone="critical">{feedback.down} reports</Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Customers marked these responses as unhelpful. Review them to see if your knowledge base or product info needs updating.
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
                Once customers start chatting, you'll see engagement and product data here.
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
