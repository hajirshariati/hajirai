import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { Page, Layout, Card, BlockStack, TextField, Select, Checkbox, Button, Banner, Text, Box, InlineGrid } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  return { config };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const data = {
    assistantName: formData.get("assistantName"),
    assistantTagline: formData.get("assistantTagline"),
    avatarUrl: formData.get("avatarUrl"),
    bannerUrl: formData.get("bannerUrl"),
    colorPrimary: formData.get("colorPrimary"),
    colorAccent: formData.get("colorAccent"),
    colorCtaBg: formData.get("colorCtaBg"),
    colorCtaText: formData.get("colorCtaText"),
    colorCtaHover: formData.get("colorCtaHover"),
    launcherWidth: formData.get("launcherWidth"),
    widgetPosition: formData.get("widgetPosition"),
    showBanner: formData.get("showBanner") === "true",
  };

  await updateShopConfig(session.shop, data);
  return { success: true };
};

export default function Branding() {
  const { config } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <Page title="Branding" backAction={{ url: "/app" }}>
      <TitleBar title="Branding" />
      <Form method="post">
        <BlockStack gap="500">
          {actionData?.success && (
            <Banner title="Settings saved" tone="success" onDismiss={() => {}} />
          )}

          <Layout>
            <Layout.AnnotatedSection
              title="Assistant Identity"
              description="Set the name and tagline that appear in the chat header."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Assistant Name"
                    name="assistantName"
                    defaultValue={config.assistantName}
                    autoComplete="off"
                  />
                  <TextField
                    label="Tagline"
                    name="assistantTagline"
                    defaultValue={config.assistantTagline}
                    autoComplete="off"
                    helpText="Appears below the name in the chat header"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Images"
              description="Avatar and banner images for the chat widget."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Avatar Image URL"
                    name="avatarUrl"
                    defaultValue={config.avatarUrl}
                    autoComplete="off"
                    helpText="Square image, at least 200x200px. Use a CDN URL."
                  />
                  <TextField
                    label="Banner Image URL"
                    name="bannerUrl"
                    defaultValue={config.bannerUrl}
                    autoComplete="off"
                    helpText="Wide image shown at the top of the welcome screen."
                  />
                  <Checkbox
                    label="Show banner on welcome screen"
                    name="showBanner"
                    value="true"
                    defaultChecked={config.showBanner}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Colors"
              description="Customize the chat widget colors to match your brand."
            >
              <Card>
                <BlockStack gap="400">
                  <InlineGrid columns={2} gap="400">
                    <TextField
                      label="Primary Color"
                      name="colorPrimary"
                      defaultValue={config.colorPrimary}
                      autoComplete="off"
                      helpText="Main brand color (hex)"
                    />
                    <TextField
                      label="Accent Color"
                      name="colorAccent"
                      defaultValue={config.colorAccent}
                      autoComplete="off"
                      helpText="Secondary color (hex)"
                    />
                  </InlineGrid>
                  <InlineGrid columns={3} gap="400">
                    <TextField
                      label="CTA Background"
                      name="colorCtaBg"
                      defaultValue={config.colorCtaBg}
                      autoComplete="off"
                    />
                    <TextField
                      label="CTA Text"
                      name="colorCtaText"
                      defaultValue={config.colorCtaText}
                      autoComplete="off"
                    />
                    <TextField
                      label="CTA Hover"
                      name="colorCtaHover"
                      defaultValue={config.colorCtaHover}
                      autoComplete="off"
                    />
                  </InlineGrid>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Layout"
              description="Position and sizing of the chat launcher."
            >
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="Widget Position"
                    name="widgetPosition"
                    options={[
                      { label: "Bottom Center", value: "bottom-center" },
                      { label: "Bottom Left", value: "bottom-left" },
                      { label: "Bottom Right", value: "bottom-right" },
                    ]}
                    defaultValue={config.widgetPosition}
                  />
                  <TextField
                    label="Launcher Width (px)"
                    name="launcherWidth"
                    defaultValue={config.launcherWidth}
                    autoComplete="off"
                    type="number"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <Box paddingBlockEnd="800">
            <Button variant="primary" submit loading={saving}>
              Save Branding
            </Button>
          </Box>
        </BlockStack>
      </Form>
    </Page>
  );
}
