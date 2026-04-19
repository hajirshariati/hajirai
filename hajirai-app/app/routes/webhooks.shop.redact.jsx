import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}. Deleting all shop data.`);

  await db.knowledgeFile.deleteMany({ where: { shop } });
  await db.shopConfig.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });
  await db.product.deleteMany({ where: { shop } });
  await db.catalogSyncState.deleteMany({ where: { shop } });
  await db.productEnrichment.deleteMany({ where: { shop } });
  await db.chatUsage.deleteMany({ where: { shop } });
  await db.chatFeedback.deleteMany({ where: { shop } });
  await db.chatProductMention.deleteMany({ where: { shop } });

  return new Response();
};
