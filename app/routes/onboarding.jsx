import { useState, useEffect } from "react";
import { PHASES, STEPS, ATTRIBUTE_MAPPINGS, CADENCE_SECTIONS } from "../lib/onboarding-data";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const meta = () => [
  { title: "Aetrex setup guide — SEoS Assistant" },
  { name: "robots", content: "noindex, nofollow" },
  {
    name: "description",
    content:
      "Internal setup guide for the AI shopping assistant powering aetrex.com.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  "Cache-Control": "private, no-cache",
});

const STYLES = `
  :root {
    color-scheme: light;
    --bg:            #ffffff;
    --bg-muted:      #f9fafb;
    --bg-cmd:        #0f172a;
    --bg-cmd-text:   #e5e7eb;
    --text:          #111827;
    --text-secondary:#374151;
    --text-muted:    #6b7280;
    --text-faint:    #9ca3af;
    --border:        #e5e7eb;
    --border-strong: #d1d5db;
    --border-soft:   #f3f4f6;
    --accent:        #2d6b4f;
    --accent-hover:  #245a42;
    --accent-on:     #ffffff;
    --tip-bg:        #fffbeb;
    --tip-text:      #78350f;
    --tip-strong:    #92400e;
    --tip-border:    #f59e0b;
    --code-bg:       #f3f4f6;
    --code-text:     #2d6b4f;
    --hero-bg:       #ffffff;
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --bg:            #0b1220;
    --bg-muted:      #131c2e;
    --bg-cmd:        #050a14;
    --bg-cmd-text:   #e5e7eb;
    --text:          #f3f4f6;
    --text-secondary:#d1d5db;
    --text-muted:    #9ca3af;
    --text-faint:    #6b7280;
    --border:        #1f2937;
    --border-strong: #334155;
    --border-soft:   #1a2332;
    --accent:        #4ade80;
    --accent-hover:  #22c55e;
    --accent-on:     #0b1220;
    --tip-bg:        #2a1f05;
    --tip-text:      #fde68a;
    --tip-strong:    #fcd34d;
    --tip-border:    #f59e0b;
    --code-bg:       #1f2937;
    --code-text:     #4ade80;
    --hero-bg:       #0b1220;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--text);
    background: var(--bg);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    transition: background 0.18s ease, color 0.18s ease;
  }

  /* ── Hero (calmer, smaller) ───────────────────────────────── */
  .hero {
    position: relative;
    border-bottom: 1px solid var(--border);
    padding: 56px 24px 40px;
    background: var(--hero-bg);
  }
  .hero-inner { max-width: 880px; margin: 0 auto; }
  .hero-eyebrow {
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin: 0 0 10px;
  }
  .hero h1 {
    margin: 0 0 14px;
    font-size: clamp(28px, 4vw, 38px);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .hero p {
    margin: 0;
    max-width: 680px;
    font-size: 16px;
    color: var(--text-secondary);
  }

  /* ── Theme toggle (top-right of hero) ─────────────────────── */
  .theme-toggle {
    position: absolute;
    top: 20px;
    right: 24px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 7px 14px 7px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }
  .theme-toggle:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .theme-toggle svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* ── Container ────────────────────────────────────────────── */
  .container { max-width: 880px; margin: 0 auto; padding: 0 24px; }
  main { padding: 32px 0 80px; }

  /* ── Phase navigator (tabs at top) ────────────────────────── */
  .phase-nav {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 4px 0 24px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 32px;
    scrollbar-width: none;
  }
  .phase-nav::-webkit-scrollbar { display: none; }
  .phase-tab {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: all 0.12s;
    font-family: inherit;
  }
  .phase-tab:hover {
    border-color: var(--border-strong);
    color: var(--text-secondary);
  }
  .phase-tab[aria-selected="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-on);
  }
  .phase-tab[aria-selected="true"]:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .phase-tab .num {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    font-weight: 600;
    opacity: 0.7;
  }
  .phase-tab .count {
    font-size: 12px;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }

  /* ── Phase intro ──────────────────────────────────────────── */
  .phase-intro {
    margin: 0 0 24px;
    padding-bottom: 20px;
    border-bottom: 1px dashed var(--border);
  }
  .phase-intro h2 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .phase-intro p {
    margin: 0;
    color: var(--text-muted);
    font-size: 15px;
  }
  .cadence-section {
    margin: 28px 0 14px;
    padding: 0 0 8px;
    border-bottom: 1px solid var(--border);
  }
  .cadence-section:first-of-type { margin-top: 8px; }
  .cadence-section h3 {
    margin: 0 0 4px;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
  }
  .cadence-section p {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* ── Step list ────────────────────────────────────────────── */
  .steps { display: flex; flex-direction: column; gap: 8px; }
  .step {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    transition: border-color 0.12s;
  }
  .step:hover { border-color: var(--border-strong); }
  .step[data-open="true"] { border-color: var(--accent); }

  .step-summary {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 16px 18px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .step-summary::-webkit-details-marker { display: none; }
  .step-num {
    flex-shrink: 0;
    width: 24px;
    margin-top: 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .step-text { flex: 1; min-width: 0; }
  .step-title {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .step-short {
    font-size: 14px;
    color: var(--text-muted);
    margin: 4px 0 0;
  }
  .step-chevron {
    flex-shrink: 0;
    margin-top: 4px;
    color: var(--text-faint);
    transition: transform 0.15s;
  }
  details[open] > .step-summary .step-chevron {
    transform: rotate(90deg);
    color: var(--accent);
  }

  .step-detail {
    padding: 4px 18px 20px 56px;
    border-top: 1px solid var(--border-soft);
    margin-top: 0;
  }
  .step-body {
    color: var(--text-secondary);
    font-size: 14.5px;
    margin: 16px 0 12px;
  }
  .step-detail ul {
    margin: 8px 0;
    padding-left: 18px;
    color: var(--text-secondary);
    font-size: 14px;
  }
  .step-detail li { margin: 5px 0; }

  /* ── Tip ──────────────────────────────────────────────────── */
  .tip {
    margin-top: 14px;
    padding: 12px 14px;
    background: var(--tip-bg);
    border-left: 3px solid var(--tip-border);
    border-radius: 4px;
    font-size: 13.5px;
    color: var(--tip-text);
  }
  .tip strong { color: var(--tip-strong); font-weight: 600; }

  /* ── Command block ────────────────────────────────────────── */
  .cmd-block {
    margin: 14px 0;
    padding: 14px 16px;
    background: var(--bg-cmd);
    color: var(--bg-cmd-text);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.65;
    overflow-x: auto;
    white-space: pre;
  }

  /* ── Reference table ──────────────────────────────────────── */
  .ref-table {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    margin: 14px 0;
  }
  .ref-table th, .ref-table td {
    text-align: left;
    padding: 11px 14px;
    font-size: 13.5px;
    border-bottom: 1px solid var(--border);
  }
  .ref-table th {
    background: var(--bg-muted);
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .ref-table tr:last-child td { border-bottom: none; }
  .ref-table code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--code-text);
    white-space: nowrap;
  }
  @media (max-width: 700px) {
    .ref-table-wrap { overflow-x: auto; }
  }

  /* ── Help block (replaces troubleshooting cards) ──────────── */
  .help {
    margin-top: 64px;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-muted);
  }
  .help h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .help p {
    margin: 0;
    font-size: 14px;
    color: var(--text-secondary);
  }
  .help a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
  }
  .help a:hover { text-decoration: underline; }

  /* ── Footer ───────────────────────────────────────────────── */
  footer.foot {
    border-top: 1px solid var(--border);
    padding: 24px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
  }
  footer.foot .links {
    display: inline-flex;
    gap: 20px;
    flex-wrap: wrap;
    justify-content: center;
    margin-bottom: 6px;
  }
  footer.foot a {
    color: var(--text-muted);
    text-decoration: none;
  }
  footer.foot a:hover { color: var(--accent); }
`;

