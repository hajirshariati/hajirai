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

function resolveRange(arg) {
  if (arg && typeof arg === "object" && arg.startDate && arg.endDate) {
    return { start: new Date(arg.startDate), end: new Date(arg.endDate) };
  }
  const days = typeof arg === "number" ? arg : arg?.days || 30;
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { start, end: new Date() };
}

export async function getFeedbackSummary(shop, range = 30) {
  const { start, end } = resolveRange(range);
  const all = await prisma.chatFeedback.findMany({
    where: { shop, createdAt: { gte: start, lte: end } },
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

export async function getRecentQuestions(shop, range = 30, limit = 15) {
  const { start, end } = resolveRange(range);
  const records = await prisma.chatFeedback.findMany({
    where: { shop, createdAt: { gte: start, lte: end }, conversation: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { conversation: true, vote: true, products: true, createdAt: true },
    take: limit * 2,
  });
  const questions = [];
  for (const r of records) {
    try {
      const conv = JSON.parse(r.conversation);
      const firstUser = (Array.isArray(conv) ? conv : []).find((m) => m.role === "user");
      if (firstUser?.content) {
        questions.push({
          question: String(firstUser.content).slice(0, 150),
          vote: r.vote,
          products: r.products || [],
          date: r.createdAt,
        });
      }
    } catch {}
    if (questions.length >= limit) break;
  }
  return questions;
}

export async function cleanupOldFeedback() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatFeedback.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) console.log(`[feedback] cleaned up ${count} records older than 90 days`);
  return count;
}
