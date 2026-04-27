import { useState } from "react";
import { redirect, data } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import {
  Page, Layout, Card, Text, Button, Badge, BlockStack, InlineStack, Banner,
  ProgressBar, Box, Icon,
} from "@shopify/polaris";
import { CheckCircleIcon, EmailIcon, MinusIcon, ClipboardIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopPlan, getConversationsThisMonth, createSubscription, setShopPlan,
  cancelSubscription, getActiveSubscription,
} from "../lib/billing.server";
import { PLANS, PLAN_ORDER, planAllows, formatLimit } from "../lib/plans";

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

const FEATURE_ROWS = [
  { label: "Conversations / month", get: (p) => formatLimit(p.conversationsPerMonth) },
  { label: "Knowledge files", get: (p) => formatLimit(p.knowledgeFiles) },
  { label: "Analytics history", get: (p) => `${p.analyticsRetentionDays} days` },
  { label: "Smart model routing", get: (p) => planAllows(p, "smartRouting") },
  { label: "Prompt caching", get: (p) => planAllows(p, "promptCaching") },
  { label: "Advanced AI model", get: (p) => planAllows(p, "advancedModel") },
  { label: "Search rules & synonyms", get: (p) => planAllows(p, "searchRules") },
  { label: "Product enrichment (CSV)", get: (p) => planAllows(p, "productEnrichment") },
  { label: "Fit predictor", get: (p) => planAllows(p, "fitPredictor") },
  { label: "VIP mode (logged-in profiles)", get: (p) => planAllows(p, "vipMode") },
  { label: "Klaviyo integration", get: (p) => planAllows(p, "klaviyoIntegration") },
  { label: "Aftership integration", get: (p) => planAllows(p, "aftershipIntegration") },
  { label: "Yotpo loyalty + reviews", get: (p) => planAllows(p, "yotpoIntegration") },
  { label: "Remove SEoS Assistant branding", get: (p) => planAllows(p, "removeBranding") },
  { label: "Email support", get: () => true },
];

// Sort rows so the features supported by the most plans float to the top and
// tier-exclusive features sink to the bottom. Visual effect: in any one plan's
// column, all the green checks stack first, then the row of dashes/X marks
// stacks at the bottom — easy to scan what a tier is missing.
const SORTED_FEATURE_ROWS = [...FEATURE_ROWS].sort((a, b) => {
  const score = (row) =>
    PLAN_ORDER.reduce(
      (acc, id) => acc + (row.get(PLANS[id]) !== false ? 1 : 0),
      0,
    );
  return score(b) - score(a);
});

function Cell({ value }) {
  if (value === true) {
    return (
      <div style={{ display: "flex", justifyContent: "center", color: "#2D6B4F" }}>
        <div style={{ width: 18, height: 18 }}><Icon source={CheckCircleIcon} tone="success" /></div>
      </div>
    );
  }
  if (value === false) {
    return (
      <div style={{ display: "flex", justifyContent: "center", color: "var(--p-color-text-disabled)" }}>
        <div style={{ width: 18, height: 18, opacity: 0.5 }}><Icon source={MinusIcon} /></div>
      </div>
    );
  }
  return <Text as="span" variant="bodyMd" alignment="center">{value}</Text>;
}

