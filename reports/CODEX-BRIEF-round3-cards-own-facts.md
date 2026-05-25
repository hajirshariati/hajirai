# CODEX Brief — Round 3 (STRUCTURAL): Cards own facts, product text is flavor

**Branch:** `main`
**Why:** After Round 1 + Slice 6, the independent adversarial hunter shows
`contradicts-self` at 38 and `scope-loss` at 32 — at or above the pre-fix baseline.
The reconcile-after-the-fact approach is not generalizing: it fixes the canary shapes
("four pink") but misses sibling shapes ("all 6 styles in size 8", color enumerations,
"both come in"). `response-contract.server.js` is now 1,287 lines / 58 functions and
the bug class it owns went UP. We are not patching reconciliation again. We are
removing the root cause.

**Root cause:** the LLM is still the source of *checkable facts* in product-listing
text (counts, sizes, prices, color lists, "all/both/every"), and code tries to verify
them after the fact. The set of false-claim shapes is unbounded, so verification can't
keep up.

## THE STRUCTURAL RULE

**On a product-LISTING turn, the cards own the facts. The summary text describes only
(a) the scope that was applied and (b) grounded product features. It must not count,
enumerate, or claim per-item attributes of the result set.**

The product cards already DISPLAY count, price, color, and sizes. So the text must stop
restating them. This shrinks the LLM's "can be wrong" surface to almost nothing.

ALLOWED in product-listing text:
- the applied scope — true by construction because code applied the filter:
  "Here are women's black sandals…" (gender/category/color the search used)
- grounded features (Slice 5/6): "…with built-in arch support."

FORBIDDEN in product-listing text:
- counts: "6 styles", "three options", any numeral/number-word used as a result count
- size/stock claims: "all available in size 8", "size 10 across the board"
- prices in prose: "$159.95" (the card shows price)
- color enumerations of the result set: "in yellow, blue, tan, white, red, black"
- universal quantifiers about the set: "all of these", "both", "every one of these"

## IMPORTANT — do NOT break the fact-ANSWER path

When the customer asks a DIRECT attribute question ("what colors does Chase come in?",
"what sizes?", "is it waterproof?"), the text SHOULD answer with the grounded facts
from variant data — that's Slice 6 and it must keep working. The no-checkable-facts
rule applies to the product-LISTING summary, not to a direct attribute answer. The code
already knows which it is (is the customer asking an attribute question, or just being
shown a result set). Carry that distinction; don't collapse the two.

## IMPLEMENTATION (two levers, and a DELETION)

1. **Prompt (`chat-prompt.server.js`) — primary lever.** Rewrite the product-response
   guidance: when products are shown as a result set, your text is ONE short flavor/
   benefit line describing the applied scope + features. Do NOT state how many, do NOT
   list colors, do NOT claim sizes/prices, do NOT say "all/both/every of these." The
   cards show all of that. This alone removes most of the checkable surface.

2. **Backstop (`response-contract.server.js`) — a single checkable-fact stripper for
   listing turns.** A category detector (NOT a phrase list) that, on a product-listing
   turn, strips leaked checkable claims: result counts, size/stock claims, prose prices,
   result-set color enumerations, universal set-quantifiers. If stripping empties the
   line, fall back to one neutral grounded flavor sentence.

3. **DELETE the now-redundant reconcile functions.** The point of moving facts to the
   cards is that you no longer need to *reconstruct* truth in prose. Remove the
   count-reconciliation / color-range-promise / generic-intro-rewrite functions that
   existed to fix facts the LLM should no longer be writing. **`response-contract.server.js`
   must SHRINK this round, not grow.** If it grows, the structural change wasn't made —
   you just added another layer.

## WHAT THIS TARGETS (set expectations honestly)

- Primarily kills `contradicts-self` (the fact-in-text class).
- Helps `scope-loss` cases that are really count mismatches ("six styles, shows five").
- Does NOT by itself fix `repetitive` (re-ask loops / chip-driven repetition) or the
  `scope-loss` cases where the SEARCH returned the wrong set ("asked for everything,
  showed only boots"). Those are separate; leave them for a focused follow-up. Do not
  scope-creep this round.

## VERIFICATION

```bash
node scripts/eval-response-contract.mjs
node scripts/eval-router.mjs
npm run eval:quality && npm run typecheck && npm run build
# deploy, wait ~90s:
CHAT_TRANSCRIPT_URL=https://www.aetrex.com/apps/hajirai/chat npm run eval:chat-transcripts -- --verbose
wc -l app/lib/response-contract.server.js   # MUST be smaller than 1287
```

Add/keep canaries: a product-listing answer must not contain a count, a size claim, a
price, a color enumeration, or "all/both/every"; AND a direct "what colors/sizes does X
come in" answer must STILL list them (Slice 6 intact).

## DEFINITION OF DONE (report back)

1. `response-contract.server.js` line count before/after — MUST be smaller (you deleted
   reconcile functions, you didn't add a layer).
2. Which reconcile functions you deleted.
3. The prompt now forbids checkable facts in listing text (quote the rule you added).
4. The fact-answer path (what colors/sizes) confirmed still working.
5. All evals + typecheck + build pass counts; live transcripts green.

Then the user re-runs the (now frozen) adversarial hunter.
**Success = `contradicts-self` drops sharply (target < 10, from 38), no new seams,
and response-contract is smaller.** If contradicts-self doesn't drop, the prompt isn't
actually constraining the LLM — fix that before adding any stripper logic.
