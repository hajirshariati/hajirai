import { useState } from "react";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const meta = () => [
  { title: "Get started — SEoS Assistant" },
  { name: "robots", content: "index, follow" },
  {
    name: "description",
    content:
      "Set up SEoS Assistant on your Shopify store in under 10 minutes. Plan-by-plan onboarding for Free, Growth, and Enterprise.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  "Cache-Control": "public, max-age=300, s-maxage=300",
});

const PLANS = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    period: "forever",
    blurb: "Perfect for evaluating SEoS Assistant or a small store with light chat traffic.",
    features: [
      "50 conversations / month",
      "1 knowledge file",
      "7-day analytics",
      "Standard AI model",
      "Email support",
    ],
    eta: "5 minutes",
    steps: [
      {
        title: "Install from the Shopify App Store",
        body:
          "Visit the SEoS Assistant listing and click Install. Approve the permissions screen — we ask for read-only access to your products, customers, and orders so the assistant can answer questions and personalize replies.",
      },
      {
        title: "Add your Anthropic API key",
        body:
          "Sign up at console.anthropic.com if you don't have an account, generate an API key, and paste it into Settings → AI engine → API key. Pay-as-you-go means you're billed by Anthropic per message at their public rate (we add no markup).",
        tip: "A typical conversation costs 1–3¢ depending on length and AI model.",
      },
      {
        title: "Wait for your products to sync",
        body:
          "We sync your full catalog automatically the first time you open the app. The home page shows '[X] products synced' once it's done — usually 1–3 minutes for stores under 1,000 products.",
      },
      {
        title: "Add the chat block to your theme",
        body:
          "From the home page, click 'Open theme editor'. Add the SEoS Assistant block to the body of your active theme. Save. The chat launcher now appears on every storefront page.",
      },
      {
        title: "Test it",
        body:
          "Open your storefront in a new tab. Click the chat launcher and ask 'show me your bestsellers'. The assistant should reply with real product cards from your catalog.",
        tip: "Stuck? Email support and we'll help you over the line.",
      },
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: "$99",
    period: "per month",
    blurb: "For growing stores that want smart cost routing, more knowledge, and search rules tailored to their catalog.",
    features: [
      "3,000 conversations / month",
      "Unlimited knowledge files",
      "90-day analytics",
      "Smart model routing",
      "Prompt caching",
      "Klaviyo + Aftership integrations",
      "Search rules, synonyms, similar-match attributes",
      "Remove SEoS Assistant branding",
      "Email support",
    ],
    eta: "15 minutes",
    steps: [
      {
        title: "Install from the Shopify App Store",
        body:
          "Visit the SEoS Assistant listing and click Install. Approve the permissions screen.",
      },
      {
        title: "Add your Anthropic API key",
        body:
          "In Settings → AI engine, paste your Anthropic API key. Switch the routing strategy to Smart — it automatically routes simple follow-ups (\"thanks\", \"ok\") to the cheaper Fast model, full product questions go to your primary model.",
      },
      {
        title: "Turn on Prompt Caching",
        body:
          "Settings → Chat features → Prompt caching. Caches the system prompt across requests so repeat messages reuse it instead of re-sending — recommended for stores doing 1,000+ monthly conversations.",
      },
      {
        title: "Wait for catalog sync",
        body:
          "Your full Shopify catalog syncs automatically. Watch the home page for '[X] products synced'.",
      },
      {
        title: "Upload knowledge files",
        body:
          "Rules & Knowledge → Knowledge files. Upload your FAQs, brand voice guide, sizing/fit info, and any product-spec CSV files. The assistant uses these as context when answering questions, so the more relevant content you give it, the better the answers.",
        tip: "CSV files with a SKU column are auto-linked to your catalog — useful for product-specific specs.",
      },
      {
        title: "Configure search rules and synonyms",
        body:
          "Rules & Knowledge → How the AI searches. Add synonyms (e.g. 'shoe' → 'sneaker, sandal, loafer') so customer questions match more products. Add category exclusions if you want certain categories filtered out for specific queries.",
      },
      {
        title: "Connect Klaviyo and Aftership (optional)",
        body:
          "Settings → Integrations. Add a Klaviyo private API key for newsletter signup forms in chat. Add an Aftership API key for branded order tracking links.",
      },
      {
        title: "Add the chat block to your theme and test",
        body:
          "From the home page, click 'Open theme editor', add the SEoS Assistant block, save. Open the storefront and test a few real customer questions to validate the answers match your knowledge files.",
      },
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$199",
    period: "per month",
    blurb: "Unlimited conversations, every integration, and personalized VIP experiences for logged-in shoppers.",
    features: [
      "Unlimited conversations",
      "Unlimited knowledge files",
      "180-day analytics",
      "Advanced AI model for complex catalogs",
      "Smart routing + prompt caching",
      "Fit predictor with size confidence",
      "VIP mode for logged-in customers",
      "Klaviyo, Yotpo loyalty + reviews, Aftership integrations",
      "Remove SEoS Assistant branding",
      "Email support",
    ],
    eta: "30 minutes",
    steps: [
      {
        title: "Install from the Shopify App Store",
        body:
          "Visit the SEoS Assistant listing and click Install. Approve the permissions screen.",
      },
      {
        title: "Add your Anthropic API key",
        body:
          "Settings → AI engine. Paste your Anthropic API key. For Enterprise we recommend the Advanced AI model for complex catalogs and Smart routing for cost-efficient follow-ups.",
      },
      {
        title: "Wait for catalog sync",
        body:
          "Your full Shopify catalog syncs automatically. Watch the home page for '[X] products synced'.",
      },
      {
        title: "Configure attribute mappings",
        body:
          "Rules & Knowledge → Catalog & attributes. If your products use Shopify metafields (e.g. custom.gender, custom.fit_type) or tag prefixes (e.g. 'color:black'), map each one to a clean attribute name. The assistant uses these to filter and recommend.",
        tip: "If unsure, start with two or three obvious ones (gender, color, size). You can add more later.",
      },
      {
        title: "Upload your knowledge base",
        body:
          "Rules & Knowledge → Knowledge files. Upload FAQs, brand voice, sizing/fit guides, return policy, and product-spec CSVs. Enterprise has unlimited file slots.",
      },
      {
        title: "Connect your data integrations",
        body:
          "Settings → Integrations. Add Klaviyo (segments + signup), Yotpo (reviews + loyalty), and Aftership (branded tracking) keys. Each is optional and independent — connect only the ones you use.",
      },
      {
        title: "Enable VIP mode",
        body:
          "Settings → VIP customer experience → Enable VIP mode. Now logged-in shoppers get personalized greetings, size recommendations anchored on their order history, and loyalty references in chat. None of their data is stored — every lookup is per-conversation, in-memory only.",
      },
      {
        title: "Set up the fit predictor (optional)",
        body:
          "Rules & Knowledge → Fit predictor. Enable it if you sell sized goods (footwear, apparel). The predictor combines review fit data, return reasons, customer order history, and any external sizing API into a single confidence score per product.",
      },
      {
        title: "Customize the widget appearance",
        body:
          "Open Theme Editor → SEoS Assistant block. Set your brand colors, assistant name, avatar, banner image, welcome message, and CTA buttons. With Enterprise you can also remove the SEoS Assistant tagline from the widget.",
      },
      {
        title: "Test with a logged-in shopper",
        body:
          "Log into your storefront as a real customer (or a test account with a few past orders). Click the chat launcher — the welcome message should personalize, and asking about sizing should reference their past purchases.",
      },
      {
        title: "Monitor in Analytics",
        body:
          "Watch the Analytics page for the first week. Conversation volume, satisfaction rate, and AI cost are tracked automatically. Negative feedback surfaces specific responses to review and tune.",
        tip: "Set the Daily message cap in Settings if you want a hard cost ceiling per day.",
      },
    ],
  },
];

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #fafafa;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .hero {
    background: linear-gradient(135deg, #2d6b4f 0%, #3a8a66 100%);
    color: #fff;
    padding: 72px 24px 56px;
    text-align: center;
  }
  .hero h1 {
    margin: 0 0 12px;
    font-size: clamp(28px, 5vw, 44px);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .hero p {
    margin: 0 auto;
    max-width: 640px;
    font-size: clamp(16px, 2vw, 18px);
    opacity: 0.9;
  }
  .hero .pill {
    display: inline-block;
    background: rgba(255, 255, 255, 0.15);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 16px;
  }

  .container {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .section {
    padding: 64px 0;
  }
  .section h2 {
    margin: 0 0 8px;
    font-size: clamp(22px, 3vw, 28px);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .section .lede {
    margin: 0 0 32px;
    color: #6b7280;
    font-size: 16px;
  }

  .plans {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  @media (max-width: 800px) {
    .plans { grid-template-columns: 1fr; }
  }
  .plan-card {
    background: #fff;
    border: 2px solid #e5e7eb;
    border-radius: 14px;
    padding: 24px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
    text-align: left;
    font-family: inherit;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .plan-card:hover {
    border-color: #2d6b4f;
    box-shadow: 0 4px 16px rgba(45, 107, 79, 0.08);
  }
  .plan-card:focus-visible {
    outline: 3px solid rgba(45, 107, 79, 0.4);
    outline-offset: 2px;
  }
  .plan-card.active {
    border-color: #2d6b4f;
    background: linear-gradient(135deg, rgba(45, 107, 79, 0.04), rgba(58, 138, 102, 0.06));
    box-shadow: 0 4px 24px rgba(45, 107, 79, 0.12);
  }
  .plan-card .plan-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .plan-card .plan-name {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .plan-card .plan-price {
    font-size: 20px;
    font-weight: 600;
    color: #2d6b4f;
  }
  .plan-card .plan-period {
    color: #6b7280;
    font-size: 13px;
    font-weight: 400;
  }
  .plan-card .plan-blurb {
    color: #374151;
    font-size: 14px;
    margin: 0;
  }
  .plan-card .plan-features {
    margin: 8px 0 0;
    padding-left: 18px;
    list-style: none;
    font-size: 13.5px;
    color: #4b5563;
  }
  .plan-card .plan-features li {
    position: relative;
    padding: 3px 0 3px 4px;
  }
  .plan-card .plan-features li::before {
    content: "✓";
    position: absolute;
    left: -16px;
    color: #2d6b4f;
    font-weight: 700;
  }
  .plan-card .badge {
    display: inline-block;
    background: #2d6b4f;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 999px;
    margin-left: 6px;
    vertical-align: middle;
  }

  .eta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #e8f5ee;
    color: #2d6b4f;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 24px;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .step {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 20px 24px;
    display: grid;
    grid-template-columns: 36px 1fr;
    gap: 16px;
    align-items: start;
  }
  .step-num {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #2d6b4f;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
    flex-shrink: 0;
  }
  .step-title {
    margin: 0 0 4px;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .step-body {
    margin: 0;
    color: #374151;
    font-size: 15px;
  }
  .tip {
    margin-top: 10px;
    padding: 10px 12px;
    background: #fff8e1;
    border-left: 3px solid #f59e0b;
    border-radius: 6px;
    font-size: 13.5px;
    color: #6b4f12;
  }
  .tip strong { color: #92400e; }

  .faq {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 24px;
  }
  .faq h3 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
  }
  .faq p {
    margin: 0 0 18px;
    color: #4b5563;
    font-size: 14.5px;
  }
  .faq p:last-child { margin-bottom: 0; }

  footer.foot {
    background: #fff;
    border-top: 1px solid #e5e7eb;
    padding: 32px 24px;
    text-align: center;
    color: #6b7280;
    font-size: 14px;
  }
  footer.foot .links {
    display: inline-flex;
    gap: 24px;
    flex-wrap: wrap;
    justify-content: center;
    margin-bottom: 8px;
  }
  footer.foot a {
    color: #2d6b4f;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  footer.foot a:hover { color: #1f4d39; }
`;

export default function Onboarding() {
  const [selectedId, setSelectedId] = useState("growth");
  const selected = PLANS.find((p) => p.id === selectedId) || PLANS[0];

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <header className="hero">
        <div className="pill">SEoS Assistant onboarding</div>
        <h1>Let&apos;s get your AI shopping assistant live</h1>
        <p>
          Pick the plan that fits your store and follow the steps. Most setups take 5–30 minutes,
          end-to-end.
        </p>
      </header>

      <main>
        <section className="container section" aria-labelledby="pick-plan-heading">
          <h2 id="pick-plan-heading">1. Pick your plan</h2>
          <p className="lede">
            Each tier unlocks more capability. You can switch any time after install — start with
            whatever matches today.
          </p>
          <div className="plans" role="tablist" aria-label="Plan selector">
            {PLANS.map((plan) => {
              const isActive = plan.id === selectedId;
              return (
                <button
                  key={plan.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`plan-card${isActive ? " active" : ""}`}
                  onClick={() => setSelectedId(plan.id)}
                >
                  <div className="plan-head">
                    <span className="plan-name">
                      {plan.name}
                      {plan.id === "growth" ? <span className="badge">Most popular</span> : null}
                    </span>
                    <span className="plan-price">
                      {plan.price}
                      <span className="plan-period"> / {plan.period}</span>
                    </span>
                  </div>
                  <p className="plan-blurb">{plan.blurb}</p>
                  <ul className="plan-features">
                    {plan.features.slice(0, 5).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {plan.features.length > 5 ? (
                      <li style={{ color: "#6b7280", fontStyle: "italic" }}>
                        + {plan.features.length - 5} more
                      </li>
                    ) : null}
                  </ul>
                </button>
              );
            })}
          </div>
        </section>

        <section className="container section" aria-labelledby="setup-heading">
          <h2 id="setup-heading">2. Set up your {selected.name} plan</h2>
          <p className="lede">
            Follow each step in order. Don&apos;t skip — every step builds on the previous one.
          </p>
          <div className="eta">⏱ Estimated time: {selected.eta}</div>

          <div className="steps">
            {selected.steps.map((step, i) => (
              <article className="step" key={`${selected.id}-${i}`}>
                <div className="step-num" aria-hidden="true">{i + 1}</div>
                <div>
                  <h3 className="step-title">{step.title}</h3>
                  <p className="step-body">{step.body}</p>
                  {step.tip ? (
                    <div className="tip">
                      <strong>Tip:</strong> {step.tip}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="container section" aria-labelledby="faq-heading">
          <h2 id="faq-heading">Common questions</h2>
          <div className="faq">
            <h3>How long does setup take?</h3>
            <p>Most stores are live within 10–30 minutes. The Free plan is fastest (5 minutes); Enterprise takes longer because of the integrations.</p>
            <h3>Can I switch plans later?</h3>
            <p>Yes. Open Plan &amp; Support in the admin and pick a different tier — Shopify handles the billing change. Your data and configuration stay.</p>
            <h3>What if I get stuck?</h3>
            <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with what you&apos;re seeing and we&apos;ll respond within one business day.</p>
            <h3>Do I need to know how to code?</h3>
            <p>No. Everything is configured in the admin UI. The only technical bit is generating an Anthropic API key — and Anthropic walks you through it.</p>
            <h3>What does the AI cost?</h3>
            <p>You&apos;re billed by Anthropic per message at their public API rate (typically 1–3¢ per conversation). SEoS Assistant adds no markup. If you want a hard ceiling, set a Daily message cap in Settings.</p>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="links">
          <a href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
          <a href="/privacy">Privacy policy</a>
          <a href="https://apps.shopify.com/" target="_blank" rel="noopener noreferrer">Shopify App Store</a>
        </div>
        <div>© HajirAi · SEoS Assistant</div>
      </footer>
    </>
  );
}
