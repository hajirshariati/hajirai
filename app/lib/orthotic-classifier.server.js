// Haiku-based intent + attribute classifier for the orthotic flow.
//
// Replaces the brittle regex stack we built up across the gate's
// engagement decisions:
//   - detectOrthoticIntent (typos, missing keywords)
//   - looksLikeFootwearCommit (false positives on "wear", "shoes")
//   - mentionsNonOrthoticFootwear (over-matched body-part nouns)
//   - GENDER_DETECT keyword table ("son" → Men was the worst miss)
//   - hasOrthoticRejection (curly apostrophes, phrasings)
//   - accumulateAnswers regex pre-extraction
//
// The LLM handles natural language natively — typos, pivots, slang,
// kid signals like "my 9-year-old" or "for my grandson" — without us
// enumerating every variation. The output is a strict structured
// schema the existing state machine consumes unchanged.
//
// Failure modes:
//   - API error / timeout → returns null (caller falls back to regex
//     so we never go offline on classifier failure)
//   - Schema violation → returns null (same fallback)
//
// Cost: ~$0.001/turn at current Haiku pricing. Latency: ~400-700ms
// added to the turn. The merchant has explicitly chosen accuracy
// over latency — slower correct answers beat fast wrong ones.

import { withAnthropicRetry } from "./anthropic-resilience.server.js";

const HAIKU_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";

// Strict tool-use schema. Haiku must populate every field; null
// means "not stated", not "unknown" — the gate uses null to know
// it still needs to ask. Confidence is hint-only; downstream code
// doesn't gate on it but logs it for offline analysis.
const CLASSIFIER_TOOL = {
  name: "classify_turn",
  description:
    "Classify the customer's latest message in an orthotic shopping conversation. " +
    "Extract any orthotic-relevant attributes the customer explicitly stated, " +
    "and decide whether the orthotic recommendation flow should engage.",
  input_schema: {
    type: "object",
    properties: {
      isOrthoticRequest: {
        type: "boolean",
        description:
          "true if the customer is asking for or open to an orthotic / insole / arch-support / footbed recommendation. " +
          "Includes clinical signals like plantar fasciitis, heel spurs, flat feet, high arch, foot pain, etc. " +
          "false if the customer is shopping for footwear (shoes, sandals, sneakers, boots) or anything non-orthotic.",
      },
      isFootwearRequest: {
        type: "boolean",
        description:
          "true if the customer is committed to buying FOOTWEAR (shoes, sandals, sneakers, boots, loafers, etc.) " +
          "and NOT asking about an orthotic. Use this to keep the orthotic flow OUT of the way of shoe shoppers. " +
          "Note: 'shoes for my orthotic' is NOT a footwear request — that's an orthotic-context question.",
      },
      isRejection: {
        type: "boolean",
        description:
          "true if the customer is explicitly REJECTING orthotics (e.g. 'I don't want orthotics', 'no insoles, just shoes'). " +
          "false otherwise.",
      },
      attributes: {
        type: "object",
        description: "Orthotic attributes the customer explicitly stated in this or previous turns. Use null for any attribute the customer has NOT mentioned.",
        properties: {
          gender: {
            type: ["string", "null"],
            enum: ["Men", "Women", "Kids", null],
            description:
              "Who the orthotic is for. 'Kids' for any minor child including 'my son', 'my daughter', 'my X-year-old', 'grandson', 'granddaughter', 'toddler', 'infant', 'boy', 'girl'. " +
              "'Men' for adult male signals (he/him/his ONLY when context implies adult, husband, dad, brother, etc.). " +
              "'Women' for adult female signals (she/her/hers when adult, wife, mom, sister). " +
              "null if not stated or ambiguous.",
          },
          useCase: {
            type: ["string", "null"],
            enum: [
              "dress",
              "dress_no_removable",
              "dress_premium",
              "casual",
              "athletic_running",
              "athletic_training",
              "athletic_general",
              "cleats",
              "skates",
              "winter_boots",
              "work_all_day",
              "comfort",
              "kids",
              null,
            ],
            description:
              "Shoe context the orthotic will go in. 'kids' for any general kid orthotic request. " +
              "null if not stated.",
          },
          condition: {
            type: ["string", "null"],
            enum: [
              "plantar_fasciitis",
              "heel_spurs",
              "metatarsalgia",
              "mortons_neuroma",
              "overpronation_flat_feet",
              "diabetic",
              "high_arch",
              "low_arch",
              "heel_pain",
              "arch_pain",
              "foot_pain",
              "none",
              null,
            ],
            description:
              "Specific clinical condition the customer named. 'none' if they explicitly said no pain / no condition. " +
              "null if not stated.",
          },
        },
        required: ["gender", "useCase", "condition"],
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Classifier's own confidence in the extraction. 'low' for ambiguous messages.",
      },
    },
    required: [
      "isOrthoticRequest",
      "isFootwearRequest",
      "isRejection",
      "attributes",
      "confidence",
    ],
  },
};

const SYSTEM_PROMPT =
  "You are a strict classifier for a shoe + orthotic Shopify shopping assistant. " +
  "Your job is to extract structured signals from the customer's conversation so a downstream state machine can drive the recommendation flow. " +
  "Only extract attributes the customer EXPLICITLY stated in their messages. Never infer or guess. " +
  "Use null for anything not clearly stated. " +
  "Always call the classify_turn tool. Never reply with prose.";

export async function classifyOrthoticTurn({ messages, anthropic, shop }) {
  if (!anthropic || !Array.isArray(messages) || messages.length === 0) return null;

  // Trim to last 8 messages — classifier only needs recent context to
  // decide intent + extract attributes. Long histories cost more and
  // don't improve accuracy.
  const trimmed = messages.slice(-8).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : "",
  }));

  try {
    const resp = await withAnthropicRetry(
      () =>
        anthropic.messages.create({
          model: HAIKU_MODEL,
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          tools: [CLASSIFIER_TOOL],
          tool_choice: { type: "tool", name: "classify_turn" },
          messages: trimmed,
        }),
      { label: "orthotic-classifier", maxRetries: 1 },
    );

    const toolUse = (resp?.content || []).find((b) => b?.type === "tool_use" && b?.name === "classify_turn");
    if (!toolUse?.input) {
      console.warn(`[classifier] no tool_use in Haiku response for shop=${shop || "?"}`);
      return null;
    }

    const out = toolUse.input;
    // Defensive normalization — Haiku occasionally returns string
    // "null" for null fields when the JSON schema accepts both.
    const attrs = out.attributes || {};
    const norm = (v) => (v === "null" || v === "" ? null : v);
    const result = {
      isOrthoticRequest: Boolean(out.isOrthoticRequest),
      isFootwearRequest: Boolean(out.isFootwearRequest),
      isRejection: Boolean(out.isRejection),
      attributes: {
        gender: norm(attrs.gender),
        useCase: norm(attrs.useCase),
        condition: norm(attrs.condition),
      },
      confidence: out.confidence || "medium",
    };
    console.log(
      `[classifier] shop=${shop || "?"} ortho=${result.isOrthoticRequest} ` +
        `footwear=${result.isFootwearRequest} reject=${result.isRejection} ` +
        `attrs=${JSON.stringify(result.attributes)} conf=${result.confidence}`,
    );
    return result;
  } catch (err) {
    console.error(`[classifier] failed for shop=${shop || "?"}:`, err?.message || err);
    return null;
  }
}
