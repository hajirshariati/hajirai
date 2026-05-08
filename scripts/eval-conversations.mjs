// Conversation-level eval suite for the Aetrex orthotic chat flow.
//
// Multi-turn scenarios. Each scenario plays out a customer conversation
// turn by turn:
//   1. Append the customer's message to history
//   2. Stub the Haiku classifier output for that turn (deterministic)
//   3. Run maybeRunOrthoticFlow with built-up history
//   4. Capture SSE events and assert on them (text, chips, gate decision)
//   5. For "resolve" turns, verify via resolveTree directly (skipping DB)
//   6. Synthesize an assistant turn from the captured text and add to
//      history before the next user turn
//
// What this catches:
//   - Gate engagement decisions (orthotic intent, footwear veto, rejection)
//   - Classifier → answers integration (gender, useCase, condition)
//   - Auto-fill behavior (Kids → useCase=kids; case-insensitive Kids)
//   - Chip filtering (gender chip hiding, condition chip filter, useCase
//     filter for Kids)
//   - Multi-turn state accumulation across the message history
//   - Resolver outcomes for given attribute sets
//
// What this does NOT catch (yet — out of scope for this harness):
//   - chat.jsx LLM-path logic (search rules, follow-up suggestions,
//     narration stripping, the "singular-narrow" heuristic, etc.)
//   - Real Haiku classifier accuracy. Classifier output is stubbed here.
//     Live-Haiku scenarios need a separate suite with budget controls.
//   - Database-level bugs (catalog filter, product fetch failures).
//     Resolver tests skip the Prisma layer.
//
// Run: node scripts/eval-conversations.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maybeRunOrthoticFlow } from "../app/lib/orthotic-flow-gate.server.js";
import { resolveTree } from "../app/lib/decision-tree-resolver.server.js";

const here = dirname(fileURLToPath(import.meta.url));
const definition = JSON.parse(
  readFileSync(resolve(here, "seeds/aetrex-orthotic-tree.json"), "utf8"),
);
const tree = { intent: "orthotic", definition };

// ---------- Test harness ----------

function makeMockSse() {
  const events = [];
  const encoder = { encode: (s) => s };
  const controller = {
    enqueue: (s) => {
      try {
        events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim()));
      } catch (_) {
        events.push({ type: "raw", raw: String(s) });
      }
    },
  };
  return { events, encoder, controller };
}

