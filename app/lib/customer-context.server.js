// Fetches the logged-in customer's profile + recent orders from the Shopify
// Admin API so the AI can deliver a personalized (VIP) experience.
//
// Safety: this helper is only called after the request has been authenticated
// via `authenticate.public.appProxy`, which validates Shopify's HMAC signature.
// The `logged_in_customer_id` query param used to build the GID is therefore
// cryptographically bound to the current request — a visitor cannot forge it.
// Nothing is persisted to our DB; every fetch is live from Shopify.

const ADMIN_API_VERSION = "2024-10";

const CUSTOMER_QUERY = `
  query GetCustomerContext($id: ID!, $orderLimit: Int!) {
    customer(id: $id) {
      firstName
      email
      numberOfOrders
      amountSpent { amount currencyCode }
      tags
      orders(first: $orderLimit, sortKey: CREATED_AT, reverse: true) {
        nodes {
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 5) {
            nodes { title quantity }
          }
        }
      }
    }
  }
`;

// In-memory cache keyed by `shop:customerId`. TTL keeps data fresh while
// avoiding redundant Admin API calls within the same chat session.
const CACHE = new Map();
const TTL_MS = 2 * 60 * 1000;

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return entry.v;
}

function cacheSet(key, v) {
  CACHE.set(key, { v, t: Date.now() });
}

function formatMoney(moneyObj) {
  if (!moneyObj) return "";
  const amount = parseFloat(moneyObj.amount || 0);
  const currency = moneyObj.currencyCode || "USD";
  if (Number.isNaN(amount)) return "";
  return `${amount.toFixed(2)} ${currency}`;
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export async function fetchCustomerContext({ shop, accessToken, customerId, orderLimit = 5 }) {
  if (!shop || !accessToken || !customerId) return null;
  const cacheKey = `${shop}:${customerId}:${orderLimit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const gid = `gid://shopify/Customer/${customerId}`;
  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  let data;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: CUSTOMER_QUERY,
        variables: { id: gid, orderLimit },
      }),
    });
    if (!res.ok) {
      console.warn(`[customer-context] Admin API ${res.status} for ${shop}`);
      return null;
    }
    const json = await res.json();
    if (json.errors) {
      console.warn(`[customer-context] GraphQL errors: ${JSON.stringify(json.errors)}`);
      return null;
    }
    data = json.data;
  } catch (e) {
    console.warn(`[customer-context] fetch failed: ${e.message}`);
    return null;
  }

  const customer = data?.customer;
  if (!customer) return null;

  const recentOrders = (customer.orders?.nodes || []).map((o) => ({
    name: o.name,
    date: formatDate(o.createdAt),
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    total: formatMoney(o.totalPriceSet?.shopMoney),
    items: (o.lineItems?.nodes || []).map((li) => `${li.title}${li.quantity > 1 ? ` ×${li.quantity}` : ""}`),
  }));

  const result = {
    firstName: customer.firstName || "",
    numberOfOrders: customer.numberOfOrders || 0,
    amountSpent: formatMoney(customer.amountSpent),
    tags: customer.tags || [],
    recentOrders,
    // Internal-only: used by Klaviyo/Yotpo enrichment helpers for email-based
    // lookups. Underscore prefix flags it as unsafe-for-prompt; the prompt
    // builder explicitly strips underscore-prefixed keys before rendering.
    _email: customer.email || "",
  };
  cacheSet(cacheKey, result);
  return result;
}
