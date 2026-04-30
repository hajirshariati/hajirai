import assert from "node:assert/strict";
import { extractAnsweredChoices, extractChoiceOptions, stripChoiceOptions } from "../app/lib/conversation-memory.server.js";

const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

assert.deepEqual(
  extractChoiceOptions("Pick one <<Red>><<Blue / Green>><<Men's>>"),
  ["Red", "Blue / Green", "Men's"],
);

assert.equal(
  stripChoiceOptions("Which color? <<Red>><<Blue>>"),
  "Which color?",
);

const cases = [
  {
    name: "remembers pain answer and shoe context answer",
    messages: [
      u("My dad has foot pain and needs something inside his shoes."),
      a("Where is the pain? <<Arch / Heel>><<Ball of Foot>><<Both>>"),
      u("Both"),
      a("Which shoes will he wear them in? <<Running shoes>><<Casual shoes>>"),
      u("Running shoes"),
      u("I already said both."),
    ],
    expected: [
      ["Where is the pain?", "Both"],
      ["Which shoes will he wear them in?", "Running shoes"],
    ],
  },
  {
    name: "remembers gender answer",
    messages: [
      u("I need shoes."),
      a("Which styles would you like to browse? <<Men's>><<Women's>>"),
      u("Men's"),
    ],
    expected: [["Which styles would you like to browse?", "Men's"]],
  },
  {
    name: "remembers color answer",
    messages: [
      u("I want sandals."),
      a("Which color family do you prefer? <<Black>><<Blue>><<Brown>>"),
      u("blue"),
    ],
    expected: [["Which color family do you prefer?", "Blue"]],
  },
  {
    name: "remembers size answer with punctuation",
    messages: [
      u("I like this one."),
      a("What size should I check? <<7>><<7.5>><<8>>"),
      u("7.5 please"),
    ],
    expected: [["What size should I check?", "7.5"]],
  },
  {
    name: "does not invent memory if answer was not an offered option",
    messages: [
      u("I need shoes."),
      a("Which styles? <<Men's>><<Women's>>"),
      u("Either is fine"),
    ],
    expected: [],
  },
  {
    name: "latest answer for repeated same question wins",
    messages: [
      u("I need shoes."),
      a("Which color? <<Black>><<Blue>>"),
      u("Black"),
      a("Which color? <<Black>><<Blue>>"),
      u("Blue"),
    ],
    expected: [["Which color?", "Blue"]],
  },
  {
    name: "yes-reply to non-chip question is recorded as Yes",
    messages: [
      u("Can you help me find an orthotic?"),
      a("Sure — want me to show some options?"),
      u("yes please"),
    ],
    expected: [["Sure — want me to show some options?", "Yes"]],
  },
  {
    name: "no-reply to non-chip question is recorded as No",
    messages: [
      u("I'm just looking."),
      a("Should I show you some bestsellers?"),
      u("nope"),
    ],
    expected: [["Should I show you some bestsellers?", "No"]],
  },
  {
    name: "long answer to non-chip question is NOT auto-classified",
    messages: [
      u("Help me."),
      a("What kind of shoes do you usually wear?"),
      u("I usually wear sneakers but sometimes boots in winter."),
    ],
    expected: [],
  },
];

let passed = 0;
for (const testCase of cases) {
  const actual = extractAnsweredChoices(testCase.messages).map((item) => [item.question, item.answer]);
  assert.deepEqual(actual, testCase.expected, testCase.name);
  passed++;
}

console.log(`choice-memory eval passed: ${passed}/${cases.length}`);
