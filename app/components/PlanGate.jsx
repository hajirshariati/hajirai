import { Banner, BlockStack, Button, Text } from "@shopify/polaris";
import { Link } from "react-router";
import { planAllows, requiredPlanFor } from "../lib/plans";

// Wraps an admin section that depends on a plan feature flag. When the
// merchant's plan does not include the feature, the children stay visible
// (so the merchant sees what's available) but every form control inside is
// disabled via <fieldset disabled> and an "Upgrade plan" banner appears
// above with a link to /app/plans. When the plan includes the feature, the
// children render unchanged.
export function PlanGate({ plan, feature, summary, children }) {
  const allowed = planAllows(plan, feature);
  if (allowed) return children;

  const required = requiredPlanFor(feature);
  const requiredLabel = required ? required.name : "a higher";

  return (
    <BlockStack gap="300">
      <Banner
        tone="info"
        title={`Available on the ${requiredLabel} plan`}
      >
        <BlockStack gap="200">
          {summary ? (
            <Text as="p" variant="bodySm">
              {summary}
            </Text>
          ) : null}
          <div>
            <Link to="/app/plans" style={{ textDecoration: "none" }}>
              <Button variant="primary" size="slim">
                View plans
              </Button>
            </Link>
          </div>
        </BlockStack>
      </Banner>
      {/* fieldset disabled cascades the disabled state to every form control
          inside, including Polaris components, so the section is read-only
          even when JS-only handlers exist. */}
      <fieldset
        disabled
        aria-disabled="true"
        style={{
          border: "none",
          padding: 0,
          margin: 0,
          opacity: 0.55,
          pointerEvents: "none",
        }}
      >
        {children}
      </fieldset>
    </BlockStack>
  );
}
