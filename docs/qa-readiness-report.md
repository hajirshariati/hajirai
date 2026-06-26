# QA readiness report

_Snapshot for the availability/ownership hardening pass. Update the counts when
the eval suite changes._

## Automated scenario coverage

All deterministic owners (TurnPlan, Availability Truth, variant matcher,
grounding validator) are covered by unit/integration evals. The live LLM
phrasing layer is verified by manual PRD live-testing, not these suites.

| Suite | Passing | Failing | Covers |
|---|---:|---:|---|
| `eval-live-core-flows` | 61 | 0 | core scenarios: workflow + search/clarify/gender + availability card-count + leak/CTA/family invariants + sizing + sale + comparison card-contract + same-session pivots + sale-search input |
| `eval-availability-truth` | 49 | 0 | availability classification, soft color, style disambiguation, follow-up memory, width split |
| `eval-variant-matcher` | 39 | 0 | size/width/SKU normalization, Aetrex labels, ranges, array-shape options |
| `eval-turn-plan` | 103 | 0 | workflow classification across all 9 workflows (incl. sizing_help, sale_browse, promo-policy) |
| `eval-turn-plan-gates` | 26 | 0 | executable gate deciders (search/display/clarifier) |
| `eval-turn-plan-failures` | 19 | 0 | regression cases from prior PRD failures |
| `eval-named-family-evidence` | 14 | 0 | named-family evidence requirement |
| `eval-clarifier-and-detector` | 40 | 0 | clarifier blocking + specific-product detection |
| `eval-evidence-alignment` | 16 | 0 | card/text family alignment |
| `eval-grounding-validator` | 74 | 0 | factual-safety blocking/warning partition + comparison length cap |
| **Total** | **441** | **0** | |

Run all: `npm run build && for s in scripts/eval-*.mjs; do node "$s"; done`

## What this pass fixed (proven failures only)

Per the "no new behavior without a proven failure" rule, the one behavior change
this pass made was driven by a QA scenario that reproduced a failure:

- **Deictic availability follow-up** — `"and in black?"` / `"in a 9?"` with a
  product in focus classified as `clarification`, so the deterministic
  availability block never ran (even though `resolveAvailabilityRequest` already
  handled it). Fixed in `turn-plan.server.js` (`FOLLOWUP_AVAIL_RE`, gated to ≤5
  words + product context). Locked by `eval-live-core-flows`.
- **Failure A — generic sizing showed a random product.** "I need help choosing
  the right size" planned as `browse`/`searchRequired`, and the forced-search
  layer searched the raw sentence → random "Mila Low Boot" + "View All Women's
  Boots". Fixed with a `sizing_help` workflow (no search, no cards), the
  `forcedSearchAllowed` invariant (no forced search without a concrete
  constraint or when the answer is a clarifying question), and a clarification
  card-wipe guard. Sizing on a named/focus product → `named_product_advisory`.
- **Failure B — "show me current sales" gave a support answer.** Planned as
  `browse` and raw-searched → 0 cards + Support Hub CTA. Fixed with a
  `sale_browse` workflow (search `onSale=true` with category/gender/price, never
  the raw sentence), promo-mechanics → `policy_account`, and Support-CTA
  suppression on commerce turns.
- **Comparison ran 3 agent retries + flooded the carousel.** "Which is better,
  Jillian or Savannah?" produced a long answer, retried 3× on length, and showed
  9 cards. Fixed: comparison is now a governed concise workflow (validator caps
  to ≤120 words as a WARNING, deterministic `compactComparison` trim at ship —
  no tool re-search), cards are pinned to one per family (≤4) bypassing the
  scorer, broad/support CTAs suppressed, and stale size/width/sale memory can no
  longer leak into the comparison/condition search.

## Known limitations

1. **LLM phrasing is not unit-tested.** Advisory/sales language quality
   (workflows: browse, comparison, advisory, condition) depends on the live
   model and is only verified by manual PRD testing. The evals guarantee
   *routing, facts, and cards*, not tone.
2. **Availability card display needs cards in the search pool.** When the model
   doesn't surface the family card in its tool results, Availability Truth pins
   whatever it filtered from the pool; if that's empty it falls back to
   text-only (correct answer, no card). The pin guarantees *no extra/wrong*
   cards, not that a card always appears.
3. **denial-recovery / recovery search overlap** the grounding validator and
   answer-workflow forced-search but aren't provably redundant — kept live as
   safety nets (see `docs/legacy-removal-plan.md`, Group 4).
4. **Width truth** is only as good as the variant data: when a family carries no
   Width option, width questions return UNKNOWN with an honest "not a tracked
   option" answer rather than a guess.
5. **Cross-repo drift risk.** The public mirror must be kept in lockstep
   manually; `scripts/audit-legacy-owners.mjs` guards the legacy guards but not
   every file.

## Remaining cleanup candidates

From `docs/legacy-removal-plan.md` — none removed yet:
- **After 2wk clean QA + flag retirement:** legacy dispatcher cascade
  (variant-fact / policy / resolver-no-match / product-turn engine),
  auto-broaden, repeated-clarifier escape.
- **Own scoped change:** PRODUCT_AUTHORITY gates, shadow mode.
- **Keep (conditional):** denial-recovery, recovery search — until tests prove
  the validator/forced-search subsume them.

## Production readiness estimate

**Ready for continued PRD soak / supervised live use.** The deterministic core
(routing, availability truth, factual safety, card ownership) is green at 405/0
and instrumented with the `[turn-invariant]` log + VIOLATION check for live
monitoring. The remaining risk is concentrated in (a) LLM phrasing quality
(monitored manually) and (b) legacy code that is inert on PRD but not yet
deleted (rollback safety). Recommended gate before removing the kill switch:
**2 weeks of PRD logs with zero `[turn-invariant] VIOLATION` lines** and no new
reproduced failures, then proceed with the Group 1–3 removals.

Confidence: **medium-high** for the availability/ownership surface; **medium**
overall pending the LLM-phrasing soak.
