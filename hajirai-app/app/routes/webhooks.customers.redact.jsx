import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} webhook for ${shop}. This app does not store customer-identifiable data.`,
    { customerId: payload?.customer?.id },
  );

  return new Response();
};
