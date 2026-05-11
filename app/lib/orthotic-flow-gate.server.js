// Orthotic-flow gate: a thin orchestrator that decides whether the
// state machine in orthotic-flow.server.js should take this turn,
// and if so, emits the SSE response server-side instead of letting
// the LLM run.
//
// Gate fires when:
//   - A `recommend_orthotic` decision tree is configured for the
//     shop, AND
//   - The conversation is mid-orthotic-flow — i.e. detectFlowState
//     identifies a current question node from the chip fingerprint
//     of the most recent assistant turn, AND
//   - The latest user reply maps to an enum value via Layer 1
//     (exact chip click) or Layer 2 (keyword enrichment).
//
// When the gate fires, this function:
//   - Advances the state machine,
//   - For a "question" step: emits the seed's question text + chips
//     (server-authoritative, no drift) and ends the SSE stream,
//   - For a "resolve" step: runs executeRecommenderTool through the
//     existing resolver/derivation/enrichment pipeline, emits the
//     product card via the standard `products` chunk, optionally
//     emits a brief LLM-generated description, and ends the stream,
//   - For a "done" step (no-match): emits a graceful redirect text
//     and ends the stream.
//
// When the gate does NOT fire, this function returns
// `{ handled: false }` and the normal LLM-driven runAgenticLoop
// proceeds unchanged. That keeps the gate opt-in and safe — any
// drift, off-topic, or free-text reply that the state machine
// can't confidently advance just falls through to the LLM as
// before.

import {
  getNextStep,
  mapAnswerToEnum,
  findNodeByChipsInText,
  findNodeById,
  getRootNode,
  nextNodeFromTransition,
  buildConstrainedAnswerPrompt,
  parseConstrainedAnswerResponse,
  isOffTopicReply,
  detectOrthoticIntent,
  hasOrthoticRejection,
  looksLikeFootwearCommit,
  mentionsNonOrthoticFootwear,
  preExtractAnswers,
  accumulateAnswers,
  looksLikeRecommendationRequest,
  looksLikeInformationalQuestion,
  looksLikeAvailabilityQuestion,
} from "./orthotic-flow.server.js";
import { executeRecommenderTool } from "./recommender-tools.server.js";
import { buildStorefrontSearchCTA } from "./storefront-search-cta.server.js";

// Format a recommender-returned product the same way chat-tools'
// extractProductCards does. Inlined (rather than imported) to keep
// the gate's dependency surface small — chat-tools.server.js pulls
// in Prisma, which breaks the eval-orthotic-gate runtime.
//
// Why this matters: variant.price comes out of the DB as a decimal
// string ("69.95"). The widget's fallback price formatter divides
// by 100 (the rest of the codebase uses cents elsewhere), so emitting
// the raw product object renders $0.70 for a $69.95 item. Setting
// price_formatted as a pre-formatted string the widget renders
// verbatim avoids the bug.
function formatRecommenderCard(product) {
  if (!product || !product.handle) return null;
  return {
    title: product.title,
    url: product.url,
    handle: product.handle,
    image: product.image || "",
    price_formatted: product.price ? `$${parseFloat(product.price).toFixed(2)}` : "",
    compare_at_price: product.compareAtPrice
      ? Math.round(parseFloat(product.compareAtPrice) * 100)
      : undefined,
  };
}

const ORTHOTIC_INTENT = "orthotic";

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Format a question node into customer-facing text with chip
 * markers. The widget's existing `<<Label>>` chip syntax is what
 * the renderer already understands.
 *
 * Chip labels come straight from the seed — no LLM rewrite, so the
 * customer's click on "None — just want comfort" maps cleanly back
 * to condition="none" via Layer 1 exact match next turn.
 */
const KIDS_GENDER_VALUES = new Set(["kids", "boys", "girls", "kid", "child"]);
function isKidsGenderValue(v) {
  if (typeof v !== "string") return false;
  return KIDS_GENDER_VALUES.has(v.toLowerCase());
}

// Compute the set of useCase values that have at least one Kids
// SKU in the resolver's masterIndex. Used to filter the q_use_case
// chips when the customer has selected Kids — we only want to ask
// about shoe types we actually carry a Kids orthotic for, instead
// of letting them pick "Dress shoes" and dead-ending into a
// "we don't have it" message.
function kidsAvailableUseCases(tree) {
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex)) return null;
  const out = new Set();
  for (const m of masterIndex) {
    if (isKidsGenderValue(m?.gender) && typeof m?.useCase === "string") {
      out.add(m.useCase);
    }
  }
  return out;
}

// For the condition question: filter chips only for Kids customers
// (where the dead-end risk is real because the merchant has limited
// Kids SKUs and the resolver is strict-Kids). For adults, return
// null so the consumer skips filtering and shows all conditions.
//
// Why no filtering for adults: most masterIndex items don't set an
// explicit `condition` field — only specialty SKUs (plantar_fasciitis,
// heel_spurs, metatarsalgia, etc.) do. The resolver uses
// CONDITION_TARGETS regex matchers and SHOE_CONTEXT_LOCKS to map a
// customer's stated condition to either a specialty SKU or the
// base family SKU. My old narrow filter (require gender+useCase+
// condition all match) hid every condition chip for Women+athletic
// because no L2900W item literally has condition="heel_spurs" set.
// The resolver would have happily returned the L2900W family SKU.
function availableConditionsForAnswers(tree, answers) {
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex) || !answers) return null;
  // Adults: no condition filtering. Resolver handles all conditions
  // via specialty tests and shoe-context locks.
  if (!isKidsGenderValue(answers.gender)) return null;
  // Kids: strict filter. Only show conditions present on Kids items.
  // "none" is always allowed as the catch-all.
  const out = new Set(["none"]);
  for (const m of masterIndex) {
    if (!isKidsGenderValue(m?.gender)) continue;
    if (typeof m?.condition === "string" && m.condition) {
      out.add(m.condition);
    }
  }
  return out;
}

