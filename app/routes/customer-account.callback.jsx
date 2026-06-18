// Customer Accounts MCP — OAuth callback.
// GET /customer-account/callback?code=<code>&state=<state>
// Exchanges the authorization code (with the saved PKCE verifier) for an
// access token and stores it against the state row. FLAG-GATED: returns
// 404 unless CUSTOMER_ACCOUNT_MCP_ENABLED=true.
//
// SECURITY TODO (before production/GA): encrypt accessToken/refreshToken
// at rest. They are short-lived and this route is disabled by default,
// but tokens should be encrypted before this is enabled for real shoppers.

import prisma from "../db.server";
import {
  customerAccountMcpEnabled,
  customerAccountClientId,
  discoverOpenIdConfig,
  exchangeCodeForToken,
} from "../lib/customer-account-mcp.server";

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>Signed in</title>" +
  "<body style=\"font-family:system-ui;padding:2rem\">" +
  "<p>You're signed in. You can return to the chat.</p>" +
  "<script>try{window.opener&&window.opener.postMessage({type:'customer-account-auth',ok:true},'*');setTimeout(function(){window.close()},300)}catch(e){}</script>";

export async function loader({ request }) {
  if (!customerAccountMcpEnabled()) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("Missing code or state", { status: 400 });

  const row = await prisma.customerAccountToken.findUnique({ where: { state } });
  if (!row || !row.codeVerifier || !row.storefrontDomain) {
    return new Response("Invalid or expired login attempt", { status: 400 });
  }

  const redirectUri = `${process.env.SHOPIFY_APP_URL}/customer-account/callback`;

  try {
    const oidc = await discoverOpenIdConfig(row.storefrontDomain);
    const token = await exchangeCodeForToken({
      tokenEndpoint: oidc.token_endpoint,
      clientId: customerAccountClientId(),
      redirectUri,
      code,
      codeVerifier: row.codeVerifier,
    });
    const expiresAt = token.expires_in
      ? new Date(Date.now() + Number(token.expires_in) * 1000)
      : null;
    await prisma.customerAccountToken.update({
      where: { state },
      data: {
        accessToken: token.access_token || null,
        refreshToken: token.refresh_token || null,
        expiresAt,
        codeVerifier: null, // consumed
      },
    });
    console.log(`[customer-account] token stored shop=${row.shop} state=${state.slice(0, 6)}…`);
  } catch (err) {
    console.error("[customer-account] token exchange failed:", err?.message || err);
    return new Response("Sign-in could not be completed. Please try again.", { status: 502 });
  }

  return new Response(DONE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
