# Adversarial Chat Hunter — Findings & Fix Plan

**Date:** 2026-05-23
**Source:** `scripts/adversarial-chat-hunter.mjs` — 40 multi-turn adversarial conversations against the live `/chat` endpoint (Aetrex production), judged turn-by-turn by structural detectors + an LLM judge.
**Raw data:** `reports/broken-convos.json` (39 real broken conversations, each turn tagged by seam)
**Result:** 39/40 conversations contained at least one real bug. ~177 individual bug instances that collapse to **4 root-cause seams**.

This document is a handoff for the next consolidation slice. It is written to stand alone — no prior conversation context required.

---

## How to reproduce

```bash
CHAT_TRANSCRIPT_BASE_URL=https://hajirai-app-production.up.railway.app \
SHOPIFY_API_SECRET=<app secret> \
ANTHROPIC_API_KEY=<key> \
  node scripts/adversarial-chat-hunter.mjs --convos=40
```

Defaults: concurrency=1, 1.5s inter-turn delay, auto-retry on HTTP 429 (the `/chat` route limits ~20 req/min per IP+shop — keep concurrency at 1). Outputs `reports/broken-convos.json` and `reports/cluster-report.md`.

---

## Methodology caveat — read before trusting counts

One detector seam, **`false-denial-with-pool`, is a FALSE POSITIVE** and should be ignored. It fires when bot text contains "we don't have / out of stock" while products are present, but in every flagged case the bot was behaving **correctly**:

- *"Our closest matches to red are Wine, Burgundy, Terracotta… we don't have a true red, but these three are closest."* — correct, honest, helpful.
- *"size 7 out of stock for X, in stock for Y"* — correct per-item status.
- *"size 11 is out of stock, here's a back-in-stock alert"* — correct.

The detector in `scripts/adversarial-chat-hunter.mjs` (`structuralBugs`, `DENIAL_RE` branch) needs to exclude per-item / partial-availability phrasing before any larger run. **Do not "fix" the chatbot for these — there is no bug here.**

Everything below is a confirmed real bug.

---

## The 4 real seams (priority order)

### SEAM 1 — Gender-gate deadlock  ⭐ HIGHEST IMPACT (≈108 of 177 instances, 60%)

**Owner:** `app/lib/orthotic-flow-gate.server.js` (the hard gender-before-category gate, introduced in commit `6f9e26c fix(orthotic): hard-gate gender-before-category on footwear path`)

**Symptom:** The footwear path requires a gender before it will show any products. There is no escape hatch. When a customer won't or can't pick a gender, the bot loops the same "men's or women's?" question indefinitely.

**Live transcript:**
```
customer: hi i need new shoes
bot:      Which styles would you like to browse — men's or women's?  <<Men's>><<Women's>>
customer: um i'm not sure, what do you have that's cheap?
bot:      No worries! Which styles would you like to browse — men's or women's?  <<Men's>><<Women's>>
customer: i dont really know tbh... what do you have
bot:      Got it — our catalog is organized by men's and women's styles. Which would you like to browse first?  <<Men's>><<Women's>>
```

Fires across personas: `confused-first-timer`, `single-word`, `ambiguous-pronoun`, `gift-shopper-pivot`, `ambiguous-category`.

**Fix (as a consolidation rule, not a phrase patch):**
The gender gate must be a *soft preference*, not a *hard wall*. Add an escape condition in the gate:
- If the customer signals open browsing ("everything", "anything", "I don't know", "just show me", "what do you have", "cheap", "bestsellers") **OR** the gender question has already been asked ≥2× without an answer →
- Stop asking. Show a mixed-gender / bestseller / unisex product pool, OR present both genders' top items. Let the customer narrow from products instead of being blocked before products.

The invariant: **a customer can always reach products.** Gender refines the pool; it must never be a prerequisite for seeing any pool.

---

### SEAM 2 — Turn-assembly atomicity (≈28 instances)

**Owner:** `app/lib/response-contract.server.js` (the turn-assembly consolidation already in progress)

**Symptom:** A single bot message contains BOTH a clarifying question AND its own answer, or the prose contradicts the cards.

**Live transcripts:**
```
customer: how about mens?
bot:      What type of men's footwear are you looking for? <<Sandals>><<Sneakers>><<Clogs>><<Accessories>>
          Here are the two men's black sandals — a flip and a slide, both on sale...
```
(Asks what type, then answers sandals in the same breath — a clarify-path and an answer-path both emitted.)

