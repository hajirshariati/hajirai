// Customer Accounts MCP — OAuth (PKCE) + MCP client.
//
// Implements Shopify's documented flow for the Customer Accounts MCP
// server (shopify.dev/docs/apps/build/storefront-mcp/servers/customer-account):
//   1. Discover OAuth + MCP endpoints from the shop's storefront domain
//      (/.well-known/openid-configuration + /.well-known/customer-account-api).
//   2. Authorization-code grant with PKCE → access token scoped to ONE
//      signed-in customer.
//   3. Call the dynamically-discovered MCP endpoint with that token.
//
// Status: FLAG-GATED and NOT wired into the chat pipeline yet. Nothing
// here runs unless CUSTOMER_ACCOUNT_MCP_ENABLED=true AND the new
// /customer-account/* routes are hit. The existing storefront-logged-in
// order-history path (customer-context.server.js) is untouched and
// remains the default. This module is verified live first; chat wiring
// is a separate phase.

import crypto from "node:crypto";

// Master switch. Off by default — turning it on only activates the new
// routes; it does not change any existing behavior.
export function customerAccountMcpEnabled() {
  return String(process.env.CUSTOMER_ACCOUNT_MCP_ENABLED || "").toLowerCase() === "true";
}

// The OAuth client_id is the app's API key (per Shopify: "Your AppID
// serves as the OAuth client_id").
export function customerAccountClientId() {
  return process.env.SHOPIFY_API_KEY || "";
}

// Scope requested in the authorize call for MCP access.
export const CUSTOMER_ACCOUNT_MCP_SCOPE = "customer-account-mcp-api:full";

// ---- PKCE + state helpers (RFC 7636) ----
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function generateCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}
export function generateCodeChallenge(verifier) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}
export function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

// ---- Discovery (always from the shop's storefront/custom domain) ----
function normalizeDomain(domain) {
  return String(domain || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export async function discoverOpenIdConfig(storefrontDomain) {
  const host = normalizeDomain(storefrontDomain);
  if (!host) throw new Error("storefront domain required for OpenID discovery");
  const res = await fetch(`https://${host}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`openid discovery failed (${res.status})`);
  return res.json(); // { authorization_endpoint, token_endpoint, ... }
}

export async function discoverCustomerAccountApi(storefrontDomain) {
  const host = normalizeDomain(storefrontDomain);
  if (!host) throw new Error("storefront domain required for Customer Account API discovery");
  const res = await fetch(`https://${host}/.well-known/customer-account-api`);
  if (!res.ok) throw new Error(`customer-account-api discovery failed (${res.status})`);
  return res.json(); // { graphql_api, mcp_api, ... }
}

// ---- Authorization URL ----
export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, state, codeChallenge, scope = CUSTOMER_ACCOUNT_MCP_SCOPE }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---- Token exchange ----
export async function exchangeCodeForToken({ tokenEndpoint, clientId, redirectUri, code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

// ---- MCP call ----
// Per the docs the access token is sent in the Authorization header as-is
// (the token already carries its scheme). Body is a JSON-RPC 2.0 message.
export async function callCustomerAccountMcp({ mcpUrl, accessToken, body }) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: accessToken, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res; // caller inspects 401 (→ re-auth) vs ok
}
