import assert from "node:assert/strict";
import { buildKidsCoveragePrompt } from "../app/lib/kids-coverage.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err?.message?.split("\n")[0] || err}`);
  }
}

console.log("Kids coverage prompt eval\n");

test("kids scoped Orthotics + Accessories: says no kids shoes but yes kids orthotics/accessories", () => {
  const out = buildKidsCoveragePrompt({
    sessionGender: "kids",
    catalogProductTypes: ["Accessories", "Orthotics"],
  });
  assert.ok(out.prompt, "expected a kids coverage prompt");
  assert.match(out.prompt, /does NOT include.+kids.+footwear/i);
  assert.match(out.prompt, /DOES include.+Orthotics.+Accessories/i);
  assert.match(out.prompt, /simply chose Kids/i);
  assert.doesNotMatch(out.prompt, /do\s+not\s+pivot.+orthotic/i);
  assert.deepEqual(out.diagnostics.availableNonFootwear, ["Accessories", "Orthotics"]);
});

test("kids scoped Orthotics only: does not imply kids orthotics are absent", () => {
  const out = buildKidsCoveragePrompt({
    sessionGender: "kid",
    catalogProductTypes: ["Orthotics"],
  });
  assert.ok(out.prompt);
  assert.match(out.prompt, /DOES include.+Orthotics/i);
  assert.match(out.prompt, /Do not imply kids orthotics.+absent/i);
});

test("kids scoped real footwear: no honesty note injected", () => {
  const out = buildKidsCoveragePrompt({
    sessionGender: "kids",
    catalogProductTypes: ["Sneakers", "Orthotics"],
  });
  assert.equal(out.prompt, "");
  assert.equal(out.diagnostics.reason, "kids_footwear_available");
});

test("adult gender: no honesty note injected", () => {
  const out = buildKidsCoveragePrompt({
    sessionGender: "women",
    catalogProductTypes: ["Orthotics"],
  });
  assert.equal(out.prompt, "");
  assert.equal(out.diagnostics.reason, "not_kids_gender");
});

console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) console.log(`  ${f.name}:\n    ${f.err?.stack || f.err}`);
  process.exit(1);
}
