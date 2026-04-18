import { useLoaderData, useActionData, useNavigation, Form, useFetcher } from "react-router";
import { useEffect, useRef, useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Checkbox,
  Button,
  Banner,
  Text,
  Box,
  InlineGrid,
  Thumbnail,
} from "@shopify/polaris";
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

function ColorField({ label, value, onChange, helpText }) {
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodyMd">{label}</Text>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <input
          type="color"
          value={safe}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} swatch`}
          style={{
            width: 40,
            height: 36,
            padding: 2,
            border: "1px solid var(--p-color-border)",
            borderRadius: 8,
            background: "transparent",
            cursor: "pointer",
            flex: "0 0 auto",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField
            label={label}
            labelHidden
            value={value}
            onChange={onChange}
            autoComplete="off"
            helpText={helpText}
          />
        </div>
      </InlineStack>
    </BlockStack>
  );
}

function ImageField({ label, helpText, value, onChange }) {
  const fetcher = useFetcher();
  const fileRef = useRef(null);
  const uploading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.url) onChange(fetcher.data.url);
  }, [fetcher.data]);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    fetcher.submit(fd, {
      method: "post",
      action: "/app/upload-image",
      encType: "multipart/form-data",
    });
    e.target.value = "";
  };

  return (
    <BlockStack gap="200">
      <Text as="span" variant="bodyMd" fontWeight="medium">{label}</Text>
      <InlineStack gap="400" blockAlign="center" wrap={false}>
        {value ? (
          <Thumbnail source={value} alt={label} size="large" />
        ) : (
          <div
            style={{
              width: 60,
              height: 60,
              border: "1px dashed var(--p-color-border)",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--p-color-text-subdued)",
              fontSize: 12,
              background: "var(--p-color-bg-surface-secondary)",
            }}
          >
            No image
          </div>
        )}
        <BlockStack gap="100">
          <InlineStack gap="200">
            <Button onClick={() => fileRef.current?.click()} loading={uploading}>
              {value ? "Change image" : "Upload image"}
            </Button>
            {value && (
              <Button variant="tertiary" tone="critical" onClick={() => onChange("")}>
                Remove
              </Button>
            )}
          </InlineStack>
          {fetcher.data?.error && (
            <Text as="span" tone="critical" variant="bodySm">
              {fetcher.data.error}
            </Text>
          )}
        </BlockStack>
      </InlineStack>
      <TextField
        label="Image URL"
        labelHidden
        value={value}
        onChange={onChange}
        autoComplete="off"
        placeholder="Or paste an image URL"
        helpText={helpText}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFile}
      />
    </BlockStack>
  );
}

export default function Branding() {
  const { config } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting" && nav.formMethod?.toUpperCase() === "POST";

  const [assistantName, setAssistantName] = useState(config.assistantName || "");
  const [assistantTagline, setAssistantTagline] = useState(config.assistantTagline || "");
  const [avatarUrl, setAvatarUrl] = useState(config.avatarUrl || "");
  const [bannerUrl, setBannerUrl] = useState(config.bannerUrl || "");
  const [showBanner, setShowBanner] = useState(Boolean(config.showBanner));
  const [colorPrimary, setColorPrimary] = useState(config.colorPrimary || "#2d6b4f");
  const [colorAccent, setColorAccent] = useState(config.colorAccent || "#3a7d5c");
  const [colorCtaBg, setColorCtaBg] = useState(config.colorCtaBg || "#e8f5ee");
  const [colorCtaText, setColorCtaText] = useState(config.colorCtaText || "#2d6b4f");
  const [colorCtaHover, setColorCtaHover] = useState(config.colorCtaHover || "#d4ebdb");
  const [widgetPosition, setWidgetPosition] = useState(config.widgetPosition || "bottom-center");
  const [launcherWidth, setLauncherWidth] = useState(config.launcherWidth || "500");

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
                    value={assistantName}
                    onChange={setAssistantName}
                    autoComplete="off"
                  />
                  <TextField
                    label="Tagline"
                    value={assistantTagline}
                    onChange={setAssistantTagline}
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
                <BlockStack gap="500">
                  <ImageField
                    label="Avatar Image"
                    value={avatarUrl}
                    onChange={setAvatarUrl}
                    helpText="Square image, at least 200×200px. Upload or paste a CDN URL."
                  />
                  <ImageField
                    label="Banner Image"
                    value={bannerUrl}
                    onChange={setBannerUrl}
                    helpText="Wide image shown at the top of the welcome screen."
                  />
                  <Checkbox
                    label="Show banner on welcome screen"
                    checked={showBanner}
                    onChange={setShowBanner}
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
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                    <ColorField
                      label="Primary Color"
                      value={colorPrimary}
                      onChange={setColorPrimary}
                      helpText="Main brand color"
                    />
                    <ColorField
                      label="Accent Color"
                      value={colorAccent}
                      onChange={setColorAccent}
                      helpText="Secondary color"
                    />
                  </InlineGrid>
                  <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                    <ColorField
                      label="CTA Background"
                      value={colorCtaBg}
                      onChange={setColorCtaBg}
                    />
                    <ColorField
                      label="CTA Text"
                      value={colorCtaText}
                      onChange={setColorCtaText}
                    />
                    <ColorField
                      label="CTA Hover"
                      value={colorCtaHover}
                      onChange={setColorCtaHover}
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
                    options={[
                      { label: "Bottom Center", value: "bottom-center" },
                      { label: "Bottom Left", value: "bottom-left" },
                      { label: "Bottom Right", value: "bottom-right" },
                    ]}
                    value={widgetPosition}
                    onChange={setWidgetPosition}
                  />
                  <TextField
                    label="Launcher Width (px)"
                    value={launcherWidth}
                    onChange={setLauncherWidth}
                    autoComplete="off"
                    type="number"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <input type="hidden" name="assistantName" value={assistantName} />
          <input type="hidden" name="assistantTagline" value={assistantTagline} />
          <input type="hidden" name="avatarUrl" value={avatarUrl} />
          <input type="hidden" name="bannerUrl" value={bannerUrl} />
          <input type="hidden" name="showBanner" value={showBanner ? "true" : "false"} />
          <input type="hidden" name="colorPrimary" value={colorPrimary} />
          <input type="hidden" name="colorAccent" value={colorAccent} />
          <input type="hidden" name="colorCtaBg" value={colorCtaBg} />
          <input type="hidden" name="colorCtaText" value={colorCtaText} />
          <input type="hidden" name="colorCtaHover" value={colorCtaHover} />
          <input type="hidden" name="widgetPosition" value={widgetPosition} />
          <input type="hidden" name="launcherWidth" value={launcherWidth} />

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
