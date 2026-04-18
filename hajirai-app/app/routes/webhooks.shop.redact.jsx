import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}. Deleting all shop data.`);

  await db.knowledgeFile.deleteMany({ where: { shop } });
  await db.shopConfig.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