function ComparisonTable({ currentPlanId, submitting, pendingPlan, onSubmit }) {
  return (
    <>
      <div className="hj-cmp-scroll">
        <table className="hj-cmp">
          <thead>
            <tr>
              <th className="hj-cmp-rowlabel"></th>
              {PLAN_ORDER.map((id) => {
                const plan = PLANS[id];
                const isCurrent = id === currentPlanId;
                const isPopular = id === "growth";
                return (
                  <th key={id} className={`hj-cmp-colhead ${isCurrent ? "hj-cmp-popular" : ""}`}>
                    <div className="hj-cmp-ribbons">
                      {isPopular ? <span className="hj-cmp-ribbon hj-cmp-ribbon-popular">Most popular</span> : null}
                      {isCurrent ? <span className="hj-cmp-ribbon hj-cmp-ribbon-current">Current plan</span> : null}
                    </div>
                    <div className="hj-cmp-header">
                      <div className="hj-cmp-plan-name">{plan.name}</div>
                      <div className="hj-cmp-plan-price">
                        <span className="hj-cmp-plan-price-amount">
                          {plan.price === 0 ? "Free" : `$${plan.price}`}
                        </span>
                        {plan.price > 0 ? <span className="hj-cmp-plan-price-unit"> / mo</span> : null}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {SORTED_FEATURE_ROWS.map((row) => (
              <tr key={row.label}>
                <td className="hj-cmp-rowlabel">{row.label}</td>
                {PLAN_ORDER.map((id) => (
                  <td key={id} className={id === currentPlanId ? "hj-cmp-popular" : ""}>
                    <Cell value={row.get(PLANS[id])} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="hj-cmp-rowlabel"></td>
              {PLAN_ORDER.map((id) => {
                const plan = PLANS[id];
                const isCurrent = id === currentPlanId;
                const isDowngrade = PLAN_ORDER.indexOf(id) < PLAN_ORDER.indexOf(currentPlanId);
                return (
                  <td key={id} className={id === currentPlanId ? "hj-cmp-popular" : ""}>
                    <Form method="post" onSubmit={() => onSubmit(id)}>
                      <input type="hidden" name="intent" value="select" />
                      <input type="hidden" name="planId" value={id} />
                      <Button
                        submit fullWidth
                        variant={isCurrent ? "secondary" : id === "growth" ? "primary" : "secondary"}
                        disabled={isCurrent || submitting}
                        loading={submitting && pendingPlan === id}
                      >
                        {isCurrent ? "Current plan" : isDowngrade ? "Downgrade" : plan.price === 0 ? "Switch to Free" : `Upgrade`}
                      </Button>
                    </Form>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <style>{`
        .hj-cmp-scroll { overflow-x: auto; margin: 0 -4px; padding: 0 4px 4px; }
        .hj-cmp { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 720px; }
        .hj-cmp th, .hj-cmp td {
          padding: 14px 12px;
          border-bottom: 1px solid var(--p-color-border-subdued);
          vertical-align: middle;
          text-align: center;
        }
        .hj-cmp thead th {
          position: sticky; top: 0; background: var(--p-color-bg-surface);
          padding-top: 52px; padding-bottom: 20px;
          border-bottom: 1px solid var(--p-color-border);
        }
        .hj-cmp-header {
          display: flex; flex-direction: column; align-items: center;
          gap: 6px;
        }
        .hj-cmp-plan-name {
          font-size: 22px; font-weight: 600; line-height: 1.2;
          letter-spacing: -0.01em;
          color: var(--p-color-text);
        }
        .hj-cmp-plan-price {
          display: inline-flex; align-items: baseline; gap: 2px;
          color: var(--p-color-text);
        }
        .hj-cmp-plan-price-amount {
          font-size: 18px; font-weight: 500;
        }
        .hj-cmp-plan-price-unit {
          font-size: 12px; color: var(--p-color-text-secondary);
        }
        .hj-cmp-rowlabel {
          text-align: left !important;
          font-size: 13px;
          color: var(--p-color-text);
          font-weight: 500;
          white-space: nowrap;
          width: 1%;
        }
        .hj-cmp tbody tr:hover { background: var(--p-color-bg-surface-hover); }
        .hj-cmp-popular {
          background: rgba(45, 107, 79, 0.04);
        }
        .hj-cmp thead .hj-cmp-popular {
          background: rgba(45, 107, 79, 0.08);
          border-top: 2px solid #2D6B4F;
          border-left: 2px solid #2D6B4F;
          border-right: 2px solid #2D6B4F;
          border-top-left-radius: 10px;
          border-top-right-radius: 10px;
        }
        .hj-cmp tfoot .hj-cmp-popular {
          border-left: 2px solid #2D6B4F;
          border-right: 2px solid #2D6B4F;
          border-bottom: 2px solid #2D6B4F;
          border-bottom-left-radius: 10px;
          border-bottom-right-radius: 10px;
        }
        .hj-cmp tbody .hj-cmp-popular:not(:last-child) {
          border-left: 2px solid #2D6B4F;
          border-right: 2px solid #2D6B4F;
        }
        .hj-cmp tbody tr td.hj-cmp-popular {
          border-left: 2px solid #2D6B4F;
          border-right: 2px solid #2D6B4F;
        }
        .hj-cmp-ribbons {
          position: absolute; top: 14px; left: 0; right: 0;
          display: flex; justify-content: center; gap: 6px;
          pointer-events: none;
        }
        .hj-cmp-colhead { position: relative; }
        .hj-cmp-ribbon {
          display: inline-block; font-size: 10px; font-weight: 700;
          padding: 3px 12px; border-radius: 999px;
          letter-spacing: 0.06em; text-transform: uppercase;
          white-space: nowrap;
          box-shadow: 0 1px 2px rgba(0,0,0,0.06);
        }
        .hj-cmp-ribbon-popular { background: #2D6B4F; color: #fff; }
        .hj-cmp-ribbon-current { background: #e3f5eb; color: #0f5132; }
      `}</style>
    </>
  );
}

function SupportBox({ shop }) {
  const [copied, setCopied] = useState(false);

  // mailto with a sensible default subject and the shop domain pre-filled in
  // the body — when the merchant clicks "Send email" their default mail
  // client (Outlook, Apple Mail, Gmail, etc.) opens with everything ready.
  const mailtoHref =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent("[SEoS Assistant] Support request")}` +
    `&body=${encodeURIComponent(`Shop: ${shop}\n\n`)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — silently ignore; the address is still on screen */
    }
  };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack gap="400" blockAlign="start" wrap={false}>
          <div
            style={{
              flexShrink: 0,
              width: 48,
              height: 48,
              borderRadius: 12,
              background: "rgba(45,107,79,0.10)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#2D6B4F",
            }}
          >
            <div style={{ width: 24, height: 24 }}>
              <Icon source={EmailIcon} />
            </div>
          </div>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                Need a hand?
              </Text>
              <Badge tone="info">Replies within 1 business day</Badge>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodyMd">
              Email us with any questions, bugs, or feature requests. A real person reads every message.
            </Text>
          </BlockStack>
        </InlineStack>

        <Box
          padding="400"
          background="bg-surface-secondary"
          borderRadius="200"
          borderWidth="025"
          borderColor="border"
        >
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
            <BlockStack gap="050">
              <Text as="span" tone="subdued" variant="bodySm">
                Support email
              </Text>
              <Text as="p" variant="headingMd" fontWeight="semibold">
                {SUPPORT_EMAIL}
              </Text>
            </BlockStack>
            <InlineStack gap="200" wrap={false}>
              <Button icon={ClipboardIcon} onClick={handleCopy} accessibilityLabel="Copy support email">
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                variant="primary"
                icon={EmailIcon}
                url={mailtoHref}
                external
              >
                Send email
              </Button>
            </InlineStack>
          </InlineStack>
        </Box>

        <Text as="p" tone="subdued" variant="bodySm">
          Send email opens your default mail app with the shop domain pre-filled.
        </Text>

        <Box paddingBlockStart="200" borderBlockStartWidth="025" borderColor="border-subdued">
          <Text as="p" tone="subdued" variant="bodySm">
            Read our{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: "2px" }}
            >
              privacy policy
            </a>{" "}
            for details on what data SEoS Assistant collects and how it&apos;s handled.
          </Text>
        </Box>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "24px", alignItems: "center" }}>
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="h2" variant="headingLg">Your plan</Text>
                  <Badge tone={currentPlanId === "free" ? "attention" : "success"}>
                    {current.price === 0 ? "Free" : `$${current.price}/mo`}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {current.name} · {limit === Infinity ? "unlimited" : formatLimit(limit)} conversations / month
                </Text>
              </BlockStack>
              <div style={{ textAlign: "right" }}>
                <Text as="p" variant="headingMd">
                  {limit === Infinity
                    ? `${used.toLocaleString()} this month`
                    : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">conversations used</Text>
              </div>
            </div>
            {limit !== Infinity ? (
              <Box paddingBlockStart="400">
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
              </Box>
            ) : null}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">Compare plans</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Change plans any time. Charges are handled by Shopify and appear on your Shopify invoice.
                </Text>
              </BlockStack>
              <ComparisonTable
                currentPlanId={currentPlanId}
                submitting={submitting}
                pendingPlan={pendingPlan}
                onSubmit={setPendingPlan}
              />
            </BlockStack>
          </Card>
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