function renderQuestionText(node, answers, tree) {
  if (!node || node.type !== "question") return "";
  const q = String(node.question || "").trim();
  // Defensive Unisex / Other / Either / Both strip — production
  // showed those labels appearing on q_gender despite the canonical
  // seed file having only Men/Women/Kids. The DB-stored tree may
  // have drifted (manual edit, older seed version, etc.); strip
  // them at emit time so customers never see a non-gender chip.
  // Also strips for the gender attribute specifically, but the
  // filter is safe to run on any node — the labels never appear
  // on non-gender questions.
  const NONSENSE_GENDER = /^(?:unisex|other|either|both)\b/i;
  let chips = (node.chips || []).filter((c) => {
    const label = String(c?.label || "").trim();
    return label && !NONSENSE_GENDER.test(label);
  });

  // Kids-aware useCase filtering. If the customer chose Kids, only
  // show chips whose value has at least one Kids SKU in the master
  // index. The gate's auto-fill step usually skips this question
  // entirely for Kids (because no chip values match Kids useCases
  // like "kids"); this filter is here as a defense-in-depth in case
  // the gate path is ever bypassed.
  if (
    node.attribute === "useCase" &&
    answers &&
    isKidsGenderValue(answers.gender)
  ) {
    const allowed = kidsAvailableUseCases(tree);
    if (allowed && allowed.size > 0) {
      chips = chips.filter((c) => allowed.has(c.value));
    }
  }

  // Condition-chip filtering. Hide condition chips that have no
  // resolvable SKU given the customer's already-answered gender +
  // useCase. "none" is always kept as a catch-all. Without this,
  // a Kids customer would see "Heel spurs" / "Plantar fasciitis"
  // chips and click them, only to dead-end at "no SKU available".
  if (node.attribute === "condition" && answers) {
    const allowed = availableConditionsForAnswers(tree, answers);
    if (allowed && allowed.size > 0) {
      chips = chips.filter((c) => allowed.has(c.value));
    }
  }

  // Hide the Kids gender chip if the merchant's masterIndex has zero
  // Kids-tagged SKUs. Without this, customers can pick Kids and then
  // either dead-end (strict resolver returns null) or get an
  // adult-shaped product (legacy fallback). Both are wrong. Removing
  // the chip is the cleanest fix — if the merchant doesn't carry
  // kids products, they shouldn't be offered as an option.
  if (node.attribute === "gender") {
    const masterIndex = tree?.definition?.resolver?.masterIndex;
    if (Array.isArray(masterIndex)) {
      const hasKidsItems = masterIndex.some((m) => isKidsGenderValue(m?.gender));
      if (!hasKidsItems) {
        chips = chips.filter((c) => !isKidsGenderValue(c?.value) && !/^(kids?|boys?|girls?|child)\b/i.test(String(c?.label || "")));
      }
    }
  }

  const chipLabels = chips.map((c) => String(c.label).trim()).filter(Boolean);
  if (chipLabels.length === 0) return q;
  const chipLine = chipLabels.map((l) => `<<${l}>>`).join(" ");
  return `${q}\n\n${chipLine}`;
}

/**
 * Apply skipIfKnown / autoSkipIfSingle node transitions to walk
 * past nodes whose answer is already known. The state machine's
 * getNextStep already does this once per call — but if a chain of
 * skippable nodes precedes a question, we need to keep walking.
 *
 * Returns the next step, possibly after multiple skips. Bounded at
 * 8 hops to defend against pathological cyclic transitions.
 */
function resolveSkippableSteps(state, tree) {
  let cur = state;
  for (let i = 0; i < 8; i++) {
    const step = getNextStep(cur, tree);
    if (step.type !== "question") return step;
    const node = step.node;
    if (node.skipIfKnown && cur.answers[node.attribute] !== undefined) {
      const nextId = nextNodeFromTransition(node, cur.answers[node.attribute]);
      if (!nextId) return step;
      cur = { ...cur, currentNodeId: nextId };
      continue;
    }
    return step;
  }
  return getNextStep(cur, tree);
}

/**
 * Main entry point. See module docstring for behavior contract.
 *
 * Parameters:
 *   - messages: full conversation history (last item is current user turn)
 *   - tree: the orthotic DecisionTree row (with .definition)
 *   - shop: shop domain (for resolver's catalog filter)
 *   - controller / encoder: SSE writer pair from chat.jsx
 *   - anthropic: Anthropic SDK client (used for Layer 3 fallback)
 *   - haikuModel: model id for the optional Layer 3 free-text mapper
 *
 * Returns:
 *   { handled: true }  if the gate took the turn (caller should not
 *                      run the LLM agentic loop)
 *   { handled: false } otherwise
 */
