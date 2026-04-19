import { useState } from "react";
import { redirect, data } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Badge,
  BlockStack,
  InlineStack,
  Banner,
  List,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopPlan,
  getConversationsThisMonth,
  createSubscription,
  setShopPlan,
  cancelSubscription,
  getActiveSubscription,
} from "../lib/billing.server";
import { PLANS, PLAN_ORDER, formatLimit } from "../lib/plans";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const plan = await getShopPlan(session.shop);
  const used = await getConversationsThisMonth(session.shop);
  return { currentPlanId: plan.id, used };
};

export const action = async ({ request }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const planId = String(form.get("planId") || "");
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";

  if (intent === "select" && PLANS[planId]) {
    if (planId === "free") {
      const active = await getActiveSubscription({ admin });
      if (active?.id) {
        await cancelSubscription({ admin, subscriptionId: active.id });
      }
      await setShopPlan({ shop: session.shop, planId: "free", subscriptionId: null });
      return data({ ok: true, message: "Switched to Free plan." });
    }

    const { confirmationUrl } = await createSubscription({
      admin,
      shop: session.shop,
      planId,
      host,
    });
    return redirect(confirmationUrl);
  }

  return data({ ok: false, message: "Unknown action" }, { status: 400 });
};

export default function PlansPage() {
  const { currentPlanId, used } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const [pendingPlan, setPendingPlan] = useState(null);

  const current = PLANS[currentPlanId] || PLANS.free;
  const limit = current.conversationsPerMonth;
  const usagePct = limit === Infinity ? 0 : Math.min(100, Math.round((used / limit) * 100));

  return (
    <Page>
      <TitleBar title="Plans" />
      <div
        style={{
          height: "6px",
          background: "linear-gradient(90deg, #2D6B4F 0%, #3a8a66 100%)",
          borderRadius: "4px",
          marginBottom: "16px",
        }}
      />

      <Layout>
        {actionData?.message ? (
          <Layout.Section>
            <Banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Current plan: {current.name}
                  </Text>
                  <Text as="p" tone="subdued">
                    {limit === Infinity
                      ? `${used.toLocaleString()} conversations this month (unlimited)`
                      : `${used.toLocaleString()} of ${limit.toLocaleString()} conversations used this month`}
                  </Text>
                </BlockStack>
                <Badge tone={currentPlanId === "free" ? "attention" : "success"}>
                  {current.price === 0 ? "Free" : `$${current.price}/mo`}
                </Badge>
              </InlineStack>
              {limit !== Infinity ? <ProgressBar progress={usagePct} tone="primary" /> : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap>
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              const isCurrent = id === currentPlanId;
              const isDowngrade =
                PLAN_ORDER.indexOf(id) < PLAN_ORDER.indexOf(currentPlanId);
              return (
                <div key={id} style={{ flex: "1 1 240px", minWidth: "240px" }}>
                  <Card>
                    <BlockStack gap="300">
                      <BlockStack gap="100">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingMd">
                            {plan.name}
                          </Text>
                          {isCurrent ? <Badge tone="success">Current</Badge> : null}
                        </InlineStack>
                        <Text as="p" variant="heading2xl">
                          {plan.price === 0 ? "Free" : `$${plan.price}`}
                          {plan.price > 0 ? (
                            <Text as="span" variant="bodyMd" tone="subdued">
                              {" "}/ month
                            </Text>
                          ) : null}
                        </Text>
                        <Text as="p" tone="subdued">
                          {formatLimit(plan.conversationsPerMonth)} conversations/mo
                        </Text>
                      </BlockStack>

                      <List type="bullet">
                        {plan.features.map((f) => (
                          <List.Item key={f}>{f}</List.Item>
                        ))}
                      </List>

                      <Form method="post" onSubmit={() => setPendingPlan(id)}>
                        <input type="hidden" name="intent" value="select" />
                        <input type="hidden" name="planId" value={id} />
                        <Button
                          submit
                          fullWidth
                          variant={isCurrent ? "secondary" : "primary"}
                          disabled={isCurrent || submitting}
                          loading={submitting && pendingPlan === id}
                        >
                          {isCurrent
                            ? "Current plan"
                            : isDowngrade
                              ? `Downgrade to ${plan.name}`
                              : plan.price === 0
                                ? "Switch to Free"
                                : `Upgrade to ${plan.name}`}
                        </Button>
                      </Form>
                    </BlockStack>
                  </Card>
                </div>
              );
            })}
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Billing FAQ
              </Text>
              <Text as="p" tone="subdued">
                Charges are handled by Shopify and appear on your Shopify invoice. You can cancel or change plans at any time. Unused conversations don't roll over.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
