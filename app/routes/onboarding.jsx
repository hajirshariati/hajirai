import { PHASES, STEPS, ATTRIBUTE_MAPPINGS } from "../lib/onboarding-data";

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
    background: rgba(255,255,255,0.18);
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
  .container { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
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
  }
  @media (max-width: 800px) { .overview { grid-template-columns: 1fr; } }
  .overview-card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 20px;
  }
  .overview-card h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  .overview-card p { margin: 0; color: #4b5563; font-size: 14px; }

  .phase { margin-bottom: 32px; }
  .phase-head {
    display: flex; align-items: center; gap: 14px;
    padding: 18px 22px;
    background: linear-gradient(90deg, rgba(45,107,79,0.07) 0%, rgba(58,138,102,0.02) 100%);
    border: 1px solid rgba(45,107,79,0.15);
    border-radius: 12px;
  }
  .phase-icon {
    width: 44px; height: 44px;
    border-radius: 10px;
    background: #2d6b4f; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; flex-shrink: 0;
  }
  .phase-title { font-size: 18px; font-weight: 700; margin: 0; }
  .phase-meta { font-size: 13.5px; color: #6b7280; margin: 2px 0 0; }
  .phase-count {
    margin-left: auto;
    font-size: 12px; font-weight: 600;
    color: #2d6b4f; background: #fff;
    padding: 4px 10px; border-radius: 999px;
    border: 1px solid rgba(45,107,79,0.2);
  }

  .step-list {
    position: relative;
    padding: 0 0 0 28px;
    margin: 0;
    list-style: none;
  }
  .step-list::before {
    content: "";
    position: absolute;
    left: 18px; top: 16px; bottom: 16px;
    width: 2px;
    background: linear-gradient(180deg, rgba(45,107,79,0.18), rgba(45,107,79,0.05));
  }
  .step {
    position: relative;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 14px 16px;
    margin: 12px 0 0 0;
    list-style: none;
  }
  .step::before {
    content: "";
    position: absolute;
    left: -19px; top: 22px;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: #fff;
    border: 2.5px solid #2d6b4f;
  }
  .step-summary {
    display: flex; align-items: center; gap: 12px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .step-summary::-webkit-details-marker { display: none; }
  .step-icon {
    flex-shrink: 0;
    width: 32px; height: 32px;
    border-radius: 8px;
    background: #e8f5ee;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px;
  }
  .step-text { flex: 1; min-width: 0; }
  .step-title { font-size: 15.5px; font-weight: 600; margin: 0; letter-spacing: -0.005em; }
  .step-short { font-size: 13.5px; color: #6b7280; margin: 2px 0 0; }
  .step-toggle {
    flex-shrink: 0;
    color: #6b7280;
    font-size: 12px; font-weight: 600;
    padding: 4px 10px; border-radius: 999px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    transition: all 0.15s;
  }
  details[open] > .step-summary .step-toggle {
    background: #2d6b4f; color: #fff; border-color: #2d6b4f;
  }
  .step-detail {
    padding: 14px 0 4px 44px;
    border-top: 1px dashed #e5e7eb;
    margin-top: 12px;
  }
  .step-body { color: #374151; font-size: 14.5px; margin: 0 0 10px; }
  .step-detail ul { margin: 8px 0 0; padding-left: 20px; color: #374151; font-size: 14px; }
  .step-detail li { margin: 3px 0; }
  .tip {
    margin-top: 12px;
    padding: 10px 12px;
    background: #fff8e1;
    border-left: 3px solid #f59e0b;
    border-radius: 6px;
    font-size: 13px;
    color: #6b4f12;
  }
  .tip strong { color: #92400e; }

  .cmd-block {
    margin: 12px 0;
    padding: 12px 14px;
    background: #1f2937;
    color: #e5e7eb;
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre;
  }

  .ref-table {
    width: 100%;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    margin-top: 12px;
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
    display: inline-flex; gap: 24px; flex-wrap: wrap; justify-content: center;
    margin-bottom: 8px;
  }
  footer.foot a {
    color: #2d6b4f;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  footer.foot a:hover { color: #1f4d39; }
`;

function groupByPhase(steps) {
  const groups = {};
  for (const step of steps) {
    if (!groups[step.phase]) groups[step.phase] = [];
    groups[step.phase].push(step);
  }
  return PHASES.filter((p) => groups[p.id]?.length > 0).map((p) => ({
    ...p,
    steps: groups[p.id],
  }));
}

export default function Onboarding() {
  const grouped = groupByPhase(STEPS);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <header className="hero">
        <div className="pill">Aetrex internal · Enterprise plan</div>
        <h1>SEoS Assistant — Aetrex setup guide</h1>
        <p>
          End-to-end configuration for the AI shopping assistant on aetrex.com. Plan an hour for
          the first install (most of it is waiting for catalog sync); subsequent re-installs are
          15 minutes.
        </p>
      </header>

      <main>
        <section className="container section" aria-labelledby="overview-heading">
          <h2 id="overview-heading">What this app does for Aetrex</h2>
          <p className="lede">Three layers, all driven by live Shopify data and Aetrex configuration.</p>
          <div className="overview">
            <div className="overview-card">
              <h3>Catalog-aware AI</h3>
              <p>Mirrors every product, variant, metafield, and tag from the Aetrex Shopify store so the assistant answers questions about real inventory.</p>
            </div>
            <div className="overview-card">
              <h3>Fit + sizing intelligence</h3>
              <p>Combines Yotpo review fit, Aftership return reasons, customer order history, and the Aetrex external sizing API into a single per-product fit prediction.</p>
            </div>
            <div className="overview-card">
              <h3>VIP personalization</h3>
              <p>Logged-in shoppers get personalized greetings, points/tier references from Yotpo Loyalty, and segment-aware tone from Klaviyo. No customer PII is stored.</p>
            </div>
          </div>
        </section>

        <section className="container section" aria-labelledby="setup-heading">
          <h2 id="setup-heading">Setup steps</h2>
          <p className="lede">Each phase builds on the previous one. Click a step to expand the full instructions.</p>

          {grouped.map((phase, phaseIdx) => (
            <div className="phase" key={phase.id}>
              <div className="phase-head">
                <div className="phase-icon" aria-hidden="true">{phase.icon}</div>
                <div>
                  <h3 className="phase-title">Phase {phaseIdx + 1} · {phase.name}</h3>
                  <p className="phase-meta">{phase.description}</p>
                </div>
                <span className="phase-count">
                  {phase.steps.length} {phase.steps.length === 1 ? "step" : "steps"}
                </span>
              </div>
              <ol className="step-list">
                {phase.steps.map((step, stepIdx) => (
                  <li className="step" key={`${phase.id}-${stepIdx}`}>
                    <details open={phaseIdx === 0 && stepIdx === 0}>
                      <summary className="step-summary">
                        <div className="step-icon" aria-hidden="true">{step.icon}</div>
                        <div className="step-text">
                          <p className="step-title">{step.title}</p>
                          <p className="step-short">{step.short}</p>
                        </div>
                        <div className="step-toggle">Details</div>
                      </summary>
                      <div className="step-detail">
                        <p className="step-body">{step.body}</p>
                        {step.list ? (
                          <ul>
                            {step.list.map((item, j) => (
                              <li key={j}>{item}</li>
                            ))}
                          </ul>
                        ) : null}
                        {step.showAttributeTable ? (
                          <div style={{ overflowX: "auto" }}>
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
                        {step.commands ? (
                          <pre className="cmd-block" aria-label="Terminal commands">
                            {step.commands.map((c) => `$ ${c}`).join("\n")}
                          </pre>
                        ) : null}
                        {step.tip ? (
                          <div className="tip">
                            <strong>Tip:</strong> {step.tip}
                          </div>
                        ) : null}
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>

        <section className="container section" aria-labelledby="trouble-heading">
          <h2 id="trouble-heading">Troubleshooting</h2>
          <div className="overview">
            <div className="overview-card">
              <h3>Catalog stuck syncing</h3>
              <p>Hard-refresh the home page. If the count hasn&apos;t moved in 10 minutes, check Railway logs for products/update errors and email support.</p>
            </div>
            <div className="overview-card">
              <h3>Fit predictor returns 0% confidence</h3>
              <p>Means the predictor has no data for that product yet. Confirm Yotpo Reviews and Aftership keys are set and the product has at least one review or return.</p>
            </div>
            <div className="overview-card">
              <h3>VIP mode not personalizing</h3>
              <p>The shopper must be logged into aetrex.com (not just have an account). Verify the Klaviyo private key has profiles:read + segments:read scopes.</p>
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
