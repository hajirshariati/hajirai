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
import prisma from "../db.server";

// Master switch. Off by default — turning it on only activates the new
// routes; it does not change any existing behavior.
export function customerAccountMcpEnabled() {
  return String(process.env.CUSTOMER_ACCOUNT_MCP_ENABLED || "").toLowerCase() === "true";
}

// ---- Token encryption at rest (AES-256-GCM) ----
// Customer access/refresh tokens are encrypted before they touch the DB.
// The key is derived (SHA-256) from ENCRYPTION_KEY so any key format
// works. Stored as "v1:<base64(iv|tag|ciphertext)>". decryptSecret is
// backward-compatible: a value without the "v1:" prefix is returned
// as-is (legacy plaintext), so nothing breaks if a row predates this.
const ENC_ALGO = "aes-256-gcm";
function encKey() {
  return crypto.createHash("sha256").update(String(process.env.ENCRYPTION_KEY || "")).digest();
}
export function encryptSecret(plain) {
  if (plain == null) return null;
  if (!process.env.ENCRYPTION_KEY) return plain; // dev fallback; set the key in prod
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, encKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + Buffer.concat([iv, tag, enc]).toString("base64");
}
export function decryptSecret(stored) {
  if (stored == null) return null;
  if (typeof stored !== "string" || !stored.startsWith("v1:")) return stored; // legacy plaintext
  const buf = Buffer.from(stored.slice(3), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ENC_ALGO, encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// Look up a valid (non-expired) customer token for a chat session.
// Returns { accessToken, storefrontDomain, customerId } with the token
// DECRYPTED, or null. A 60s skew guard avoids using a token about to
// expire mid-request.
export async function getValidTokenForSession(shop, chatSessionId) {
  if (!shop || !chatSessionId) return null;
  const row = await prisma.customerAccountToken.findFirst({
    where: { shop, chatSessionId, accessToken: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || !row.accessToken) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now() + 60_000) return null;
  return {
    accessToken: decryptSecret(row.accessToken),
    storefrontDomain: row.storefrontDomain,
    customerId: row.customerId || null,
  };
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

// Call a specific MCP tool by name (JSON-RPC tools/call). Discovers the
// MCP endpoint from the storefront domain, posts the request, and
// returns the parsed `result`. Throws with err.code=401 when the token
// is rejected (caller should prompt re-auth).
export async function callMcpTool({ storefrontDomain, accessToken, name, args = {} }) {
  const api = await discoverCustomerAccountApi(storefrontDomain);
  if (!api.mcp_api) throw new Error("MCP endpoint unavailable for this store");
  const res = await callCustomerAccountMcp({
    mcpUrl: api.mcp_api,
    accessToken,
    body: { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
  });
  if (res.status === 401) {
    const e = new Error("customer token unauthorized");
    e.code = 401;
    throw e;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`MCP tool ${name} failed (${res.status})`);
  if (json.error) throw new Error(json.error.message || `MCP tool ${name} error`);
  return json.result;
}
