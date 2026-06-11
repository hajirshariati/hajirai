// Pre-gate for the Haiku orthotic classifier. Locks in the bypass
// matrix so cost optimization can't accidentally turn into a quality
// regression: any orthotic-flow signal or foot-condition pivot must
// always run the classifier; routine footwear browsing must always
// bypass it.

import assert from "node:assert/strict";
import { shouldRunOrthoticClassifier } from "../app/lib/orthotic-classifier.server.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

function user(text) { return [{ role: "user", content: text }]; }

console.log("classifier-gate — invocations the classifier MUST handle:");

test("ortho vocab — 'orthotics'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("do you have orthotics?") }), true);
});
test("ortho vocab — common typo 'orhtotics'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("do you have orhtotics?") }), true);
});
test("ortho vocab — 'insoles'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("I need new insoles") }), true);
});
test("ortho vocab — 'arch support'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("looking for shoes with arch support") }), true);
});
test("foot condition — 'plantar fasciitis'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("I have plantar fasciitis") }), true);
});
test("foot condition — 'flat feet'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("I have flat feet") }), true);
});
test("foot condition — 'high arch'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("high arch friendly?") }), true);
});
test("foot condition — 'diabetic-friendly'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("diabetic-friendly options?") }), true);
});
test("foot condition — 'bunion'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("anything good for bunions?") }), true);
});
test("recipient ambiguity — 'for my son'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("looking for shoes for my son") }), true);
});
test("recipient ambiguity — 'for my mom'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("something for my mom") }), true);
});
test("active flow — prior assistant turn referenced orthotics", () => {
  const messages = [
    { role: "user", content: "show me orthotics" },
    { role: "assistant", content: "Who are these orthotics for — men, women, or kids?" },
    { role: "user", content: "women" }, // bare answer would otherwise bypass
  ];
  assert.equal(shouldRunOrthoticClassifier({ messages }), true);
});

console.log("\nclassifier-gate — invocations the classifier should bypass:");

test("plain footwear browse — 'pink shoes'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("show me pink shoes") }), false);
});
test("plain footwear browse — 'sneakers in size 8'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("do you have sneakers in size 8?") }), false);
});
test("comparison — 'X vs Y'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("what's the difference between the Maui and the Reagan?") }), false);
});
test("greeting — 'hi'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("hi") }), false);
});
test("policy — 'return policy?'", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: user("what is your return policy?") }), false);
});
test("empty input → false", () => {
  assert.equal(shouldRunOrthoticClassifier({ messages: [] }), false);
});
