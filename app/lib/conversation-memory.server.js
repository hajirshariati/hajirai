function normalizeChoice(text) {
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

function answerMatchesOption(answer, option) {
  const a = normalizeChoice(answer);
  const o = normalizeChoice(option);
  if (!a || !o) return false;
  if (a === o) return true;
  return containsNormalizedPhrase(a, o);
}

export function extractAnsweredChoices(messages, { limit = 8 } = {}) {
  const answered = [];

  for (let i = 0; i < (messages || []).length - 1; i++) {
    const assistant = messages[i];
    const user = messages[i + 1];
    if (assistant?.role !== "assistant" || user?.role !== "user") continue;
    if (typeof assistant.content !== "string" || typeof user.content !== "string") continue;

    const options = extractChoiceOptions(assistant.content);
    if (options.length === 0) continue;

    const matchedOption = [...options]
      .sort((a, b) => normalizeChoice(b).length - normalizeChoice(a).length)
      .find((option) => answerMatchesOption(user.content, option));
    if (!matchedOption) continue;

    const question = stripChoiceOptions(assistant.content);
    if (!question) continue;

    answered.push({
      question,
      answer: matchedOption,
      rawAnswer: user.content.trim(),
      options,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (let i = answered.length - 1; i >= 0; i--) {
    const item = answered[i];
    const key = normalizeChoice(item.question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.reverse().slice(-limit);
}
