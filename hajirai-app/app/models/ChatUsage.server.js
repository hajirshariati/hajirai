import prisma from "../db.server";
import { computeCost } from "../lib/pricing.server";

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

export async function getUsageSummary(shop, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const records = await prisma.chatUsage.findMany({
    where: { shop, createdAt: { gte: since } },
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
    days,
  };
}
