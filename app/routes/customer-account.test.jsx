// Customer Accounts MCP — diagnostic smoke test.
// GET /customer-account/test?shop=<shop>[&storefront_domain=<domain>]
// Uses the most recent stored customer token to call the MCP server's
// tools/list and returns the raw result. Confirms the MCP endpoint works
// (and surfaces the custom-domain requirement) BEFORE wiring into chat.
// FLAG-GATED: 404 unless CUSTOMER_ACCOUNT_MCP_ENABLED=true.

import prisma from "../db.server";
import {
  customerAccountMcpEnabled,
  discoverCustomerAccountApi,
  callCustomerAccountMcp,
  decryptSecret,
} from "../lib/customer-account-mcp.server";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function loader({ request }) {
  if (!customerAccountMcpEnabled()) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  if (!shop) return json({ error: "Missing shop" }, 400);

  const row = await prisma.customerAccountToken.findFirst({
    where: { shop, accessToken: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || !row.accessToken) {
    return json({ error: "No stored customer token. Run /customer-account/start and sign in first." }, 400);
  }

  const storefrontDomain = url.searchParams.get("storefront_domain") || row.storefrontDomain;
  const out = { shop, storefrontDomain, tokenExpiresAt: row.expiresAt };

  try {
    const api = await discoverCustomerAccountApi(storefrontDomain);
    out.mcp_api = api.mcp_api || null;
    if (!api.mcp_api) {
      out.error = "Discovery returned no mcp_api — the store likely needs a custom domain for the Customer Accounts MCP.";
      return json(out, 200);
    }
    const res = await callCustomerAccountMcp({
      mcpUrl: api.mcp_api,
      accessToken: decryptSecret(row.accessToken),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    out.mcpStatus = res.status;
    const text = await res.text().catch(() => "");
    out.mcpBody = text.slice(0, 3000);
    if (res.status === 401) out.note = "401 from MCP — token rejected/expired; re-auth via /customer-account/start.";
    return json(out, 200);
  } catch (err) {
    out.error = String(err?.message || err);
    return json(out, 200);
  }
}
