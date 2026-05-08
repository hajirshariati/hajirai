// Live-Haiku LONG conversation eval for the orthotic intent classifier.
//
// Unlike eval-classifier-live.mjs (single message per case), this suite
// plays out multi-turn conversations and runs the classifier on EACH
// turn with the full accumulated history. Tests the classifier's
// ability to:
//   1. Track state across turns (gender persists once mentioned)
//   2. Detect mid-conversation pivots (customer changes mind)
//   3. Handle Q&A interleaved with shopping
//   4. Resume after off-topic interludes
//   5. Combine signals across turns ('I have flat feet' + 'for my son' =
//      Kids + condition)
//
// Run:
//   ANTHROPIC_API_KEY=sk-... node scripts/eval-classifier-live-conversations.mjs
//
// Cost: ~50 Haiku calls × $0.001 ≈ $0.05 per run. Cheap.
//
// Each scenario has a list of turns. For each user turn:
//   - Append to messages history
//   - Append a synthetic assistant response (so the conversation has
//     interleaved user + assistant, like a real chat)
//   - Call classifyOrthoticTurn with the full history
//   - Assert the classifier output matches expectations
//   - Move to the next turn

import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { classifyOrthoticTurn } from "../app/lib/orthotic-classifier.server.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "\nERROR: ANTHROPIC_API_KEY not set.\n" +
      "Run with: ANTHROPIC_API_KEY=sk-... node scripts/eval-classifier-live-conversations.mjs\n",
  );
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

// ---------- Test harness ----------

async function runScenario(name, turns) {
  const messages = [];
  let turnIdx = 0;
  for (const turn of turns) {
    turnIdx += 1;
    messages.push({ role: "user", content: turn.user });

    const result = await classifyOrthoticTurn({
      messages,
      anthropic,
      shop: "test.myshopify.com",
    });
    if (!result) {
      throw new Error(`turn ${turnIdx} ('${turn.user.slice(0, 40)}'): classifier returned null`);
    }

    const exp = turn.expect || {};
    if ("isOrthoticRequest" in exp) {
      assert.equal(
        result.isOrthoticRequest,
        exp.isOrthoticRequest,
        `turn ${turnIdx} ('${turn.user.slice(0, 40)}'): isOrthoticRequest expected ${exp.isOrthoticRequest}, got ${result.isOrthoticRequest}`,
      );
    }
    if ("isFootwearRequest" in exp) {
      assert.equal(
        result.isFootwearRequest,
        exp.isFootwearRequest,
        `turn ${turnIdx} ('${turn.user.slice(0, 40)}'): isFootwearRequest expected ${exp.isFootwearRequest}, got ${result.isFootwearRequest}`,
      );
    }
    if ("isRejection" in exp) {
      assert.equal(
        result.isRejection,
        exp.isRejection,
        `turn ${turnIdx} ('${turn.user.slice(0, 40)}'): isRejection expected ${exp.isRejection}, got ${result.isRejection}`,
      );
    }
    if (exp.attributes) {
      for (const [k, v] of Object.entries(exp.attributes)) {
        assert.equal(
          result.attributes[k],
          v,
          `turn ${turnIdx} ('${turn.user.slice(0, 40)}'): attributes.${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(result.attributes[k])}`,
        );
      }
    }

    // Append a synthetic assistant turn so the next iteration's history
    // has interleaved user/assistant. Use the optional fixedAssistant
    // override if the scenario specifies one (e.g. mimicking a chip
    // question), otherwise a generic ack.
    const assistantText = turn.assistant || "Got it. What's next?";
    messages.push({ role: "assistant", content: assistantText });
  }
}

// ---------- Scenarios ----------

