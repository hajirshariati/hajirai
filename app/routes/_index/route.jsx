import { redirect } from "react-router";
import styles from "./styles.module.css";

export const meta = () => [
  { title: "SEoS Assistant — AI shopping assistant for Shopify" },
  {
    name: "description",
    content:
      "SEoS Assistant adds an AI-powered shopping assistant to your Shopify storefront. Real-time product search, fit predictions from review and return data, and personalized recommendations for logged-in customers.",
  },
];

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // Anyone arriving here with a ?shop= param is mid-install via the App Store
  // or Shopify admin; redirect into the embedded admin OAuth flow.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

// Public marketing landing. Intentionally has no shop-domain input — Shopify
// requires installs to start from a Shopify-owned surface (App Store listing
// or the Shopify Admin), so we don't accept a manually-typed myshopify.com
// here.
export default function Landing() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SEoS Assistant</h1>
        <p className={styles.text}>
          AI shopping assistant for Shopify stores. Search Engine on Steroids.
        </p>

        <p className={styles.text}>
          Install from the{" "}
          <a
            href="https://apps.shopify.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Shopify App Store
          </a>{" "}
          or directly from your Shopify admin.
        </p>

        <ul className={styles.list}>
          <li>
            <strong>Knows your catalog.</strong> Mirrors every product, variant,
            metafield, and tag so the AI answers questions about your real
            inventory in real time.
          </li>
          <li>
            <strong>Personalized for logged-in shoppers.</strong> Pulls order
            history and loyalty data on demand to anchor size recommendations
            and surface VIP perks — never stored.
          </li>
          <li>
            <strong>Privacy-first.</strong> Encrypted secrets at rest, no
            customer PII in our database, and a daily cost cap so the merchant
            stays in control.
          </li>
        </ul>
      </div>
    </div>
  );
}
