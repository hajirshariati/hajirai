import prisma from "../db.server";
import { computeCost } from "../lib/pricing.server";

// UTC midnight keeps the cap consistent across server instances and matches
// how Shopify reports day boundaries in the admin.
function startOfTodayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function getTodayMessageCount(shop) {
  return prisma.chatUsage.count({
    where: { shop, createdAt: { gte: startOfTodayUtc() } },
  });
}

export async function recordChatUsage({ shop, model, usage, toolCalls }) {
  const costUsd = computeCost(model, usage);
  return prisma.chatUsage.create({
    data: {
      shop,
      model,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
      costUsd,
      toolCalls: toolCalls || 0,
    },
  });
}

function resolveRange(arg) {
  if (arg instanceof Date || typeof arg === "string") {
    const start = arg instanceof Date ? arg : new Date(arg);
    return { start, end: new Date() };
  }
  if (arg && typeof arg === "object") {
    if (arg.startDate && arg.endDate) {
      return { start: new Date(arg.startDate), end: new Date(arg.endDate) };
    }
    if (typeof arg.days === "number") {
      const start = new Date();
      start.setDate(start.getDate() - arg.days);
      return { start, end: new Date() };
    }
  }
  if (typeof arg === "number") {
    const start = new Date();
    start.setDate(start.getDate() - arg);
    return { start, end: new Date() };
  }
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start, end: new Date() };
}

export async function getUsageSummary(shop, range = 30) {
  const { start, end } = resolveRange(range);

  const records = await prisma.chatUsage.findMany({
    where: { shop, createdAt: { gte: start, lte: end } },
    orderBy: { createdAt: "desc" },
  });

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  const byModel = {};
  const dailyCosts = {};

  for (const r of records) {
    totalCost += r.costUsd;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalMessages += 1;
    totalToolCalls += r.toolCalls;

    if (!byModel[r.model]) byModel[r.model] = { cost: 0, messages: 0 };
    byModel[r.model].cost += r.costUsd;
    byModel[r.model].messages += 1;

    const day = r.createdAt.toISOString().split("T")[0];
    if (!dailyCosts[day]) dailyCosts[day] = { cost: 0, messages: 0 };
    dailyCosts[day].cost += r.costUsd;
    dailyCosts[day].messages += 1;
  }

  return {
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalMessages,
    totalToolCalls,
    avgCostPerMessage: totalMessages > 0 ? totalCost / totalMessages : 0,
    byModel,
    dailyCosts,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

export async function getDailySeries(shop, range = 30) {
  const { start, end } = resolveRange(range);
  const [usageRows, feedbackRows] = await Promise.all([
    prisma.chatUsage.findMany({
      where: { shop, createdAt: { gte: start, lte: end } },
      select: { createdAt: true, costUsd: true, inputTokens: true, outputTokens: true, toolCalls: true },
    }),
    prisma.chatFeedback.findMany({
      where: { shop, createdAt: { gte: start, lte: end } },
      select: { createdAt: true, vote: true },
    }),
  ]);

  const map = new Map();
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().split("T")[0];
    map.set(key, { date: key, messages: 0, cost: 0, tokens: 0, toolCalls: 0, up: 0, down: 0 });
  }
  for (const r of usageRows) {
    const key = r.createdAt.toISOString().split("T")[0];
    const row = map.get(key);
    if (!row) continue;
    row.messages += 1;
    row.cost += r.costUsd || 0;
    row.tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    row.toolCalls += r.toolCalls || 0;
  }
  for (const r of feedbackRows) {
    const key = r.createdAt.toISOString().split("T")[0];
    const row = map.get(key);
    if (!row) continue;
    if (r.vote === "up") row.up += 1;
    else if (r.vote === "down") row.down += 1;
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}
