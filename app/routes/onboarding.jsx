import { useState } from "react";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const meta = () => [
  { title: "Aetrex setup guide — SEoS Assistant" },
  { name: "robots", content: "noindex, nofollow" },
  {
    name: "description",
    content:
      "Internal setup guide for the AI shopping assistant powering aetrex.com. Enterprise plan, end-to-end data configuration.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  "Cache-Control": "private, no-cache",
});

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
  .hero h1 {
    margin: 0 0 12px;
    font-size: clamp(28px, 5vw, 44px);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .hero p {
    margin: 0 auto;
    max-width: 720px;
    font-size: clamp(16px, 2vw, 18px);
    opacity: 0.92;
  }
  .container { max-width: 980px; margin: 0 auto; padding: 0 24px; }
  .section { padding: 56px 0; }
  .section h2 {
    margin: 0 0 8px;
    font-size: clamp(22px, 3vw, 28px);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .section .lede {
    margin: 0 0 24px;
    color: #6b7280;
    font-size: 16px;
  }

  .overview {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 8px;
  }
  @media (max-width: 800px) { .overview { grid-template-columns: 1fr; } }
  .overview-card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 20px;
  }
  .overview-card h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .overview-card p {
    margin: 0;
    color: #4b5563;
    font-size: 14px;
  }

  .steps { display: flex; flex-direction: column; gap: 16px; }
  .step {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 22px 24px;
    display: grid;
    grid-template-columns: 36px 1fr;
    gap: 16px;
    align-items: start;
  }
  .step-num {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: #2d6b4f;
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px;
    flex-shrink: 0;
  }
  .step h3 {
    margin: 0 0 6px;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .step p { margin: 0 0 8px; color: #374151; font-size: 15px; }
  .step ul { margin: 8px 0 0; padding-left: 20px; color: #374151; font-size: 14.5px; }
  .step li { margin: 3px 0; }
  .step code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    background: #f3f4f6;
    padding: 1px 6px;
    border-radius: 4px;
    color: #1f4d39;
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

  .ref-table {
    width: 100%;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
  }
  .ref-table th, .ref-table td {
    text-align: left;
    padding: 12px 16px;
    font-size: 14px;
    border-bottom: 1px solid #e5e7eb;
  }
  .ref-table th {
    background: #f9fafb;
    font-weight: 600;
    color: #374151;
  }
  .ref-table tr:last-child td { border-bottom: none; }
  .ref-table code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
    color: #1f4d39;
    white-space: nowrap;
  }
  @media (max-width: 700px) {
    .ref-table { display: block; overflow-x: auto; }
  }

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


const STEPS = [
  {
    title: "Confirm install + open the app",
    body:
      "Open the SEoS Assistant app from the Aetrex Shopify admin (Apps → SEoS Assistant). The home page is the setup checklist — every following step lives in the admin, no external tools.",
  },
  {
    title: "Connect the AI engine",
    body:
      "Settings → AI engine → API key. Paste the Aetrex Anthropic API key (kept in 1Password under 'Anthropic — Aetrex prod'). Choose Smart routing as the strategy.",
    tip:
      "Smart routing sends 'thanks'/'ok' follow-ups to Claude Haiku and full product questions to Claude Sonnet, cutting cost on chatty conversations without affecting answer quality.",
  },
  {
    title: "Wait for the catalog to sync",
    body:
      "First load triggers a full Shopify catalog sync. Aetrex's catalog (~700 products) usually takes 2–5 minutes. The home page shows '[X] products synced' once it's done; do not move on until that number stabilizes.",
  },
  {
    title: "Configure attribute mappings",
    body:
      "Rules & Knowledge → Catalog & attributes. Aetrex products use Shopify metafields under the `custom` namespace. Map each one to a clean attribute name the assistant uses for filtering. Reference table below — copy these exactly:",
  },
  {
    title: "Upload Aetrex knowledge files",
    body:
      "Rules & Knowledge → Knowledge files. Upload these files (kept in the shared Drive folder /Aetrex/SEoS-knowledge/):",
    list: [
      "aetrex-faqs.md — FAQ list (sizing, returns, shipping, technology questions)",
      "brand-voice.md — tone guidelines (warm, expert, never pushy)",
      "sizing-guide.md — Aetrex sizing chart and how to read it for men's/women's",
      "fit-glossary.md — definitions of Lynco, HealthySteps, arch types, fit types",
      "product-attributes.csv — SKU-keyed material/care/fit-notes per product",
    ],
    tip:
      "The CSV file with a SKU column auto-links to the catalog — useful for product-specific specs the AI can cite.",
  },
  {
    title: "Connect Yotpo (reviews + loyalty)",
    body:
      "Settings → Integrations → Yotpo Reviews and Yotpo Loyalty & Referrals. Both keys live in 1Password under 'Yotpo — Aetrex'. Reviews powers fit summaries and 'what do reviewers say' answers; Loyalty powers VIP perks for logged-in shoppers.",
    list: [
      "Yotpo Reviews API key → enables review-based fit summaries",
      "Yotpo Loyalty API key + GUID → enables points balance, tier, and personal referral link in chat",
    ],
  },
  {
    title: "Connect Aftership",
    body:
      "Settings → Integrations → Aftership. Paste the Aftership API key from 1Password. This unlocks two things: return-reason data feeds the fit predictor (so 'too small' returns inform sizing recommendations), and tracking links shown to logged-in shoppers route to the Aetrex-branded Aftership tracking page instead of the generic carrier site.",
  },
  {
    title: "Connect Klaviyo",
    body:
      "Settings → Integrations → Klaviyo. Paste the Aetrex Klaviyo Company ID, List ID, and private API key. The private key unlocks segment enrichment in VIP mode — the assistant adapts tone based on whether a logged-in shopper is in the VIP, Winback, or Churn Risk segments (segment names are never shown to the customer).",
  },
  {
    title: "Enable VIP mode",
    body:
      "Settings → VIP customer experience → toggle VIP mode on. Logged-in shoppers now get personalized greetings, size recommendations anchored on their order history, and loyalty references in chat. None of their data is stored — every lookup is per-conversation, in-memory only.",
    tip:
      "Test VIP mode with a real Aetrex customer account that has at least 2 past orders. Without past orders the size predictor falls back to review and return data.",
  },
  {
    title: "Configure the fit predictor",
    body:
      "Rules & Knowledge → Fit predictor → Enabled. The predictor combines Yotpo review fit data, Aftership return reasons, the customer's own order history, and the Aetrex external sizing API into a single confidence score per product. Paste the external sizing API endpoint and key from 1Password.",
  },
  {
    title: "Customize the widget appearance",
    body:
      "Open Theme Editor → SEoS Assistant block. Set the Aetrex brand colors (Primary #2D6B4F to match site, accent your existing CTA color), upload the Aetrex avatar (square logo), and set the welcome banner. Confirm the assistant name is 'The Fit Concierge' and the tagline matches the rest of the site.",
    tip:
      "The Enterprise plan removes the SEoS Assistant tagline from the widget footer. Confirm it's gone before going live.",
  },
  {
    title: "Add the chat block to the live theme",
    body:
      "In Theme Editor, add the SEoS Assistant block to the body of the live Aetrex theme. Save. The launcher now appears in the bottom corner of every storefront page. If you want to hide it on specific pages (cart, checkout-confirmation), use Settings → Widget visibility → Hide-on URLs.",
  },
  {
    title: "QA with a real shopper account",
    body:
      "Log into aetrex.com as a test customer with at least 2 past orders. Open the chat. Verify each:",
    list: [
      "Welcome message shows the customer's first name (VIP greeting)",
      "Asking 'what size should I get in [product]' returns a fit prediction card with a confidence percentage",
      "Asking about points or rewards mentions their actual Yotpo balance",
      "Asking about an order's tracking returns an Aftership link to the Aetrex-branded tracking page",
      "Asking 'I have foot pain, what should I wear?' walks the customer through gender → category → recommendation, only offering categories Aetrex actually sells for that gender",
    ],
  },
  {
    title: "Monitor in Analytics for the first week",
    body:
      "Analytics page tracks every conversation. Watch satisfaction rate (thumbs-up/down), AI cost, and rate-limit hits daily for the first week. Negative feedback surfaces specific responses to review and tune the knowledge files.",
    tip:
      "If AI cost spikes unexpectedly, set a Daily message cap in Settings → Daily message cap. The assistant pauses when the cap is hit and resumes the next day at midnight UTC.",
  },
];

const ATTRIBUTE_MAPPINGS = [
  { source: "metafield: custom.attr_gender", attribute: "gender", note: "Used to scope all category buttons + searches by men's / women's" },
  { source: "metafield: custom.attr_category", attribute: "category", note: "Sneakers, Sandals, Clogs, Loafers, Slippers, Oxfords, etc." },
  { source: "metafield: custom.attr_arch_type", attribute: "arch_type", note: "Low / Medium / High — feeds fit recommendations" },
  { source: "metafield: custom.attr_fit_type", attribute: "fit_type", note: "Standard / Wide / Narrow — feeds size predictor" },
  { source: "metafield: custom.attr_use_case", attribute: "use_case", note: "Walking / Running / Casual / Dress / Athletic" },
  { source: "tag prefix: color:", attribute: "color", note: "Tags like 'color:black' map to the color attribute" },
  { source: "tag prefix: occasion:", attribute: "occasion", note: "Optional — only on dress styles" },
];

export default function Onboarding() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <header className="hero">
        <div className="pill">Aetrex internal · Enterprise plan</div>
        <h1>SEoS Assistant — Aetrex setup guide</h1>
        <p>
          End-to-end configuration for the AI shopping assistant on aetrex.com. Plan an hour for the
          first install (most of it is waiting for catalog sync); subsequent re-installs are 15 minutes.
        </p>
      </header>

      <main>
        <section className="container section" aria-labelledby="overview-heading">
          <h2 id="overview-heading">What this app does for Aetrex</h2>
          <p className="lede">
            Three layers, all running off the live Shopify catalog and merchant-configured data.
          </p>
          <div className="overview">
            <div className="overview-card">
              <h3>Catalog-aware AI</h3>
              <p>
                Mirrors every product, variant, metafield, and tag from the Aetrex Shopify store so the
                assistant answers questions about real inventory.
              </p>
            </div>
            <div className="overview-card">
              <h3>Fit + sizing intelligence</h3>
              <p>
                Combines Yotpo review fit, Aftership return reasons, customer order history, and the
                Aetrex external sizing API into a single per-product fit prediction.
              </p>
            </div>
            <div className="overview-card">
              <h3>VIP personalization</h3>
              <p>
                Logged-in shoppers get personalized greetings, points/tier references from Yotpo
                Loyalty, and segment-aware tone from Klaviyo. No customer PII is stored.
              </p>
            </div>
          </div>
        </section>

        <section className="container section" aria-labelledby="setup-heading">
          <h2 id="setup-heading">Setup steps</h2>
          <p className="lede">
            Follow each step in order. Don&apos;t skip — every step builds on the previous one.
          </p>

          <div className="steps">
            {STEPS.map((s, i) => (
              <article className="step" key={i}>
                <div className="step-num" aria-hidden="true">{i + 1}</div>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  {s.list ? (
                    <ul>
                      {s.list.map((item, j) => (
                        <li key={j}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {i === 3 ? (
                    <div style={{ marginTop: 16, overflowX: "auto" }}>
                      <table className="ref-table">
                        <thead>
                          <tr>
                            <th>Source (Shopify)</th>
                            <th>Maps to attribute</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ATTRIBUTE_MAPPINGS.map((m) => (
                            <tr key={m.attribute}>
                              <td><code>{m.source}</code></td>
                              <td><code>{m.attribute}</code></td>
                              <td>{m.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {s.tip ? (
                    <div className="tip">
                      <strong>Tip:</strong> {s.tip}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="container section" aria-labelledby="trouble-heading">
          <h2 id="trouble-heading">Troubleshooting</h2>
          <div className="overview">
            <div className="overview-card">
              <h3>Catalog stuck syncing</h3>
              <p>
                Hard-refresh the home page. If the count hasn&apos;t moved in 10 minutes, check Railway
                logs for <code>[products/update]</code> errors and email support.
              </p>
            </div>
            <div className="overview-card">
              <h3>Fit predictor returns 0% confidence</h3>
              <p>
                Means the predictor has no data for that product yet. Confirm Yotpo Reviews and
                Aftership keys are set and the product has at least one review or return.
              </p>
            </div>
            <div className="overview-card">
              <h3>VIP mode not personalizing</h3>
              <p>
                The shopper must be logged into aetrex.com (not just have an account). Verify the
                Klaviyo private key has <code>profiles:read</code> + <code>segments:read</code> scopes.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="links">
          <a href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
          <a href="/privacy">Privacy policy</a>
          <a href="/app" target="_blank" rel="noopener noreferrer">Open admin</a>
        </div>
        <div>© HajirAi · SEoS Assistant for Aetrex</div>
      </footer>
    </>
  );
}
