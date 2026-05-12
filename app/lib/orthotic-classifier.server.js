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
          "true if the customer's intent is an orthotic / insole / arch-support / footbed / insert recommendation. " +
          "Three cases set this to true: " +
          "(1) Customer named an orthotic-shaped noun: 'I need orthotics', 'recommend an insole for plantar fasciitis', " +
          "'arch support for my flat feet'. " +
          "(2) Customer mentioned a clinical foot condition with NO product noun at all: " +
          "'I have plantar fasciitis', 'my heels hurt', 'I'm a 45-year-old woman with plantar fasciitis', " +
          "'my arch hurts when I walk'. Orthotics are this merchant's primary clinical-support product, " +
          "so a bare clinical signal defaults to orthotic intent. " +
          "(3) Customer asked about a kid's foot issue with no specific product noun: " +
          "'my son has high arch', 'what should my daughter wear, she has flat feet'. " +
          "Set to FALSE when: " +
          "(a) Customer named a FOOTWEAR noun (shoe / sandal / sneaker / boot / loafer / clog / footwear) " +
          "even paired with a condition. 'show me shoes for plantar fasciitis' → false. " +
          "'sandals with arch support' → false. 'boots for flat feet' → false. " +
          "(b) Customer is asking about something else entirely (returns, shipping, sizing, hello). " +
          "(c) OFF-TOPIC SIDE QUESTION (narrow rule): if the latest message is a QUESTION on a " +
          "non-shopping topic — shipping ('do you ship internationally'), policy ('what's your " +
          "return policy'), brand ('what brand are these', 'who makes these'), pricing-only " +
          "('how much', 'discount'), location ('where are you based') — return " +
          "isOrthoticRequest=false EVEN IF earlier turns established orthotic intent. The " +
          "downstream gate handles re-engagement. Examples mid-flow: 'do you ship to Canada' → " +
          "false. 'what brand is this' → false. 'can I return it' → false. " +
          "IMPORTANT EXCEPTIONS to rule (c) — these still inherit orthotic context from history: " +
          "(c1) SHORT ATTRIBUTE ANSWERS like 'men's', 'women's', 'kids', 'casual', 'running', " +
          "'flat feet', 'medium arch', or chip clicks like 'Men' / 'Women' — these are answers " +
          "to a prior chip question and KEEP isOrthoticRequest=true if the flow was active. " +
          "(c2) AFFIRMATIONS like 'yes', 'ok', 'sure', 'go ahead', 'next', 'continue' — these are " +
          "keep-alive responses, not topic changes. KEEP isOrthoticRequest=true if flow was active. " +
          "(c3) COMPOUND statements that include both rejection AND a NEW shopping intent like " +
          "'I don't want orthotics, just shoes' or 'no insoles, just sneakers' — set " +
          "isFootwearRequest=true (the 'just X' clause is a positive footwear request), " +
          "isRejection=true (the 'no orthotics' clause), isOrthoticRequest=false. The rejection " +
          "and the new request are BOTH signals. " +
          "(d) INFORMATIONAL / DEFINITIONAL QUESTIONS: if the latest message is asking what " +
          "something IS, how it works, what it's made of, what its specs are, or to be told " +
          "about a specific product — return isOrthoticRequest=false even if the named product " +
          "or topic is orthotic-related. The customer wants information, not a recommendation. " +
          "Examples: 'what is a thinsole?', 'what are Thinsoles made of?', 'how does the foam " +
          "work?', 'tell me about the L620', 'explain the difference between posted and " +
          "non-posted orthotics', 'what's the difference between A and B?', 'how thin are " +
          "these?', 'what material is in this?'. The LLM (with knowledge access) should answer. " +
          "A later explicit recommendation request ('ok recommend me one') can re-engage. " +
          "Also set isFootwearRequest=false for these unless the message is also a clear " +
          "footwear-shopping request.",
      },
      isFootwearRequest: {
        type: "boolean",
        description:
          "true if the customer is asking for FOOTWEAR (shoes, sandals, sneakers, boots, loafers, clogs, etc.) " +
          "as the product they want — INCLUDING when paired with a clinical condition. " +
          "Examples that ARE footwear requests: 'show me shoes for plantar fasciitis', 'sandals with arch support', " +
          "'find men's shoes', 'boots for flat feet', 'sneakers for heel pain'. " +
          "ALSO footwear requests (orthotic-compatible footwear): 'shoes for my orthotic', " +
          "'what shoes work with my orthotic', 'I have an orthotic, what shoes fit it', " +
          "'orthotic-friendly sneakers'. The customer already HAS an orthotic and is " +
          "shopping for shoes that accommodate it — that's a footwear request. " +
          "CRITICAL — CONTEXT-AWARE EXCEPTION: If prior turns established the customer is " +
          "shopping for an ORTHOTIC (isOrthoticRequest was true earlier in the conversation, " +
          "or the assistant just asked something like 'what kind of shoes will the orthotic " +
          "go in?'), and the customer's current message is a SHORT shoe-type phrase like " +
          "'casual shoes', 'dress shoes', 'athletic shoes', 'sneakers', 'sandals', 'boots', " +
          "'work shoes', etc., that is the customer ANSWERING the use-case question for the " +
          "orthotic — NOT a pivot to footwear shopping. In that case set isOrthoticRequest=true " +
          "and isFootwearRequest=false, and extract the useCase from the phrase. The orthotic " +
          "context dominates the literal noun. " +
          "Set false (this field) only when the customer is shopping for the orthotic itself, " +
          "OR for non-shopping queries (returns, shipping, hello, FAQ), OR for the " +
          "context-aware case above where 'X shoes' is a use-case answer mid-orthotic-flow.",
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
              "dress_no_removable",
              "non_removable",
              "comfort_walking_everyday",
              "comfort_memory_foam",
              "comfort_memory_foam_everyday",
              "comfort_bundle",
              "diabetic",
              "athletic_running",
              "athletic_training_gym",
              "athletic_training_sports",
              "skates",
              "winter_boots",
              "boots_construction",
              null,
            ],
            description:
              "Shoe context the orthotic will go in. " +
              "MAPPING RULES (use these exact enum values for the listed phrases): " +
              "'dress shoes' / 'heels' / 'fashion shoes' / 'pumps' / 'flats' → 'dress_no_removable'. " +
              "'non-removable insole' / 'fixed insole' / 'inside the shoe' / 'shoe with built-in insole' → 'non_removable'. " +
              "'casual' / 'everyday' / 'walking' / 'day to day' / 'standing around' → 'comfort_walking_everyday'. " +
              "'memory foam' / 'extra cushion' / 'soft insole' / 'plush' (no 'everyday' qualifier) → 'comfort_memory_foam'. " +
              "'memory foam for everyday' / 'cushioned daily wear' → 'comfort_memory_foam_everyday'. " +
              "'plantar fasciitis kit' / 'PF kit' / 'plantar fasciitis bundle' → 'comfort_bundle'. " +
              "'diabetic' / 'diabetes' / 'neuropathy' / 'diabetic-friendly' → 'diabetic'. " +
              "'running' / 'jog' / 'jogging' / 'marathon' / '5k' / '10k' → 'athletic_running'. " +
              "'gym' / 'training' / 'crossfit' / 'weights' / 'lifting' / 'exercise' → 'athletic_training_gym'. " +
              "'tennis' / 'basketball' / 'court shoes' / 'pickleball' / 'sports' / generic 'athletic' / 'active lifestyle' → 'athletic_training_sports'. " +
              "'soccer' / 'football' / 'baseball' / 'lacrosse' / 'rugby' / 'spike shoes' / 'cleats' → 'athletic_training_sports'. " +
              "'hockey' / 'ice skates' / 'skates' → 'skates'. " +
              "'winter boots' / 'snow boots' / 'cold weather boots' / 'shearling' → 'winter_boots'. " +
              "'work boots' / 'construction' / 'standing all day' / 'on my feet all day' / 'warehouse' / 'nursing' → 'boots_construction'. " +
              "If the customer is a Kid: pick the closest match (usually 'comfort_walking_everyday'). " +
              "null if no shoe-context is stated.",
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
              "Specific clinical condition the customer named. " +
              "MAPPING RULES (use these exact enum values for the listed phrases — downstream resolver depends on them): " +
              "'flat feet' / 'fallen arches' / 'overpronation' / 'pronate inward' → 'overpronation_flat_feet' (NOT 'low_arch'). " +
              "'high arches' / 'high arch' / 'supination' / 'underpronation' / 'roll outward' → 'high_arch'. " +
              "'low arches' / 'low arch' (only when explicitly said 'low arch', not 'flat feet') → 'low_arch'. " +
              "'plantar fasciitis' / 'PF' → 'plantar_fasciitis'. " +
              "'heel spurs' / 'spur' → 'heel_spurs'. " +
              "'ball-of-foot pain' / 'metatarsalgia' / 'forefoot pain' → 'metatarsalgia'. " +
              "'morton's neuroma' / 'neuroma' → 'mortons_neuroma'. " +
              "'diabetic foot' / 'diabetes' / 'neuropathy' → 'diabetic'. " +
              "'heel pain' alone (no spur) → 'heel_pain'. " +
              "'arch pain' alone → 'arch_pain'. " +
              "Generic 'foot pain' with no specific location → 'foot_pain'. " +
              "Customer explicitly said 'no pain' / 'just comfort' / 'no specific issue' → 'none'. " +
              "NON-FOOT pain (knee pain, back pain, hip pain, ankle pain, leg pain, shin splints) → " +
              "'none'. The merchant only carries foot orthotics — non-foot conditions don't map to " +
              "any specialty SKU, but a general-support orthotic may still help with biomechanics. " +
              "Use 'none' so the resolver picks the merchant's general-comfort line, and the bot " +
              "can clarify in text that we don't make condition-specific orthotics for non-foot pain. " +
              "CRITICAL — CHIP-ANSWER SCOPE: do NOT extract a condition from a bare chip-style answer " +
              "to a different question. If the prior assistant message asked the OVERPRONATION chip " +
              "question (typically 'When you walk or stand, do your ankles roll inward or do you have " +
              "flat-feet symptoms?') and the customer's latest message is just 'Yes' / 'Yeah' / 'Sometimes' " +
              "/ 'Not sure' / 'No', that is the OVERPRONATION attribute being answered, NOT a condition " +
              "claim. Return condition=null (or whatever the customer previously stated) — do NOT set " +
              "condition='overpronation_flat_feet' just because the question's text contained the word " +
              "'flat-feet'. Same rule for ARCH chip answers ('Flat / Low Arch', 'Medium / High Arch', " +
              "'I don't know') — those are arch values, not condition declarations. Same for GENDER chip " +
              "answers ('Men', 'Women', 'Kids'). Only set condition when the customer explicitly NAMES a " +
              "clinical condition in free text. " +
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
    let useCase = norm(attrs.useCase);
    const condition = norm(attrs.condition);
    // The masterIndex CSV format only carries useCase, not condition.
    // For products whose category IS the condition (diabetic line, PF
    // kit), backfill useCase from condition so the resolver finds them
    // even when the customer phrased it as a clinical condition only.
    if (!useCase && condition === "diabetic") useCase = "diabetic";
    if (!useCase && condition === "plantar_fasciitis") useCase = "comfort_bundle";
    // Note: we do NOT silently flip isFootwearRequest → false when
    // useCase happens to be an "orthotic-only" value like
    // dress_no_removable. That flip used to live here but bypassed
    // the gate's footwear-path veto in conversation-aware scenarios
    // (production 2026-05-12: customer in footwear flow said "heels",
    // classifier extracted useCase=dress_no_removable, the silent
    // flip put them in the orthotic chip funnel — wrong recommendation).
    // Path-ambiguity is now handled by the gate, which has conversation
    // history and can emit a transparent clarifying question instead.
    const result = {
      isOrthoticRequest: Boolean(out.isOrthoticRequest),
      isFootwearRequest: Boolean(out.isFootwearRequest),
      isRejection: Boolean(out.isRejection),
      attributes: {
        gender: norm(attrs.gender),
        useCase,
        condition,
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
