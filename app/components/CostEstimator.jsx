import { useState } from "react";

// ---------------------------------------------------------------------------
// CostEstimator — Apple-style "what will this cost me?" panel. The merchant
// types their store sessions, drags an engagement slider, and picks a
// conversation depth; the result panel answers with a live monthly figure.
// The per-request rate anchors on the store's own last-30-day average once
// there's enough real traffic to trust it, otherwise on a typical blended
// rate — and the anchor in use is always disclosed under the result.
// Self-contained: carries its own styles so any page can drop it in.
// ---------------------------------------------------------------------------
const CALC_MIN_SAMPLE = 25; // real requests needed before trusting the store's own average

// Per-request cost falls as volume grows: at low traffic nearly every
// conversation pays a fresh prompt-cache write with nothing amortizing it,
// while at high traffic the cache stays hot (reads bill at ~1/10th the
// input price) and the fast-model share of routing rises. Extrapolating a
// low-volume average linearly to big traffic therefore overstates cost
// badly — so the rate log-interpolates from the anchored low-volume rate
// down to the at-scale blended rate between 2K and 100K requests/month.
const CALC_AMORT_START = 2000;
const CALC_AMORT_FULL = 100000;

// The per-request rate is driven mostly by which model answers — that's the
// single biggest cost lever (see the AI-engine model-strategy setting). At
// scale the dominant cost is the cached system-prefix READ, so the rates
// below scale with each model's cache-read + output price relative to
// Sonnet (pricing.server.js): Sonnet cacheRead $0.30/M, out $15/M (1.0x);
// Haiku $0.10/M, $5/M (~1/3x); Opus $0.50/M, $25/M (~1.7x). The Sonnet
// at-scale anchor ($0.006) is validated against real warm-cache spend.
//   • Smart           → Sonnet for substantive turns (Haiku for trivial).
//   • Cost optimized   → Haiku-first; Sonnet only on grounding escalation
//                        and high-risk turns, so a Haiku-leaning blend.
//   • Premium quality  → Opus on every turn.
const STRATEGY_RATES = {
  smart: { fallback: 0.008, atScale: 0.006 },
  "cost-optimized": { fallback: 0.005, atScale: 0.0035 },
  "always-opus": { fallback: 0.014, atScale: 0.011 },
};

// Map the stored strategy (incl. legacy values) to a rate profile + label.
function strategyProfile(strategy) {
  switch (strategy) {
    case "cost-optimized":
    case "always-haiku": // legacy: pure fast model — closest to cost-optimized
      return { rates: STRATEGY_RATES["cost-optimized"], label: "Cost-optimized routing" };
    case "always-opus":
    case "premium":
      return { rates: STRATEGY_RATES["always-opus"], label: "Premium quality" };
    default: // smart, always-sonnet, unknown
      return { rates: STRATEGY_RATES.smart, label: "Smart routing" };
  }
}

function effectiveRate(baseRate, monthlyRequests, atScaleRate) {
  if (baseRate <= atScaleRate) return baseRate;
  if (!Number.isFinite(monthlyRequests) || monthlyRequests <= CALC_AMORT_START) return baseRate;
  const t = Math.min(
    1,
    (Math.log10(monthlyRequests) - Math.log10(CALC_AMORT_START)) /
      (Math.log10(CALC_AMORT_FULL) - Math.log10(CALC_AMORT_START)),
  );
  return baseRate + (atScaleRate - baseRate) * t;
}

const CALC_DEPTHS = [
  { key: "quick", label: "Quick", desc: "2 messages", turns: 2 },
  { key: "typical", label: "Typical", desc: "4 messages", turns: 4 },
  { key: "detailed", label: "Detailed", desc: "7 messages", turns: 7 },
];

