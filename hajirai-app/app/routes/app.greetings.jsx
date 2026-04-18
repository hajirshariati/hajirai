import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { Page, Layout, Card, BlockStack, TextField, Button, Banner, Text, Box, InlineGrid } from "@shopify/polaris";
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
    greeting: formData.get("greeting"),
    greetingCta: formData.get("greetingCta"),
    launcherPlaceholder: formData.get("launcherPlaceholder"),
    inputPlaceholder: formData.get("inputPlaceholder"),
    disclaimerText: formData.get("disclaimerText"),
    privacyUrl: formData.get("privacyUrl"),
    ctaHint: formData.get("ctaHint"),
    cta1Label: formData.get("cta1Label"),
    cta1Message: formData.get("cta1Message"),
    cta2Label: formData.get("cta2Label"),
    cta2Message: formData.get("cta2Message"),
    cta3Label: formData.get("cta3Label"),
    cta3Message: formData.get("cta3Message"),
    cta4Label: formData.get("cta4Label"),
    cta4Message: formData.get("cta4Message"),
    qp1Label: formData.get("qp1Label"),
    qp1Message: formData.get("qp1Message"),
    qp2Label: formData.get("qp2Label"),
    qp2Message: formData.get("qp2Message"),
    qp3Label: formData.get("qp3Label"),
    qp3Message: formData.get("qp3Message"),
    qp4Label: formData.get("qp4Label"),
    qp4Message: formData.get("qp4Message"),
  };

  await updateShopConfig(session.shop, data);
  return { success: true };
};

export default function Greetings() {
  const { config } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <Page title="Greetings & CTAs" backAction={{ url: "/app" }}>
      <TitleBar title="Greetings & CTAs" />
      <Form method="post">
        <BlockStack gap="500">
          {actionData?.success && (
            <Banner title="Settings saved" tone="success" onDismiss={() => {}} />
          )}

          <Layout>
            <Layout.AnnotatedSection
              title="Welcome Message"
              description="The greeting customers see when they first open the chat."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Greeting Message"
                    name="greeting"
                    defaultValue={config.greeting}
                    autoComplete="off"
                    multiline={3}
                  />
                  <TextField
                    label="Greeting Call-to-Action"
                    name="greetingCta"
                    defaultValue={config.greetingCta}
                    autoComplete="off"
                    helpText="Prompt shown below the greeting"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Input Placeholders"
              description="Placeholder text in the search bar and chat input."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Launcher Placeholder"
                    name="launcherPlaceholder"
                    defaultValue={config.launcherPlaceholder}
                    autoComplete="off"
                    helpText="Text shown in the search-bar launcher"
                  />
                  <TextField
                    label="Chat Input Placeholder"
                    name="inputPlaceholder"
                    defaultValue={config.inputPlaceholder}
                    autoComplete="off"
                    helpText="Text shown in the message input field"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="CTA Buttons"
              description="Up to 4 category buttons shown on the welcome screen. Each needs a label and a message that gets sent when clicked."
            >
              <Card>
                <BlockStack gap="500">
                  {[1, 2, 3, 4].map((n) => (
                    <BlockStack gap="200" key={n}>
                      <Text as="h3" variant="headingSm">CTA {n}</Text>
                      <InlineGrid columns={2} gap="400">
                        <TextField
                          label="Button Label"
                          name={`cta${n}Label`}
                          defaultValue={config[`cta${n}Label`]}
                          autoComplete="off"
                          placeholder="e.g. Women's Shoes"
                        />
                        <TextField
                          label="Message Sent"
                          name={`cta${n}Message`}
                          defaultValue={config[`cta${n}Message`]}
                          autoComplete="off"
                          placeholder="e.g. Show me women's shoes"
                        />
                      </InlineGrid>
                    </BlockStack>
                  ))}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Quick Picks"
              description="Small pill buttons below the CTAs for common topics."
            >
              <Card>
                <BlockStack gap="500">
                  {[1, 2, 3, 4].map((n) => (
                    <InlineGrid columns={2} gap="400" key={n}>
                      <TextField
                        label={`Quick Pick ${n} Label`}
                        name={`qp${n}Label`}
                        defaultValue={config[`qp${n}Label`]}
                        autoComplete="off"
                      />
                      <TextField
                        label={`Quick Pick ${n} Message`}
                        name={`qp${n}Message`}
                        defaultValue={config[`qp${n}Message`]}
                        autoComplete="off"
                      />
                    </InlineGrid>
                  ))}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Footer"
              description="Disclaimer text and privacy policy link."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="CTA Hint Text"
                    name="ctaHint"
                    defaultValue={config.ctaHint}
                    autoComplete="off"
                    helpText="Optional hint shown below CTAs"
                  />
                  <TextField
                    label="Disclaimer Text"
                    name="disclaimerText"
                    defaultValue={config.disclaimerText}
                    autoComplete="off"
                  />
                  <TextField
                    label="Privacy Policy URL"
                    name="privacyUrl"
                    defaultValue={config.privacyUrl}
                    autoComplete="off"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <Box paddingBlockEnd="800">
            <Button variant="primary" submit loading={saving}>
              Save Greetings & CTAs
            </Button>
          </Box>
        </BlockStack>
      </Form>
    </Page>
  );
}
