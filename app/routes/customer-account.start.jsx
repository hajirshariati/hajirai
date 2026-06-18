// Customer Accounts MCP — OAuth start.
// GET /customer-account/start?shop=<shop>&storefront_domain=<custom domain>
// Generates PKCE + state, persists the verifier, and redirects the
// shopper to Shopify's hosted customer login. FLAG-GATED: returns 404
// unless CUSTOMER_ACCOUNT_MCP_ENABLED=true. Not referenced by the chat
// pipeline — hitting this route is an explicit action.

import prisma from "../db.server";
import {
  customerAccountMcpEnabled,
  customerAccountClientId,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  discoverOpenIdConfig,
  buildAuthorizationUrl,
} from "../lib/customer-account-mcp.server";

export async function loader({ request }) {
  if (!customerAccountMcpEnabled()) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const storefrontDomain = url.searchParams.get("storefront_domain") || "";
  const chatSessionId = url.searchParams.get("session") || null;
  if (!shop || !storefrontDomain) {
    return new Response("Missing shop or storefront_domain", { status: 400 });
  }

  const clientId = customerAccountClientId();
  if (!clientId) return new Response("App not configured", { status: 500 });

  const redirectUri = `${process.env.SHOPIFY_APP_URL}/customer-account/callback`;
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  await prisma.customerAccountToken.create({
    data: { shop, storefrontDomain, chatSessionId, state, codeVerifier },
  });

  let oidc;
  try {
    oidc = await discoverOpenIdConfig(storefrontDomain);
  } catch (err) {
    console.error("[customer-account] discovery failed:", err?.message || err);
    return new Response("Customer login is unavailable for this store.", { status: 502 });
  }

  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: oidc.authorization_endpoint,
    clientId,
    redirectUri,
    state,
    codeChallenge,
  });

  return new Response(null, { status: 302, headers: { Location: authUrl } });
}
