import { useState, useMemo } from "react";
import { redirect, data } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import {
  Page, Layout, Card, Text, Button, Badge, BlockStack, InlineStack, Banner,
  ProgressBar, Box, Divider, Icon, TextField,
} from "@shopify/polaris";
import { CheckCircleIcon, EmailIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopPlan, getConversationsThisMonth, createSubscription, setShopPlan,
  cancelSubscription, getActiveSubscription,
} from "../lib/billing.server";
import { PLANS, PLAN_ORDER, formatLimit } from "../lib/plans";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const plan = await getShopPlan(session.shop);
  const used = await getConversationsThisMonth(session.shop);
  return { currentPlanId: plan.id, used, shop: session.shop };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const planId = String(form.get("planId") || "");
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";
  if (intent === "select" && PLANS[planId]) {
    if (planId === "free") {
      const active = await getActiveSubscription({ admin });
      if (active?.id) await cancelSubscription({ admin, subscriptionId: active.id });
      await setShopPlan({ shop: session.shop, planId: "free", subscriptionId: null });
      return data({ ok: true, message: "Switched to Free plan." });
    }
    const { confirmationUrl } = await createSubscription({ admin, shop: session.shop, planId, host });
    return redirect(confirmationUrl);
  }
  return data({ ok: false, message: "Unknown action" }, { status: 400 });
};

function PlanCard({ plan, isCurrent, isDowngrade, submitting, pendingPlan, onSubmit, highlight }) {
  return (
    <div style={{ flex: "1 1 220px", minWidth: "220px", display: "flex" }}>
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        border: highlight ? "2px solid #2D6B4F" : "1px solid var(--p-color-border)",
        borderRadius: "12px",
        padding: "20px",
        background: "var(--p-color-bg-surface)",
        position: "relative",
      }}>
        {highlight ? (
          <div style={{
            position: "absolute", top: "-10px", left: "50%", transform: "translateX(-50%)",
            background: "#2D6B4F", color: "#fff", fontSize: "11px", fontWeight: 600,
            padding: "2px 10px", borderRadius: "10px", letterSpacing: "0.04em",
          }}>
            MOST POPULAR
          </div>
        ) : null}
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">{plan.name}</Text>
            {isCurrent ? <Badge tone="success">Current</Badge> : null}
          </InlineStack>
          <Box>
            <InlineStack gap="100" blockAlign="end">
              <Text as="span" variant="heading2xl">{plan.price === 0 ? "Free" : `$${plan.price}`}</Text>
              {plan.price > 0 ? <Text as="span" variant="bodyMd" tone="subdued">/ month</Text> : null}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              {formatLimit(plan.conversationsPerMonth)} conversations / month
            </Text>
          </Box>
          <Divider />
          <BlockStack gap="150">
            {plan.features.map((f) => (
              <InlineStack key={f} gap="150" blockAlign="start" wrap={false}>
                <div style={{ flexShrink: 0, width: "16px", height: "16px", color: "#2D6B4F", marginTop: "2px" }}>
                  <Icon source={CheckCircleIcon} tone="success" />
                </div>
                <Text as="span" variant="bodySm">{f}</Text>
              </InlineStack>
            ))}
          </BlockStack>
        </BlockStack>
        <div style={{ marginTop: "auto", paddingTop: "20px" }}>
          <Form method="post" onSubmit={onSubmit}>
            <input type="hidden" name="intent" value="select" />
            <input type="hidden" name="planId" value={plan.id} />
            <Button
              submit fullWidth
              variant={isCurrent ? "secondary" : highlight ? "primary" : "secondary"}
              disabled={isCurrent || submitting}
              loading={submitting && pendingPlan === plan.id}
            >
              {isCurrent ? "Current plan" : isDowngrade ? `Downgrade to ${plan.name}` : plan.price === 0 ? "Switch to Free" : `Upgrade to ${plan.name}`}
            </Button>
          </Form>
        </div>
      </div>
    </div>
  );
}

