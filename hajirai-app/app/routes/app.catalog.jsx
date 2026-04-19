import { useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getCatalogSyncState,
  getProductCount,
  syncCatalogAsync,
} from "../models/Product.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [state, count] = await Promise.all([
    getCatalogSyncState(session.shop),
    getProductCount(session.shop),
  ]);
  return {
    shop: session.shop,
    status: state.status,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
    productsCount: count,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "resync") {
    syncCatalogAsync(admin, session.shop);
    return { started: true };
  }
  return { error: "unknown intent" };
};

function formatTime(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString();
}

function statusBadge(status) {
  if (status === "running") return <Badge tone="info">Syncing</Badge>;
  if (status === "error") return <Badge tone="critical">Error</Badge>;
  return <Badge tone="success">Idle</Badge>;
}

export default function Catalog() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const isRunning = data.status === "running" || fetcher.state !== "idle";

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [isRunning, revalidator]);

  const handleResync = () => {
    fetcher.submit({ intent: "resync" }, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Catalog" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Catalog sync</Text>
                  <Text as="p" tone="subdued">
                    ShopAgent indexes your Shopify products, variants, prices, and inventory into a
                    searchable database. The AI uses this to search your catalog, look up product
                    details, and check SKUs in real time — instead of guessing.
                  </Text>
                </BlockStack>
                {statusBadge(data.status)}
              </InlineStack>

              <Divider />

              <InlineStack gap="800">
                <Box>
                  <Text as="p" tone="subdued" variant="bodySm">Products indexed</Text>
                  <Text as="p" variant="headingLg">{data.productsCount}</Text>
                </Box>
                <Box>
                  <Text as="p" tone="subdued" variant="bodySm">Last sync</Text>
                  <Text as="p" variant="bodyMd">{formatTime(data.lastSyncedAt)}</Text>
                </Box>
              </InlineStack>

              {data.lastError && (
                <Banner tone="critical" title="Last sync failed">
                  <p>{data.lastError}</p>
                </Banner>
              )}

              <InlineStack>
                <Button variant="primary" loading={isRunning} onClick={handleResync}>
                  {isRunning ? "Syncing..." : "Resync now"}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
