import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Link } from "react-router";
import { login } from "../../shopify.server";

// `login(request)` returns a redirect Response when it can start the OAuth
// flow (i.e. the request URL carries a valid ?shop= query). In that case the
// throw-redirect short-circuits the loader and the render below never runs —
// the merchant lands on Shopify's OAuth consent screen.
//
// We only reach the JSX render path when login() failed to start OAuth (no
// shop param, malformed shop, etc.). Per Shopify's "Initiate installation
// from a Shopify-owned surface" requirement, the recovery here is NOT a
// manual shop-domain input — it's a link to the App Store / merchant's own
// Shopify admin.
export const loader = async ({ request }) => {
  await login(request);
  return null;
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Install SEoS Assistant from a Shopify-owned surface">
          <s-paragraph>
            To install SEoS Assistant, visit the Shopify App Store or open the
            app from inside your Shopify admin. Installs need to start from a
            Shopify-owned surface so the OAuth flow can attach to your store.
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
