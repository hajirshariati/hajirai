# CODEX Brief — Shopping-Path Consolidation (Round 1 of 2 to go-live)

**Branch to work on:** `main`
**Author of brief:** verified against `main` @ commit `cab2249`, chat.jsx = 3,365 lines.
**Measured starting point (live adversarial hunter, 40 convos):** 89 real bugs, 20/40 convos clean.
**Goal of this round:** drive real bugs from ~89 → ~40, clean convos from 50% → ~75-80%, AND reduce `chat.jsx` size. Get the SHOPPING path to go-live quality. (Orthotics is Round 2, do NOT start it here.)

---

## THE ONE NON-NEGOTIABLE RULE

**Delete as you add. Every slice's net line count must be ≤ 0 in `chat.jsx`.**

The last session added +388 lines to `chat.jsx` (2,977 → 3,365) by stacking 4 separate card-hydration guards and ~11 text-strip passes. That guard-stacking halved bugs but spawned new ones (truncated sentences). This round REVERSES that pattern. If a slice is `+N / -0`, it is wrong — stop and rethink. Target: `chat.jsx` back under 3,000 lines by the end.

Principle (unchanged from the whole project): **code decides facts, AI decides only wording.** Every remaining bug is a place where that line blurred — either code let the AI invent a fact, or code mangled the AI's words after the fact.

---

## SLICE 1 — Collapse the 4 card-hydration sites into ONE owner

**Problem:** `chat.jsx` now hydrates product cards in 4 different places, each a band-aid for "text presents products but zero cards emitted":
- line ~1046 — resolver-recovery hydration
- line ~1097 — empty-pool-before-display hydration
- line ~1133 — display-filter-wiped-to-zero re-hydration
- line ~1817 — final pre-emit hydration

Plus two helper functions `hydrateScopedProductCards` and `hydrateResolverCandidateCards`.

**Fix:** Create ONE function — `ensureProductTurnCards({ ctx, allProductPool })` — in `app/lib/response-contract.server.js` (the response owner). It encapsulates the full fallback ladder ONCE, in priority order:
1. scoped search (gender+category+color)
2. if empty, relax color (keep gender+category)
3. if still empty, hydrate from resolver candidate handles
4. return the final pool + a diagnostic of which rung fired

Call it from `chat.jsx` at exactly ONE point in the turn lifecycle (right before the text/card coherence checks). **Delete the other 3 call sites and the inline ladders.** The route should read: "if this is a product-presenting turn and the pool is empty, call `ensureProductTurnCards` once."

**Verify:** `chat.jsx` shrinks by ~150+ lines. `grep -c "hydrate" app/routes/chat.jsx` drops from ~14 to ~2.

---

## SLICE 2 — Prose generated FROM the final card set (kills `contradicts-self`, 19 bugs)

**Problem:** The LLM free-writes claims that the rendered cards then contradict:
- *"Here are four pink women's sneakers"* → 5 cards render, one is Peach (not pink).
- *"Eggplant is the closest match to purple"* → eggplant IS purple; it should be presented as a purple match, not a compromise.
- *"Here's the size 10 breakdown for each style"* → no size info shown.

**Fix:** After the final card set is locked (post Slice-1 hydration + scope filter), the product-presenting sentence must be reconciled against the ACTUAL cards before emit:
- **Counts:** if the text says a number ("four pink"), it must equal the rendered card count, or the number is stripped/corrected to match.
- **Colors named:** any color the text asserts ("pink") must be present in the rendered cards' color attributes; if a card's color isn't what the text claims, either the card is out of scope (drop it) or the text claim is softened.
- **Promised breakdowns:** if the text promises per-item data ("size 10 breakdown", "stock status"), and that data isn't in the payload, the promise sentence is removed.

Do this as ONE reconciliation function in `response-contract.server.js` (e.g. `reconcileProseToCards({ text, cards })`) — not scattered. This REPLACES some of the existing ad-hoc strips, so net lines should be flat or negative.

**Verify:** the `color-iteration` hunter persona stops producing "four pink → five cards" mismatches.

---

## SLICE 3 — Fix text-strip truncation (REGRESSION, `confusing` seam)

**Problem:** `chat.jsx` runs ~11 sequential regex strip passes (`stripBannedNarration`, `stripMetaNarration`, `dedupeConsecutiveSentences`, `stripLineupPromiseSentences`, `stripFillerIntensifiers`, `stripMissingSkus`, `stripRejectedCategoryChips`, `stripToolCallSyntax`, `stripStockClaim`, `stripInternalLeaks`, `repairProductTurnAssembly`). Chained, they leave dangling fragments:
- *"None of these offer wide width, so the width options are."* ← cuts off
- *"…but here are a couple of ways to save."* ← then lists nothing