```
customer: any of these come in pink?
bot:      Here are the pink women's sneakers — Danika, Xspress Runner 2, Kinsley... plus the Emily Lace-Up in a soft peach tone!
```
(Calls peach "pink"; shows an Erica Casual Sneaker that the text never mentions — text/card mismatch.)

```
customer: what about size 10? do all of these come in 10?
bot:      Great news — here's the size 10 breakdown for each style.
```
(Promises a size breakdown, then shows only names/colors with no size info.)

**Fix:** The turn result must be exactly one mode: *ask-clarification* OR *show-answer*, never both. The response contract should reject a turn that emits clarifying chips alongside product cards for the same scope. Prose claims (colors named, "size breakdown", "pink") must be validated against the actual card set before emit — text may only assert what the cards support.

---

### SEAM 3 — Scope loss: referent, width, and pivot fidelity (≈24 instances)

**Owner:** `app/lib/session-memory.server.js` (carryover/pivot rules) + `app/lib/catalog-resolver.server.js` (constraint application)

**Symptoms & transcripts:**

*Referent not resolved:*
```
customer: show me all the colors you have in that style
bot:      Take a look — these are the closest matches I've got.   [shows multiple DIFFERENT styles]
```
"that style" must resolve to the specific product from prior turns, then return its color variants — not re-run an open search.

*Width inverted / dropped:*
```
customer: do you have 11 narrow?
bot:      ...here are women's sneakers tagged for narrow feet worth a look!   [shows wide-friendly sneakers]
```
Width constraint must filter, not invert.

*Gender pivot abandons context without confirmation:*
```
customer: wait do you have men's sneakers too?   [was shopping women's running shoes]
bot:      Absolutely! Here are our men's arch support sneakers...   [fully drops women's context]
```
A "too / also" pivot should preserve the prior scope as a branch, not silently replace it.

**Fix:** Scope owner (`session-memory`) must carry the active product referent so "that style / these / the second one" resolve deterministically. Constraint application in `catalog-resolver` must treat width/size/color as hard filters (never relax into the opposite). Pivots phrased additively ("too", "also", "as well") preserve prior scope.

---

### SEAM 4 — Compound-question handling (≈17 instances)

**Owner:** `app/lib/chat-prompt.server.js` (response contract) + agentic loop

**Symptom:** When one message contains two asks, the bot answers one and silently drops the other.

**Live transcripts:**
```
customer: ok cool what about your return policy? and do you have any brown sneakers for men?
bot:      Our return policy: 30-day returns... $5.95 return fee...   [no brown men's sneakers shown]

customer: yeah that loyalty thing sounds good, do i need to sign up before i order or can i add it after? and yeah show me some sneakers in brown
bot:      Tell me a bit more — color, style, or what you're using them for...   [ignored both the loyalty timing question AND the already-specified "brown"]
```

Fires on `policy-mixed-shopper` especially.

**Fix:** The prompt contract must require the bot to address every distinct ask in a message (policy + product, loyalty + product). A turn that answers only one clause of a compound question is incomplete. This is a grounding/contract rule, not a new module.

---

## How these map to the consolidation effort

These are not 177 phrase patches. They are 4 seams, each owned by a module that is already part of the consolidation:

| Seam | Owner module | Already a consolidation target? |
|---|---|---|
| 1. Gender-gate deadlock | `orthotic-flow-gate.server.js` | Orthotic subsystem (separate strangler) |
| 2. Turn-assembly atomicity | `response-contract.server.js` | ✅ Yes — CODEX's current slice |
| 3. Scope loss | `session-memory.server.js` + `catalog-resolver.server.js` | Input-side consolidation (next) |
| 4. Compound questions | `chat-prompt.server.js` | Prompt contract |

**Recommended order:** Seam 1 first (60% of bugs, hurts real customers now, and the orthotic-gate is touchable without disturbing the response-contract slice). Then Seam 2 (lands inside the slice already in flight). Then 3 and 4.

**Verification loop:** after each fix, rerun the hunter (`--convos=40`) and confirm the seam's instance count drops. The 39 conversations in `reports/broken-convos.json` are a ready-made regression set — they can be converted into permanent cases in `scripts/chat-transcripts.aetrex.json`.

**The invariant to hold across all four:** code decides facts (can the customer reach products? what's in scope? what do the cards contain? how many asks were made?), AI decides only wording. Every one of these bugs is a place where that line blurred.
