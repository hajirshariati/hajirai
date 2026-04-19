import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getActiveSubscription, setShopPlan } from "../lib/billing.server";
import { PLANS } from "../lib/plans";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const planId = url.searchParams.get("plan") || "free";
  const chargeId = url.searchParams.get("charge_id");

  if (!PLANS[planId]) {
    return redirect("/app/plans?error=invalid_plan");
  }

  const active = await getActiveSubscription({ admin });

  if (planId !== "free" && (!active || active.status !== "ACTIVE")) {
    return redirect("/app/plans?error=not_active");
  }

  await setShopPlan({
    shop: session.shop,
    planId,
    subscriptionId: active?.id || null,
  });

  return redirect(`/app/plans?activated=${planId}${chargeId ? `&charge_id=${chargeId}` : ""}`);
};

export default function BillingCallback() {
  return null;
}
