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

// Yes/no/sure replies that count as an affirmative answer to a non-chip
// assistant question ("Want me to show some?" → "yes please").
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

export function extractAnsweredChoices(messages, { limit = 8 } = {}) {
  const answered = [];

  for (let i = 0; i < (messages || []).length - 1; i++) {
    const assistant = messages[i];
    const user = messages[i + 1];
    if (assistant?.role !== "assistant" || user?.role !== "user") continue;
    if (typeof assistant.content !== "string" || typeof user.content !== "string") continue;

    const options = extractChoiceOptions(assistant.content);

    if (options.length > 0) {
      // Standard chip-driven match.
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
    } else if (isLikelyQuestion(assistant.content)) {
      // Non-chip yes/no question. Ends in a "?", user replied with a
      // short affirmative or negative. Record so the AI doesn't re-ask
      // "want me to show some?" after the user already said yes.
      const classified = classifyShortAffirmative(user.content);
      if (!classified) continue;

      const question = String(assistant.content).trim();
      answered.push({
        question,
        answer: classified,
        rawAnswer: user.content.trim(),
        options: ["Yes", "No"],
      });
    }
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