**Fix (two parts):**
1. **Immediate:** after the entire strip chain runs, add ONE final coherence guard: if the result ends mid-sentence (dangling connector like "so/but/and/are" + period, or trailing colon with no list), trim back to the last complete sentence. If that empties the text, fall back to a clean canned line appropriate to the turn (product turn → "Here are some options that fit." / clarifying turn → the question).
2. **Structural (preferred if time allows):** the reason 11 strips exist is the prompt lets the LLM say things it shouldn't. Move 2-3 of the most-fired strips' intent INTO `chat-prompt.server.js` as explicit "never say X" rules, then DELETE those strip passes. Each deleted strip = fewer truncation chances + fewer lines. This is the real consolidation; the strips are the "code writes sentences" anti-pattern.

**Verify:** no hunter response ends mid-sentence; `confusing` seam → 0.

---

## SLICE 4 — Stop re-asking the same clarifying question (`repetitive`, 45 bugs, still #1)

**Problem:** When the customer's reply doesn't cleanly answer a clarifying question, the bot asks the IDENTICAL question again:
- "hi i need new shoes" → "men's, women's, or kids'?" → [customer dodges] → "men's, women's, or kids'?" again
- asks budget twice in a row

The hard gender deadlock is already softened (good — that's why this dropped from 108→45). The remaining issue is the re-ask loop on ambiguous answers.

**Fix:** Track the last clarifying question asked in session memory (`session-memory.server.js`). Before emitting a clarifying question, check: did we just ask this exact question type last turn? If yes:
- do NOT re-ask. Either (a) advance with a sensible default and SHOW products (the soft-gate behavior), or (b) acknowledge the customer's actual words and offer a different next step.
- A clarifying question may never be emitted twice in a row for the same slot.

**Verify:** `confused-first-timer`, `single-word`, `gift-shopper-pivot` personas stop looping; `repetitive` drops to <15.

---

## SLICE 5 — Ground product feature claims (`hallucinated-fact`, low volume)

**Problem:** *"both sandals have Aetrex arch support"* when only one was established.

**Fix:** Product feature claims (arch support, waterproof, cushioning) in prose must come from the card/catalog data, not the model's memory. If the attribute isn't in the card data, the claim is removed or softened to "designed for comfort." Small rule, add to the `reconcileProseToCards` from Slice 2.

---

## WHAT NOT TO DO THIS ROUND

- Do NOT touch the orthotics subsystem (`orthotic-flow.server.js`, `orthotic-flow-gate.server.js`) beyond the gender-gate that's already fixed. That's Round 2.
- Do NOT add a new standalone module/"backbone." All fixes land in existing owners: `response-contract.server.js` (assembly/reconciliation), `session-memory.server.js` (re-ask tracking), `chat-prompt.server.js` (prompt rules).
- Do NOT add a guard without deleting the code it supersedes.

---

## VERIFICATION (run ALL before declaring done)

```bash
# 1. Local unit + contract suites must stay green
npm run eval:quality
npm run eval:intent
npm run eval:memory
node scripts/eval-response-contract.mjs
node scripts/eval-router.mjs
node scripts/eval-orthotic-gate.mjs
npm run typecheck
npm run build

# 2. Commit + push, wait for Railway deploy (~90s)

# 3. Live transcript suite — must stay 14/14 (no regression on fixed seams)
CHAT_TRANSCRIPT_URL=https://www.aetrex.com/apps/hajirai/chat npm run eval:chat-transcripts -- --verbose

# 4. Line-count discipline check — chat.jsx MUST be smaller than 3365
wc -l app/routes/chat.jsx
grep -c "hydrate" app/routes/chat.jsx   # should be ~2, not ~14
```

## DEFINITION OF DONE (send this block to the user to relay for double-check)

Report back with ALL of:
1. `chat.jsx` line count before/after (must be DOWN from 3,365; target <3,000)
2. `grep -c "hydrate" app/routes/chat.jsx` result (should be ~2)
3. Number of text-strip passes before/after (should be fewer)
4. All local evals + typecheck + build: pass counts
5. Live transcript suite result (must be 14/14)
6. Confirmation that each slice DELETED the code it replaced (paste the net +/- per slice)

Then the user re-runs the adversarial hunter (`node scripts/adversarial-chat-hunter.mjs --convos=40`) and shares `reports/cluster-report.md`. **Success = real bug count drops from ~89 toward ~40 AND no new seams appear** (specifically: `confusing` and `hallucinated-fact` should be 0, and no brand-new seam types). If new seams appear, the guard-stacking pattern is repeating — stop and consolidate instead.
