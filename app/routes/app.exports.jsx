import { authenticate } from "../shopify.server";
import { getDailySeries, getUsageSummary } from "../models/ChatUsage.server";
import { getFeedbackSummary } from "../models/ChatFeedback.server";
import { getTopProducts, getProductsByTool } from "../models/ChatProductMention.server";
import { getRecentQuestions } from "../models/ChatFeedback.server";
import { toCsv, csvResponse } from "../lib/csv-export.server";

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
    if (s && e) return { startDate: new Date(s), endDate: new Date(e) };
  }

  if (preset === "7d") start = new Date(now.getTime() - 7 * 86400000);
  else if (preset === "90d") start = new Date(now.getTime() - 90 * 86400000);
  else if (preset === "ytd") start = new Date(now.getFullYear(), 0, 1);
  else start = new Date(now.getTime() - 30 * 86400000);

  return { startDate: start, endDate: end };
}

async function buildCsv(shop, section, rangeArg) {
  if (section === "daily") {
    const daily = await getDailySeries(shop, rangeArg);
    return toCsv(
      ["Date", "Messages", "Cost (USD)", "Tokens", "Tool Calls", "Helpful", "Not Helpful"],
      daily.map((d) => [d.date, d.messages, d.cost.toFixed(4), d.tokens, d.toolCalls, d.up, d.down]),
    );
  }
  if (section === "searched" || section === "viewed") {
    const pt = await getProductsByTool(shop, rangeArg, 500);
    const rows = (pt[section] || []).map((p, i) => [i + 1, p.title, p.handle, p.count]);
    return toCsv(["Rank", "Product", "Handle", section === "searched" ? "Searches" : "Detail Views"], rows);
  }
  if (section === "top") {
    const top = await getTopProducts(shop, rangeArg, 500);
    return toCsv(["Rank", "Product", "Handle", "Mentions"], top.map((p, i) => [i + 1, p.title, p.handle, p.mentions]));
  }
  if (section === "questions") {
    const qs = await getRecentQuestions(shop, rangeArg, 500);
    return toCsv(
      ["Date", "Question", "Rating", "Products"],
      qs.map((q) => [new Date(q.date).toISOString(), q.question, q.vote || "", (q.products || []).join(" | ")]),
    );
  }
  if (section === "models") {
    const usage = await getUsageSummary(shop, rangeArg);
    const rows = Object.entries(usage.byModel).map(([m, d]) => [
      modelLabel(m),
      d.messages,
      d.cost.toFixed(4),
      d.messages > 0 ? (d.cost / d.messages).toFixed(6) : "0",
    ]);
    return toCsv(["Model", "Messages", "Total Cost (USD)", "Avg Cost per Msg (USD)"], rows);
  }
  if (section === "feedback") {
    const fb = await getFeedbackSummary(shop, rangeArg);
    return toCsv(
      ["Date", "Vote", "User Hash", "Bot Response", "Products"],
      fb.negativeFeedback.map((f) => [
        new Date(f.createdAt).toISOString(),
        f.vote,
        f.userHash || "",
        f.botResponse || "",
        (f.products || []).join(" | "),
      ]),
    );
  }
  return null;
}

// Resource route — only exports a loader, no default component. React Router
// serves the loader's Response directly without trying to render a page,
// which is the pattern for file downloads. This avoids the bug where
// `app.analytics.jsx` was returning a CSV Response from a loader that ALSO
// had a default component, causing React Router v7 to call the component
// renderer with the Response object and crash on the destructured data.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const section = url.searchParams.get("section");
  if (!section) {
    return new Response("Missing 'section' query parameter", { status: 400 });
  }

  const { startDate, endDate } = parseRange(url.searchParams);
  const rangeArg = { startDate, endDate };

  const csv = await buildCsv(session.shop, section, rangeArg);
  if (!csv) {
    return new Response(`Unknown export section: ${section}`, { status: 400 });
  }

  const fname = `${section}_${startDate.toISOString().slice(0, 10)}_to_${endDate.toISOString().slice(0, 10)}.csv`;
  return csvResponse(fname, csv);
};
