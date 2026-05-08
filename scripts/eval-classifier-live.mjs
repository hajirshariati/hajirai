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
