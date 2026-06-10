# Architecture Migration — Phase 1: LLM owns the turn

This is the first piece of the migration plan that ends the two-year
"code vs LLM" pendulum. The full diagnosis is in the session history;
the short version:

- **"LLM owns the turn"** failed last time because the model composed
  from bare cards (no verified facts) and the system prompt forbade
  honest "we don't carry that" framing.
- **"Code owns the truth"** still failed because code's regex layer
  can't understand negation ("NOT in black"), anaphora ("both
  technologies"), or pivots, and the code-driven engine still
  invoked a model at the end to write the words — so confabulation
  just moved.

The fix is neither pole: **code owns facts, model owns language, a
validator with reject-and-retry enforces the boundary**. Phase 1 ships
the validator and the orchestrator behind a feature flag. Nothing in
production changes until the flag is turned on.

## What landed in Phase 1

### New modules

- `app/lib/grounding-validator.server.js` — checks every load-bearing
  claim in the model's reply against the tool results from the same
  turn. Three rules:
    1. **Ungrounded product name** — bolded product family must appear
       in some tool result this turn.
    2. **Wrong price** — quoted dollar figure must match the card.
    3. **Unsupported feature claim** — "X has BioRocker" / "Y has
       memory foam" requires evidence in the card's description, tags,
       attributes, or claim facts.
  Returns structured errors. Never silently rewrites text.

- `app/lib/llm-owns-turn.server.js` — orchestrator. Wraps the existing
  `runAgenticLoop` with:
    - Feature-flag check (`isLlmOwnsTurnEnabled`, `isShadowModeEnabled`).
    - Pool gathering from tool_result messages.
    - **Retry on failure**: when the validator returns errors, append a
      structured correction message to the conversation and re-run the
      loop. Max 2 retries. The model rewrites its own answer using the
      validator's feedback — no silent post-processing.
    - Shadow-diff record builder for the comparison harness.

### Wiring in `app/routes/chat.jsx`

Just before the dispatcher cascade (the existing `runVariantFactDispatch`
/ `runPolicyTurnDispatch` / `runResolverNoMatchDispatch` / `runProductTurnDispatch`
chain), a single conditional:

```js
if (isLlmOwnsTurnEnabled()) {
  // skip the cascade and the ~50 post-processors
  // one model call, grounded, with retry
  await runWithGroundingRetry({...});
  return;
}
if (isShadowModeEnabled()) {
  // run the new path in parallel into a discard buffer
  // log its outcome; old pipeline still answers the customer
}
// ... existing dispatcher cascade unchanged
```

## Feature flags

| Variable | Default | Behavior |
|---|---|---|
| `LLM_OWNS_ALL_TURNS` | `false` | When `true`, route every turn through the new path. Skips dispatcher cascade + all post-processors. |
| `LLM_OWNS_ALL_TURNS_SHADOW` | `false` | When `true` (and main flag `false`), the new path runs in parallel into a discard buffer for log comparison. Old path still answers the customer. |

## Test coverage

- 20 new tests in `scripts/eval-grounding-validator.mjs` covering all
  three rules plus retry-instruction formatting and edge cases.
- 13 new tests in `scripts/eval-llm-owns-turn.mjs` covering flag
  behavior, pool gathering, retry-on-ungrounded loop, retry exhaustion,
  shadow diff records.
- All 336 pre-existing tests still pass.

## How to roll out

### Step 1 — Shadow mode in staging

```
LLM_OWNS_ALL_TURNS=false
LLM_OWNS_ALL_TURNS_SHADOW=true
```

Run the 30-question torture script we drafted last session. Grep
`[llm-owns-turn:shadow]` lines and diff against `[chat] emit` lines
from the same shop+timestamp. We're looking for:

- New path text length is reasonable (not 0, not 5× the old).
- Validator catches at least the known confabulations we've fixed
  ("Noelle has both technologies" should fail the validator and
  trigger a retry).
- Card counts roughly track between old and new.

### Step 2 — Single test shop

Flip `LLM_OWNS_ALL_TURNS=true` for one staging shop. Run real
conversations through it for a day. Watch for regressions the
validator missed.

### Step 3 — Phase 2 (next session)

Move the engine's claim-fact attachment INTO the `search_products`
tool result so every card already ships verified facts. The
validator's evidence base gets richer; the model has more to work
with; code-owned templates shrink to safety nets.

Also: fill the knowledge-base holes. The current logs show
`[rag] retrieved 0 chunks` for BioRocker/UltraSky queries — no
architecture can answer from data that doesn't exist.

### Step 4 — Phase 3 (later session)

Prompt diet: 78K chars → ~10K. Delete the contradictory rules. Keep
the five honesty rules that actually matter.

### Step 5 — Phase 4 (later session)

Once shadow mode shows the new path is at least as good as the old
across a week of real traffic, flip the main flag for all shops and
delete the dead routing/guarding code (~15K lines).

## What's intentionally NOT in Phase 1

- No orthotic-flow changes. That decision tree is a real business
  workflow; it stays as today's gate.
- No `search_products` changes. Phase 2 work.
- No prompt edits. Phase 3 work.
- No deletions. Phase 4 work, only after shadow mode and full rollout
  validate the new path.

The whole point of this migration is **no big bang**. Each phase is
shippable on its own and reversible by toggling a flag.
