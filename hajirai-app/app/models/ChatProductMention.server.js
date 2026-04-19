import prisma from "../db.server";

export async function logMentions(shop, entries) {
  if (!shop || !entries?.length) return;
  const rows = entries
    .filter((e) => e?.handle && e?.title)
    .map((e) => ({
      shop,
      handle: String(e.handle).slice(0, 255),
      title: String(e.title).slice(0, 300),
      tool: String(e.tool || "unknown").slice(0, 50),
    }));
  if (rows.length === 0) return;
  try {
    await prisma.chatProductMention.createMany({ data: rows });
  } catch (err) {
    console.error("[ChatProductMention] log error:", err?.message);
  }
}

export async function getTopProducts(shop, days = 30, limit = 10) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.chatProductMention.groupBy({
    by: ["handle", "title"],
    where: { shop, createdAt: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { handle: "desc" } },
    take: limit,
  });
  return rows.map((r) => ({
    handle: r.handle,
    title: r.title,
    mentions: r._count._all,
  }));
}

export async function cleanupOldMentions() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  try {
    await prisma.chatProductMention.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error("[ChatProductMention] cleanup error:", err?.message);
  }
}
