import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Link } from "react-router";
import { login } from "../../shopify.server";

// `login(request)` returns/throws a redirect when it can start the OAuth flow
// (the request carries a valid ?shop=). We only reach the JSX render path when
// it couldn't — which, for an already-installed merchant, almost always means
// an embedded session token expired and the request fell out of the embedded
// context. In that case we auto-recover (see RECOVER below) instead of showing
// a dead end; the install message is only the last resort for genuinely
// external visits.
export const loader = async ({ request }) => {
  await login(request);
  return null;
};

// Client-side recovery. Shopify passes the base64 `host` (the admin URL of this
// app embed) on embedded requests. If it's present, the session merely expired:
// point the TOP admin frame back at the app so App Bridge re-initializes and
// re-authenticates via token exchange — no merchant action needed. A 15s guard
// prevents a redirect loop if re-auth keeps failing.
const RECOVER = `
  (function () {
    try {
      var host = new URLSearchParams(window.location.search).get('host');
      if (!host || !window.top) return;
      var key = 'de_reauth_ts';
      var last = +(sessionStorage.getItem(key) || 0);
      if (Date.now() - last < 15000) return;
      sessionStorage.setItem(key, String(Date.now()));
      var target = host.indexOf('http') === 0 ? host : 'https://' + atob(host);
      window.top.location.href = target;
    } catch (e) {}
  })();
`;

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <script dangerouslySetInnerHTML={{ __html: RECOVER }} />
      <s-page>
        <s-section heading="Reopen SEoS Assistant">
          <s-paragraph>
            Your session expired. Reopen SEoS Assistant from your Shopify admin and
            you&rsquo;ll be signed back in automatically — no data was changed.
            If you haven&rsquo;t installed it yet, get it from the Shopify App
            Store.
          </s-paragraph>
          <s-paragraph>
            <Link
              to="https://apps.shopify.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open the Shopify App Store
            </Link>
          </s-paragraph>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
