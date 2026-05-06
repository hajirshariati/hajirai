import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Divider,
  FormLayout,
  TextField,
  Select,
  Checkbox,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import { getShopPlan } from "../lib/billing.server";
import { PlanGate } from "../components/PlanGate";

// Focused loader — only the fields the fit-predictor card needs.
// Keeping this independent from app.rules.jsx so the bigger admin
// page doesn't have to change shape when fit-predictor evolves.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [config, plan] = await Promise.all([
    getShopConfig(session.shop),
    getShopPlan(session.shop),
  ]);
  return {
    fitPredictorEnabled: config.fitPredictorEnabled === true,
    fitPredictorConfig: (() => {
      try {
        const v = JSON.parse(config.fitPredictorConfig || "{}");
        return v && typeof v === "object" ? v : {};
      } catch {
        return {};
      }
    })(),
    plan: { id: plan.id, name: plan.name, features: plan.features },
  };
};

// Two intents — toggle on/off, save weights/display/external API config.
// Mirrors the previous handlers in app.rules.jsx so existing
// FitPredictorCard form-data shape stays valid.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "toggle_fit_predictor") {
    const value = formData.get("fitPredictorEnabled") === "true";
    await updateShopConfig(session.shop, { fitPredictorEnabled: value });
    return { saved: true };
  }

  if (intent === "save_fit_predictor_config") {
    const raw = formData.get("fitPredictorConfig");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const clean = {
          reviewsWeight: Number.isFinite(parsed.reviewsWeight) ? Math.max(0, Math.min(1, parsed.reviewsWeight)) : 0.4,
          returnsWeight: Number.isFinite(parsed.returnsWeight) ? Math.max(0, Math.min(1, parsed.returnsWeight)) : 0.2,
          historyWeight: Number.isFinite(parsed.historyWeight) ? Math.max(0, Math.min(1, parsed.historyWeight)) : 0.3,
          externalWeight: Number.isFinite(parsed.externalWeight) ? Math.max(0, Math.min(1, parsed.externalWeight)) : 0.1,
          minConfidence: Number.isFinite(parsed.minConfidence) ? Math.max(0, Math.min(100, parsed.minConfidence)) : 50,
          display: parsed.display === "percent" || parsed.display === "bar" || parsed.display === "hide" ? parsed.display : "bar",
          externalUrl: typeof parsed.externalUrl === "string" ? parsed.externalUrl.trim() : "",
          externalAuthHeader: typeof parsed.externalAuthHeader === "string" ? parsed.externalAuthHeader.trim() : "",
        };
        await updateShopConfig(session.shop, { fitPredictorConfig: JSON.stringify(clean) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid fit predictor config." };
  }

  return { error: "Unknown intent." };
};

function FitPredictorCard({ enabled, config }) {
  const fetcher = useFetcher();
  const [isOn, setIsOn] = useState(!!enabled);
  const [reviewsW, setReviewsW] = useState(String(config?.reviewsWeight ?? 0.4));
  const [returnsW, setReturnsW] = useState(String(config?.returnsWeight ?? 0.2));
  const [historyW, setHistoryW] = useState(String(config?.historyWeight ?? 0.3));
  const [externalW, setExternalW] = useState(String(config?.externalWeight ?? 0.1));
  const [minConf, setMinConf] = useState(String(config?.minConfidence ?? 50));
  const [display, setDisplay] = useState(config?.display === "percent" ? "percent" : "bar");
  const [externalUrl, setExternalUrl] = useState(config?.externalUrl || "");
  const [externalAuth, setExternalAuth] = useState(config?.externalAuthHeader || "");

  const toggle = (checked) => {
    setIsOn(checked);
    const fd = new FormData();
    fd.set("intent", "toggle_fit_predictor");
    fd.set("fitPredictorEnabled", String(checked));
    fetcher.submit(fd, { method: "post" });
  };

  const saveConfig = () => {
    const num = (v, d) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : d;
    };
    const payload = {
      reviewsWeight: num(reviewsW, 0.4),
      returnsWeight: num(returnsW, 0.2),
      historyWeight: num(historyW, 0.3),
      externalWeight: num(externalW, 0.1),
      minConfidence: num(minConf, 50),
      display,
      externalUrl: externalUrl.trim(),
      externalAuthHeader: externalAuth.trim(),
    };
    const fd = new FormData();
    fd.set("intent", "save_fit_predictor_config");
    fd.set("fitPredictorConfig", JSON.stringify(payload));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Fit predictor</Text>
            <Badge tone="info">Beta</Badge>
            <Badge tone={isOn ? "success" : undefined}>{isOn ? "Enabled" : "Disabled"}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Shows a visual size recommendation with a confidence score when a customer asks "what size should I get?". Combines review fit data (Yotpo), return sizing reasons (Aftership), the logged-in customer's own order history, and an optional external fit API into one card under the product.
          </Text>
        </BlockStack>

        <Checkbox
          label="Enable fit predictor"
          helpText="When off, sizing questions fall back to the existing reviews + returns behavior."
          checked={isOn}
          onChange={toggle}
        />

        {isOn && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Signal weights (0–1, relative)</Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="Reviews weight" type="number" step="0.05" min="0" max="1"
                    value={reviewsW} onChange={setReviewsW} autoComplete="off"
                    helpText="Yotpo review fit summary." />
                  <TextField label="Returns weight" type="number" step="0.05" min="0" max="1"
                    value={returnsW} onChange={setReturnsW} autoComplete="off"
                    helpText="Aftership sizing return reasons." />
                </FormLayout.Group>
                <FormLayout.Group>
                  <TextField label="History weight" type="number" step="0.05" min="0" max="1"
                    value={historyW} onChange={setHistoryW} autoComplete="off"
                    helpText="Logged-in customer's past order sizes (VIP only)." />
                  <TextField label="External weight" type="number" step="0.05" min="0" max="1"
                    value={externalW} onChange={setExternalW} autoComplete="off"
                    helpText="Optional external fit API (see below)." />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>

            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Display</Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="Minimum confidence to show (%)" type="number" step="5" min="0" max="100"
                    value={minConf} onChange={setMinConf} autoComplete="off"
                    helpText="Below this, the card is hidden — the AI answers in plain text instead." />
                  <Select
                    label="Visual style"
                    options={[
                      { label: "Progress bar", value: "bar" },
                      { label: "Percent only", value: "percent" },
                      { label: "Hidden (size only)", value: "hide" },
                    ]}
                    value={display}
                    onChange={setDisplay}
                    helpText='How confidence is rendered. "Hidden" shows only the recommended size and reasons — no percentage or bar.'
                  />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>

            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">External fit API (optional)</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                If you have a foot-scan or fit service, the predictor will POST <code>{`{ shop, productHandle, customerId }`}</code> to this URL and expects JSON <code>{`{ size, confidence?, summary? }`}</code>. Leave blank to skip.
              </Text>
              <FormLayout>
                <TextField
                  label="Endpoint URL"
                  value={externalUrl}
                  onChange={setExternalUrl}
                  placeholder="https://api.example.com/fit"
                  autoComplete="off"
                />
                <TextField
                  label="Auth header (optional)"
                  value={externalAuth}
                  onChange={setExternalAuth}
                  placeholder="Authorization: Bearer xxxx"
                  autoComplete="off"
                  helpText="Format: Header-Name: value"
                />
              </FormLayout>
            </BlockStack>

            <InlineStack align="end">
              <Button variant="primary" onClick={saveConfig} loading={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save_fit_predictor_config"}>
                Save settings
              </Button>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

export default function FitPredictor() {
  const data = useLoaderData();
  return (
    <Page>
      <TitleBar title="Fit predictor" />
      <div style={{ height: "4px", borderRadius: "2px", background: "linear-gradient(90deg, #2D6B4F, #3a8a66, transparent)", marginBottom: "20px" }} />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingLg">Fit predictor</Text>
              <Badge tone="info">Beta</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              A visual size-recommendation card the AI can show in chat when a customer asks "what size should I get?". This feature is in beta — accuracy depends on having Yotpo reviews, Aftership return reasons, and/or an external fit API connected.
            </Text>
          </BlockStack>
        </Card>
        <PlanGate
          plan={data.plan}
          feature="fitPredictor"
          summary="Visual fit-confidence card with size recommendation, aggregating reviews, return reasons, customer order history, and any merchant-configured external fit API."
        >
          <FitPredictorCard enabled={data.fitPredictorEnabled} config={data.fitPredictorConfig} />
        </PlanGate>
      </BlockStack>
    </Page>
  );
}
