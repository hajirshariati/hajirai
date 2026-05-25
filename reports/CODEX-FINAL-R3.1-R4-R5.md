# CODEX Handoff — R3.1, R4, R5 (sequential, each gated by the hunter)

Branch: `main`. Do these IN ORDER. After each, deploy, then the owner runs the frozen
adversarial hunter (`node scripts/adversarial-chat-hunter.mjs --convos=40`) and checks
the gate before the next round. Rules every round: code owns facts, LLM owns wording,
NO phrase lists for intent, delete-as-you-add (don't grow files), don't scope-creep.

Current measured state (frozen hunter, deployed `d3b5702`):
repetitive 71 · scope-loss 54 · ignores-user 41 · contradicts-self 13 · others ≤2.

---

## R3.1 — make the code-owned listing line truthful + answer compound turns

R3 (code-owned listing line) dropped contradicts-self 38→13 but regressed scope-loss
(32→54) and ignores-user (18→41). Both are side effects of the code-owned line. Fix
without reverting R3 and without returning product facts to the LLM.

### Bug 1 — the line names the REQUESTED color even when cards aren't that color
Exact code: `app/lib/response-contract.server.js`
- `buildCodeOwnedProductListingText` (~line 934) decides the line.
- `exactRequestedColorMatches` (~line 925) uses `cardColors(card).has(color)` where
  `cardColors` (~716) / `normalizeKnownTextColor` (~841) fold family colors together.
  So burgundy/terracotta/wine count as "red" → line says "Here are the red sneakers"
  over a non-red pool. Hunter saw exactly this ("any in red?" → "red sneakers" but cards
  are terracotta/burgundy). Inverse also seen: "black sandals?" → "couldn't find black"
  when black was in the pool.

Fix:
- Name the requested color in the line ONLY when the cards' actual color NAMES match it
  (exact named-color match, not family/semantic). If the cards are a related-but-different
  named color, use honest "closest/similar" wording: "I couldn't find an exact red, but
  here are women's sneakers in similar warm tones." Never assert a color the cards don't
  literally have.
- Derive the no-match / relaxed wording from the ACTUAL returned pool, never from the
  requested filter. Never say "couldn't find X" when X is present in the shown cards.
- General rule: every attribute the line states (color, gender, category) must be
  verified true of (essentially) all shown cards; if not, drop or soften it. The line is
  code-owned, so code must check it against the cards it is about to render.

### Bug 2 — compound turns drop the non-product clause
Exact code: `app/routes/chat.jsx`
- `isCompoundPolicyProductQuestion` (~line 294) gates compound handling; at ~line
  1459-1461 the route appends `compoundPolicyFallbackText(...)` to the listing line.
- Hunter shows it still drops the non-product half: "discount codes? also sneakers" →
  just shows sneakers; "return policy and these in brown?" → policy only. So either the
  detector misses discount/loyalty/shipping phrasings, or the appended fallback text
  defers ("tell me more") instead of answering.

Fix:
- `isCompoundPolicyProductQuestion` must catch the non-product clause generally —
  discount/promo codes, loyalty, shipping, returns, general questions — not just the
  word "policy". Detect "product ask + non-product ask" structurally.
- The non-product clause must be actually ANSWERED from the existing policy/knowledge
  path (the same source a pure policy turn uses), not a generic deferral. Compose:
  answer the non-product clause, then the code-owned product line. Neither half vanishes.
- Keep the product line code-owned; only the non-product clause uses the policy/LLM path.

GATE R3.1: scope-loss < 20, ignores-user < 20, contradicts-self ≤ 13, no new seams.

---

## R4 — repetition (biggest seam, 71)

Symptom: the bot re-asks the SAME clarifying question verbatim across turns when the
customer doesn't cleanly answer. Top example, every run:
"hi i need new shoes" → "men's, women's, or kids'?" → [customer dodges] → same question
again, and again. Round 1 added "repeated clarifier memory" but it is NOT firing here.
Also: tapping a quick-reply chip that re-asks the same thing drives the loop.

Fix (code state, not phrase matching):
- Track the last clarifying question asked, by SLOT (gender / category / budget / etc.)
  in session memory. A clarifier for a given slot may NEVER be emitted twice in a row.
- On the 2nd attempt at the same slot without a usable answer, STOP asking: fall through
  to the soft-gender/broad browse (show products) or advance with a sensible default.
  The customer must always be able to reach products; a clarifier is a preference, never
  a gate that can repeat.
- Applies whether the repeat is triggered by free text OR by a chip tap.
- Find where clarifying questions are emitted (orthotic-flow-gate.server.js soft-gender
  path + the footwear clarifier path + chip handling) and route them through one
  "have I already asked this slot?" check. One owner, not per-call-site patches.

Do NOT touch contradicts-self/scope-loss work from R3.1 or orthotic internals here.

GATE R4: repetitive < 15, no regression in scope-loss/ignores-user/contradicts-self.

---

## R5 — orthotics hardening (the untested 2,577-line subsystem)

Scope: `orthotic-flow.server.js`, `orthotic-flow-gate.server.js`,
`orthotic-classifier.server.js`, decision-tree resolver, orthotic recommendation text.
Principle holds: the decision tree is code-owned FACTS (fine); the LLM owns interpreting
free-text answers into tree options (by understanding, NOT regex) and friendly wording.

Fix/verify these risk areas:
1. Enum leaks: internal tokens (overpronation_flat_feet, comfort_walking_everyday,
   q_arch, etc.) must NEVER reach customer text/chips. ONE enum→friendly-label mapping
   (facts) + one enforcement point that blocks any unmapped internal token before emit.
2. Free-text answers: a customer answering a tree question in their own words ("pretty
   high arches", "on my feet all day") must be mapped to the tree option by handing the
   LLM the structured options + the message. NO regex answer-list.
3. Flow coherence: each answered question reduces remaining questions and reaches a
   recommendation; never re-ask an answered question (reuse R4's slot memory); no loops.
4. Memory separation: shopping scope (color/category) and orthotic flow state are
   separate namespaces — neither contaminates the other on entry/exit/mid-flow jumps.
5. Recommendation text: resolved by code (fact); the explanation is LLM-worded from the
   resolved product's real attributes, enum-free, no unverified feature claims.
6. Mid-flow exits: customer jumps to a product question and back → product question
   answered, then orthotic flow resumes where it was (not restarted, not lost).

Extend the hunter: add 4-5 orthotic personas to `scripts/adversarial-chat-hunter.mjs`
(deep free-text condition flow; uncovered condition → honest no-match; mid-flow jump to
shopping and back; vague/uncertain answers; condition changed mid-flow). Run them.

GATE R5: enum leaks = 0, no orthotic loops, no shopping/orthotic memory contamination,
recommendations grounded; shopping-path gates from R3.1/R4 still hold.

---

## Verification (run after EACH round, before its gate)
```
node scripts/eval-response-contract.mjs
node scripts/eval-router.mjs
node scripts/eval-orthotic-gate.mjs
node scripts/eval-orthotic-regressions.mjs
npm run eval:quality && npm run eval:intent && npm run eval:memory
npm run typecheck && npm run build
# deploy, wait ~90s:
CHAT_TRANSCRIPT_URL=https://www.aetrex.com/apps/hajirai/chat npm run eval:chat-transcripts -- --verbose
```
Then owner runs the frozen hunter (40 convos) and checks that round's gate.

Done = all three gates green AND, before launch, the bot never states an unverified fact
(fail-safe) with production conversation logging in place to watch the real-traffic
number.
