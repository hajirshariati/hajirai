// Live-Haiku eval for the orthotic intent classifier.
//
// Unlike eval-conversations.mjs (which stubs classifier output), this
// suite makes REAL Haiku API calls with realistic customer phrasings
// and verifies the classifier returns the right intent + attributes.
//
// Run:
//   ANTHROPIC_API_KEY=sk-... node scripts/eval-classifier-live.mjs
//
// Cost: ~30 prompts × ~$0.001/call ≈ $0.03 per full run. Cheap.
//
// Why this matters: the classifier is the front door for every
// customer query. If it mis-classifies "shoe for plantar fasciitis"
// as ortho=true, we route into the wrong flow. If it misses a kid
// signal, the customer gets adult products. The conversation eval
// stubs this layer; this eval verifies the real model behavior.

import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { classifyOrthoticTurn } from "../app/lib/orthotic-classifier.server.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "\nERROR: ANTHROPIC_API_KEY not set. This eval makes real Haiku calls.\n" +
      "Run with: ANTHROPIC_API_KEY=sk-... node scripts/eval-classifier-live.mjs\n",
  );
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

// Helper to convert raw user text into a single-turn message array.
function singleTurn(userText) {
  return [{ role: "user", content: userText }];
}

// ---------- Test cases ----------
//
// Each case: { phrase, expect: { isOrthoticRequest, isFootwearRequest,
// isRejection, attributes: {...partial...} } }.
//
// Attributes are checked partially — only fields specified in `expect`
// are asserted. Use `null` to assert "must be null", omit to "don't
// care".

