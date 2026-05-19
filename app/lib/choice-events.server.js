export function normalizeChoice(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsNormalizedPhrase(text, phrase) {
  if (!text || !phrase) return false;
  return new RegExp(`(^| )${escapeRegExp(phrase)}( |$)`).test(text);
}

export function extractChoiceOptions(text) {
  return Array.from(String(text || "").matchAll(/<<([^<>]+)>>/g))
    .map((m) => String(m[1] || "").trim())
    .filter(Boolean);
}

export function stripChoiceOptions(text) {
  return String(text || "")
    .replace(/<<[^<>]+>>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function answerMatchesOption(answer, option) {
  const a = normalizeChoice(answer);
  const o = normalizeChoice(option);
  if (!a || !o) return false;
  if (a === o) return true;
  return containsNormalizedPhrase(a, o);
}

const AFFIRMATIVE_REPLIES = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "please",
  "yes please", "sounds good", "do it", "show me", "go ahead",
]);
const NEGATIVE_REPLIES = new Set([
  "no", "nope", "nah", "not now", "not really", "no thanks",
]);

function classifyShortAffirmative(text) {
  const norm = normalizeChoice(text);
  if (!norm) return null;
  if (norm.split(" ").length > 4) return null;
  if (AFFIRMATIVE_REPLIES.has(norm)) return "Yes";
  if (NEGATIVE_REPLIES.has(norm)) return "No";
  return null;
}

function isLikelyQuestion(text) {
  return /\?\s*$/.test(String(text || "").trim());
}

export function mapChoiceToMemoryFact(label, question = "") {
  const lc = String(label).toLowerCase().trim();
  const q = String(question || "").toLowerCase();

  if (/^men'?s?$/.test(lc) || lc === "male") return { key: "gender", value: "men" };
  if (/^women'?s?$/.test(lc) || lc === "female") return { key: "gender", value: "women" };
  if (lc === "kids" || lc === "kid") return { key: "gender", value: "kids" };

  if (/flat\s*\/\s*low|low\s+arch|flat\s+feet/i.test(lc)) return { key: "arch", value: "low" };
  if (/medium\s*\/\s*high|medium\s+arch|high\s+arch/i.test(lc)) return { key: "arch", value: lc.includes("high") ? "high" : "medium" };
  if (/^(?:low|medium|high)(?:\s+arch)?$/.test(lc)) return { key: "arch", value: lc.replace(/\s+arch$/, "") };

  if (/plantar/i.test(lc)) return { key: "condition", value: "plantar_fasciitis" };
  if (/ball[- ]?of[- ]?foot|metatarsalgia/i.test(lc)) return { key: "condition", value: "metatarsalgia" };
  if (/morton/i.test(lc)) return { key: "condition", value: "mortons_neuroma" };
  if (/heel\s+spur/i.test(lc)) return { key: "condition", value: "heel_spur" };
  if (/bunion/i.test(lc)) return { key: "condition", value: "bunions" };
  if (/flat\s*feet|low\s*arch/i.test(lc)) return { key: "condition", value: "flat_feet" };
  if (/high\s*arch/i.test(lc)) return { key: "condition", value: "high_arch" };
  if (/general\s+comfort/i.test(lc)) return { key: "condition", value: "general_comfort" };

  if (/walking|everyday|comfort/i.test(lc)) return { key: "useCase", value: "comfort_walking_everyday" };
  if (/running|training|athletic|sport/i.test(lc)) return { key: "useCase", value: "athletic_training_sports" };
  if (/work|standing/i.test(lc)) return { key: "useCase", value: "standing_all_day" };

  if ((lc === "yes" || lc === "no") && /overpronat|roll inward|pronation/i.test(q)) {
    return { key: "overpronation", value: lc };
  }

  if (lc === "the shoes themselves" || lc === "footwear with arch support") {
    return { key: "category", value: "footwear" };
  }
  if (lc === "orthotic insole for these" || lc === "orthotic insole") {
    return { key: "category", value: "orthotics" };
  }
  return null;
}

function dedupeChoiceEvents(events, limit) {
  const deduped = [];
  const seen = new Set();
  for (let i = events.length - 1; i >= 0; i--) {
    const item = events[i];
    const key = normalizeChoice(item.question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.reverse().slice(-limit);
}

export function extractChoiceEvents(messages, { limit = 8 } = {}) {
  const events = [];

  for (let i = 0; i < (messages || []).length - 1; i++) {
    const assistant = messages[i];
    const user = messages[i + 1];
    if (assistant?.role !== "assistant" || user?.role !== "user") continue;
    if (typeof assistant.content !== "string" || typeof user.content !== "string") continue;

    const options = extractChoiceOptions(assistant.content);
    if (options.length > 0) {
      const matchedOption = [...options]
        .sort((a, b) => normalizeChoice(b).length - normalizeChoice(a).length)
        .find((option) => answerMatchesOption(user.content, option));
      if (!matchedOption) continue;

      const question = stripChoiceOptions(assistant.content);
      if (!question) continue;

      events.push({
        type: "chip_answer",
        question,
        answer: matchedOption,
        rawAnswer: user.content.trim(),
        options,
        fact: mapChoiceToMemoryFact(matchedOption, question),
        assistantTurnIndex: i,
        userTurnIndex: i + 1,
      });
    } else if (isLikelyQuestion(assistant.content)) {
      const classified = classifyShortAffirmative(user.content);
      if (!classified) continue;

      const question = String(assistant.content).trim();
      events.push({
        type: "short_answer",
        question,
        answer: classified,
        rawAnswer: user.content.trim(),
        options: ["Yes", "No"],
        fact: mapChoiceToMemoryFact(classified, question),
        assistantTurnIndex: i,
        userTurnIndex: i + 1,
      });
    }
  }

  return dedupeChoiceEvents(events, limit);
}
