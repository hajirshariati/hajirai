import { forwardRef } from "react";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { Box, Text } from "@shopify/polaris";
import { NavMenu } from "@shopify/app-bridge-react";
import enTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

// Polaris components that take a `url` prop (Button, Banner action, ActionList,
// …) render plain <a href>. Inside the embedded admin iframe a full-page
// navigation drops the App Bridge session token, so the next request hits
// authenticate.admin() with no session and bounces to the OAuth login page.
// Routing in-app paths through react-router's Link keeps the navigation
// client-side and preserves the session.
const PolarisLink = forwardRef(function PolarisLink(
  { children, url = "", external, target, download, ...rest },
  ref,
) {
  const isProtocolUrl = /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
  // mailto:/tel:/sms: must escape the iframe so the OS handler runs —
  // top-level navigation to those schemes is blocked by Shopify's frame policy.
  const isHandoffScheme = /^(mailto|tel|sms):/i.test(url);
  if (external || download || isProtocolUrl) {
    const newTab = external || isHandoffScheme;
    return (
      <a
        ref={ref}
        href={url}
        target={newTab ? "_blank" : target}
        rel={newTab ? "noopener noreferrer" : undefined}
        download={download}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <Link ref={ref} to={url} {...rest}>
      {children}
    </Link>
  );
});

export default function App() {
  const { apiKey } = useLoaderData();
  return (
    <ShopifyAppProvider isEmbeddedApp apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations} linkComponent={PolarisLink}>
        <NavMenu>
          <Link to="/app" rel="home">SEoS Assistant</Link>
          <Link to="/app/rules-knowledge">Rules & Knowledge</Link>
          <Link to="/app/analytics">Analytics</Link>
          <Link to="/app/plans">Plans &amp; Support</Link>
          <Link to="/app/api-keys">Settings</Link>
        </NavMenu>
        <Outlet />
        <div style={{ marginTop: "40px", padding: "16px", textAlign: "center", borderTop: "2px solid #2D6B4F" }}>
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            SEoS Assistant v1.0. All rights reserved. ·{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: "2px" }}
            >
              Privacy policy
            </a>
          </Text>
        </div>
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
