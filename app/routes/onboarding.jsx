import { useState } from "react";
import { PLAN_META, PHASES, STEPS_BY_PLAN } from "../lib/onboarding-data";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const meta = () => [
  { title: "Get started — SEoS Assistant" },
  { name: "robots", content: "index, follow" },
  {
    name: "description",
    content:
      "Set up SEoS Assistant on your Shopify store. Plan-by-plan onboarding for Free, Growth, and Enterprise.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  "Cache-Control": "public, max-age=300, s-maxage=300",
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
    max-width: 640px;
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
    margin: 0 0 28px;
    color: #6b7280;
    font-size: 16px;
  }
  .plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  @media (max-width: 800px) { .plans { grid-template-columns: 1fr; } }
  .plan-card {
    background: #fff;
    border: 2px solid #e5e7eb;
    border-radius: 14px;
    padding: 22px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
    text-align: left;
    font-family: inherit;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .plan-card:hover { border-color: #2d6b4f; }
  .plan-card:focus-visible { outline: 3px solid rgba(45,107,79,0.4); outline-offset: 2px; }
  .plan-card.active {
    border-color: #2d6b4f;
    background: linear-gradient(135deg, rgba(45,107,79,0.04), rgba(58,138,102,0.06));
    box-shadow: 0 4px 24px rgba(45,107,79,0.12);
  }
  .plan-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .plan-name { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .plan-price { font-size: 20px; font-weight: 600; color: #2d6b4f; }
  .plan-period { color: #6b7280; font-size: 13px; font-weight: 400; }
  .plan-blurb { color: #374151; font-size: 14px; margin: 0; }
  .plan-features { margin: 8px 0 0; padding-left: 18px; list-style: none; font-size: 13.5px; color: #4b5563; }
  .plan-features li { position: relative; padding: 3px 0 3px 4px; }
  .plan-features li::before { content: "✓"; position: absolute; left: -16px; color: #2d6b4f; font-weight: 700; }
  .badge {
    display: inline-block;
    background: #2d6b4f; color: #fff;
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    padding: 3px 10px; border-radius: 999px;
    margin-left: 6px; vertical-align: middle;
  }
  .eta {
    display: inline-flex; align-items: center; gap: 6px;
    background: #e8f5ee; color: #2d6b4f;
    padding: 6px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 600;
    margin-bottom: 24px;
  }
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
  .step-body { color: #374151; font-size: 14.5px; margin: 0; }
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
  .faq {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 24px;
  }
  .faq h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
  .faq p { margin: 0 0 18px; color: #4b5563; font-size: 14.5px; }
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
  const [selectedId, setSelectedId] = useState("growth");
  const plan = PLAN_META[selectedId];
  const grouped = groupByPhase(STEPS_BY_PLAN[selectedId]);

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
            Each tier unlocks more capability. You can switch any time after install.
          </p>
          <div className="plans" role="tablist" aria-label="Plan selector">
            {Object.entries(PLAN_META).map(([id, p]) => {
              const isActive = id === selectedId;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`plan-card${isActive ? " active" : ""}`}
                  onClick={() => setSelectedId(id)}
                >
                  <div className="plan-head">
                    <span className="plan-name">
                      {p.name}
                      {id === "growth" ? <span className="badge">Most popular</span> : null}
                    </span>
                    <span className="plan-price">
                      {p.price}
                      <span className="plan-period"> / {p.period}</span>
                    </span>
                  </div>
                  <p className="plan-blurb">{p.blurb}</p>
                  <ul className="plan-features">
                    {p.features.slice(0, 5).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {p.features.length > 5 ? (
                      <li style={{ color: "#6b7280", fontStyle: "italic" }}>
                        + {p.features.length - 5} more
                      </li>
                    ) : null}
                  </ul>
                </button>
              );
            })}
          </div>
        </section>

        <section className="container section" aria-labelledby="setup-heading">
          <h2 id="setup-heading">2. Set up your {plan.name} plan</h2>
          <p className="lede">
            Each phase builds on the previous one. Click a step to expand the full instructions.
          </p>
          <div className="eta">⏱ Estimated time: {plan.eta}</div>

          {grouped.map((phase, phaseIdx) => (
            <div className="phase" key={phase.id}>
              <div className="phase-head">
                <div className="phase-icon" aria-hidden="true">{phase.icon}</div>
                <div>
                  <h3 className="phase-title">
                    Phase {phaseIdx + 1} · {phase.name}
                  </h3>
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
