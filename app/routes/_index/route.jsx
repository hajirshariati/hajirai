import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
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

  // Anyone arriving here with a ?shop= param is mid-install; Shopify expects
  // an immediate redirect into the embedded admin OAuth flow.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Landing() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SEoS Assistant</h1>
        <p className={styles.text}>
          AI shopping assistant for Shopify stores. Search Engine on Steroids.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Install on your store</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
                autoComplete="off"
              />
              <span>Enter your myshopify.com domain to continue.</span>
            </label>
            <button className={styles.button} type="submit">
              Install
            </button>
          </Form>
        )}

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