const SCENARIOS = [
  {
    name: "Full orthotic chip flow (5 turns) — state preserved across each turn",
    turns: [
      { user: "I need orthotics", expect: { isOrthoticRequest: true } },
      {
        user: "Men",
        assistant: "Got it. What kind of shoes?",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men" } },
      },
      {
        user: "athletic running",
        assistant: "Any specific condition?",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "athletic_running" } },
      },
      {
        user: "plantar fasciitis",
        assistant: "What's your arch type?",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "athletic_running", condition: "plantar_fasciitis" } },
      },
      {
        user: "Medium / High Arch",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "athletic_running", condition: "plantar_fasciitis" } },
      },
    ],
  },

  {
    name: "Mid-conversation pivot to footwear",
    turns: [
      { user: "I need orthotics", expect: { isOrthoticRequest: true, isFootwearRequest: false } },
      {
        user: "Men",
        assistant: "Got it. What kind of shoes?",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men" } },
      },
      {
        user: "actually just show me sneakers instead",
        assistant: "Sure, here are some sneakers.",
        expect: { isOrthoticRequest: false, isFootwearRequest: true },
      },
    ],
  },

  {
    name: "Family shopping: orthotic for self, then for wife",
    turns: [
      {
        user: "I need orthotics for me, men's, athletic",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men" } },
      },
      {
        user: "running specifically",
        assistant: "OK, athletic running it is.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "athletic_running" } },
      },
      {
        user: "no specific condition",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "athletic_running", condition: "none" } },
      },
      {
        user: "now I need one for my wife",
        assistant: "Sure, what's the use-case for her?",
        expect: { isOrthoticRequest: true, attributes: { gender: "Women" } },
      },
      {
        user: "casual, she has flat feet",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Women", useCase: "casual", condition: "overpronation_flat_feet" } },
      },
    ],
  },

  {
    name: "Q&A interleaved — gate-fall-through path",
    turns: [
      { user: "I need orthotics", expect: { isOrthoticRequest: true } },
      {
        user: "do you ship internationally?",
        assistant: "We ship to the US and Canada.",
        // Off-topic mid-flow; classifier should say neither
        expect: { isOrthoticRequest: false, isFootwearRequest: false },
      },
      {
        user: "ok cool, women's please",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Women" } },
      },
    ],
  },

  {
    name: "Gender pivot: husband → wife",
    turns: [
      {
        user: "I need orthotics for my husband, he plays soccer",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "cleats" } },
      },
      {
        user: "actually it's for my wife, not him",
        assistant: "Got it, switching to women's.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Women" } },
      },
    ],
  },

  {
    name: "Long context: greeting → policy → orthotic flow",
    turns: [
      {
        user: "Hi",
        expect: { isOrthoticRequest: false, isFootwearRequest: false },
      },
      {
        user: "what's your return policy?",
        assistant: "30 days.",
        expect: { isOrthoticRequest: false, isFootwearRequest: false },
      },
      {
        user: "ok thanks. I have plantar fasciitis",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { condition: "plantar_fasciitis" } },
      },
      {
        user: "Women",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Women", condition: "plantar_fasciitis" } },
      },
      {
        user: "casual shoes",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Women", useCase: "casual", condition: "plantar_fasciitis" } },
      },
    ],
  },

  {
    name: "Kid signal accumulation across turns",
    turns: [
      { user: "I need an orthotic for my son", expect: { isOrthoticRequest: true, attributes: { gender: "Kids" } } },
      {
        user: "he plays soccer",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Kids", useCase: "cleats" } },
      },
      {
        user: "and he has flat feet",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Kids", condition: "overpronation_flat_feet" } },
      },
    ],
  },

  {
    name: "Footwear flow with refinement",
    turns: [
      { user: "show me shoes", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
      {
        user: "for women",
        assistant: "Got it.",
        expect: { isOrthoticRequest: false, isFootwearRequest: true, attributes: { gender: "Women" } },
      },
      {
        user: "I have plantar fasciitis",
        assistant: "Got it.",
        expect: { isOrthoticRequest: false, isFootwearRequest: true, attributes: { gender: "Women", condition: "plantar_fasciitis" } },
      },
    ],
  },

  {
    name: "Rejection then reversal",
    turns: [
      {
        user: "I don't want orthotics, just shoes",
        expect: { isOrthoticRequest: false, isFootwearRequest: true, isRejection: true },
      },
      {
        user: "actually wait, I do need orthotics",
        assistant: "OK, switching back.",
        // Should treat as orthotic intent now (rejection reversed)
        expect: { isOrthoticRequest: true, isRejection: false },
      },
    ],
  },

  {
    name: "Off-topic absorption mid-orthotic-flow",
    turns: [
      {
        user: "I need an orthotic for plantar fasciitis",
        expect: { isOrthoticRequest: true, attributes: { condition: "plantar_fasciitis" } },
      },
      {
        user: "what brand are these?",
        assistant: "Aetrex.",
        expect: { isOrthoticRequest: false, isFootwearRequest: false },
      },
      {
        user: "ok, men's please",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", condition: "plantar_fasciitis" } },
      },
    ],
  },

  {
    name: "Long: greeting → browse intent → policy → orthotic → final attrs",
    turns: [
      { user: "hello there", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
      {
        user: "what do you sell",
        assistant: "We sell shoes and orthotics.",
        expect: { isOrthoticRequest: false, isFootwearRequest: false },
      },
      {
        user: "do you have free shipping",
        assistant: "Free over $50.",
        expect: { isOrthoticRequest: false, isFootwearRequest: false },
      },
      {
        user: "ok cool, I'll take an orthotic",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true },
      },
      {
        user: "for my husband, he stands all day at work",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "work_all_day" } },
      },
      {
        user: "his heels hurt",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "work_all_day", condition: "heel_pain" } },
      },
    ],
  },

  {
    name: "useCase pivot mid-flow (running → casual)",
    turns: [
      {
        user: "I need an orthotic for running",
        expect: { isOrthoticRequest: true, attributes: { useCase: "athletic_running" } },
      },
      {
        user: "Men",
        assistant: "Got it.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "athletic_running" } },
      },
      {
        user: "actually wait, casual not running",
        assistant: "Got it, switching.",
        expect: { isOrthoticRequest: true, attributes: { gender: "Men", useCase: "casual" } },
      },
    ],
  },
];

// ---------- Run ----------

let passed = 0;
let failed = 0;
const failures = [];

console.log(`\nlive-Haiku LONG-conversation eval (${SCENARIOS.length} scenarios)\n`);

for (const scenario of SCENARIOS) {
  try {
    await runScenario(scenario.name, scenario.turns);
    passed += 1;
    console.log(`  ✓ ${scenario.name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name: scenario.name, err });
    console.log(`  ✗ ${scenario.name}`);
    console.log(`    ${err?.message?.split("\n")[0] || err}`);
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${SCENARIOS.length} scenarios passed\n`);

if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.err?.message || f.err}`);
  }
  process.exit(1);
}