// Inline script that runs BEFORE React hydrates so the saved theme
// applies on first paint — no flash of light theme on dark-preferred
// users. Reads localStorage; falls back to OS prefers-color-scheme.
const THEME_INIT_SCRIPT = `
  (function () {
    try {
      var stored = localStorage.getItem("aetrex-onboarding-theme");
      var t = stored || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", t);
    } catch (e) { /* localStorage blocked — default light is fine */ }
  })();
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

// Maintain phase has too many steps to read flat — group by cadence
// (Weekly / Monthly / Quarterly / As-needed / Reference) so the user
// knows what to do when. Order is determined by CADENCE_SECTIONS.
function renderMaintainSteps(steps) {
  const buckets = new Map(CADENCE_SECTIONS.map((s) => [s.id, []]));
  const other = [];
  for (const step of steps) {
    if (step.cadence && buckets.has(step.cadence)) buckets.get(step.cadence).push(step);
    else other.push(step);
  }
  const sections = CADENCE_SECTIONS
    .map((s) => ({ ...s, steps: buckets.get(s.id) }))
    .filter((s) => s.steps.length > 0);
  if (other.length > 0) sections.push({ id: "other", label: "Other", blurb: "", steps: other });

  let runningIdx = 0;
  return (
    <>
      {sections.map((section) => (
        <div key={section.id}>
          <div className="cadence-section">
            <h3>{section.label}</h3>
            {section.blurb ? <p>{section.blurb}</p> : null}
          </div>
          <ol className="steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {section.steps.map((step) => {
              const stepIdx = runningIdx++;
              return (
                <li className="step" key={`maintain-${stepIdx}`}>
                  <details>
                    <summary className="step-summary">
                      <span className="step-num" aria-hidden="true">{String(stepIdx + 1).padStart(2, "0")}</span>
                      <div className="step-text">
                        <p className="step-title">{step.title}</p>
                        <p className="step-short">{step.short}</p>
                      </div>
                      <svg className="step-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </summary>
                    <div className="step-detail">
                      <p className="step-body">{step.body}</p>
                      {step.list ? (
                        <ul>
                          {step.list.map((item, j) => (<li key={j}>{item}</li>))}
                        </ul>
                      ) : null}
                      {step.commands ? (
                        <pre className="cmd-block" aria-label="Terminal commands">
                          {step.commands.map((c) => `$ ${c}`).join("\n")}
                        </pre>
                      ) : null}
                      {step.tip ? (
                        <div className="tip"><strong>Tip:</strong> {step.tip}</div>
                      ) : null}
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </>
  );
}

export default function Onboarding() {
  const grouped = groupByPhase(STEPS);
  const [activeId, setActiveId] = useState(grouped[0]?.id || "");
  const active = grouped.find((p) => p.id === activeId) || grouped[0];
  const activeIndex = grouped.findIndex((p) => p.id === activeId);

  // Theme: the inline THEME_INIT_SCRIPT below sets data-theme on
  // <html> before React hydrates, so first paint is correct. We
  // sync React state from that on mount, then write back to both
  // documentElement and localStorage on change.
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const initial = document.documentElement.getAttribute("data-theme") || "light";
    setTheme(initial);
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("aetrex-onboarding-theme", theme); } catch { /* ignore */ }
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <header className="hero">
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? (
            // Sun icon — currently in dark mode, click to go light
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            // Moon icon — currently in light mode, click to go dark
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
          <span>{theme === "dark" ? "Light" : "Dark"} mode</span>
        </button>
        <div className="hero-inner">
          <p className="hero-eyebrow">Aetrex internal · Enterprise plan</p>
          <h1>SEoS Assistant setup guide</h1>
          <p>
            Configure the AI shopping assistant for aetrex.com. Pick a phase
            below — first install takes about an hour, mostly waiting for the
            catalog sync.
          </p>
        </div>
      </header>

      <main>
        <div className="container">
          <nav className="phase-nav" role="tablist" aria-label="Setup phases">
            {grouped.map((phase, idx) => (
              <button
                key={phase.id}
                role="tab"
                aria-selected={phase.id === activeId}
                className="phase-tab"
                onClick={() => setActiveId(phase.id)}
                type="button"
              >
                <span className="num">{idx + 1}</span>
                <span>{phase.name}</span>
                <span className="count">· {phase.steps.length}</span>
              </button>
            ))}
          </nav>

          {active ? (
            <section aria-labelledby={`phase-${active.id}-heading`}>
              <header className="phase-intro">
                <h2 id={`phase-${active.id}-heading`}>
                  Phase {activeIndex + 1} · {active.name}
                </h2>
                <p>{active.description}</p>
              </header>

              {active.id === "maintain" ? renderMaintainSteps(active.steps) : (
              <ol className="steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {active.steps.map((step, stepIdx) => (
                  <li className="step" key={`${active.id}-${stepIdx}`}>
                    <details>
                      <summary className="step-summary">
                        <span className="step-num" aria-hidden="true">
                          {String(stepIdx + 1).padStart(2, "0")}
                        </span>
                        <div className="step-text">
                          <p className="step-title">{step.title}</p>
                          <p className="step-short">{step.short}</p>
                        </div>
                        <svg
                          className="step-chevron"
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M6 4l4 4-4 4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
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
                          <div className="ref-table-wrap">
                            <table className="ref-table">
                              <thead>
                                <tr>
                                  <th>Source (Shopify)</th>
                                  <th>Maps to</th>
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
              )}
            </section>
          ) : null}

          <aside className="help">
            <h3>Need help?</h3>
            <p>
              Email{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{" "}
              with your shop domain and a screenshot of what you&apos;re seeing.
              Common issues — catalog stuck syncing, fit predictor at 0%
              confidence, VIP mode not personalizing — are usually fixed in
              under 24 hours.
            </p>
          </aside>
        </div>
      </main>

      <footer className="foot">
        <div className="links">
          <a href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
          <a href="/privacy">Privacy</a>
          <a href="/app" target="_blank" rel="noopener noreferrer">Open admin</a>
        </div>
        <div>© HajirAi · SEoS Assistant for Aetrex</div>
      </footer>
    </>
  );
}