const CASES = [
  // ===== Clear orthotic requests =====
  {
    phrase: "I need orthotics",
    expect: { isOrthoticRequest: true, isFootwearRequest: false },
  },
  {
    phrase: "recommend the right orthotic for me",
    expect: { isOrthoticRequest: true, isFootwearRequest: false },
  },
  {
    phrase: "I need an insole for plantar fasciitis",
    expect: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      attributes: { condition: "plantar_fasciitis" },
    },
  },
  {
    phrase: "what's the best arch support for flat feet",
    expect: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      attributes: { condition: "overpronation_flat_feet" },
    },
  },
  {
    phrase: "I have heel spurs and need an orthotic",
    expect: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      attributes: { condition: "heel_spurs" },
    },
  },

  // ===== Clear footwear requests =====
  {
    phrase: "show me men's sneakers",
    expect: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      attributes: { gender: "Men" },
    },
  },
  {
    phrase: "find me sandals under $80",
    expect: { isOrthoticRequest: false, isFootwearRequest: true },
  },
  {
    phrase: "do you have winter boots for women",
    expect: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      attributes: { gender: "Women" },
    },
  },

  // ===== The pivotal "shoe for [condition]" case — must be footwear =====
  {
    phrase: "can you show me a shoe for plantar fasciitis",
    expect: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      attributes: { condition: "plantar_fasciitis" },
    },
  },
  {
    phrase: "sandals with arch support",
    expect: { isOrthoticRequest: false, isFootwearRequest: true },
  },
  {
    phrase: "boots for flat feet",
    expect: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      attributes: { condition: "overpronation_flat_feet" },
    },
  },
  {
    phrase: "sneakers for heel pain",
    expect: { isOrthoticRequest: false, isFootwearRequest: true },
  },

  // ===== Kid signals =====
  {
    phrase: "I need an orthotic for my son",
    expect: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      attributes: { gender: "Kids" },
    },
  },
  {
    phrase: "looking for an orthotic for my 9-year-old",
    expect: { isOrthoticRequest: true, attributes: { gender: "Kids" } },
  },
  {
    phrase: "my daughter has flat feet",
    expect: {
      attributes: { gender: "Kids", condition: "overpronation_flat_feet" },
    },
  },
  {
    phrase: "what orthotic should my grandson wear",
    expect: { isOrthoticRequest: true, attributes: { gender: "Kids" } },
  },

  // ===== Adult gender signals =====
  {
    phrase: "I'm a 45-year-old woman with plantar fasciitis",
    expect: {
      isOrthoticRequest: true,
      attributes: { gender: "Women", condition: "plantar_fasciitis" },
    },
  },
  {
    phrase: "for my husband, he has heel pain",
    expect: { attributes: { gender: "Men" } },
  },

  // ===== Rejections =====
  {
    phrase: "I don't want orthotics, just shoes",
    expect: { isRejection: true, isFootwearRequest: true },
  },
  {
    phrase: "no insoles, I just want comfortable shoes",
    expect: { isRejection: true, isFootwearRequest: true },
  },

  // ===== Ambiguous / non-orthotic-non-footwear =====
  {
    phrase: "hi",
    expect: { isOrthoticRequest: false, isFootwearRequest: false },
  },
  {
    phrase: "what's your return policy",
    expect: { isOrthoticRequest: false, isFootwearRequest: false },
  },
  {
    phrase: "do you have free shipping",
    expect: { isOrthoticRequest: false, isFootwearRequest: false },
  },

  // ===== Typos =====
  {
    phrase: "I have plantar fasciitis, what orhtotic should I get",
    expect: {
      isOrthoticRequest: true,
      attributes: { condition: "plantar_fasciitis" },
    },
  },
  {
    phrase: "what insol is best for high arch",
    expect: {
      isOrthoticRequest: true,
      attributes: { condition: "high_arch" },
    },
  },

  // ===== Curly apostrophes =====
  {
    phrase: "find men’s shoes for my needs",
    expect: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      attributes: { gender: "Men" },
    },
  },
  {
    phrase: "I need men’s orthotics",
    expect: {
      isOrthoticRequest: true,
      attributes: { gender: "Men" },
    },
  },

  // ===== Mixed signals =====
  {
    phrase: "show me athletic running orthotics for women",
    expect: {
      isOrthoticRequest: true,
      attributes: { gender: "Women", useCase: "athletic_running" },
    },
  },
  {
    phrase: "I want a dress shoe orthotic",
    expect: {
      isOrthoticRequest: true,
      attributes: { useCase: "dress" },
    },
  },

  // ===== Tricky: "orthotic-friendly shoes" =====
  {
    phrase: "do you have orthotic-friendly sneakers",
    expect: {
      // This is a footwear question — customer wants shoes that
      // accommodate orthotics, not orthotics themselves.
      isOrthoticRequest: false,
      isFootwearRequest: true,
    },
  },

  // ===== Day 2 expansion: simple one-word queries =====
  { phrase: "orthotics", expect: { isOrthoticRequest: true } },
  { phrase: "shoes", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "sneakers", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "boots", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "sandals", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "insole", expect: { isOrthoticRequest: true } },
  { phrase: "arch support", expect: { isOrthoticRequest: true } },
  { phrase: "help", expect: { isOrthoticRequest: false, isFootwearRequest: false } },

  // ===== Day 2: longer / multi-clause queries =====
  {
    phrase: "I'm a runner training for a marathon and I'm starting to get plantar fasciitis. Looking for an insole that can help.",
    expect: {
      isOrthoticRequest: true,
      attributes: { useCase: "athletic_running", condition: "plantar_fasciitis" },
    },
  },
  {
    phrase: "my wife is a nurse who stands all day and her feet hurt",
    expect: {
      attributes: { gender: "Women", useCase: "work_all_day" },
    },
  },
  {
    phrase: "looking for an orthotic for my husband who plays soccer and has high arches",
    expect: {
      isOrthoticRequest: true,
      attributes: { gender: "Men", useCase: "cleats", condition: "high_arch" },
    },
  },
  {
    phrase: "I'm going on a long trip to Europe and walking a lot, what insole should I get",
    expect: { isOrthoticRequest: true },
  },

  // ===== Day 2: bare clinical signals (must default to orthotic) =====
  { phrase: "I have plantar fasciitis", expect: { isOrthoticRequest: true } },
  { phrase: "my feet hurt", expect: { isOrthoticRequest: true } },
  { phrase: "I'm getting heel spurs", expect: { isOrthoticRequest: true } },
  { phrase: "my arch hurts", expect: { isOrthoticRequest: true } },
  { phrase: "I have ball of foot pain", expect: { isOrthoticRequest: true, attributes: { condition: "metatarsalgia" } } },
  { phrase: "my feet always feel tired", expect: { isOrthoticRequest: true } },

  // ===== Day 2: useCase coverage =====
  { phrase: "I work standing on my feet all day", expect: { attributes: { useCase: "work_all_day" } } },
  { phrase: "looking for an orthotic for the gym", expect: { isOrthoticRequest: true, attributes: { useCase: "athletic_training" } } },
  { phrase: "I need an orthotic for my soccer cleats", expect: { isOrthoticRequest: true, attributes: { useCase: "cleats" } } },
  { phrase: "orthotic for hockey skates", expect: { isOrthoticRequest: true, attributes: { useCase: "skates" } } },
  { phrase: "I want an orthotic for dress shoes", expect: { isOrthoticRequest: true, attributes: { useCase: "dress" } } },

  // ===== Day 2: pivots and corrections (single-turn captures) =====
  { phrase: "actually just show me sneakers instead", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "wait actually women's", expect: { attributes: { gender: "Women" } } },
  { phrase: "no orthotics, just looking for shoes", expect: { isRejection: true, isFootwearRequest: true } },

  // ===== Day 2: typos & informal =====
  { phrase: "I need orthtoics for my flat feet", expect: { isOrthoticRequest: true, attributes: { condition: "overpronation_flat_feet" } } },
  { phrase: "I have planter facsitis", expect: { isOrthoticRequest: true, attributes: { condition: "plantar_fasciitis" } } },
  { phrase: "do you sell shoe inserts", expect: { isOrthoticRequest: true } },
  { phrase: "something for my flat feet", expect: { isOrthoticRequest: true, attributes: { condition: "overpronation_flat_feet" } } },

  // ===== Day 2: edge phrasings =====
  { phrase: "I NEED ORTHOTICS NOW", expect: { isOrthoticRequest: true } },
  { phrase: "do u have insoles 4 plantar fasciitis", expect: { isOrthoticRequest: true, attributes: { condition: "plantar_fasciitis" } } },

  // ===== Day 2: kid signals (diverse) =====
  { phrase: "my toddler has flat feet", expect: { attributes: { gender: "Kids", condition: "overpronation_flat_feet" } } },
  { phrase: "orthotics for boys", expect: { attributes: { gender: "Kids" } } },
  { phrase: "orthotic for my child", expect: { attributes: { gender: "Kids" } } },
  { phrase: "what should my 7 year old wear for arch support", expect: { isOrthoticRequest: true, attributes: { gender: "Kids" } } },

  // ===== Day 2: ambiguous / non-shopping =====
  { phrase: "hello there", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
  { phrase: "how are you", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
  { phrase: "are you a real person", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
  { phrase: "do you ship internationally", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
  { phrase: "what's your refund policy", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
  { phrase: "how long does shipping take", expect: { isOrthoticRequest: false, isFootwearRequest: false } },
  { phrase: "where are you located", expect: { isOrthoticRequest: false, isFootwearRequest: false } },

  // ===== Day 2: footwear with various contexts =====
  { phrase: "I need wedding shoes", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "comfortable walking shoes", expect: { isOrthoticRequest: false, isFootwearRequest: true } },
  { phrase: "shoes for plantar fasciitis and standing all day", expect: { isOrthoticRequest: false, isFootwearRequest: true, attributes: { condition: "plantar_fasciitis" } } },
  { phrase: "do you have men's loafers", expect: { isOrthoticRequest: false, isFootwearRequest: true, attributes: { gender: "Men" } } },
  { phrase: "wedges for my mom", expect: { isOrthoticRequest: false, isFootwearRequest: true, attributes: { gender: "Women" } } },

  // ===== Day 2: tricky cases =====
  { phrase: "shoes for orthotics", expect: { isFootwearRequest: true } }, // shoes that fit orthotics
  { phrase: "what shoes work with my orthotic", expect: { isFootwearRequest: true } },
  { phrase: "I have an orthotic, need a shoe to wear it in", expect: { isFootwearRequest: true } },
  { phrase: "diabetic shoes for my dad", expect: { isFootwearRequest: true, attributes: { gender: "Men", condition: "diabetic" } } },
];

// ---------- Run ----------

let passed = 0;
let failed = 0;
const failures = [];

console.log(`\nlive-Haiku classifier eval (${CASES.length} cases)\n`);

for (const c of CASES) {
  try {
    const result = await classifyOrthoticTurn({
      messages: singleTurn(c.phrase),
      anthropic,
      shop: "test.myshopify.com",
    });
    if (!result) {
      throw new Error("classifier returned null");
    }

    const exp = c.expect;
    if ("isOrthoticRequest" in exp) {
      assert.equal(
        result.isOrthoticRequest,
        exp.isOrthoticRequest,
        `isOrthoticRequest expected ${exp.isOrthoticRequest}, got ${result.isOrthoticRequest}`,
      );
    }
    if ("isFootwearRequest" in exp) {
      assert.equal(
        result.isFootwearRequest,
        exp.isFootwearRequest,
        `isFootwearRequest expected ${exp.isFootwearRequest}, got ${result.isFootwearRequest}`,
      );
    }
    if ("isRejection" in exp) {
      assert.equal(
        result.isRejection,
        exp.isRejection,
        `isRejection expected ${exp.isRejection}, got ${result.isRejection}`,
      );
    }
    if (exp.attributes) {
      for (const [k, v] of Object.entries(exp.attributes)) {
        assert.equal(
          result.attributes[k],
          v,
          `attributes.${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(result.attributes[k])}`,
        );
      }
    }
    passed += 1;
    console.log(`  ✓ ${c.phrase.slice(0, 60)}`);
  } catch (err) {
    failed += 1;
    failures.push({ phrase: c.phrase, err });
    console.log(`  ✗ ${c.phrase.slice(0, 60)}`);
    console.log(`    ${err?.message?.split("\n")[0] || err}`);
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${CASES.length} passed\n`);

if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  • "${f.phrase}"`);
    console.log(`    ${f.err?.message || f.err}`);
  }
  process.exit(1);
}
