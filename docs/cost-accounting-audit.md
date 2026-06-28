# Cost accounting audit — admin Analytics CostEstimator

Scope: make the admin Analytics cost figures honest. No chat behavior changed.

## 1. What "a message" means

`ChatUsage` records **one row per assistant reply (chat turn)**, plus separate
rows for image-preview generations. The Analytics CostEstimator multiplier is
therefore **estimated assistant replies (chat turns)**, not raw provider API
requests — a single reply can fan out into a classifier call, model retries,
follow-up suggestions, tool calls, and embeddings. Labels and copy say
"assistant replies", never "AI requests".

## 2. Chat cost vs image-preview cost

`getUsageSummary` / `summarizeUsageRecords` now expose:

- `totalCost` — everything (Anthropic chat + embeddings + image previews).
- `chatOnlyCost` = `totalCost − imageCost` (Anthropic chat + embeddings).
- `avgChatCostPerMessage` = `chatOnlyCost / totalMessages` ← the estimator anchor.
- `avgCostPerMessage` = `totalCost / totalMessages` (all-in; legacy KPI only).
- `imageCost` / `imageCount` — kept visible separately in Analytics.

"See It Styled" image generations are optional clicks, not part of every chat
reply, so they must never inflate the per-reply rate the estimator extrapolates
from. The estimator is passed `avgChatCostPerMessage`, not `avgCostPerMessage`.

## 3. Side LLM calls during a customer turn — metered status

| Call | Model | Metered into ChatUsage? |
|---|---|---|
| Main LLM turn + retries | Sonnet/Haiku/Opus | **Yes** — `totalUsage` → `recordChatUsage` |
| Grounding-escalation retry (Haiku→Sonnet→Opus) | varies | **Yes** — `addUsage` folds both attempts |
| Follow-up suggestions | Haiku | **Yes** — `addUsage` into the turn's `totalUsage` |
| Semantic-search embeddings | — | **Yes** — `ctx.embeddingUsage` → `embeddingCostUsd` |
| Product-turn voice synthesis (`chat.jsx`) | Haiku | **No** — `r.usage` discarded |
| Policy-answer synthesis (`chat.jsx`) | Haiku | **No** |
| Orthotic intent classifier (`orthotic-classifier.server.js`) | Haiku | **No** |
| Orthotic-flow layer-3 mapping (`orthotic-flow-gate.server.js`) | Haiku | **No** |
| Greeting translation (`greeting-translation.server.js`) | Haiku | **No** — but it's a merchant **config** action (translating the greeting), not a per-customer-turn cost, so out of scope here |

The unmetered per-turn calls are all small **Haiku** calls (80–512 max tokens)
that fire on a *subset* of turns (a turn is typically product **or** policy
**or** orthotic), so on top of a ~$0.006 main turn they add a few percent.

**Decision (option B — documented overhead factor).** They live in dispatch
paths with their own emit flow, so threading their usage into the turn's
`ChatUsage` row risks the chat hot path, which is out of bounds for this change
("do not change chat behavior"). Instead the estimator applies a small,
disclosed `SIDE_CALL_OVERHEAD` (`cost-estimator-math.js`, currently `1.06`) to
the **anchored real average** only — the recorded average is known to
understate true cost by exactly these unmetered auxiliary calls. The **fallback**
blended rates already include auxiliary overhead and are not multiplied again.
Each unmetered call site carries a `// COST AUDIT` comment pointing here.

Future option A (preferred long-term): add a per-turn `ctx.sideUsage`
accumulator (mirroring `ctx.embeddingUsage`), have these dispatch closures push
their `r.usage` into it, and fold it into `recordChatUsage`. Then drop
`SIDE_CALL_OVERHEAD` to `1.0`.

## 4. Anchored vs fallback estimate

- `totalMessages >= CALC_MIN_SAMPLE` (25): the estimator anchors on the store's
  own recorded chat average → copy reads
  *"Based on your recorded chat average over the selected analytics period."*
- `totalMessages < CALC_MIN_SAMPLE`: it uses the strategy's blended assumption →
  copy reads
  *"Based on typical model-routing assumptions until your store has enough traffic."*

## 5. QA / debug traffic

- The admin **test chat** (`internal: true`) is **excluded** from `ChatUsage` —
  both `recordChatUsage` sites skip it — so a merchant's own in-admin testing
  never pollutes their analytics or the estimator.
- **Storefront** QA (testing through the real PRD storefront) is **counted** as
  real usage, because those turns are indistinguishable from real customer
  traffic at the API. This is acceptable; it's documented here so the forecast
  is understood. A future admin-only filter to exclude known QA sessions is
  possible but not implemented.
