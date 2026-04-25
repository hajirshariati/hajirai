import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { forwardRef } from "react";
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

const PolarisLink = forwardRef(function PolarisLink(
  { url, external, target, children, ...rest },
  ref,
) {
  if (external || target === "_blank" || (typeof url === "string" && /^https?:\/\//.test(url))) {
    return (
      <a href={url} target={target || "_blank"} rel="noopener noreferrer" ref={ref} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={url} ref={ref} {...rest}>
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
          <Link to="/app" rel="home">Seos</Link>
          <Link to="/app/rules-knowledge">Rules & Knowledge</Link>
          <Link to="/app/analytics">Analytics</Link>
          <Link to="/app/plans">Plans</Link>
          <Link to="/app/api-keys">Settings</Link>
        </NavMenu>
        <Outlet />
        <div style={{ marginTop: "40px", padding: "16px", textAlign: "center", borderTop: "2px solid #2D6B4F" }}>
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            Seos v1.0. All rights reserved.
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
