# CODEX Brief — Quick-Reply Answerability (facts-grounded suggestions)

**Branch:** `main`
**Why:** The single most persistent customer-reported failure. The bot suggests
quick-reply buttons ("What width options are available?", "Are the clogs and slides
good for work?") that it then **cannot answer**. Tapping a suggested chip breaks the
chat. This has recurred for a long time because suggestions are generated as free-form
text with no guarantee the system can fulfill them.

## THE PRINCIPLE (same as every round — no phrase lists)

A quick reply is a **pre-canned next customer message**. It is a PROMISE. Like every
other promise in this system, it must be grounded in facts the code can actually
deliver. The bot must never suggest a question it cannot answer.

This is NOT "detect bad chip phrases and remove them." It is: **a suggestion may only
be shown if the system can answer it from available facts.** Code owns "can we answer
this?" (a fact); the LLM owns wording the suggestion nicely.

## THE FIX

There is already `app/lib/chip-filter.server.js` and a "follow-up validator" in the
chat route (it currently drops gender-contradicting chips — e.g. "do you have women's?"
after the customer established men's). **Extend that same validator** — do not build a
new module — so a candidate suggestion is dropped unless its answer can be grounded in
the facts available this turn.

Reuse the variant/attribute facts that Slice 6 just plumbed through (`buildStyleColorFacts`,
`productVariantFacts`, product attributes). A suggestion is answerable only if the data
needed to answer it exists for the products/scope in play:

- "What width options are available?" → keep ONLY if the shown products actually carry
  width data. If width isn't an attribute in the catalog/variants, the bot can't answer
  it — drop it.
- "Are the clogs and slides good for work or casual?" → keep ONLY if there's an
  occasion/use-case attribute to answer from. If not, drop it.
- "Do you have arch-support in sneakers?" → keep if arch-support is a known attribute
  (it is, for Aetrex) AND there are arch-support sneakers in scope.
- A suggestion that would route to a capability the bot doesn't have (order tracking,
  live inventory it can't read, etc.) → drop it.

PREFERRED shape if feasible: generate suggestions FROM the available facts/attributes
(only propose questions about attributes that exist for the in-scope products), so the
set is answerable by construction. Generate-then-validate-against-facts is an acceptable
fallback. Either way: **no hardcoded list of allowed/banned chip phrases.**

## WHAT NOT TO DO

- No regex/phrase list of "good" or "bad" chip text.
- No new module — extend `chip-filter.server.js` / the existing follow-up validator.
- Don't add a guard without deleting any now-redundant chip logic it supersedes.
- Don't touch orthotics structurally (that's the separate Round 2).

## VERIFICATION

```bash
node scripts/eval-response-contract.mjs
node scripts/eval-router.mjs
npm run eval:quality && npm run typecheck && npm run build
# deploy, wait ~90s, then live:
CHAT_TRANSCRIPT_URL=https://www.aetrex.com/apps/hajirai/chat npm run eval:chat-transcripts -- --verbose
```

Add live transcript canaries that TAP suggested chips:
- ask "show me men's sneakers", then tap each suggested quick reply in turn, and assert
  the bot gives a grounded answer to each (no vague non-answer, no "tell me more" loop,
  no deflection). Width/occasion chips must only appear if the bot can answer them.

## DEFINITION OF DONE (report back)

1. The follow-up validator now drops any suggestion not answerable from facts (describe
   the mechanism — confirm it's fact-checked, not phrase-matched).
2. No phrase list was added.
3. chip-filter / validator: net lines (should not balloon; redundant logic removed).
4. All evals + typecheck + build pass counts.
5. Live transcripts still green, plus new chip-tap canaries pass.
6. Confirm: every suggestion the bot can emit is answerable by the bot.

Then the user re-runs the adversarial hunter (now includes chip-masher personas):
**success = `chip-unanswerable` seam = 0, and no new seams introduced.**
