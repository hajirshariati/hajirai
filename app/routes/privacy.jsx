// Public privacy policy. Served from the app's own domain so the URL is
// stable and indexable — required for the Shopify App Store listing's
// privacy policy field. The route is intentionally outside `/app/*` so it
// doesn't go through admin authentication and can be visited by anyone.

const LAST_UPDATED = "April 26, 2026";
const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const meta = () => [
  { title: "Privacy Policy — SEoS Assistant" },
  { name: "robots", content: "index, follow" },
  {
    name: "description",
    content:
      "Privacy policy for SEoS Assistant, an AI shopping assistant for Shopify. Describes what data we collect, how we use it, and how merchants can exercise their data rights.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  // 1 hour CDN, 1 day browser — this page rarely changes and is purely public.
  "Cache-Control": "public, max-age=86400, s-maxage=3600",
});

const STYLES = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #fafafa;
    line-height: 1.6;
  }
  .privacy {
    max-width: 760px;
    margin: 0 auto;
    padding: 56px 24px 96px;
  }
  .privacy header {
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 24px;
    margin-bottom: 32px;
  }
  .privacy h1 {
    font-size: 32px;
    font-weight: 700;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  .privacy h2 {
    font-size: 20px;
    font-weight: 600;
    margin: 40px 0 12px;
    color: #111827;
  }
  .privacy .meta {
    color: #6b7280;
    font-size: 14px;
    margin: 0;
  }
  .privacy p, .privacy li {
    font-size: 16px;
    color: #374151;
  }
  .privacy ul {
    padding-left: 20px;
    margin: 12px 0;
  }
  .privacy li { margin: 6px 0; }
  .privacy strong { color: #111827; }
  .privacy a {
    color: #2D6B4F;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .privacy a:hover { color: #1f4d39; }
  .privacy code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    background: #f3f4f6;
    padding: 1px 6px;
    border-radius: 4px;
  }
  .privacy footer {
    margin-top: 64px;
    padding-top: 24px;
    border-top: 1px solid #e5e7eb;
    color: #6b7280;
    font-size: 14px;
  }
`;

export default function PrivacyPolicy() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <main className="privacy">
        <header>
          <h1>SEoS Assistant Privacy Policy</h1>
          <p className="meta">Last updated: {LAST_UPDATED}</p>
        </header>

        <p>
          SEoS Assistant (&quot;we&quot;, &quot;our&quot;, &quot;the app&quot;) is operated by HajirAi.
          This policy describes how SEoS Assistant collects, uses, and
          handles data when installed on a Shopify store.
        </p>
        <p>
          <strong>Contact:</strong>{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
          <br />
          <strong>Address:</strong> HajirAi · [your street address] · [city, region, postal code, country]
        </p>

        <h2>1. Data we collect</h2>
        <p>When a merchant installs SEoS Assistant, we index the following from their Shopify store:</p>
        <ul>
          <li>Product catalog data (titles, descriptions, prices, variants, images, tags, metafields, product types).</li>
          <li>Product attribute mappings configured by the merchant (metafield mappings and tag prefixes).</li>
          <li>Knowledge files uploaded by the merchant (FAQs, sizing guides, brand info, product specs, custom rules).</li>
          <li>Merchant-provided third-party API keys (Anthropic, Klaviyo, Yotpo, Aftership) — encrypted at rest.</li>
        </ul>
        <p>When a customer uses the chat widget:</p>
        <ul>
          <li>Chat messages are sent to our server to generate AI responses.</li>
          <li>We do not store customer names, emails, addresses, or any personally identifiable information (PII) in our database.</li>
          <li>Anonymous usage metrics (message count, AI model used, token usage, cost, tool calls) are recorded per store for billing and analytics.</li>
          <li>If the merchant enables feedback and the shopper rates a response thumbs-up or thumbs-down, the conversation up to that point is stored alongside the rating so the merchant can review what the AI got right or wrong. The stored conversation is keyed only by a hashed source-IP identifier — never by customer ID, email, or any other PII — and is automatically deleted after 90 days.</li>
          <li>If the merchant enables VIP Mode and the shopper is logged in, the assistant fetches the shopper&apos;s first name, order history, loyalty balance (Yotpo), and segment data (Klaviyo) per conversation to personalize replies. This data is used in-memory for the response and is not stored in our database.</li>
        </ul>

        <h2>2. How we use data</h2>
        <ul>
          <li>Product catalog data is stored in our database so the AI can search and recommend products in real time.</li>
          <li>Chat messages are forwarded to Anthropic&apos;s Claude API to generate responses. Messages are not retained by us after the response is delivered, except where a shopper submits feedback (see §1).</li>
          <li>Knowledge files, attribute mappings, search rules, and category exclusions are included in the AI system prompt to improve answer quality and constrain results to your catalog.</li>
          <li>Usage data powers the analytics dashboard, plan limits, and billing.</li>
          <li>Customer email (when the shopper is logged in and VIP Mode is enabled) is used only server-side to look up loyalty and segment data from Klaviyo and Yotpo. It is never stored, logged, or placed in the AI prompt.</li>
        </ul>

        <h2>3. Third-party services</h2>
        <ul>
          <li><strong>Anthropic (Claude API)</strong> — Chat messages are sent to Anthropic for AI processing. Anthropic&apos;s data policy applies: <a href="https://www.anthropic.com/privacy" rel="noreferrer">anthropic.com/privacy</a>. Messages sent via the API are not used to train Anthropic&apos;s models.</li>
          <li><strong>Railway</strong> — Our application is hosted on Railway in their AWS US region. Data is stored in a PostgreSQL database within Railway&apos;s infrastructure.</li>
          <li><strong>Shopify</strong> — We use Shopify&apos;s Admin API and App Bridge for authentication, store data access, customer order lookup, and billing.</li>
          <li><strong>Klaviyo (optional)</strong> — If the merchant adds a Klaviyo private API key, the assistant queries Klaviyo for shopper segments to personalize replies. <a href="https://www.klaviyo.com/privacy" rel="noreferrer">klaviyo.com/privacy</a></li>
          <li><strong>Yotpo (optional)</strong> — If the merchant adds a Yotpo loyalty API key, the assistant queries Yotpo for points balance, tier, and rewards to personalize replies. <a href="https://www.yotpo.com/privacy-policy" rel="noreferrer">yotpo.com/privacy-policy</a></li>
          <li><strong>Aftership (optional)</strong> — If the merchant adds an Aftership API key, tracking links shown to shoppers route to their branded Aftership tracking page.</li>
        </ul>
        <p>
          Where personal data is transferred from the European Economic Area to the United States, we rely on Standard Contractual Clauses (SCCs) approved by the European Commission as the legal basis for the transfer.
        </p>

        <h2>4. Data retention</h2>
        <ul>
          <li>Chat usage records are retained for the analytics period defined by the merchant&apos;s plan (7, 90, or 180 days).</li>
          <li>Product catalog data is retained while the app is installed and updated in real time via Shopify webhooks.</li>
          <li>Knowledge files are retained until deleted by the merchant.</li>
          <li>Feedback data (including any conversation captured under §1) is automatically deleted after 90 days.</li>
          <li>Conversation history shown in the widget is stored in the shopper&apos;s browser (<code>localStorage</code>) and is not transmitted to our servers except as part of the per-message context window.</li>
        </ul>

        <h2>5. Data deletion</h2>
        <ul>
          <li>When a merchant uninstalls SEoS Assistant, all associated data is permanently deleted from our database, including product data, knowledge files, attribute mappings, search rules, chat usage records, feedback, encrypted API keys, configuration, and analytics.</li>
          <li>We respond to Shopify&apos;s mandatory GDPR webhooks (customer data requests, customer redaction, shop redaction) within 30 days.</li>
          <li>Merchants can delete individual knowledge files at any time from the admin dashboard.</li>
          <li>Merchants can clear the encrypted Anthropic, Klaviyo, Yotpo, and Aftership API keys at any time from the Settings page.</li>
        </ul>

        <h2>6. Data security</h2>
        <ul>
          <li>API keys (Anthropic, Klaviyo, Yotpo, Aftership) are encrypted at rest using AES-256-GCM with a per-app key stored in our hosting environment.</li>
          <li>All communication between the widget, our server, Shopify, and third-party APIs uses HTTPS/TLS.</li>
          <li>No customer PII is stored in our database.</li>
          <li>Per-store and per-IP rate limiting protects merchants from abuse.</li>
          <li>Webhook payloads from Shopify are HMAC-verified before processing.</li>
        </ul>

        <h2>7. Cookies</h2>
        <p>
          SEoS Assistant does not set any cookies. The chat widget stores conversation history in the shopper&apos;s browser <code>localStorage</code>, which is cleared when the shopper clears their browser data or starts a new chat from the menu.
        </p>

        <h2>8. Changes to this policy</h2>
        <p>
          We may update this policy from time to time. Changes will be reflected by updating the &quot;Last updated&quot; date above.
        </p>

        <h2>9. Contact</h2>
        <p>
          For questions about this privacy policy or data handling: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>

        <footer>
          © HajirAi · SEoS Assistant
        </footer>
      </main>
    </>
  );
}
