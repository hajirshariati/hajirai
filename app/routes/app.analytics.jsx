import { useState, useMemo, useCallback } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page, Card, BlockStack, InlineStack, Text, InlineGrid, Badge, Box,
  Button, ButtonGroup, DataTable, Banner, Popover, DatePicker, Divider,
} from "@shopify/polaris";
import { CalendarIcon, ExportIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getUsageSummary, getDailySeries } from "../models/ChatUsage.server";
import { getFeedbackSummary, cleanupOldFeedback, getRecentQuestions } from "../models/ChatFeedback.server";
import {
  getTopProducts, getProductsByTool, getInterestBreakdown, cleanupOldMentions,
} from "../models/ChatProductMention.server";

const MODEL_LABELS = {
  "claude-sonnet-4-20250514": "Standard",
  "claude-haiku-4-5-20251001": "Fast",
  "claude-opus-4-20250514": "Advanced",
};
const modelLabel = (m) => MODEL_LABELS[m] || m;

function parseRange(searchParams) {
  const preset = searchParams.get("range") || "30d";
  const now = new Date();
  const end = now;
  let start;

  if (preset === "custom") {
    const s = searchParams.get("start");
    const e = searchParams.get("end");
    if (s && e) return { startDate: new Date(s), endDate: new Date(e), preset, label: `${s} → ${e}` };
  }

  if (preset === "7d") start = new Date(now.getTime() - 7 * 86400000);
  else if (preset === "90d") start = new Date(now.getTime() - 90 * 86400000);
  else if (preset === "ytd") start = new Date(now.getFullYear(), 0, 1);
  else { start = new Date(now.getTime() - 30 * 86400000); }

  return { startDate: start, endDate: end, preset, label: { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", ytd: "Year to date" }[preset] || "Last 30 days" };
}

function daysBetween(a, b) {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { startDate, endDate, preset, label } = parseRange(url.searchParams);
  const rangeArg = { startDate, endDate };

  const spanDays = daysBetween(startDate, endDate);
  const prevEnd = new Date(startDate.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - spanDays * 86400000);
  const prevRange = { startDate: prevStart, endDate: prevEnd };

  const [usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily, prevUsage, prevFeedback] = await Promise.all([
    getUsageSummary(session.shop, rangeArg),
    getFeedbackSummary(session.shop, rangeArg),
    getTopProducts(session.shop, rangeArg, 10),
    getProductsByTool(session.shop, rangeArg, 10),
    getInterestBreakdown(session.shop, rangeArg),
    getRecentQuestions(session.shop, rangeArg, 20),
    getDailySeries(session.shop, rangeArg),
    getUsageSummary(session.shop, prevRange),
    getFeedbackSummary(session.shop, prevRange),
  ]);
  cleanupOldFeedback().catch(() => {});
  cleanupOldMentions().catch(() => {});

  return {
    usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily,
    previous: { messages: prevUsage.totalMessages, cost: prevUsage.totalCost, satisfaction: prevFeedback.satisfactionRate, toolCalls: prevUsage.totalToolCalls },
    range: { preset, label, startDate: startDate.toISOString(), endDate: endDate.toISOString(), days: spanDays },
  };
};

function formatCost(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function pctChange(curr, prev) {
  if (!prev) return curr > 0 ? { delta: 100, direction: "up" } : { delta: 0, direction: "flat" };
  const delta = ((curr - prev) / prev) * 100;
  return { delta: Math.abs(delta), direction: delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat" };
}

function DeltaBadge({ curr, prev, goodDirection = "up", unit = "%" }) {
  const { delta, direction } = pctChange(curr, prev);
  if (direction === "flat") return <Badge>No change</Badge>;
  const isGood = direction === goodDirection;
  return (
    <InlineStack gap="050" blockAlign="center">
      <Badge tone={isGood ? "success" : "warning"}>
        {`${direction === "up" ? "+" : "−"}${delta.toFixed(0)}${unit} vs prior period`}
      </Badge>
    </InlineStack>
  );
}

function KpiCard({ label, value, curr, prev, goodDirection = "up", sublabel }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel ? <Text as="p" tone="subdued" variant="bodySm">{sublabel}</Text> : null}
        {typeof curr === "number" && typeof prev === "number" ? <DeltaBadge curr={curr} prev={prev} goodDirection={goodDirection} /> : null}
      </BlockStack>
    </Card>
  );
}

function LineChart({ data, height = 220 }) {
  const width = 800;
  const padL = 40, padR = 40, padT = 16, padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  if (!data || data.length === 0) return (
    <Box padding="400"><Text as="p" tone="subdued" alignment="center">No data for this range yet.</Text></Box>
  );

  const maxMsg = Math.max(1, ...data.map((d) => d.messages));
  const maxCost = Math.max(0.01, ...data.map((d) => d.cost));
  const x = (i) => padL + (data.length === 1 ? innerW / 2 : (i * innerW) / (data.length - 1));
  const yMsg = (v) => padT + innerH - (v / maxMsg) * innerH;
  const yCost = (v) => padT + innerH - (v / maxCost) * innerH;

  const pathMsg = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yMsg(d.messages).toFixed(1)}`).join(" ");
  const pathCost = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yCost(d.cost).toFixed(1)}`).join(" ");

  const ticks = [];
  const step = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== data.length - 1) ticks.push(data.length - 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily conversations and cost" style={{ width: "100%", height: "auto", display: "block" }}>
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const y = padT + innerH * t;
        return <line key={i} x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e1e3e5" strokeDasharray="2 4" />;
      })}
      {[0, 0.5, 1].map((t, i) => (
        <text key={i} x={padL - 6} y={padT + innerH * (1 - t) + 4} fontSize="10" fill="#6d7175" textAnchor="end">{Math.round(maxMsg * t)}</text>
      ))}
      {[0, 0.5, 1].map((t, i) => (
        <text key={i} x={width - padR + 6} y={padT + innerH * (1 - t) + 4} fontSize="10" fill="#6d7175" textAnchor="start">${(maxCost * t).toFixed(2)}</text>
      ))}
      {ticks.map((i) => (
        <text key={i} x={x(i)} y={height - 8} fontSize="10" fill="#6d7175" textAnchor="middle">
          {data[i].date.slice(5)}
        </text>
      ))}
      <path d={pathCost} fill="none" stroke="#b98a5a" strokeWidth="2" strokeDasharray="4 3" />
      <path d={pathMsg} fill="none" stroke="#2D6B4F" strokeWidth="2.5" />
      {data.map((d, i) => <circle key={`m${i}`} cx={x(i)} cy={yMsg(d.messages)} r="2.5" fill="#2D6B4F" />)}
    </svg>
  );
}

