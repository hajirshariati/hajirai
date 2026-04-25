import { authenticate } from "../shopify.server";

// GDPR: Shopify forwards customer data-access requests here. SEoS Assistant
// stores no customer-identifiable records. Chat interactions are anonymized via
// a SHA-256 hash of the source IP and are not linked to any Shopify customer
// ID, email, phone, or order. Therefore there is no per-customer data to
// return. We respond with a JSON acknowledgement so the request is auditable.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return Response.json({
    shop_domain: shop,
    customer_data: [],
    notice:
      "SEoS Assistant does not store customer-identifiable data. Chat interactions are anonymized via a hash of the source IP address and cannot be linked to a Shopify customer identity.",
  });
};