function SupportBox({ shop }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const mailtoHref = useMemo(() => {
    const s = subject.trim() || "Support request";
    const bodyLines = [
      `Shop: ${shop}`,
      "",
      message.trim(),
    ].join("\n");
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`[Seos] ${s}`)}&body=${encodeURIComponent(bodyLines)}`;
  }, [subject, message, shop]);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack gap="200" blockAlign="center">
          <Icon source={EmailIcon} />
          <Text as="h2" variant="headingMd">Email support</Text>
          <Badge tone="info">Replies within 1 business day</Badge>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">
          Question, bug, or feature request? Send it to our team — we read every message.
        </Text>
        <TextField
          label="Subject"
          value={subject}
          onChange={setSubject}
          placeholder="e.g. Billing question, product sync issue, feature request"
          autoComplete="off"
        />
        <TextField
          label="Message"
          value={message}
          onChange={setMessage}
          multiline={6}
          placeholder="Tell us what's happening — include any error messages or screenshots if helpful."
          autoComplete="off"
        />
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="p" tone="subdued" variant="bodySm">
            Sends to <strong>{SUPPORT_EMAIL}</strong> from your default mail app.
          </Text>
          <Button
            variant="primary"
            icon={EmailIcon}
            url={mailtoHref}
            disabled={message.trim().length === 0}
          >
            Send email
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function PlansPage() {
  const { currentPlanId, used, shop } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const [pendingPlan, setPendingPlan] = useState(null);
  const current = PLANS[currentPlanId] || PLANS.free;
  const limit = current.conversationsPerMonth;
  const usagePct = limit === Infinity ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const usageTone = usagePct >= 90 ? "critical" : usagePct >= 75 ? "caution" : "primary";

  return (
    <Page>
      <TitleBar title="Plan & Support" />
      <div style={{ height: "6px", background: "linear-gradient(90deg, #2D6B4F 0%, #3a8a66 100%)", borderRadius: "4px", marginBottom: "16px" }} />
      <Layout>
        {actionData?.message ? (
          <Layout.Section>
            <Banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingLg">Your plan</Text>
                    <Badge tone={currentPlanId === "free" ? "attention" : "success"}>
                      {current.price === 0 ? "Free" : `$${current.price}/mo`}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {current.name} · {limit === Infinity ? "unlimited" : formatLimit(limit)} conversations / month
                  </Text>
                </BlockStack>
                <BlockStack gap="050" align="end">
                  <Text as="p" variant="headingMd">
                    {limit === Infinity
                      ? `${used.toLocaleString()} this month`
                      : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">conversations used</Text>
                </BlockStack>
              </InlineStack>
              {limit !== Infinity ? (
                <BlockStack gap="100">
                  <ProgressBar progress={usagePct} tone={usageTone} />
                  {usagePct >= 90 ? (
                    <Text as="p" tone="critical" variant="bodySm">
                      You're at {usagePct}% — upgrade now to avoid hitting the limit.
                    </Text>
                  ) : usagePct >= 75 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {usagePct}% used — consider upgrading before the end of the month.
                    </Text>
                  ) : null}
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingLg">Compare plans</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Change plans any time. Charges are handled by Shopify and appear on your Shopify invoice.
              </Text>
            </BlockStack>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
              {PLAN_ORDER.map((id) => {
                const plan = PLANS[id];
                const isCurrent = id === currentPlanId;
                const isDowngrade = PLAN_ORDER.indexOf(id) < PLAN_ORDER.indexOf(currentPlanId);
                return (
                  <PlanCard
                    key={id}
                    plan={plan}
                    isCurrent={isCurrent}
                    isDowngrade={isDowngrade}
                    submitting={submitting}
                    pendingPlan={pendingPlan}
                    highlight={id === "growth"}
                    onSubmit={() => setPendingPlan(id)}
                  />
                );
              })}
            </div>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <SupportBox shop={shop} />
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Billing FAQ</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                <strong>How am I billed?</strong> Charges are handled by Shopify and appear on your Shopify invoice.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                <strong>Can I change plans later?</strong> Yes — upgrade or downgrade any time. Changes take effect immediately.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                <strong>Do unused conversations roll over?</strong> No — each month's allowance resets at the start of the billing cycle.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                <strong>What happens if I hit my limit?</strong> The AI pauses for new conversations until next cycle or an upgrade — your widget still loads but won't reply.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