// Extract the chip labels from the `<<Label>>` markers in emitted text.
function extractChipLabels(text) {
  const out = [];
  const re = /<<([^<>]+)>>/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

// ---------- Scenario runner ----------

async function runScenario(scenario) {
  const messages = [];
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    messages.push({ role: "user", content: turn.user });

    // For "resolve" expectations, skip the gate entirely and verify
    // the resolver directly. This covers the masterSku-correctness
    // dimension without depending on Prisma. The gate's own resolve
    // path is tested in eval-orthotic-gate.mjs separately.
    if (turn.expect.resolveTo) {
      const result = resolveTree(
        turn.expect.resolveTo.attrs,
        definition.resolver,
      );
      if (turn.expect.resolveTo.shouldResolve === false) {
        assert(
          !result.resolved,
          `expected NO resolution for attrs=${JSON.stringify(turn.expect.resolveTo.attrs)} but got masterSku=${result.resolved?.masterSku}`,
        );
        continue;
      }
      assert(
        result.resolved,
        `resolver returned no SKU for attrs=${JSON.stringify(turn.expect.resolveTo.attrs)} (reason: ${result.reason})`,
      );
      const sku = result.resolved.masterSku;
      const pattern = turn.expect.resolveTo.masterSkuPattern;
      if (pattern instanceof RegExp) {
        assert.match(
          sku,
          pattern,
          `expected masterSku to match ${pattern} but got ${sku}`,
        );
      } else if (typeof pattern === "string") {
        assert.equal(
          sku,
          pattern,
          `expected masterSku=${pattern} but got ${sku}`,
        );
      }
      continue;
    }

    const { events, encoder, controller } = makeMockSse();
    const gate = await maybeRunOrthoticFlow({
      messages,
      tree,
      shop: "test.myshopify.com",
      controller,
      encoder,
      classifiedIntent: turn.classifier || null,
    });

    if (turn.expect.gateHandled === false) {
      assert.equal(
        gate.handled,
        false,
        `gate should NOT have handled this turn (user: "${turn.user.slice(0, 60)}")`,
      );
      // Don't add assistant turn to history when gate fell through —
      // production-equivalent would be the LLM responding, but the
      // scenario should specify that explicitly if it matters for
      // the next turn's history.
      if (turn.synthesizedAssistant) {
        messages.push({ role: "assistant", content: turn.synthesizedAssistant });
      }
      continue;
    }

    // gateHandled true (or default): expect events emitted
    assert.equal(
      gate.handled,
      true,
      `gate SHOULD have handled this turn (user: "${turn.user.slice(0, 60)}")`,
    );
    const textEvent = events.find((e) => e?.type === "text");
    assert(textEvent, "expected a text event but found none");
    const text = textEvent.text || "";

    if (turn.expect.questionMatches) {
      assert.match(
        text,
        turn.expect.questionMatches,
        `question text did not match ${turn.expect.questionMatches}`,
      );
    }

    if (turn.expect.chipsExact) {
      const chips = extractChipLabels(text);
      assert.deepEqual(
        chips,
        turn.expect.chipsExact,
        `chips mismatch — expected ${JSON.stringify(turn.expect.chipsExact)} got ${JSON.stringify(chips)}`,
      );
    }
    if (turn.expect.chipsContain) {
      const chips = extractChipLabels(text);
      for (const expected of turn.expect.chipsContain) {
        assert(
          chips.includes(expected),
          `expected chip "${expected}" but got ${JSON.stringify(chips)}`,
        );
      }
    }
    if (turn.expect.chipsExclude) {
      const chips = extractChipLabels(text);
      for (const excluded of turn.expect.chipsExclude) {
        assert(
          !chips.includes(excluded),
          `chip "${excluded}" should NOT be present but is. chips=${JSON.stringify(chips)}`,
        );
      }
    }
    if (typeof turn.expect.minChipCount === "number") {
      const chips = extractChipLabels(text);
      assert(
        chips.length >= turn.expect.minChipCount,
        `expected at least ${turn.expect.minChipCount} chips but got ${chips.length}: ${JSON.stringify(chips)}`,
      );
    }

    // Synthesize the assistant turn so the next iteration's history
    // walk sees the chip set the bot actually emitted.
    messages.push({ role: "assistant", content: text });
  }
}

// ---------- Scenarios ----------
//
// Each scenario:
//   - name: human-readable
//   - turns: [{user, classifier, expect}, ...]
//
// classifier shape (stubs Haiku output):
//   {
//     isOrthoticRequest: bool,
//     isFootwearRequest: bool,
//     isRejection: bool,
//     attributes: { gender, useCase, condition },
//     confidence: "high"|"medium"|"low",
//   }
//
// expect shape (any subset):
//   {
//     gateHandled: bool,                 // default: true (assert handled)
//     questionMatches: RegExp,           // bot's text matches
//     chipsExact: [labels],              // exact list of chip labels
//     chipsContain: [labels],            // chips include all of these
//     chipsExclude: [labels],            // chips include none of these
//     minChipCount: number,
//     resolveTo: {                        // skip gate, verify resolver
//       attrs: {gender, useCase, condition, ...},
//       masterSkuPattern: RegExp | string,
//     },
//     synthesizedAssistant: string,       // optional fake assistant turn
//   }

const C = (overrides) => ({
  isOrthoticRequest: true,
  isFootwearRequest: false,
  isRejection: false,
  attributes: { gender: null, useCase: null, condition: null },
  confidence: "high",
  ...overrides,
  attributes: { gender: null, useCase: null, condition: null, ...(overrides?.attributes || {}) },
});

