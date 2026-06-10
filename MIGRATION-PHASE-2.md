# Architecture Migration — Phase 2: facts on every card, honesty allowed

Phase 1 shipped the validator + retry orchestrator behind a flag (now
default ON). Phase 2 closes the loop on the two reasons "LLM owns the
turn" failed last time:

1. The model composed from bare cards with no verified facts.
2. The system prompt forbade honest "I don't see that" answers.

## What changed this phase

### 1. Validator pool gathering now reads the real card source

The Phase 1 validator scanned `tool_result` messages for product
pools. That misses cards attached AFTER the agent loop's tool calls
return — by the post-processing layers (resolver-candidates,
group-guards, focused-handle filters, etc.).

Added `gatherPoolFromResult(result)` which reads in priority order:
`result.turnResult.products` → `result.finalProductCards` → message
history. The orchestrator now uses this, so the validator sees the
exact same card set the customer will see.

Live trace 2026-06-10 showed the bug: `cards=0` in the final log
even when the reply had 5 cards. Fixed.

### 2. Validator false-positive on heading bolds

Live trace: a BioRocker compare burned 10s on a wasted retry because
the validator extracted "key" as a product family from `**The key
difference:**`. Heading-style bolds end in punctuation (colon, em/en
dash). Now skipped.

Three new tests in `eval-grounding-validator.mjs` cover:
- `**The key difference:**` (heading, not product)
- `**Quick take —**` (heading, not product)
- `**Phantom Sneaker**` (real product name still flagged when ungrounded)

### 3. Claim-fact contract locked at the tool API boundary

The merchant-configurable claim system (tags, attributes,
description scans, claim-rules) already produces a per-card
`_claimFacts` map with source provenance. It was being attached in
`extractProductCards` but the search_products tool DESCRIPTION
didn't tell the model the contract exists, so the model would mix
description-derived guesses with verified facts.

Updated the `search_products` tool description to make the contract
explicit:

> CLAIM-FACT CONTRACT: every returned product includes `_claimFacts`
> — a merchant-verified, source-tagged map of feature claims (e.g.
> `archSupport: {value: true, source: 'tag'}`). Quote claims ONLY
> when the corresponding `_claimFacts.<feature>.value === true`.
> When `.value === false` or the key is absent, do NOT claim that
> feature.

This is the single source of truth. The validator already checks
`_claimFacts` first when verifying feature claims, so the model and
the validator now agree on what counts as evidence.

### 4. Deleted the lie-or-stay-silent rule (Phase 3 preview)

The biggest single reason "LLM owns the turn" failed previously was
**system-prompt rule 49**:

> NEVER imply the store lacks an item the store actually carries.
> Forbidden phrasings include any variant of 'we don't have', 'we
> don't carry', 'couldn't find', 'no match'…

This rule **forced** the model to invent products when it had no
evidence. It was a "never deny" gun pointed at the model's foot.

Replaced with:

> HONESTY IS ALLOWED — DO NOT INVENT TO AVOID SAYING NO. If you
> genuinely don't have evidence in this turn's tool results / RAG /
> customer-context that something exists, say so honestly. 'I'm not
> certain we carry that' / 'I don't see that' / 'I can't confirm
> which has X' is a CORRECT answer, never a failure. Inventing a
> product, feature, or claim to avoid saying 'no' is the worst
> possible answer. CALIBRATION: before denying, exhaust your
> searches… But once you've actually searched and have nothing, 'we
> don't carry that' is the truthful answer — pair it with the
> closest alternative you DID find.

This single edit removes half the confabulation pressure. The
calibration clause prevents the opposite failure mode (giving up
after one weak search).

## What did NOT change (intentionally)

- **RAG content holes** (BioRocker / UltraSky have 0 knowledge
  chunks). This is a CONTENT task — the merchant needs to upload
  knowledge files via the admin panel at `/app/catalog`. No
  architecture rescues missing data. Action: write a Brand &
  Technology knowledge file covering BioRocker, UltraSKY, Aetrex
  Orthotic System, Memory Foam Footbed, Lynco, and the major
  materials, and upload it through the admin UI.

- **The dispatcher cascade**. Still in place as a fallback (it's
  skipped when the LLM-owns flag is on). Phase 4 will delete it
  once we have weeks of clean production data.

- **The ~50 post-processors inside `runAgenticLoop`**. They still
  run inside the loop. They produce the final `turnResult.products`
  the validator now reads, so the loop's outputs are clean. Phase 4
  removes the ones that fight the model (named-product mismatch
  guard, response-contract verifier inside the loop). The cleanup
  pipeline (header breaks, dedupe) stays — those don't fight the
  model, they format its output.

## How to test

| What | How |
|---|---|
| Honesty allowed | Ask `do you have leather sandals with cork heel and lapis lazuli insole?` — model should now say it can't confirm rather than invent |
| Validator pool fix | Any product turn — final log should show `cards=N` matching the rendered count |
| Heading-bold false positive | Ask `compare two of your sandals` — answer shouldn't trigger a retry just for using a heading like `**Bottom line:**` |
| Claim-fact respect | Ask `which of your boots has memory foam?` — model should only name boots whose `_claimFacts.memoryFoam.value === true` |

## What's next

- **Phase 3** (later session): full prompt diet, 78K → ~10K chars.
  Delete the 30 micro-rules that fight specific past failures. Keep
  the five honesty rules that matter. The tests carry the regression
  protection now.
- **Phase 4** (after weeks of clean production): delete the
  dispatcher cascade and the in-loop mutators that conflict with
  the model. ~15K lines of routing/guarding code goes away.
- **Content task** (anytime): merchant uploads the Brand & Tech
  knowledge file so RAG actually returns chunks for BioRocker /
  UltraSky / etc.