function calcMoney(n) {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const rateFmt = (r) => `$${r.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

export default function CostEstimator({ avgCostPerMessage, totalMessages, modelStrategy = "smart" }) {
  const { rates, label: strategyLabel } = strategyProfile(modelStrategy);
  const anchored = totalMessages >= CALC_MIN_SAMPLE && avgCostPerMessage > 0;
  const baseRate = anchored ? avgCostPerMessage : rates.fallback;

  const [sessionsRaw, setSessionsRaw] = useState("25,000");
  const [period, setPeriod] = useState("month");
  const [engagement, setEngagement] = useState(5);
  const [depth, setDepth] = useState("typical");

  const onSessions = (e) => {
    const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 9);
    setSessionsRaw(digits ? Number(digits).toLocaleString("en-US") : "");
  };

  // Switching the period converts the typed number (25,000/mo ↔ 300,000/yr)
  // so the toggle changes how you read the field — never the estimate.
  const onPeriod = (next) => {
    if (next === period) return;
    const current = parseInt(sessionsRaw.replace(/[^\d]/g, ""), 10) || 0;
    if (current > 0) {
      const converted = Math.min(
        next === "year" ? current * 12 : Math.round(current / 12),
        999999999,
      );
      setSessionsRaw(converted.toLocaleString("en-US"));
    }
    setPeriod(next);
  };

  const sessions = parseInt(sessionsRaw.replace(/[^\d]/g, ""), 10) || 0;
  const monthlySessions = period === "year" ? sessions / 12 : sessions;
  const turns = CALC_DEPTHS.find((d) => d.key === depth).turns;
  const conversations = monthlySessions * (engagement / 100);
  const requests = conversations * turns;
  const rate = effectiveRate(baseRate, requests, rates.atScale);
  const scaled = rate < baseRate - 1e-9;
  const monthlyCost = requests * rate;
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");

  const ENG_MIN = 1;
  const ENG_MAX = 50;
  const fill = `${(((engagement - ENG_MIN) / (ENG_MAX - ENG_MIN)) * 100).toFixed(1)}%`;

  return (
    <section className="seos-calc" aria-label="AI cost estimator">
      <style>{`
        /* Cost estimator — full-width interactive card. Left: three
           controls (sessions, engagement slider, depth). Right: a quiet
           green result panel with the live figure. */
        .seos-calc {
          display: flex;
          flex-direction: column;
          border-radius: 16px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          overflow: hidden;
        }
        .seos-calc-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.25fr) minmax(280px, 1fr);
        }
        .seos-calc-controls {
          padding: 24px 28px 26px;
          display: flex;
          flex-direction: column;
          gap: 22px;
          min-width: 0;
        }
        .seos-calc-title { font-size: 15px; font-weight: 650; color: #1a2e26; letter-spacing: -0.1px; }
        .seos-calc-desc { font-size: 12.5px; line-height: 1.5; color: rgba(26,46,38,0.62); margin-top: 4px; }
        .seos-calc-field { display: flex; flex-direction: column; gap: 8px; }
        .seos-calc-labelrow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .seos-calc-label { font-size: 12.5px; font-weight: 650; color: #1a2e26; }
        .seos-calc-hint { font-size: 11.5px; color: rgba(26,46,38,0.45); }
        .seos-calc-input {
          appearance: none;
          width: 100%;
          box-sizing: border-box;
          font: inherit;
          font-size: 17px;
          font-weight: 650;
          letter-spacing: -0.2px;
          font-variant-numeric: tabular-nums;
          color: #1a2e26;
          background: rgba(26,46,38,0.035);
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 12px;
          padding: 11px 14px;
          transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-calc-input:hover { border-color: rgba(45,107,79,0.3); }
        .seos-calc-input:focus {
          outline: none;
          background: #fff;
          border-color: #2D6B4F;
          box-shadow: 0 0 0 3px rgba(45,107,79,0.15);
        }
        .seos-calc-readout {
          font-size: 13px;
          font-weight: 650;
          color: #2D6B4F;
          font-variant-numeric: tabular-nums;
          background: rgba(45,107,79,0.08);
          border: 1px solid rgba(45,107,79,0.18);
          border-radius: 999px;
          padding: 2px 10px;
        }
        .seos-calc-seg {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          background: rgba(26,46,38,0.05);
          border-radius: 9px;
        }
        .seos-calc-seg button {
          appearance: none;
          font: inherit;
          border: none;
          cursor: pointer;
          font-size: 11.5px;
          font-weight: 600;
          color: rgba(26,46,38,0.6);
          background: transparent;
          border-radius: 7px;
          padding: 4px 10px;
          transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-calc-seg button:focus-visible {
          outline: 2px solid rgba(45,107,79,0.5);
          outline-offset: 1px;
        }
        .seos-calc-seg button.is-on {
          background: #fff;
          color: #1a2e26;
          box-shadow: 0 1px 3px rgba(26,46,38,0.14);
        }
        .seos-calc-seg--wide { display: flex; width: 100%; box-sizing: border-box; }
        .seos-calc-seg--wide button {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          padding: 8px 10px;
        }
        .seos-calc-seg--wide button small { font-size: 10.5px; font-weight: 500; color: rgba(26,46,38,0.45); }
        .seos-calc-seg--wide button.is-on small { color: rgba(26,46,38,0.55); }
        .seos-calc-slider {
          appearance: none;
          -webkit-appearance: none;
          width: 100%;
          height: 6px;
          border-radius: 999px;
          background: linear-gradient(90deg, #2D6B4F 0%, #3a8a66 var(--fill, 0%), rgba(26,46,38,0.10) var(--fill, 0%));
          outline: none;
          cursor: pointer;
          margin: 8px 0 2px;
        }
        .seos-calc-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.06);
          box-shadow: 0 2px 8px rgba(26,46,38,0.28), 0 1px 2px rgba(26,46,38,0.18);
          transition: transform 0.15s ease;
        }
        .seos-calc-slider::-webkit-slider-thumb:hover { transform: scale(1.08); }
        .seos-calc-slider::-moz-range-thumb {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.06);
          box-shadow: 0 2px 8px rgba(26,46,38,0.28);
        }
        .seos-calc-slider:focus-visible { box-shadow: 0 0 0 3px rgba(45,107,79,0.2); }
        .seos-calc-result {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 4px;
          padding: 26px 28px;
          background: linear-gradient(160deg, rgba(45,107,79,0.055), rgba(58,138,102,0.035));
          border-left: 1px solid rgba(45,107,79,0.12);
          min-width: 0;
        }
        .seos-calc-result-label {
          font-size: 10.5px;
          font-weight: 650;
          letter-spacing: 1.1px;
          text-transform: uppercase;
          color: rgba(45,107,79,0.75);
        }
        .seos-calc-bignum {
          font-size: 44px;
          font-weight: 700;
          letter-spacing: -1.5px;
          color: #1a2e26;
          font-variant-numeric: tabular-nums;
          line-height: 1.1;
        }
        .seos-calc-per {
          font-size: 16px;
          font-weight: 600;
          letter-spacing: 0;
          color: rgba(26,46,38,0.5);
          margin-left: 4px;
        }
        .seos-calc-yearly { font-size: 13px; color: rgba(26,46,38,0.55); font-variant-numeric: tabular-nums; }
        .seos-calc-breakdown {
          display: flex;
          margin-top: 16px;
          border-top: 1px solid rgba(45,107,79,0.12);
          padding-top: 14px;
          gap: 12px;
        }
        .seos-calc-breakdown > div { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .seos-calc-breakdown span { font-size: 15px; font-weight: 650; color: #1a2e26; font-variant-numeric: tabular-nums; }
        .seos-calc-breakdown small { font-size: 10.5px; color: rgba(26,46,38,0.5); }
        .seos-calc-anchor { margin-top: 14px; font-size: 11.5px; line-height: 1.5; color: rgba(26,46,38,0.5); }
        @media (max-width: 860px) {
          .seos-calc-grid { grid-template-columns: 1fr; }
          .seos-calc-result {
            border-left: none;
            border-top: 1px solid rgba(45,107,79,0.12);
          }
        }
      `}</style>
      <div className="seos-calc-grid">
        <div className="seos-calc-controls">
          <div>
            <div className="seos-calc-title">Cost estimator</div>
            <div className="seos-calc-desc">
              See what the assistant would cost at your store&rsquo;s traffic.
              Type your sessions, drag the slider — the estimate updates live.
            </div>
          </div>

          <div className="seos-calc-field">
            <div className="seos-calc-labelrow">
              <label className="seos-calc-label" htmlFor="seos-calc-sessions">Store sessions</label>
              <div className="seos-calc-seg" role="group" aria-label="Sessions period">
                <button type="button" className={period === "month" ? "is-on" : ""} onClick={() => onPeriod("month")}>Monthly</button>
                <button type="button" className={period === "year" ? "is-on" : ""} onClick={() => onPeriod("year")}>Yearly</button>
              </div>
            </div>
            <input
              id="seos-calc-sessions"
              className="seos-calc-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={sessionsRaw}
              onChange={onSessions}
              placeholder="25,000"
            />
            <div className="seos-calc-hint">
              Pre-filled with an example — replace it with your real number from
              Shopify admin &rarr; Analytics &rarr; Sessions.
            </div>
          </div>

          <div className="seos-calc-field">
            <div className="seos-calc-labelrow">
              <label className="seos-calc-label" htmlFor="seos-calc-engagement">Visitors who chat</label>
              <span className="seos-calc-readout">{engagement}%</span>
            </div>
            <input
              id="seos-calc-engagement"
              className="seos-calc-slider"
              type="range"
              min={ENG_MIN}
              max={ENG_MAX}
              step="1"
              value={engagement}
              onChange={(e) => setEngagement(Number(e.target.value))}
              style={{ "--fill": fill }}
              aria-valuetext={`${engagement} percent of sessions`}
            />
            <div className="seos-calc-hint">Most stores see 2&ndash;8% of sessions open the assistant.</div>
          </div>

          <div className="seos-calc-field">
            <div className="seos-calc-labelrow">
              <span className="seos-calc-label" id="seos-calc-depth-label">Conversation depth</span>
            </div>
            <div className="seos-calc-seg seos-calc-seg--wide" role="group" aria-labelledby="seos-calc-depth-label">
              {CALC_DEPTHS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={depth === d.key ? "is-on" : ""}
                  onClick={() => setDepth(d.key)}
                >
                  {d.label}
                  <small>{d.desc}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="seos-calc-result">
          <div className="seos-calc-result-label">Estimated AI cost</div>
          <div className="seos-calc-bignum">
            {calcMoney(monthlyCost)}
            <span className="seos-calc-per">/month</span>
          </div>
          <div className="seos-calc-yearly">&asymp; {calcMoney(monthlyCost * 12)} per year</div>
          <div className="seos-calc-breakdown">
            <div>
              <span>{fmtInt(conversations)}</span>
              <small>conversations / mo</small>
            </div>
            <div>
              <span>{fmtInt(requests)}</span>
              <small>AI requests / mo</small>
            </div>
            <div>
              <span>{calcMoney(rate * turns)}</span>
              <small>per conversation</small>
            </div>
          </div>
          <div className="seos-calc-anchor">
            {scaled
              ? `${anchored
                ? `Your store's current average is ${rateFmt(baseRate)} per AI request at today's low volume`
                : `The typical low-volume rate on ${strategyLabel} is ${rateFmt(baseRate)} per AI request`}, but AI gets much cheaper at scale — prompt caching and fast-model routing bring it down to about ${rateFmt(rate)} per request at this traffic. The estimate uses the at-scale rate.`
              : anchored
                ? `Anchored on your store's real average of ${rateFmt(rate)} per AI request over the last 30 days.`
                : `Based on the ${strategyLabel} blended rate of ${rateFmt(rate)} per AI request. Once your store has chat activity, this switches to your real average automatically.`}
          </div>
          <div className="seos-calc-anchor" style={{ marginTop: 4 }}>
            Estimate reflects your current model strategy ({strategyLabel}) and includes semantic search embedding costs when enabled.
          </div>
        </div>
      </div>
    </section>
  );
}
