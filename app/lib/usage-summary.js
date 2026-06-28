// Pure summarizer over raw ChatUsage rows. Extracted into its own
// dependency-free module (no prisma/pricing imports) so the cost accounting —
// especially the chat-vs-image-preview split — is unit-testable without a DB.
//
// `records` is the array of ChatUsage rows; `start`/`end` are ISO strings
// echoed back on the response.
export function summarizeUsageRecords(records, start, end) {
  let totalCost = 0;
  let totalEmbeddingCost = 0;
  let totalImageCost = 0;
  let totalImageCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  const byModel = {};
  const dailyCosts = {};

  for (const r of records) {
    const day = r.createdAt.toISOString().split("T")[0];
    if (!dailyCosts[day]) dailyCosts[day] = { cost: 0, messages: 0 };

    // Image-styling rows ("See It Styled") are their own usage records
    // (model = "image:<provider>"), not chat messages. Fold their cost into the
    // true total + daily spend, but DON'T count them as messages or as a model
    // row — otherwise the message count and per-model table are skewed.
    if (typeof r.model === "string" && r.model.startsWith("image:")) {
      const imgCost = r.imageCostUsd || 0;
      totalCost += imgCost;
      totalImageCost += imgCost;
      totalImageCount += r.imageCount || 1;
      dailyCosts[day].cost += imgCost;
      continue;
    }

    // Every cost total folds in the turn's semantic-search (embedding) spend so
    // charts and totals reflect true cost, not just Anthropic tokens.
    // Pre-migration rows have no embeddingCostUsd → 0.
    const embCost = r.embeddingCostUsd || 0;
    const turnCost = (r.costUsd || 0) + embCost;
    totalCost += turnCost;
    totalEmbeddingCost += embCost;
    totalInputTokens += r.inputTokens || 0;
    totalOutputTokens += r.outputTokens || 0;
    totalMessages += 1;
    totalToolCalls += r.toolCalls || 0;

    // Per-model rows stay Anthropic-only: the analytics table shows a separate
    // "Semantic search" breakout row, so folding embeddings in here would
    // represent the same dollars twice in the breakdown.
    if (!byModel[r.model]) byModel[r.model] = { cost: 0, messages: 0 };
    byModel[r.model].cost += r.costUsd || 0;
    byModel[r.model].messages += 1;

    dailyCosts[day].cost += turnCost;
    dailyCosts[day].messages += 1;
  }

  // Chat-only cost = Anthropic chat + embeddings, EXCLUDING image previews.
  // "See It Styled" image generations are optional clicks, not part of every
  // chat reply, so they must not inflate the per-reply average the estimator
  // anchors on. They stay visible separately via imageCost.
  const chatOnlyCost = totalCost - totalImageCost;

  return {
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalMessages,
    totalToolCalls,
    // Average over ALL recorded spend incl. image previews — kept for the
    // legacy "Avg cost / message" KPI, but NOT what the estimator uses.
    avgCostPerMessage: totalMessages > 0 ? totalCost / totalMessages : 0,
    // Chat-only (Anthropic + embeddings, image previews excluded). This is the
    // honest per-reply rate the CostEstimator anchors on.
    chatOnlyCost,
    avgChatCostPerMessage: totalMessages > 0 ? chatOnlyCost / totalMessages : 0,
    // Semantic-search (embedding) share of totalCost — included in
    // totalCost/dailyCosts above (true spend), broken out of byModel so the
    // analytics table's model rows + this row sum to the total.
    embeddingCost: totalEmbeddingCost,
    avgEmbeddingCostPerMessage: totalMessages > 0 ? totalEmbeddingCost / totalMessages : 0,
    // "See It Styled" image-styling share of totalCost — kept separate.
    imageCost: totalImageCost,
    imageCount: totalImageCount,
    avgImageCostPerMessage: totalMessages > 0 ? totalImageCost / totalMessages : 0,
    byModel,
    dailyCosts,
    startDate: start,
    endDate: end,
  };
}
