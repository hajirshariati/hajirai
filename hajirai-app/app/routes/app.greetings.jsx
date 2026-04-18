import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { useState } from "react";
import { Page, Layout, Card, BlockStack, TextField, Button, Banner, Text, Box, InlineGrid } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

const FIELD_KEYS = [
  "greeting", "greetingCta", "launcherPlaceholder", "inputPlaceholder",
  "disclaimerText", "privacyUrl", "ctaHint",
  "cta1Label", "cta1Message", "cta2Label", "cta2Message",
  "cta3Label", "cta3Message", "cta4Label", "cta4Message",
  "qp1Label", "qp1Message", "qp2Label", "qp2Message",
  "qp3Label", "qp3Message", "qp4Label", "qp4Message",
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  return { config };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = {};
  for (const key of FIELD_KEYS) data[key] = formData.get(key) ?? "";
  await updateShopConfig(session.shop, data);
  return { success: true };
};

export default function Greetings() {
  const { config } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [values, setValues] = useState(() => {
    const v = {};
    for (const k of FIELD_KEYS) v[k] = config[k] ?? "";
    return v;
  });
  const setField = (k) => (val) => setValues((prev) => ({ ...prev, [k]: val }));

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
                    value={values.greeting}
                    onChange={setField("greeting")}
                    autoComplete="off"
                    multiline={3}
                  />
                  <TextField
                    label="Greeting Call-to-Action"
                    value={values.greetingCta}
                    onChange={setField("greetingCta")}
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
                    value={values.launcherPlaceholder}
                    onChange={setField("launcherPlaceholder")}
                    autoComplete="off"
                    helpText="Text shown in the search-bar launcher"
                  />
                  <TextField
                    label="Chat Input Placeholder"
                    value={values.inputPlaceholder}
                    onChange={setField("inputPlaceholder")}
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
                      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                        <TextField
                          label="Button Label"
                          value={values[`cta${n}Label`]}
                          onChange={setField(`cta${n}Label`)}
                          autoComplete="off"
                          placeholder="e.g. Women's Shoes"
                        />
                        <TextField
                          label="Message Sent"
                          value={values[`cta${n}Message`]}
                          onChange={setField(`cta${n}Message`)}
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
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400" key={n}>
                      <TextField
                        label={`Quick Pick ${n} Label`}
                        value={values[`qp${n}Label`]}
                        onChange={setField(`qp${n}Label`)}
                        autoComplete="off"
                      />
                      <TextField
                        label={`Quick Pick ${n} Message`}
                        value={values[`qp${n}Message`]}
                        onChange={setField(`qp${n}Message`)}
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
                    value={values.ctaHint}
                    onChange={setField("ctaHint")}
                    autoComplete="off"
                    helpText="Optional hint shown below CTAs"
                  />
                  <TextField
                    label="Disclaimer Text"
                    value={values.disclaimerText}
                    onChange={setField("disclaimerText")}
                    autoComplete="off"
                  />
                  <TextField
                    label="Privacy Policy URL"
                    value={values.privacyUrl}
                    onChange={setField("privacyUrl")}
                    autoComplete="off"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          {FIELD_KEYS.map((k) => (
            <input key={k} type="hidden" name={k} value={values[k]} />
          ))}

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
