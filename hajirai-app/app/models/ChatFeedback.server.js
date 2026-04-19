import crypto from "crypto";
import prisma from "../db.server";

function hashValue(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function recordFeedback({ shop, sessionId, vote, botResponse, products, conversation, ip }) {
  return prisma.chatFeedback.create({
    data: {
      shop,
      sessionId,
      vote,
      botResponse: (botResponse || "").slice(0, 500),
      products: (products || []).slice(0, 5),
      conversation: conversation ? JSON.stringify(conversation) : null,
      userHash: hashValue(ip),
    },
  });
}

export async function getFeedbackSummary(shop, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const all = await prisma.chatFeedback.findMany({
    where: { shop, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      vote: true,
      botResponse: true,
      products: true,
      conversation: true,
      userHash: true,
      createdAt: true,
    },
  });

  const up = all.filter((f) => f.vote === "up").length;
  const down = all.filter((f) => f.vote === "down").length;
  const total = up + down;

  return {
    total,
    up,
    down,
    satisfactionRate: total > 0 ? Math.round((up / total) * 100) : 0,
    negativeFeedback: all.filter((f) => f.vote === "down").slice(0, 20),
  };
}

export async function cleanupOldFeedback() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatFeedback.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) console.log(`[feedback] cleaned up ${count} records older than 90 days`);
  return count;
}
