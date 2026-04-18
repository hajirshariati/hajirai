import prisma from "../db.server";

export async function getShopConfig(shop) {
  let config = await prisma.shopConfig.findUnique({ where: { shop } });
  if (!config) {
    config = await prisma.shopConfig.create({ data: { shop } });
  }
  return config;
}

export async function updateShopConfig(shop, data) {
  return prisma.shopConfig.upsert({
    where: { shop },
    update: { ...data, updatedAt: new Date() },
    create: { shop, ...data },
  });
}

export async function getKnowledgeFiles(shop) {
  return prisma.knowledgeFile.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true, updatedAt: true },
  });
}

export async function saveKnowledgeFile(shop, { fileName, fileType, fileSize, content }) {
  const existing = await prisma.knowledgeFile.findFirst({
    where: { shop, fileType },
  });
  if (existing) {
    return prisma.knowledgeFile.update({
      where: { id: existing.id },
      data: { fileName, fileSize, content, updatedAt: new Date() },
    });
  }
  return prisma.knowledgeFile.create({
    data: { shop, fileName, fileType, fileSize, content },
  });
}

export async function deleteKnowledgeFile(id) {
  return prisma.knowledgeFile.delete({ where: { id } });
}
