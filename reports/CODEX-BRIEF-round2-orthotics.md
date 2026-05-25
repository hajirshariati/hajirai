# CODEX Brief — Round 2: Orthotics Hardening (final structural round before go-live)

**Prerequisite:** Do NOT start until the adversarial hunter confirms Round 1 held
(real bugs trending toward ~40, no new seams). If that gate hasn't passed, stop.

**Branch:** `main`
**Scope:** the orthotic subsystem only — `orthotic-flow.server.js`,
`orthotic-flow-gate.server.js`, `orthotic-classifier.server.js`, the decision-tree
resolver, and the orthotic recommendation text path. Leave the shopping path alone
(it's consolidated; don't regress it).

---

## THE GUIDING PRINCIPLE (same as Round 1 — read first)

**Code owns facts. The LLM owns understanding and wording. Never hardcode intent phrases.**

For orthotics specifically:
- The decision tree (condition → use case → arch → recommended orthotic) is FACTS +
  structure. Code legitimately owns it. That is not "hardcoding intent" — it's a
  catalog/recommender truth table.
- The LLM owns: (a) interpreting a customer's free-text answer into the tree's options
  ("my arches are kinda flat" → low arch) by UNDERSTANDING, not regex; (b) wording the
  questions and the final recommendation in friendly, enum-free language.
- If you find yourself adding a regex of answer-phrases, stop — that means the tree
  options aren't being given to the LLM to map against. Give the model the structured
  options + the customer's words and let it choose.

**Delete as you add.** Net lines in the orthotic files should not balloon. If a fix is
+N/-0, rethink.

---

## KNOWN RISK AREAS (verify each with the hunter + manual probes; fix only what's real)

### R1 — Internal enum leaks to the customer
Symptom seen earlier: raw tokens like `overpronation_flat_feet`,
`comfort_walking_everyday`, `q_arch` reaching customer-facing text or chips.
Fix: code owns ONE enum→friendly-label mapping (this is facts, fine). No internal
token may appear in any emitted text, chip, or card. Add a single enforcement point
that scrubs/blocks unmapped enum tokens before emit — not scattered per-question.

### R2 — Free-text answers not understood (and the temptation to hardcode them)
Symptom risk: customer answers a tree question in their own words ("pretty high
arches", "I'm on my feet all day at work") and the flow fails to map it, then either
loops or asks again.
Fix (NO phrase list): pass the tree question's structured options + the customer's
raw message to the LLM and let it select the option (or "unclear → ask once more
with a friendlier prompt"). The LLM understands; code just needs to hand it the
options and accept its structured choice.

### R3 — Flow coherence / no infinite loops
Verify the tree always advances: each answered question must reduce remaining
questions and reach a recommendation. A question already answered (via memory or
chip) must never be re-asked (reuse the repeated-clarifier memory from Round 1).

### R4 — Memory contamination between shopping and orthotic flows
Symptom risk: shopping scope (e.g. color=pink, category=sandals) bleeding into an
orthotic recommendation, or orthotic condition leaking into a later shopping turn.
Fix: orthotic flow state and shopping scope are separate namespaces in session
memory. Entering/leaving the orthotic flow must not silently inherit or overwrite
the other's facts. (We saw "off-topic side question mid-flow → falling through to
LLM" already works; verify the return path restores orthotic state cleanly.)

### R5 — Recommendation text quality
The final recommendation card is resolved by code (correct — it's a fact). But the
explanatory sentence should be LLM-worded from the resolved product's real
attributes, customer-friendly, enum-free — not raw tree output, and not claiming
features the product doesn't have (same grounding rule as shopping Slice 5).

### R6 — Mid-flow exits and re-entry
Customer starts orthotic flow, jumps to a product question, comes back. Verify:
the product question is answered, then the orthotic flow resumes from where it was
(not restarted, not lost).

---

## EXTEND THE HUNTER (required part of this round)

The adversarial hunter has only one orthotic persona. Add 4-5 orthotic-specific
personas to `scripts/adversarial-chat-hunter.mjs` that exercise R1-R6:
- deep condition flow answered in free text (not chips)
- condition the catalog may not cover (verify honest "no exact match")
- mid-flow jump to a shopping question and back
- vague/uncertain answers ("not sure", "kind of both")
- a customer who changes their condition mid-flow

Then run the hunter against the deployed orthotic flow and confirm no enum leaks,
no loops, no contamination, and recommendations are grounded.

---

## VERIFICATION (run ALL before declaring done)

```bash
node scripts/eval-orthotic-gate.mjs
node scripts/eval-orthotic-regressions.mjs
node scripts/eval-decision-tree.mjs
node scripts/eval-response-contract.mjs
node scripts/eval-router.mjs
npm run eval:quality
npm run typecheck && npm run build
# deploy, wait ~90s, then:
CHAT_TRANSCRIPT_URL=https://www.aetrex.com/apps/hajirai/chat npm run eval:chat-transcripts -- --verbose
```

## DEFINITION OF DONE (report this back)

1. Orthotic file line counts before/after (should not balloon; net ≤ ~0)
2. Confirmation NO regex phrase-list was added for answer interpretation
3. Single enum→label enforcement point exists; no internal token can reach emit
4. All evals + typecheck + build: pass counts
5. Live transcripts: still 14/14 (shopping path not regressed)
6. Hunter re-run WITH the new orthotic personas: enum leaks = 0, no loops, no
   shopping/orthotic memory contamination, recommendations grounded

Success = the orthotic flow survives adversarial orthotic journeys the way the
shopping path now survives shopping journeys. That is the last structural round
before go-live.
