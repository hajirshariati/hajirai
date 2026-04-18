import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  await db.knowledgeFile.deleteMany({ where: { shop } });
  await db.shopConfig.deleteMany({ where: { shop } });
  await db.product.deleteMany({ where: { shop } });
  await db.catalogSyncState.deleteMany({ where: { shop } });

  return new Response();
};