export async function maybeRunOrthoticFlow({
  messages,
  tree,
  shop,
  controller,
  encoder,
  anthropic,
  haikuModel,
  classifiedIntent,
  storefrontSearchUrlPattern = "",
  ctaOverrides = [],
}) {
  if (!tree || tree.intent !== ORTHOTIC_INTENT) return { handled: false };
  if (!tree.definition || !Array.isArray(tree.definition.nodes)) {
    return { handled: false };
  }
  if (!Array.isArray(messages) || messages.length === 0) return { handled: false };

  // The latest message must be from the user — that's what we're
  // mapping. If the last turn is somehow assistant-tail or empty,
  // fall through to the normal flow.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { handled: false };
  const rawUserText = typeof last.content === "string" ? last.content : "";
  if (!rawUserText.trim()) return { handled: false };

  // Unified gate: accumulate every Layer-1/2 answer signal across
  // the whole conversation, then walk the seed tree from root and
  // emit the next unanswered question. Replaces the old bootstrap-
  // vs-continuation split, which was broken in production because
  // the chip `<<>>` markers don't survive the widget's history
  // round-trip — so findNodeByChipsInText returned null on every
  // turn and the chip-fingerprint continuation never engaged.
  //
  // Engagement rule: the gate is "active" if ANY of these hold:
  //   1. detectOrthoticIntent matches the latest message (fresh
  //      bootstrap), OR
  //   2. detectOrthoticIntent matches anywhere in history (mid-flow
  //      pivot back into the orthotic flow), OR
  //   3. accumulateAnswers found ≥1 prior answer (we're already
  //      mid-flow even if intent words have faded from history).
  //
  // Otherwise the LLM stays in charge — same fall-through behavior
  // as before. Anything the gate emits uses seed-byte-exact chips.
  const priorMessages = messages.slice(0, -1);
  const accumulated = accumulateAnswers(priorMessages, tree.definition);
  const latestExtracted = preExtractAnswers(rawUserText, tree.definition);

  // Classifier-extracted attributes from Haiku take PRECEDENCE over
  // the legacy regex pre-extraction for the latest message. Haiku
  // handles natural language we used to chase with regex patches —
  // "my son" → Kids (not Men), "high arch" → high_arch condition,
  // typos like "orhtotic", curly apostrophes, kid signals like
  // "my 9-year-old" or "grandson". Only applied when the classifier
  // ran successfully; on null we keep the regex extraction so the
  // gate never goes offline on classifier failure.
  if (classifiedIntent && classifiedIntent.attributes) {
    const a = classifiedIntent.attributes;
    if (a.gender) latestExtracted.gender = a.gender;
    if (a.useCase) latestExtracted.useCase = a.useCase;
    if (a.condition) latestExtracted.condition = a.condition;
  }

  // Chip-context defense for the overpronation chip question.
  // Production trace: when the assistant's prior message was the
  // overpronation chip ("...do your ankles roll inward or do you have
  // flat-feet symptoms?") and the customer answers "Yes", Haiku reads
  // the chip text + Yes and infers `condition=overpronation_flat_feet`.
  // That's wrong: the chip's purpose is to set `overpronation=yes`
  // ONLY, not to inject a clinical condition the customer never named
  // in free text. Drop the spurious condition extraction when we
  // detect this combination. Also drop spurious arch extraction in
  // the same shape ("Flat / Low Arch" Y/N answer is for the arch
  // chip, not the condition chip).
  {
    const priorLastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
    const priorLastText = priorLastAssistant && typeof priorLastAssistant.content === "string"
      ? priorLastAssistant.content
      : "";
    const priorWasOverpronationChip = /ankles\s+roll\s+inward|flat-feet\s+symptoms/i.test(priorLastText);
    const latestIsYesNo = /^\s*(?:yes|yeah|yep|yup|sure|absolutely|definitely|no|nope|not\s+(?:really|sure)|maybe|kind\s+of|sort\s+of)[\s.!?]*$/i
      .test(rawUserText);
    if (
      priorWasOverpronationChip &&
      latestIsYesNo &&
      latestExtracted.condition === "overpronation_flat_feet"
    ) {
      console.log(
        `[orthotic-flow] chip-context defense: dropping spurious condition=overpronation_flat_feet ` +
          `from Y/N answer to overpronation chip (prior msg was the chip question)`,
      );
      delete latestExtracted.condition;
    }
  }

  // Kids-sticky: once gender=Kids is established, it CANNOT be silently
  // flipped to Men/Women by a subsequent message. Production trace —
  // customer chose Kids on q_gender, the LLM later asked an unsolicited
  // 'boy or girl?' follow-up with Men's/Women's chips, customer
  // clicked Women's, Layer 2 mapped that to gender=Women, the resolver
  // returned a Women's adult orthotic for what was supposed to be a
  // child. Letting an adult-gender override a kids-gender is virtually
  // never what the customer means; if they truly need to switch from
  // a child to themselves they say so explicitly ('actually it's for
  // me' / 'it's for my mom'), which the LLM handles outside the gate.
  if (
    isKidsGenderValue(accumulated.gender) &&
    latestExtracted.gender &&
    !isKidsGenderValue(latestExtracted.gender)
  ) {
    console.log(
      `[orthotic-flow] kids-sticky: blocking gender override ` +
        `(accumulated=${accumulated.gender} → latest=${latestExtracted.gender})`,
    );
    delete latestExtracted.gender;
  }

  // Subject-pivot reset. When the latest message names a NEW
  // subject (different gender from accumulated), the prior subject's
  // arch/overpronation/condition answers don't apply. Production
  // trace: grandma asked for self (Women + Medium arch + overpronation
  // yes) — bot resolved L220W. Then "how about for my 9 year old?" —
  // gate inherited the Medium arch + overpronation=yes and resolved
  // L1720Y (Kids Posted) using the WIFE'S overpronation answer. Same
  // for "and for my dad" — inherited wife's flat-feet posted state.
  // Customer kept screaming "he doesn't have flat feet" because every
  // subject's recommendation came from the wife's accumulated state.
  //
  // Reset condition + arch + overpronation when gender pivots. Keep
  // useCase (shoe context — "casual" tends to carry across subjects
  // if the customer didn't say otherwise). The kids-sticky case above
  // is already handled — if it fired, latestExtracted.gender is now
  // deleted so this check doesn't trigger.
  if (
    latestExtracted.gender &&
    accumulated.gender &&
    latestExtracted.gender !== accumulated.gender
  ) {
    console.log(
      `[orthotic-flow] subject pivot: gender ${accumulated.gender} → ${latestExtracted.gender}; ` +
        `dropping accumulated condition/arch/overpronation (subject-specific attrs)`,
    );
    delete accumulated.condition;
    delete accumulated.arch;
    delete accumulated.overpronation;
  }

  // Customer-correction veto. The customer just pushed back on a
  // prior accumulated answer ("but he doesn't have flat feet" /
  // "actually she doesn't / no he doesn't"). Whatever we accumulated
  // is now suspect — fall through to the LLM, which can apologize
  // and re-elicit cleanly. Auto-resolving the same SKU after the
  // customer contradicted us is the worst customer-experience bug.
  const CORRECTION_RE = /^\s*(?:but|actually|no,?\s+(?:he|she|they|i))\b[^.!?]{0,80}?\b(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not)\b/i;
  if (CORRECTION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] customer correction detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Subject-clarification veto. Customer is correcting the bot's
  // assumption that the orthotic is for THEM ("this is not for me",
  // "it's not for me", "i don't need this for me, i need it for my
  // brother"). Production trace 2026-05-10 16:01: bot kept emitting
  // q_arch three turns in a row while customer typed "this is not
  // for me" twice — the gate didn't recognize the redirect. Fall
  // through so the LLM can ack the subject and re-ask appropriately.
  // Match both "this is not for me" AND the contraction "this isn't for me"
  // (which has no space inside "isn't"). Earlier version required (?:is\s+)?
  // before "not" — that worked for the spaced form but missed the contraction.
  const SUBJECT_CLARIFICATION_RE = /\b(?:(?:this|it|that)(?:['‘’]?s)?\s+(?:(?:is|are)\s+not|isn['‘’]?t|aren['‘’]?t|ain['‘’]?t|not)\s+for\s+me|(?:i'?m|i\s+am)\s+not\s+the\s+(?:one|person)|i\s+don'?t\s+need\s+(?:this|it|one)\s+for\s+me|not\s+for\s+me[,.\s]+(?:for|it'?s|its)\b)/i;
  if (SUBJECT_CLARIFICATION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] subject clarification detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Meta-frustration veto. Customer is questioning whether the bot is
  // even paying attention ("are you listening?", "did you read what
  // i said?", "are you listing to me?" — typos welcome). Production
  // trace 2026-05-10 16:01: bot ignored two prior redirects, customer
  // typed "are you listeting to me?", bot emitted q_arch a THIRD
  // time. Fall through so the LLM can apologize and recover.
  const META_FRUSTRATION_RE = /\b(?:are\s+you\s+(?:list[a-z]*|hear[a-z]*|read[a-z]*|paying\s+attention|even\s+(?:list|read|hear))|did\s+you\s+(?:read|hear|listen|understand|see)\s+(?:what|me|that)|do\s+you\s+(?:even|actually)\s+understand|hello\?+\s*$|are\s+you\s+(?:there|alive|broken|stuck|a\s+(?:bot|robot)))/i;
  if (META_FRUSTRATION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] meta-frustration detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Give-up veto. Customer is fed up with the question chain and just
  // wants a result NOW ("ugh whatever just pick one", "you choose",
  // "just give me something", "i don't care"). Continuing the chip
  // chain after this signal feels like the bot ignoring the customer.
  // Fall through so the LLM can offer a sensible default or short-list.
  const GIVE_UP_RE = /\b(?:(?:ugh|fine|whatever)\b[^.!?]{0,30}?\b(?:just|pick|choose|give|whatever)|just\s+(?:pick|choose|give\s+me|show\s+me)\s+(?:one|something|anything)|you\s+(?:pick|choose|decide)|surprise\s+me|i\s+don'?t\s+care|doesn'?t\s+matter\s+(?:to\s+me)?|stop\s+asking)/i;
  if (GIVE_UP_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] give-up signal detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Source-challenge / meta-question detection. When the customer
  // questions where a prior AI claim came from ("where did you get that
  // from?", "what's your source?", "you said X — where's that from?"),
  // the right answer is the LLM defending or retracting the claim — NOT
  // the gate seeding the next chip question. Customer is contesting,
  // not progressing through the funnel.
  //
  // Production trace 2026-05-11: AI said "customers swear by these
  // plantar fasciitis kits" → customer asked "you said 'swear by' —
  // where did you get that from?" → gate saw accumulated condition and
  // emitted q_gender ("Who are these orthotics for?"), totally
  // off-topic. Fix: skip the gate on this turn.
  const META_QUESTION_RE = /\b(?:where\s+(?:did|do)\s+you\s+(?:get|find|hear|read|see)\s+(?:that|this|it)|where\s+(?:does|did)\s+(?:that|this|it)\s+come\s+from|what(?:['‘’]?s| is)\s+your\s+source|how\s+do\s+you\s+know\s+(?:that|this)|who\s+told\s+you|what\s+(?:are|is)\s+you\s+basing\s+(?:that|this|it)\s+on|(?:any|got\s+a|got\s+any|cite\s+a|cite\s+any)\s+sources?|how\s+can\s+you\s+say\s+that|prove\s+it|(?:you|u)\s+(?:just\s+)?said\s+["“'‘]|(?:you|u)\s+(?:just\s+)?said\s+(?:that\s+)?(?:["“'‘]|customers|people|fans|users))/i;
  if (META_QUESTION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] meta-question / source challenge ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Domain disambiguation. When the customer mentions a clinical
  // condition + a generic shopping verb but no product noun ("I have
  // foot pain, what should I wear?"), the old regex intent stack used
  // to ask "footwear or orthotic?" before launching the orthotic chip
  // funnel. The Haiku classifier (4524e94) is more eager to commit to
  // orthotic on a bare condition, so customers who actually wanted
  // arch-support footwear get dragged through 5 chip turns and then
  // shown an orthotic that may or may not be in stock.
  //
  // Trigger: latest message has a condition hint AND a generic
  // shopping verb AND no footwear noun AND no orthotic noun.
  // Suppress: if the disambiguation has already been asked this
  // conversation (chip label present in any prior assistant turn).
  // Footwear nouns. `heels?` and `flats?` are intentionally absent —
  // they collide with anatomy/condition words ("heel pain", "flat
  // feet"). The customer who really means high heels says "heels" in
  // a different shape; if they typed "heel pain, what to wear" they
  // need the disambig anyway.
  const FOOTWEAR_NOUN_RE = /\b(shoes?|sandals?|sneakers?|boots?|loafers?|clogs?|slip[- ]ons?|mary[- ]janes?|wedges?|footwear|oxfords?|moccasins?|slippers?|trainers?|pumps?|mules?)\b/i;
  const ORTHOTIC_NOUN_RE = /\b(orthotics?|insoles?|inserts?|inner[- ]soles?|arch[- ]support[- ]insert|heel[- ]cups?|footbeds?|thinsoles?)\b/i;
  const SHOPPING_VERB_RE = /\b(wear|wears|wearing|recommend|recommendation|recommends|find|finding|looking[- ]for|want|wants|wanting|need|needs|needing|get|gets|getting|buy|buying|best|good|suitable|right|help\s+(?:me|with))\b/i;
  const CONDITION_HINT_RE = /\b(pain|aching?|sore|sores|fasciit(?:is|us)|bunions?|hammertoes?|neuroma|flat[- ]feet|high[- ]arch|low[- ]arch|overpronation|underpronation|plantar|metatarsal|heel[- ]spurs?|diabetic|diabetes|arthritis)\b/i;
  const DISAMBIG_CHIP_RE = /<<\s*Footwear\s+with\s+arch\s+support\s*>>|<<\s*Orthotic\s+insole\s*>>/i;
  const alreadyAsked = Array.isArray(messages) && messages.slice(0, -1).some((m) => {
    return m && m.role === "assistant" && typeof m.content === "string" && DISAMBIG_CHIP_RE.test(m.content);
  });
  const isConditionOnly = CONDITION_HINT_RE.test(rawUserText) &&
                          SHOPPING_VERB_RE.test(rawUserText) &&
                          !FOOTWEAR_NOUN_RE.test(rawUserText) &&
                          !ORTHOTIC_NOUN_RE.test(rawUserText);
  if (isConditionOnly && !alreadyAsked) {
    const text =
      "Got it — sounds like you're dealing with some foot discomfort. " +
      "Are you looking for footwear with built-in arch support, or an " +
      "orthotic insole that goes inside your existing shoes?\n\n" +
      "<<Footwear with arch support>><<Orthotic insole>>";
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] domain disambig: condition-only query without product noun ` +
        `("${rawUserText.slice(0, 60)}"); asked footwear-vs-orthotic`,
    );
    return { handled: true };
  }

  const answers = { ...accumulated, ...latestExtracted };

  // Kids auto-fill for useCase. When gender=Kids, the seed's q_use_case
  // chips (Dress shoes, Cleats, Skates, etc.) almost never have a
  // Kids-tagged SKU behind them — the merchant's Kids orthotic line
  // (L17xx) is a generic "kids" useCase that doesn't appear as a chip
  // label. Asking the customer to pick a shoe-type only sends them to
  // a dead-end. Instead: if the masterIndex has any Kids-tagged SKUs,
  // auto-fill answers.useCase to the first one (lex-sorted for
  // determinism) and skip the q_use_case question entirely. Customer
  // goes directly to q_condition. If they already picked a non-Kids
  // useCase via chip ("Cleats"), override it — Kids selection wins.
  if (isKidsGenderValue(answers.gender)) {
    const allowed = kidsAvailableUseCases(tree);
    if (!allowed || allowed.size === 0) {
      // Merchant's masterIndex has zero Kids-tagged SKUs. Don't lead
      // the customer through a chip flow that ends in "we don't carry
      // it" — fall through to the LLM, which can say so honestly in a
      // single message and offer alternatives. Logged so the merchant
      // can see they need to either tag products as Kids or remove
      // the Kids chip from their gender question.
      console.log(
        `[orthotic-flow] kids classifier-extracted but no Kids items in masterIndex; ` +
          `falling through to LLM`,
      );
      return { handled: false };
    }
    // ALWAYS override useCase to a kids-available value when
    // gender=Kids. The merchant's Kids line spans a few useCase
    // buckets (kids / dress / casual) and the customer's earlier-
    // mentioned shoe-context doesn't have a Kids SKU behind it.
    // Priority: prefer the literal "kids" useCase if available
    // (it's the merchant's general kids line, useCase-agnostic),
    // otherwise lex-first. The conversation eval caught the
    // alphabetical-sort picking "casual" over "kids".
    const target = allowed.has("kids") ? "kids" : [...allowed].sort()[0];
    if (answers.useCase !== target) {
      console.log(
        `[orthotic-flow] kids auto-fill: useCase=${answers.useCase || "(unset)"} → ${target} ` +
          `(kids-available=${[...allowed].join(",")})`,
      );
      answers.useCase = target;
    }
  }

  // Hard veto: customer explicitly rejected orthotics in their
  // latest message. Classifier-first; regex fallback only when the
  // classifier didn't run (network error etc).
  const rejected = classifiedIntent
    ? classifiedIntent.isRejection
    : hasOrthoticRejection(rawUserText);
  if (rejected) {
    return { handled: false };
  }

  // Off-topic side question mid-flow. If the classifier confidently
  // says the latest message is NEITHER orthotic NOR footwear (e.g.
  // 'are you a real person', 'what's your return policy', 'how long
  // does shipping take'), AND the latest message doesn't look like a
  // chip click, fall through to the LLM so it can answer the side
  // question. The next turn will resume the flow naturally.
  //
  // Without this, customers asking side questions mid-orthotic-flow
  // see the bot re-emit the chip question instead of answering them
  // — broken UX. The eval caught this on a 9-turn scenario.
  if (
    classifiedIntent &&
    classifiedIntent.isOrthoticRequest === false &&
    classifiedIntent.isFootwearRequest === false &&
    classifiedIntent.isRejection === false
  ) {
    // Check whether the latest message is a chip click (would map to
    // an attribute via preExtractAnswers). If so, the classifier is
    // wrong — the customer DID answer a chip — treat as in-flow.
    const latestExtractedCheck = preExtractAnswers(rawUserText, tree.definition);
    const isChipShaped = Object.keys(latestExtractedCheck).length > 0;
    if (!isChipShaped) {
      console.log(
        `[orthotic-flow] off-topic side question mid-flow (classifier: neither ortho nor footwear); falling through to LLM`,
      );
      return { handled: false };
    }
  }

  // Hard veto #1: customer committed to the FOOTWEAR path — either
  // in the latest message or in a prior turn. Classifier-first; the
  // classifier returns isFootwearRequest=true when the customer is
  // shoe-shopping AND isOrthoticRequest=false. The latest-message
  // pivot rule (orthotic intent overrides prior footwear commit)
  // is implicit in the classifier's joint output.
  const intentInLatestForVeto = classifiedIntent
    ? classifiedIntent.isOrthoticRequest
    : detectOrthoticIntent(rawUserText);
  const footwearCommitInLatest = classifiedIntent
    ? classifiedIntent.isFootwearRequest
    : looksLikeFootwearCommit(rawUserText);
  const footwearCommitInPrior =
    !intentInLatestForVeto &&
    priorMessages.some(
      (m) =>
        m &&
        m.role === "user" &&
        typeof m.content === "string" &&
        looksLikeFootwearCommit(m.content),
    );
  if (footwearCommitInLatest || footwearCommitInPrior) {
    console.log(
      `[orthotic-flow] footwear-path veto: customer committed to footwear ` +
        `(${footwearCommitInLatest ? "latest" : "prior"}); falling through to LLM`,
    );
    return { handled: false };
  }

  // Hard veto #2: latest message names a concrete non-orthotic
  // footwear product (shoes, sandals, sneakers, boots, loafers,
  // oxfords, slippers, clogs, mary janes, trainers, footwear,
  // wedges, heels, flats, pumps, mules). Production showed
  // "best summer sandal for a beach for my mom" slipping past
  // looksLikeFootwearCommit (no find/show/need/want trigger word)
  // and engaging the orthotic flow because Layer 2 picked gender=
  // Women from "for my mom". Catching the product noun directly
  // is more robust than enumerating phrasings.
  //
  // BUT only apply this when no orthotic intent is already
  // established in history. Once a customer has said "I need
  // orthotics" earlier in the conversation, their later messages
  // ARE expected to mention footwear nouns — they're answering
  // questions like "What kind of shoes will the orthotics go in?"
  // with chip values like "Everyday / casual shoes". Without this
  // intent-history bypass, the veto would catch chip clicks and
  // bump the customer out of mid-flow. Equivalent guard already
  // lives inside looksLikeFootwearCommit via detectOrthoticIntent
  // for the latest message; the history-level intent check covers
  // the multi-turn case.
  const intentAnywhereInHistory =
    intentInLatestForVeto ||
    priorMessages.some(
      (m) => m && m.role === "user" && typeof m.content === "string" &&
        detectOrthoticIntent(m.content),
    );
  if (!intentAnywhereInHistory && mentionsNonOrthoticFootwear(rawUserText)) {
    console.log(
      `[orthotic-flow] non-orthotic-footwear veto: latest names a footwear ` +
        `product without orthotic intent; falling through to LLM`,
    );
    return { handled: false };
  }

  // Off-topic + chip-fingerprint detection upfront — both are used
  // by the engagement rule below.
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
  const lastAssistantText = lastAssistant && typeof lastAssistant.content === "string"
    ? lastAssistant.content
    : "";
  const fingerprintNode = lastAssistantText && /<<[^<>]+>>/.test(lastAssistantText)
    ? findNodeByChipsInText(lastAssistantText, tree.definition)
    : null;

  // Classifier-first intent check. Haiku reads the entire trimmed
  // history and decides whether the customer is asking for an
  // orthotic — so intentInLatest already incorporates the history
  // signal. We still scan priorMessages for legacy regex on
  // classifier-failure paths.
  const intentInLatest = classifiedIntent
    ? classifiedIntent.isOrthoticRequest
    : detectOrthoticIntent(rawUserText);
  const intentInHistory =
    intentInLatest ||
    priorMessages.some(
      (m) =>
        m &&
        m.role === "user" &&
        typeof m.content === "string" &&
        detectOrthoticIntent(m.content),
    );
  const haveAccumulated = Object.keys(accumulated).length > 0;

  // Engagement rule. The customer must EITHER have expressed clear
  // orthotic intent at some point in the conversation, OR be on a
  // recognized seed question (fingerprintNode) — accumulated answers
  // alone are NOT enough.
  //
  // Production scenario this rule fixes: customer browses sneakers
  // and sandals across several turns. Layer 2 incidentally picks up
  // gender=Women from "for my mom" or pronouns. Accumulated answers
  // grow without any orthotic context. Then the customer asks for a
  // sandal — and the gate would have engaged purely because
  // haveAccumulated was true. With this rule it does not, since
  // intentInHistory stays false on a footwear-only conversation.
  if (!intentInHistory && !fingerprintNode) {
    return { handled: false };
  }
  if (fingerprintNode && isOffTopicReply(rawUserText, fingerprintNode)) {
    console.log(
      `[orthotic-flow] off-topic reply on ${fingerprintNode.id} ("${rawUserText.slice(0, 40)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // If the latest message didn't already give us the current
  // node's answer via Layer 1/2, try Layer 3 (constrained Haiku
  // call) as a last sync-mappable resort. Only worth doing when we
  // have a reliable currentNode handle from the chip fingerprint.
  let layer3Attempted = false;
  let layer3Mapped = false;
  if (
    fingerprintNode &&
    fingerprintNode.attribute &&
    answers[fingerprintNode.attribute] === undefined
  ) {
    const askLLM = anthropic && haikuModel ? makeLayer3Hook(anthropic, haikuModel) : null;
    layer3Attempted = true;
    const mapped = await mapAnswerToEnum(
      rawUserText,
      fingerprintNode,
      tree.definition,
      askLLM ? { askLLM } : {},
    );
    if (mapped && mapped.value !== null && mapped.value !== undefined) {
      answers[fingerprintNode.attribute] = mapped.value;
      layer3Mapped = true;
      console.log(
        `[orthotic-flow] layer-${mapped.layer} mapped ${fingerprintNode.id} → ` +
          `${fingerprintNode.attribute}=${mapped.value}`,
      );
    }
  }

  // If the chip fingerprint was the ONLY engagement signal (no
  // prior intent, no prior accumulated answers, no Layer-1/2 hit
  // on the latest message) AND mapping the latest reply to that
  // current node failed across all layers, the customer's reply is
  // off-topic / unmappable for that question. Yield to the LLM —
  // emitting the next seed question would feel like a non-sequitur.
  if (
    fingerprintNode &&
    !intentInHistory &&
    !haveAccumulated &&
    Object.keys(latestExtracted).length === 0 &&
    layer3Attempted &&
    !layer3Mapped
  ) {
    console.log(
      `[orthotic-flow] reply on ${fingerprintNode.id} unmappable across layers; falling through to LLM`,
    );
    return { handled: false };
  }

  // Informational-question mid-flow veto. The customer IS engaged in
  // orthotic flow (intentInHistory or fingerprintNode), but THIS turn
  // is asking what something IS / how it works / what its specs are
  // — not answering a chip and not requesting a recommendation. The
  // LLM (with RAG knowledge) is the right path. Without this veto:
  //
  //   - With full attrs already accumulated, gate walks to resolve
  //     and emits a phantom card on questions like "what is
  //     thinsole?" — production trace bug.
  //   - With partial attrs, gate emits the next chip question on
  //     unrelated info questions like "tell me about the L620" —
  //     bad UX.
  //
  // Bypass conditions (don't fire the veto):
  //   - Latest message extracted a new attribute → it's a chip
  //     answer, not an info question.
  //   - Layer 3 mapped the reply onto the fingerprint chip → also a
  //     chip answer.
  //   - Prior assistant message had chip syntax (fingerprintNode is
  //     set) → customer might be answering the chip question with an
  //     info-shaped reply ("yes, but how does this work?"). Defer.
  if (
    looksLikeInformationalQuestion(rawUserText) &&
    !looksLikeRecommendationRequest(rawUserText) &&
    Object.keys(latestExtracted).length === 0 &&
    !layer3Mapped &&
    !fingerprintNode
  ) {
    console.log(
      `[orthotic-flow] informational question mid-flow ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Availability-question mid-flow veto. Customer asked "do you have
  // X / do you carry Y / are there any Z" — a yes/no availability
  // question. Gate would otherwise emit the next chip question
  // ("What's your arch type?") on every turn, looping. The LLM must
  // answer yes/no with cards (or honest denial).
  //
  // NOTE: unlike the informational-question veto above, this one
  // does NOT require empty latestExtracted. The phrase "do you have
  // kids orthotics?" legitimately extracts useCase=kids via the
  // attribute pre-extractor — but the customer's INTENT is yes/no
  // availability, not a chip-flow continuation. The chip flow can
  // resume on the next turn if the customer wants to refine.
  // The fingerprintNode check still applies — if the prior assistant
  // message was a chip question, the customer might be answering it
  // with an info-shaped reply (e.g. "yes, but do you have kids?"),
  // and we defer to the chip-mapping logic.
  if (
    looksLikeAvailabilityQuestion(rawUserText) &&
    !looksLikeRecommendationRequest(rawUserText) &&
    !fingerprintNode
  ) {
    console.log(
      `[orthotic-flow] availability question mid-flow ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Pick the next question node by `requiredAttributes` order rather
  // than following the seed's `next` chain. This guarantees gender
  // is always asked first, then useCase, then condition — regardless
  // of how the merchant's DB-stored tree happens to be wired (the
  // canonical seed file says gender-first but older DB copies may
  // still chain useCase → gender → condition). When all required
  // attributes are filled, fall through to the seed's node chain so
  // the resolve step at the end still fires.
  const required = Array.isArray(tree.definition?.requiredAttributes)
    ? tree.definition.requiredAttributes.filter((s) => typeof s === "string")
    : [];
  let currentNodeId = null;
  for (const attr of required) {
    if (answers[attr] !== undefined) continue;
    const candidate = (tree.definition?.nodes || []).find(
      (n) => n && n.type === "question" && n.attribute === attr,
    );
    if (candidate) {
      currentNodeId = candidate.id;
      break;
    }
  }
  // All required attrs are filled (or no requiredAttributes defined):
  // walk the seed chain from root, skipping past answered nodes,
  // until we land on the resolve step.
  if (!currentNodeId) {
    const root = getRootNode(tree.definition);
    if (!root) return { handled: false };
    currentNodeId = root.id;
    for (let i = 0; i < 16; i++) {
      const node = findNodeById(tree.definition, currentNodeId);
      if (!node || node.type !== "question") break;
      if (!node.attribute || answers[node.attribute] === undefined) break;
      const nextId = nextNodeFromTransition(node, answers[node.attribute]);
      if (!nextId) break;
      currentNodeId = nextId;
    }
  }

  const state = { currentNodeId, answers, unmappedTurns: 0 };
  const step = resolveSkippableSteps(state, tree.definition);

  if (step.type === "question") {
    // Note: there used to be a "stuck-loop" detector here that fired
    // when the same question was asked twice in a row. It was too
    // aggressive — false-positives on legitimate corrections, fragment
    // answers, and "ok / next / go on" keep-alives. Removed.
    //
    // The production trace that motivated it ('knee pain' loop) is
    // now handled at the classifier level: the classifier prompt
    // explicitly maps non-foot pain (knee/back/hip) to
    // condition='none' so the resolver picks a general orthotic
    // and the flow advances.

    const text = renderQuestionText(step.node, answers, tree);
    if (!text) return { handled: false };
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] emitted seed question ${step.node.id} (${step.node.attribute}); ` +
        `answers=${Object.keys(answers).length} (${describeAnswers(answers)}); bypassed LLM`,
    );
    return { handled: true };
  }

  if (step.type === "resolve") {
    // Resolve-intent guard. Don't auto-emit a card just because all
    // required attributes happen to be filled from earlier turns. The
    // bug this fixes: customer says "what is thinsole?" mid-flow with
    // gender/useCase/condition already accumulated. Without this
    // guard, the gate walks straight to resolve and emits the same
    // phantom SKU card on every ortho-tagged turn — customer asked an
    // informational question, gets a product card, never learns what
    // a Thinsole is.
    //
    // Only auto-resolve when ONE of these is true:
    //   (a) The customer just answered a chip — fingerprintNode is
    //       set AND this turn produced a Layer-1/2/3 mapping. The
    //       last assistant message offered chip buttons and the
    //       customer answered them.
    //   (b) The latest message extracted at least one new attribute.
    //       Customer is providing the missing piece. (This subsumes
    //       (a) for most cases, but kept separate for clarity.)
    //   (c) The latest message is an explicit recommendation request
    //       ("show me / recommend / find me one / I'll take it / go
    //       ahead / sounds good / let's do it").
    //
    // OVERRIDE: if the message looks like an informational question
    // ("what is X / explain Y / tell me about Z"), fall through even
    // if (b) or (c) match. The customer's intent is to learn, not
    // to buy. A subsequent "yes, recommend one" can re-trigger.
    //
    // Otherwise: fall through to LLM. The LLM still has the
    // recommend_orthotic tool and can call it when it judges that's
    // what the customer actually wants.
    const justAnsweredChip =
      !!fingerprintNode && (Object.keys(latestExtracted).length > 0 || layer3Mapped);
    const completedAttrThisTurn = Object.keys(latestExtracted).length > 0;
    const explicitRecRequest = looksLikeRecommendationRequest(rawUserText);
    const informationalQuestion = looksLikeInformationalQuestion(rawUserText);
    const hasResolveSignal =
      (justAnsweredChip || completedAttrThisTurn || explicitRecRequest) &&
      !informationalQuestion;
    if (!hasResolveSignal) {
      console.log(
        `[orthotic-flow] resolve held: full attrs but no recommendation signal in latest turn ` +
          `("${rawUserText.slice(0, 60)}"); ` +
          `informational=${informationalQuestion}, justAnsweredChip=${justAnsweredChip}, ` +
          `completedAttr=${completedAttrThisTurn}, explicitReq=${explicitRecRequest}; ` +
          `falling through to LLM`,
      );
      return { handled: false };
    }

    const conversationText = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    let result = await executeRecommenderTool({
      toolName: `recommend_${ORTHOTIC_INTENT}`,
      input: step.attrs,
      shop,
      trees: [tree],
      conversationText,
      latestUserText: rawUserText,
    });
    // Kids safety-net retry. If the first resolve fails for a Kids
    // customer, force useCase to the first kids-available value
    // and try again. The auto-fill above SHOULD prevent ever
    // reaching here with a non-kids useCase, but production has
    // shown cases where it didn't fire (stale data, edge cases),
    // and the failure mode is brutal — customer dead-ends after a
    // 4-question form. This retry is defense-in-depth: if a Kids
    // customer reaches here unresolved, force the kids line and
    // try once more.
    if (
      (result?.error || !result?.product) &&
      isKidsGenderValue(step.attrs?.gender)
    ) {
      const kidsAllowed = kidsAvailableUseCases(tree);
      if (kidsAllowed && kidsAllowed.size > 0) {
        const kidsTarget = kidsAllowed.has("kids")
          ? "kids"
          : [...kidsAllowed].sort()[0];
        if (step.attrs.useCase !== kidsTarget) {
          console.log(
            `[orthotic-flow] kids resolve retry: useCase=${step.attrs.useCase || "(unset)"} → ${kidsTarget}`,
          );
          const retryAttrs = { ...step.attrs, useCase: kidsTarget };
          const retry = await executeRecommenderTool({
            toolName: `recommend_${ORTHOTIC_INTENT}`,
            input: retryAttrs,
            shop,
            trees: [tree],
            conversationText,
            latestUserText: rawUserText,
          });
          if (retry?.product) {
            result = retry;
            step.attrs = retryAttrs;
          }
        }
      }
    }
    if (result?.error || !result?.product) {
      console.log(
        `[orthotic-flow] resolve failed (${result?.error || "no product"}); falling through to LLM`,
      );
      return { handled: false };
    }
    const card = formatRecommenderCard(result.product);
    if (!card) {
      console.log(
        `[orthotic-flow] resolved sku=${result.masterSku} but card formatting failed; falling through to LLM`,
      );
      return { handled: false };
    }
    const intro = buildResolveIntro(result, step.attrs);
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text: intro })));
    controller.enqueue(encoder.encode(sseChunk({
      type: "products",
      products: [card],
    })));
    // Auto-generated storefront search CTA below the resolved orthotic
    // card. Built from the customer's resolved gender + the implicit
    // "orthotics" category. Emits nothing if storefrontSearchUrlPattern
    // is empty (default), preserving back-compat for shops that
    // haven't opted in.
    if (storefrontSearchUrlPattern || (Array.isArray(ctaOverrides) && ctaOverrides.length > 0)) {
      const lastUserText = (() => {
        for (let i = (messages || []).length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m?.role === "user" && typeof m.content === "string") return m.content;
        }
        return "";
      })();
      const auto = buildStorefrontSearchCTA({
        pattern: storefrontSearchUrlPattern,
        overrides: ctaOverrides,
        gender: step.attrs?.gender || answers?.gender || "",
        category: "orthotics",
        latestUserMessage: lastUserText,
        intent: "orthotic",
      });
      if (auto) {
        controller.enqueue(encoder.encode(sseChunk({
          type: "link",
          url: auto.url,
          label: auto.label,
        })));
      }
    }
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] resolved → ${result.masterSku} (${result.title}); ` +
        `answers=${describeAnswers(answers)}; emitted card; bypassed LLM`,
    );
    return { handled: true };
  }

  console.log(`[orthotic-flow] unexpected step type=${step.type}; falling through`);
  return { handled: false };
}

function describeAnswers(answers) {
  const entries = Object.entries(answers || {});
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function buildResolveIntro(result, attrs) {
  const title = String(result?.title || "this orthotic").trim();
  const reasonBits = [];
  if (attrs?.condition && attrs.condition !== "none") {
    reasonBits.push(humanizeCondition(attrs.condition));
  }
  if (attrs?.useCase) {
    reasonBits.push(humanizeUseCase(attrs.useCase));
  }
  if (attrs?.arch) {
    reasonBits.push(`${attrs.arch.toLowerCase()}`);
  }
  if (reasonBits.length === 0) {
    return `Based on what you've shared, **${title}** is the best match.`;
  }
  return `Based on what you've shared (${reasonBits.join(", ")}), **${title}** is the best match.`;
}

function humanizeCondition(c) {
  switch (c) {
    case "plantar_fasciitis": return "plantar fasciitis";
    case "heel_spurs":        return "heel spurs";
    case "metatarsalgia":     return "ball-of-foot pain";
    case "mortons_neuroma":   return "Morton's neuroma";
    case "diabetic":          return "diabetic foot care";
    default: return c;
  }
}

// Build a Layer 3 LLM hook bound to the given Anthropic client +
// model id. The hook signature matches what mapAnswerToEnum expects:
// `async (rawAnswer, node, tree) => { value }`. Returns null on
// errors so the orchestrator can fall through cleanly.
function makeLayer3Hook(anthropic, model) {
  return async function askLLM(rawAnswer, node /* , tree */) {
    const prompt = buildConstrainedAnswerPrompt(rawAnswer, node);
    if (!prompt) return { value: null };
    try {
      const res = await anthropic.messages.create({
        model,
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      });
      const text = res?.content?.[0]?.text || "";
      const value = parseConstrainedAnswerResponse(text, node);
      return { value };
    } catch (err) {
      // Re-throw so mapAnswerToEnum's catch records it as
      // layer="llm-error" — caller (gate) treats that as unmapped.
      throw err;
    }
  };
}

function humanizeUseCase(u) {
  switch (u) {
    case "casual":             return "everyday casual shoes";
    case "comfort":            return "general comfort";
    case "athletic_running":   return "running";
    case "athletic_training":  return "gym / training";
    case "athletic_general":   return "athletic / court";
    case "cleats":             return "cleats";
    case "skates":             return "hockey skates";
    case "winter_boots":       return "winter boots";
    case "work_all_day":       return "long days on your feet";
    case "dress":              return "dress shoes";
    case "dress_no_removable": return "dress shoes (no removable insole)";
    case "dress_premium":      return "premium dress shoes";
    default: return u;
  }
}