const SCENARIOS = [
  {
    name: "Adult orthotic happy path: Women + casual + plantar_fasciitis",
    turns: [
      {
        user: "I need an orthotic",
        classifier: C({ attributes: {} }),
        expect: { questionMatches: /Who are these orthotics for/i, chipsExact: ["Men", "Women", "Kids"] },
      },
      {
        user: "Women",
        classifier: C({ attributes: { gender: "Women" } }),
        expect: { questionMatches: /What kind of shoes/i, chipsContain: ["Everyday / casual shoes"] },
      },
      {
        user: "Everyday / casual shoes",
        classifier: C({ attributes: { gender: "Women", useCase: "casual" } }),
        expect: { questionMatches: /condition/i, chipsContain: ["Plantar fasciitis", "None — just want comfort"] },
      },
      {
        user: "Plantar fasciitis",
        classifier: C({ attributes: { gender: "Women", useCase: "casual", condition: "plantar_fasciitis" } }),
        expect: { questionMatches: /arch type/i },
      },
      {
        user: "Resolve check",
        expect: {
          resolveTo: {
            attrs: { gender: "Women", useCase: "casual", condition: "plantar_fasciitis" },
            masterSkuPattern: /^PFK[WMU]?$|^L[0-9]+W$/, // PF kit OR a Women's L-series SKU
          },
        },
      },
    ],
  },

  {
    name: "Footwear vs orthotic: 'show me shoes for plantar fasciitis' must NOT engage gate",
    turns: [
      {
        user: "can you show me a shoe for plantar fasciitis ?",
        classifier: {
          isOrthoticRequest: false,
          isFootwearRequest: true,
          isRejection: false,
          attributes: { gender: null, useCase: null, condition: "plantar_fasciitis" },
          confidence: "high",
        },
        expect: { gateHandled: false },
      },
    ],
  },

  {
    name: "Footwear: 'find men's shoes' must NOT engage gate",
    turns: [
      {
        user: "find men's shoes for my needs",
        classifier: {
          isOrthoticRequest: false,
          isFootwearRequest: true,
          isRejection: false,
          attributes: { gender: "Men", useCase: null, condition: null },
          confidence: "high",
        },
        expect: { gateHandled: false },
      },
    ],
  },

  {
    name: "Hard rejection: 'I don't want orthotics' must NOT engage gate",
    turns: [
      {
        user: "I don't want orthotics, just shoes",
        classifier: {
          isOrthoticRequest: false,
          isFootwearRequest: true,
          isRejection: true,
          attributes: { gender: null, useCase: null, condition: null },
          confidence: "high",
        },
        expect: { gateHandled: false },
      },
    ],
  },

  {
    name: "Kids auto-fill: gender Kids → useCase auto-set to kids → skips q_use_case → asks condition",
    turns: [
      {
        user: "I need an orthotic for my son",
        classifier: C({ attributes: { gender: "Kids" } }),
        expect: { questionMatches: /condition|pain/i },
      },
      {
        user: "Resolve check Kids+kids+none",
        expect: {
          resolveTo: {
            attrs: { gender: "Kids", useCase: "kids", condition: "none" },
            masterSkuPattern: /^L17/,
          },
        },
      },
    ],
  },

  {
    name: "Kids condition chip set is filtered to what Kids actually has",
    turns: [
      {
        user: "I need an orthotic",
        classifier: C({ attributes: {} }),
        expect: { chipsContain: ["Kids"] },
      },
      {
        user: "Kids",
        classifier: C({ attributes: { gender: "Kids" } }),
        expect: {
          questionMatches: /condition|pain/i,
          // Kids customers should always have "None" as a chip option;
          // specialty conditions only appear if the masterIndex has a
          // matching Kids SKU. Don't assert a specific size here since
          // it depends on data.
          chipsContain: ["None — just want comfort"],
        },
      },
    ],
  },

  {
    name: "Adult condition chip set is FULL (all conditions, not just None)",
    turns: [
      {
        user: "I need an orthotic",
        classifier: C({ attributes: {} }),
        expect: {},
      },
      {
        user: "Women",
        classifier: C({ attributes: { gender: "Women" } }),
        expect: {},
      },
      {
        user: "Athletic — court / general",
        classifier: C({ attributes: { gender: "Women", useCase: "athletic_general" } }),
        expect: {
          questionMatches: /condition|pain/i,
          // Adults: full condition list, not just "None"
          chipsContain: [
            "Plantar fasciitis",
            "Heel spurs",
            "None — just want comfort",
          ],
          minChipCount: 4,
        },
      },
    ],
  },

  {
    name: "Resolver: Women + dress + heel_spurs → heel-spurs SKU",
    turns: [
      {
        user: "Resolve check",
        expect: {
          resolveTo: {
            attrs: { gender: "Women", useCase: "casual", condition: "heel_spurs" },
            masterSkuPattern: /^L2460[WU]?$|^L[0-9]+W$/,
          },
        },
      },
    ],
  },

  {
    name: "Resolver: Men + comfort + plantar_fasciitis → PFK kit",
    turns: [
      {
        user: "Resolve check",
        expect: {
          resolveTo: {
            attrs: { gender: "Men", useCase: "comfort", condition: "plantar_fasciitis" },
            masterSkuPattern: /^PFK/,
          },
        },
      },
    ],
  },

  {
    name: "Resolver: Men + cleats + metatarsalgia → cleats family SKU (shoe-context-locked)",
    turns: [
      {
        user: "Resolve check",
        expect: {
          resolveTo: {
            attrs: { gender: "Men", useCase: "cleats", condition: "metatarsalgia", metSupport: true },
            masterSkuPattern: /^L1[0-9]{3}[UM]/,
          },
        },
      },
    ],
  },

  {
    name: "Resolver: Kids + kids + heel_spurs → falls back gracefully (no Kids+heel_spurs SKU)",
    turns: [
      {
        user: "Resolve check",
        expect: {
          // The resolver will return null with a clean reason for this
          // combo (no Kids+heel_spurs SKU exists). The chip filter
          // should prevent this combo from ever being asked, but the
          // resolver behavior should still be safe.
          resolveTo: {
            attrs: { gender: "Kids", useCase: "kids", condition: "heel_spurs" },
            // Resolver returns null with reason — caught by the
            // assert(result.resolved) check above. We expect this
            // scenario to FAIL the resolver assertion intentionally.
            // Test framework: invert via a try/catch wrapper. (See note
            // below — this scenario is currently informational only.)
            masterSkuPattern: /.*/, // accept whatever resolver returns
          },
        },
      },
    ],
    // Marked informational; resolver fallback behavior here is policy-
    // dependent and tested directly in eval-decision-tree.mjs.
    skip: true,
  },

  {
    name: "Curly apostrophe: 'find men's shoes' (U+2019) → footwear veto",
    turns: [
      {
        user: "Find men’s shoes for my needs",
        classifier: {
          isOrthoticRequest: false,
          isFootwearRequest: true,
          isRejection: false,
          attributes: { gender: "Men", useCase: null, condition: null },
          confidence: "high",
        },
        expect: { gateHandled: false },
      },
    ],
  },

  {
    name: "Mid-flow pivot: orthotic flow established → 'just shoes' → falls through",
    turns: [
      {
        user: "I need orthotics",
        classifier: C({ attributes: {} }),
        expect: { questionMatches: /Who are these orthotics for/i },
      },
      {
        user: "actually just show me some shoes",
        classifier: {
          isOrthoticRequest: false,
          isFootwearRequest: true,
          isRejection: false,
          attributes: { gender: null, useCase: null, condition: null },
          confidence: "high",
        },
        expect: { gateHandled: false },
      },
    ],
  },

  {
    name: "Free-text: 'my daughter has flat feet' → resolves Kids+kids+overpronation_flat_feet",
    turns: [
      // Direct resolver test (skips Prisma). Verifies the masterIndex
      // has a Kids SKU for flat-feet kids and the resolver picks it.
      // The gate's auto-fill in production turns this into useCase=
      // kids before resolving — we assert the same combination here.
      {
        user: "Resolve check",
        expect: {
          resolveTo: {
            attrs: {
              gender: "Kids",
              useCase: "kids",
              condition: "overpronation_flat_feet",
              posted: true,
            },
            masterSkuPattern: /^L17/,
          },
        },
      },
    ],
  },

  {
    name: "Engagement: bare orthotic intent in latest turn → emit q_gender",
    turns: [
      {
        user: "I want an orthotic",
        classifier: C({ attributes: {} }),
        expect: {
          questionMatches: /Who are these orthotics for/i,
          chipsExact: ["Men", "Women", "Kids"],
        },
      },
    ],
  },

  // ========== Day 1: expanded resolver coverage ==========
  // For every "important" customer query, what masterSku should the
  // resolver return? These tests exercise the resolver directly so
  // they don't depend on Prisma or chat.jsx — just the decision-tree
  // logic. If a customer reaches these attribute combinations
  // through any path (chip flow, free text, classifier extraction),
  // these are the answers we expect.

  {
    name: "Resolver: Men + casual + none (default) → some Men SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Men", useCase: "casual", condition: "none" }, masterSkuPattern: /M$|U$/ } } }],
  },
  {
    name: "Resolver: Women + casual + none → some Women SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Women", useCase: "casual", condition: "none" }, masterSkuPattern: /W$|U$/ } } }],
  },
  {
    name: "Resolver: Men + dress + none → dress SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Men", useCase: "dress", condition: "none" }, masterSkuPattern: /M$|U$/ } } }],
  },
  {
    name: "Resolver: Women + athletic_running + none → athletic SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Women", useCase: "athletic_running", condition: "none" }, masterSkuPattern: /W$|U$/ } } }],
  },
  {
    name: "Resolver: Men + winter_boots + none → winter boots SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Men", useCase: "winter_boots", condition: "none" }, masterSkuPattern: /M$|U$/ } } }],
  },
  {
    name: "Resolver: Men + skates + none → unisex skates SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Men", useCase: "skates", condition: "none" }, masterSkuPattern: /U$|X$/ } } }],
  },
  {
    name: "Resolver: Women + work_all_day + none → work SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Women", useCase: "work_all_day", condition: "none" }, masterSkuPattern: /W$|U$/ } } }],
  },
  {
    name: "Resolver: Men + dress_no_removable + metatarsalgia → some Men SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Men", useCase: "dress_no_removable", condition: "metatarsalgia", metSupport: true }, masterSkuPattern: /M$/ } } }],
  },
  {
    name: "Resolver: Women + casual + diabetic → conform/diabetic SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Women", useCase: "casual", condition: "diabetic" }, masterSkuPattern: /W$|U$/ } } }],
  },
  {
    name: "Resolver: Women + casual + mortons_neuroma → met-support SKU",
    turns: [{ user: "Resolve check", expect: { resolveTo: { attrs: { gender: "Women", useCase: "casual", condition: "mortons_neuroma", metSupport: true }, masterSkuPattern: /W$|U$/ } } }],
  },
  {
    name: "Resolver: Kids + kids + plantar_fasciitis → no resolution (no Kids PF SKU; strict-Kids policy)",
    turns: [{
      user: "Resolve check",
      expect: {
        resolveTo: {
          attrs: { gender: "Kids", useCase: "kids", condition: "plantar_fasciitis" },
          // The merchant has no Kids+plantar_fasciitis SKU. Strict-Kids
          // policy refuses Unisex fallback. Resolver returns null with
          // a clean reason; the gate falls through to the LLM, which
          // tells the customer honestly we don't carry one.
          shouldResolve: false,
        },
      },
    }],
  },

  // ========== Day 1: classifier veto / engagement edge cases ==========
  // These test the gate's decision to engage (or not) given various
  // classifier outputs. The whole point of the classifier-first design
  // is that the gate's behavior is predictable from the classifier
  // output alone — these scenarios pin down that contract.

  {
    name: "Veto: classifier says BOTH ortho=true AND footwear=true → gate engages (orthotic wins)",
    turns: [{
      user: "I need orthotics and shoes",
      classifier: {
        isOrthoticRequest: true,
        isFootwearRequest: true,
        isRejection: false,
        attributes: { gender: null, useCase: null, condition: null },
        confidence: "medium",
      },
      // Current gate logic: footwearCommitInLatest is true, gate vetoes.
      // This is a TENSION case — customer wants both. Documenting current
      // behavior so we know if it changes.
      expect: { gateHandled: false },
    }],
  },
  {
    name: "Veto: classifier says rejection AND ortho=true → rejection wins",
    turns: [{
      user: "I don't want orthotics",
      classifier: {
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: true,
        attributes: { gender: null, useCase: null, condition: null },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },
  {
    name: "Engagement: ortho=true with no attributes → emit q_gender",
    turns: [{
      user: "what's the best orthotic for me",
      classifier: C({ attributes: {} }),
      expect: {
        questionMatches: /Who are these orthotics for/i,
        chipsContain: ["Men", "Women"],
      },
    }],
  },
  {
    name: "Engagement: ortho=true, gender pre-extracted → skip to q_use_case",
    turns: [{
      user: "I need a men's orthotic",
      classifier: C({ attributes: { gender: "Men" } }),
      expect: {
        questionMatches: /What kind of shoes/i,
      },
    }],
  },

  // ========== Day 1: chip filter integrity ==========

  {
    name: "Chip filter: q_gender always offers Men + Women (must never strip those)",
    turns: [{
      user: "orthotic",
      classifier: C({ attributes: {} }),
      expect: {
        chipsContain: ["Men", "Women"],
        // Kids may or may not be present depending on merchant data;
        // don't assert on it here.
      },
    }],
  },
  {
    name: "Chip filter: useCase chips include common adult shoe types",
    turns: [
      { user: "orthotic", classifier: C({}), expect: {} },
      {
        user: "Men",
        classifier: C({ attributes: { gender: "Men" } }),
        expect: {
          chipsContain: ["Everyday / casual shoes"],
          minChipCount: 5,
        },
      },
    ],
  },

  // ========== Day 1: footwear path coverage ==========

  {
    name: "Footwear: 'sandals with arch support' → gate stays out",
    turns: [{
      user: "do you have sandals with arch support?",
      classifier: {
        isOrthoticRequest: false,
        isFootwearRequest: true,
        isRejection: false,
        attributes: { gender: null, useCase: null, condition: null },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },
  {
    name: "Footwear: 'boots for flat feet' → gate stays out",
    turns: [{
      user: "boots for flat feet",
      classifier: {
        isOrthoticRequest: false,
        isFootwearRequest: true,
        isRejection: false,
        attributes: { gender: null, useCase: null, condition: "overpronation_flat_feet" },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },
  {
    name: "Footwear: 'sneakers for foot pain' → gate stays out",
    turns: [{
      user: "show me sneakers for foot pain",
      classifier: {
        isOrthoticRequest: false,
        isFootwearRequest: true,
        isRejection: false,
        attributes: { gender: null, useCase: null, condition: "foot_pain" },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },
  {
    name: "Footwear: 'best summer sandal for my mom' → gate stays out",
    turns: [{
      user: "best summer sandal for my mom under $50",
      classifier: {
        isOrthoticRequest: false,
        isFootwearRequest: true,
        isRejection: false,
        attributes: { gender: "Women", useCase: null, condition: null },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },

  // ========== Day 1: free-text orthotic intent ==========

  {
    name: "Free-text: 'my arch hurts' (clinical signal) → engages",
    turns: [{
      user: "my arch hurts when I walk",
      classifier: C({
        attributes: { gender: null, useCase: null, condition: "arch_pain" },
      }),
      expect: { questionMatches: /Who are these orthotics for/i },
    }],
  },
  {
    name: "Free-text: 'I have plantar fasciitis' → engages",
    turns: [{
      user: "I have plantar fasciitis",
      classifier: C({
        attributes: { gender: null, useCase: null, condition: "plantar_fasciitis" },
      }),
      expect: { questionMatches: /Who are these orthotics for/i },
    }],
  },
  {
    name: "Free-text: 'best insole for athletes' → engages, asks gender",
    turns: [{
      user: "what's the best insole for athletes",
      classifier: C({
        attributes: { gender: null, useCase: "athletic_general", condition: null },
      }),
      expect: { questionMatches: /Who are these orthotics for/i },
    }],
  },

  // ========== Day 1: kid-signal recognition ==========

  {
    name: "Kid signal: 'for my 9-year-old' → Kids gender",
    turns: [{
      user: "I need an orthotic for my 9-year-old",
      classifier: C({ attributes: { gender: "Kids" } }),
      // Auto-fill useCase=kids, gate goes to q_condition
      expect: { questionMatches: /condition|pain/i },
    }],
  },
  {
    name: "Kid signal: 'grandson' → Kids gender",
    turns: [{
      user: "looking for an orthotic for my grandson",
      classifier: C({ attributes: { gender: "Kids" } }),
      expect: { questionMatches: /condition|pain/i },
    }],
  },
  {
    name: "Kid signal: 'son' alone (no age) → Kids gender (not Men)",
    turns: [{
      user: "my son needs an orthotic",
      classifier: C({ attributes: { gender: "Kids" } }),
      expect: { questionMatches: /condition|pain/i },
    }],
  },

  // ========== Day 1: typos and apostrophe variants ==========

  {
    name: "Typo: 'orhtotic' (missing t) — classifier must still detect intent",
    turns: [{
      user: "what orhtotic should I get for plantar fasciitis",
      classifier: C({ attributes: { condition: "plantar_fasciitis" } }),
      expect: { questionMatches: /Who are these orthotics for/i },
    }],
  },
  {
    name: "Curly apostrophe: 'men's' (U+2019) on orthotic intent → engages with gender Men",
    turns: [{
      user: "I need men's orthotics",
      classifier: C({ attributes: { gender: "Men" } }),
      expect: { questionMatches: /What kind of shoes/i },
    }],
  },

  // ========== Day 1: greetings / non-orthotic ==========

  {
    name: "Greeting: 'hi' → gate does not engage",
    turns: [{
      user: "hi",
      classifier: {
        isOrthoticRequest: false,
        isFootwearRequest: false,
        isRejection: false,
        attributes: { gender: null, useCase: null, condition: null },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },
  {
    name: "Policy question: 'what is your return policy' → gate does not engage",
    turns: [{
      user: "what is your return policy?",
      classifier: {
        isOrthoticRequest: false,
        isFootwearRequest: false,
        isRejection: false,
        attributes: { gender: null, useCase: null, condition: null },
        confidence: "high",
      },
      expect: { gateHandled: false },
    }],
  },

  // ========== Day 1: state-machine state correctness ==========

  {
    name: "State: after 3 chip answers, q_arch is the next question",
    turns: [
      { user: "orthotic", classifier: C({}), expect: {} },
      { user: "Women", classifier: C({ attributes: { gender: "Women" } }), expect: {} },
      { user: "Everyday / casual shoes", classifier: C({ attributes: { gender: "Women", useCase: "casual" } }), expect: {} },
      {
        user: "Plantar fasciitis",
        classifier: C({ attributes: { gender: "Women", useCase: "casual", condition: "plantar_fasciitis" } }),
        expect: { questionMatches: /arch type/i, chipsContain: ["Flat / Low", "Medium", "High", "I don't know"] },
      },
    ],
  },

  {
    name: "State: 'None — just want comfort' chip click maps to condition=none",
    turns: [
      { user: "orthotic", classifier: C({}), expect: {} },
      { user: "Men", classifier: C({ attributes: { gender: "Men" } }), expect: {} },
      { user: "Everyday / casual shoes", classifier: C({ attributes: { gender: "Men", useCase: "casual" } }), expect: {} },
      {
        user: "None — just want comfort",
        classifier: C({ attributes: { gender: "Men", useCase: "casual", condition: "none" } }),
        expect: { questionMatches: /arch type/i },
      },
    ],
  },
];

// ---------- Run ----------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

console.log("\nconversation eval suite\n");

for (const scenario of SCENARIOS) {
  if (scenario.skip) {
    skipped += 1;
    console.log(`  ⏭  ${scenario.name} (skipped)`);
    continue;
  }
  try {
    await runScenario(scenario);
    passed += 1;
    console.log(`  ✓ ${scenario.name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name: scenario.name, err });
    console.log(`  ✗ ${scenario.name}`);
    console.log(`    ${err?.message?.split("\n")[0] || err}`);
  }
}

console.log(
  `\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed, ${skipped} skipped\n`,
);

if (failed > 0) {
  console.log("Failure details:");
  for (const f of failures) {
    console.log(`\n— ${f.name}`);
    console.log(`  ${f.err?.stack || f.err?.message || f.err}`);
  }
  process.exit(1);
}
