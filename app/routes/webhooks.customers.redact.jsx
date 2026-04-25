import { authenticate } from "../shopify.server";

// GDPR: Shopify forwards customer-deletion requests here. SEoS Assistant has
// no record keyed to a Shopify customer ID, email, phone, or order — chat
// interactions are anonymized via a hash of the source IP and cannot be
// correlated to a customer. There is therefore nothing to redact at the
// per-customer level. The shop/redact webhook handles full-shop removal.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