function SectionHeader({ title, count, tone, description, exportSection, onExport, exporting }) {
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">{title}</Text>
          {count != null ? <Badge tone={tone}>{String(count)}</Badge> : null}
        </InlineStack>
        {exportSection ? (
          <Button
            icon={ExportIcon}
            variant="tertiary"
            loading={exporting === exportSection}
            disabled={Boolean(exporting) && exporting !== exportSection}
            onClick={() => onExport(exportSection)}
          >
            Export CSV
          </Button>
        ) : null}
      </InlineStack>
      {description ? <Text as="p" tone="subdued" variant="bodySm">{description}</Text> : null}
    </BlockStack>
  );
}

function RangeSelector({ current, searchParams }) {
  const [open, setOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(new Date().getMonth());
  const [pickerYear, setPickerYear] = useState(new Date().getFullYear());
  const [picked, setPicked] = useState({ start: new Date(searchParams.get("start") || Date.now() - 30 * 86400000), end: new Date(searchParams.get("end") || Date.now()) });

  const buildUrl = useCallback((preset, start, end) => {
    const p = new URLSearchParams();
    p.set("range", preset);
    if (preset === "custom" && start && end) {
      p.set("start", start.toISOString().slice(0, 10));
      p.set("end", end.toISOString().slice(0, 10));
    }
    return `?${p.toString()}`;
  }, []);

  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <ButtonGroup variant="segmented">
        {[
          { id: "7d", label: "7 days" },
          { id: "30d", label: "30 days" },
          { id: "90d", label: "90 days" },
          { id: "ytd", label: "YTD" },
        ].map((opt) => (
          <Button key={opt.id} url={buildUrl(opt.id)} pressed={current === opt.id}>{opt.label}</Button>
        ))}
      </ButtonGroup>
      <Popover
        active={open}
        activator={<Button icon={CalendarIcon} onClick={() => setOpen((v) => !v)} pressed={current === "custom"}>Custom range</Button>}
        onClose={() => setOpen(false)}
      >
        <Box padding="300" minWidth="320px">
          <BlockStack gap="300">
            <DatePicker
              month={pickerMonth}
              year={pickerYear}
              onMonthChange={(m, y) => { setPickerMonth(m); setPickerYear(y); }}
              selected={{ start: picked.start, end: picked.end }}
              onChange={({ start, end }) => setPicked({ start, end })}
              allowRange
            />
            <InlineStack align="end" gap="200">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" url={buildUrl("custom", picked.start, picked.end)}>Apply</Button>
            </InlineStack>
          </BlockStack>
        </Box>
      </Popover>
    </InlineStack>
  );
}

