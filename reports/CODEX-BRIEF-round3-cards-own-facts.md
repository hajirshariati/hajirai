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

## THE STRUCTURAL RULE (stricter version — code OWNS the listing line)

**On a product-LISTING turn, CODE generates the summary line deterministically. The LLM
does not write it.** Do not "prompt the LLM to be careful and strip after" — that still
lets infinite claim shapes leak. Once the cards are selected, code emits a simple line
and the cards carry every fact (titles, colors, prices, sizes, count).

The deterministic line states ONLY the actual returned scope. It must NOT include feature
claims unless code verified them across all shown cards — even "these all have arch
support" is a checkable universal claim and is NOT allowed unless verified. Safest default:

  "Here are the women's black sandals I found."
  "Here are the women's black sandals I found. Tap any style to see details."

CRITICAL — the line must reflect what was ACTUALLY returned, including relaxations.
Code knows when a filter was relaxed (e.g. "brown" found nothing → relaxed color). The
line must not claim the requested scope when the pool doesn't match it:
  requested brown, relaxed to any color → "I couldn't find brown, but here are men's
  sneakers in other colors." NOT "Here are the brown sneakers I found."

ANTI-ROBOTIC (still deterministic): code may rotate a small set of FACT-FREE opener
templates ("Here are the…", "Found these for you —", "Here's what I've got in…") so it
isn't identical every turn. Variety comes from code-owned templates, never from LLM text.

FORBIDDEN anywhere in the listing line (because they're checkable and the cards show them):
- counts: "6 styles", "three options"
- size/stock claims: "all available in size 8"
- prices in prose: "$159.95"
- color enumerations of the result set: "in yellow, blue, tan, white, red, black"
- universal feature/quantifier claims: "all of these", "both", "every one has arch support"

## IMPORTANT — do NOT break the fact-ANSWER path

When the customer asks a DIRECT attribute question ("what colors does Chase come in?",
"what sizes?", "is it waterproof?"), the text SHOULD answer with the grounded facts
from variant data — that's Slice 6 and it must keep working. The no-checkable-facts
rule applies to the product-LISTING summary, not to a direct attribute answer. The code
already knows which it is (is the customer asking an attribute question, or just being
shown a result set). Carry that distinction; don't collapse the two.

## IMPLEMENTATION (code owns the line; guards shrink to leak-catching)

1. **Code-generated listing line (primary change).** On a product-listing turn, after
   the final card set is locked, CODE emits the summary line from the actual returned
   scope + relaxation state (see rule above). The LLM's free-written product intro is
   REPLACED by this deterministic line on listing turns. This is the core of the round —
   not a prompt tweak.

2. **Keep the fact-ANSWER path for the LLM.** Non-listing turns (clarification,
   comparison, advice) and direct attribute questions ("what colors/sizes does X come
   in?") still use LLM text, answered ONLY from supplied/grounded facts (Slice 6). Do
   NOT make those deterministic — that's where the LLM's value is.

3. **Shrink the guards to leak-catching, don't delete Slice 6.** The reconcile functions
   that existed to REPAIR free-form sales copy (count reconciliation, color-range
   promise, generic-intro rewrite) are now redundant for listing turns — remove/shrink
   them. Their remaining job is "catch a stray leak," not "reconstruct truth." KEEP the
   Slice 6 variant/sibling-color fact supply — it's needed for the fact-answer path.
   **`response-contract.server.js` must SHRINK from 1287 lines.** If it grows, the
   change wasn't made.

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
