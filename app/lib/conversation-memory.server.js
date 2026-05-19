import {
  extractChoiceEvents,
  extractChoiceOptions,
  stripChoiceOptions,
} from "./choice-events.server.js";

export { extractChoiceOptions, stripChoiceOptions };

export function extractAnsweredChoices(messages, { limit = 8 } = {}) {
  return extractChoiceEvents(messages, { limit }).map((event) => ({
    question: event.question,
    answer: event.answer,
    rawAnswer: event.rawAnswer,
    options: event.options,
  }));
}