export default function Analytics() {
  const { usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily, previous, range } = useLoaderData();
  const [searchParams] = useSearchParams();
  const shopify = useAppBridge();
  const [exporting, setExporting] = useState(null);
  const hasData = usage.totalMessages > 0;

  // CSV download has to run from inside the embedded iframe so the App Bridge
  // session token is available. Opening ?export=… in a new tab (the old
  // `external` Button) bypasses the iframe, has no session token, and gets
  // bounced to the OAuth login page. Instead we fetch a dedicated resource
  // route (/app/exports) with the App Bridge JWT in the Authorization header
  // and trigger a download client-side from the returned blob. The exports
  // route is loader-only (no default component) so React Router serves the
  // CSV Response directly without server-rendering a page underneath it.
  const handleExport = useCallback(async (section) => {
    if (exporting) return;
    setExporting(section);
    try {
      const params = new URLSearchParams(searchParams);
      params.delete("export");
      params.set("section", section);
      const url = `/app/exports?${params.toString()}`;
      const token = await shopify.idToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const filename =
        res.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] ||
        `${section}.csv`;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      console.error("[analytics export] failed:", err);
      shopify.toast.show("Export failed. Please try again.", { isError: true });
    } finally {
      setExporting(null);
    }
  }, [searchParams, shopify, exporting]);

  const modelRows = useMemo(() => Object.entries(usage.byModel).map(([m, d]) => [
    modelLabel(m), String(d.messages), formatCost(d.cost), d.messages > 0 ? formatCost(d.cost / d.messages) : "—",
  ]), [usage]);

  const searchedRows = (productsByTool?.searched || []).slice(0, 10).map((p, i) => [
    String(i + 1), p.title.length > 50 ? p.title.slice(0, 48) + "…" : p.title, String(p.count),
  ]);
  const viewedRows = (productsByTool?.viewed || []).slice(0, 10).map((p, i) => [
    String(i + 1), p.title.length > 50 ? p.title.slice(0, 48) + "…" : p.title, String(p.count),
  ]);

  return (
    <Page>
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)" }} />

        <Card>
          <InlineStack align="space-between" blockAlign="center" wrap>
            <BlockStack gap="050">
              <Text as="h2" variant="headingLg">{range.label}</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                {new Date(range.startDate).toLocaleDateString()} — {new Date(range.endDate).toLocaleDateString()} · {range.days} days
              </Text>
            </BlockStack>
            <RangeSelector current={range.preset} searchParams={searchParams} />
          </InlineStack>
        </Card>

        {!hasData && (
          <Banner tone="info" title="No conversations yet in this range">
            <p>Pick a wider range or wait for customers to start chatting. Data appears here as soon as the widget is live.</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <KpiCard label="Conversations" value={String(usage.totalMessages)} curr={usage.totalMessages} prev={previous.messages} goodDirection="up" />
          <KpiCard
            label="Satisfaction"
            value={feedback.total > 0 ? `${feedback.satisfactionRate}%` : "—"}
            sublabel={feedback.total > 0 ? `${feedback.up} helpful · ${feedback.down} not` : "Awaiting feedback"}
            curr={feedback.satisfactionRate} prev={previous.satisfaction} goodDirection="up"
          />
          <KpiCard label="AI Actions" value={String(usage.totalToolCalls)} sublabel="Searches & lookups" curr={usage.totalToolCalls} prev={previous.toolCalls} goodDirection="up" />
          <KpiCard label="API Cost" value={formatCost(usage.totalCost)} sublabel={`Avg ${formatCost(usage.avgCostPerMessage)} / msg`} curr={usage.totalCost} prev={previous.cost} goodDirection="down" />
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <SectionHeader title="Daily activity" description="Conversations (green, solid) and API cost (amber, dashed)." exportSection="daily" onExport={handleExport} exporting={exporting} />
            <LineChart data={daily} />
            <InlineStack gap="400" blockAlign="center">
              <InlineStack gap="100" blockAlign="center"><span style={{ width: 14, height: 3, background: "#2D6B4F", display: "inline-block" }} /><Text as="span" variant="bodySm" tone="subdued">Conversations (left axis)</Text></InlineStack>
              <InlineStack gap="100" blockAlign="center"><span style={{ width: 14, height: 3, background: "#b98a5a", display: "inline-block" }} /><Text as="span" variant="bodySm" tone="subdued">Cost (right axis)</Text></InlineStack>
            </InlineStack>
          </BlockStack>
        </Card>

        {interest.total > 0 && (
          <Card>
            <BlockStack gap="400">
              <SectionHeader title="How the AI helps customers" description="Breakdown of what the AI does when customers ask questions." />
              <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
                <KpiCard label="Product searches" value={String(interest.searches)} sublabel="Customers looking for products" />
                <KpiCard label="Product views" value={String(interest.views)} sublabel="Detailed info requested" />
                <KpiCard label="SKU lookups" value={String(interest.skuLookups)} sublabel="Matched to uploaded data" />
                <KpiCard label="Total actions" value={String(interest.total)} sublabel="Across all interactions" />
              </InlineGrid>
            </BlockStack>
          </Card>
        )}

        {searchedRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <SectionHeader title="What customers are searching for" description="Products customers asked the AI to find." exportSection="searched" onExport={handleExport} exporting={exporting} />
              <DataTable columnContentTypes={["numeric", "text", "numeric"]} headings={["#", "Product", "Searches"]} rows={searchedRows} />
            </BlockStack>
          </Card>
        )}

        {viewedRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <SectionHeader title="Products with detail requests" description="Strongest purchase signals — customers asked about pricing, sizes, availability." exportSection="viewed" onExport={handleExport} exporting={exporting} />
              <DataTable columnContentTypes={["numeric", "text", "numeric"]} headings={["#", "Product", "Detail views"]} rows={viewedRows} />
            </BlockStack>
          </Card>
        )}

        {recentQuestions.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <SectionHeader title="Customer questions" count={recentQuestions.length} tone="info" description="Real questions from customers — use to improve FAQs or product copy." exportSection="questions" onExport={handleExport} exporting={exporting} />
              <BlockStack gap="200">
                {recentQuestions.map((q, i) => (
                  <Box key={i} padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Text as="span" variant="bodySm" tone="subdued">{new Date(q.date).toLocaleDateString()}</Text>
                        {q.vote === "up" && <Badge tone="success">Helpful</Badge>}
                        {q.vote === "down" && <Badge tone="critical">Not helpful</Badge>}
                        {q.products?.length > 0 && <Badge>{`${q.products.length} product${q.products.length > 1 ? "s" : ""}`}</Badge>}
                      </InlineStack>
                      <Text as="p" variant="bodyMd">{q.question}</Text>
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {feedback.negativeFeedback.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <SectionHeader title="Responses flagged unhelpful" count={feedback.down} tone="critical" description="Review these to spot gaps in your knowledge base or product info." exportSection="feedback" onExport={handleExport} exporting={exporting} />
              <BlockStack gap="200">
                {feedback.negativeFeedback.slice(0, 10).map((f) => (
                  <Box key={f.id} padding="300" background="bg-surface-critical-subdued" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" tone="subdued">{new Date(f.createdAt).toLocaleDateString()}</Text>
                      <Text as="p" variant="bodyMd">{f.botResponse}</Text>
                      {f.products?.length > 0 && <Text as="p" variant="bodySm" tone="subdued">Products: {f.products.join(", ")}</Text>}
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {feedback.total > 0 && feedback.down === 0 && (
          <Banner tone="success" title="No negative feedback in this period" />
        )}

        <Divider />

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <KpiCard label="Input tokens" value={formatTokens(usage.totalInputTokens)} sublabel="Prompts sent to AI" />
          <KpiCard label="Output tokens" value={formatTokens(usage.totalOutputTokens)} sublabel="Responses generated" />
          <KpiCard label="Avg cost / message" value={formatCost(usage.avgCostPerMessage)} sublabel="Across all models" />
          <KpiCard label="Active days" value={`${daily.filter((d) => d.messages > 0).length}/${daily.length}`} sublabel={`${Math.round((daily.filter((d) => d.messages > 0).length / Math.max(1, daily.length)) * 100)}% of range`} />
        </InlineGrid>

        {modelRows.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <SectionHeader title="Cost by model" description="Smart routing uses Fast for short follow-ups and Standard for product questions." exportSection="models" onExport={handleExport} exporting={exporting} />
              <DataTable columnContentTypes={["text", "numeric", "numeric", "numeric"]} headings={["Model", "Messages", "Total cost", "Avg / msg"]} rows={modelRows} />
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
