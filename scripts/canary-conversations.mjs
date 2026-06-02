// Cheap manual-canary pass: walk five scripted conversations through
// the deterministic intent + memory pipeline (no Anthropic, no DB)
// and print what happens at each user turn. Verifies the recent
// consolidations behave correctly on the production-shaped flows
// without running the hunter or spinning up the real chat stack.
//
// Reports:
//   - intent.label / .reason / .staleKeysToDrop for the last user turn
//   - memory.explicit scope after each user turn
//   - asserts the expected behavior (intent label, key drops, scope
//     preservation) per the canary brief

import assert from "node:assert/strict";
import { buildSessionMemory } from "../app/lib/session-memory.server.js";

const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

// Helper: build memory at turn N (slice of messages up to and including
// the N-th user message). Returns the memory after that turn.
function memoryAt(messages) {
  return buildSessionMemory({ messages });
}

function fmtScope(memory) {
  const e = memory.explicit || {};
  return Object.entries(e)
    .filter(([k, v]) => k !== "rejectedCategories" && v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "(empty)";
}

function fmtIntent(memory) {
  const i = memory.latestTurnIntent || {};
  return `label=${i.label} reason=${i.reason} drop=[${(i.staleKeysToDrop || []).join(",")}]`;
}

console.log("Canary pass — 5 scripted conversations\n");

// ===========================================================================
// C1 — "women black sandals" → "how about mens?"
// Expected: gender-only continuation; category/color preserved across pivot.
// ===========================================================================
console.log("C1 — women black sandals → how about mens?");
{
  const m1 = memoryAt([u("I'm looking for black sandals for women")]);
  const m2 = memoryAt([
    u("I'm looking for black sandals for women"),
    a("Here are some women's black sandals"),
    u("how about mens?"),
  ]);
  console.log(`    T1 scope: ${fmtScope(m1)}`);
  console.log(`    T2 scope: ${fmtScope(m2)}  intent: ${fmtIntent(m2)}`);
  check("C1 — T2 is gender-only continuation", () => {
    assert.equal(m2.latestTurnIntent?.label, "continue");
    assert.equal(m2.latestTurnIntent?.reason, "gender_only_continuation");
  });
  check("C1 — gender pivots to men", () => {
    assert.equal(m2.explicit.gender, "men");
  });
  check("C1 — category survives the gender pivot", () => {
    assert.equal(m2.explicit.category, "sandals");
  });
  check("C1 — color survives the gender pivot", () => {
    assert.equal(m2.explicit.color, "black");
  });
  console.log();
}

// ===========================================================================
// C2 — "white men's sneakers" → "are there other colors?"
// Expected: meta/fact turn; scope preserved; downstream direct-fact path
// catches it (verified at response-contract layer).
// ===========================================================================
console.log("C2 — white men's sneakers → are there other colors?");
{
  const m1 = memoryAt([u("show me white men's sneakers")]);
  const m2 = memoryAt([
    u("show me white men's sneakers"),
    a("Here are some white men's sneakers."),
    u("are there other colors?"),
  ]);
  console.log(`    T1 scope: ${fmtScope(m1)}`);
  console.log(`    T2 scope: ${fmtScope(m2)}  intent: ${fmtIntent(m2)}`);
  check("C2 — T2 is meta/fact (yes-no inverted)", () => {
    assert.equal(m2.latestTurnIntent?.label, "meta");
  });
  check("C2 — staleKeysToDrop is empty (scope preserved)", () => {
    assert.deepEqual(m2.latestTurnIntent?.staleKeysToDrop, []);
  });
  check("C2 — gender / category / color preserved", () => {
    assert.equal(m2.explicit.gender, "men");
    assert.equal(m2.explicit.category, "sneakers");
    assert.equal(m2.explicit.color, "white");
  });
  console.log();
}

// ===========================================================================
// C3 — "show me women's sneakers" → "compare the first two"
// Expected: compare_request meta; scope preserved; response-contract uses
// it to skip listing rewrite.
// ===========================================================================
console.log("C3 — show me women's sneakers → compare the first two");
{
  const m1 = memoryAt([u("show me women's sneakers")]);
  const m2 = memoryAt([
    u("show me women's sneakers"),
    a("Here are some women's sneakers."),
    u("compare the first two"),
  ]);
  console.log(`    T1 scope: ${fmtScope(m1)}`);
  console.log(`    T2 scope: ${fmtScope(m2)}  intent: ${fmtIntent(m2)}`);
  check("C3 — T2 is meta with reason=compare_request", () => {
    assert.equal(m2.latestTurnIntent?.label, "meta");
    assert.equal(m2.latestTurnIntent?.reason, "compare_request");
  });
  check("C3 — scope preserved (gender + category)", () => {
    assert.equal(m2.explicit.gender, "women");
    assert.equal(m2.explicit.category, "sneakers");
  });
  console.log();
}

// ===========================================================================
// C4 — "I'm going to Italy and need walking shoes for my bunions"
// Expected: this single turn extracts walking-related useCase + bunion
// condition; intent is a first-turn establishment (continue or refine);
// scope is built up cleanly without spurious drops.
// ===========================================================================
console.log("C4 — Italy / walking / bunion recommendation (single turn)");
{
  const m1 = memoryAt([u("I'm going to Italy and need walking shoes for my bunions")]);
  console.log(`    T1 scope: ${fmtScope(m1)}  intent: ${fmtIntent(m1)}`);
  check("C4 — bunion condition extracted", () => {
    assert.equal(m1.explicit.condition, "bunions");
  });
  check("C4 — no spurious stale drops on first turn", () => {
    assert.deepEqual(m1.latestTurnIntent?.staleKeysToDrop, []);
  });
  // Walking should also surface (either as useCase or implicit context).
  // We don't assert hard on useCase because the extractor maps "walking"
  // to a use-case key only when it's the clinical "walking_everyday"
  // bucket; either way, scope should not be wrong.
  check("C4 — no carry-over from nothing (scope is just what was said)", () => {
    // gender wasn't mentioned, so it must be undefined.
    assert.equal(m1.explicit.gender, undefined);
  });
  console.log();
}

// ===========================================================================
// C5 — frustration check: prior context + "do you even understand what
// I'm saying?"
// Expected: meta intent; scope preserved; response-contract meta
// short-circuit keeps AI's apology / clarification reply intact.
// ===========================================================================
console.log("C5 — prior context → do you even understand what I'm saying?");
{
  const m1 = memoryAt([
    u("show me white women's wedge heels"),
    a("Here are some women's wedge heels."),
    u("how about that one for $50?"),
    a("That style is currently $104.97."),
    u("do you even understand what I'm saying?"),
  ]);
  console.log(`    T-last scope: ${fmtScope(m1)}  intent: ${fmtIntent(m1)}`);
  check("C5 — meta intent on frustration check", () => {
    assert.equal(m1.latestTurnIntent?.label, "meta");
    assert.equal(m1.latestTurnIntent?.reason, "meta_conversational");
  });
  check("C5 — scope preserved across the meta turn", () => {
    assert.deepEqual(m1.latestTurnIntent?.staleKeysToDrop, []);
    assert.equal(m1.explicit.gender, "women");
    assert.equal(m1.explicit.category, "wedges-heels");
    assert.equal(m1.explicit.color, "white");
  });
  console.log();
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`FAILURE: ${f.name}\n  ${f.err.stack || f.err.message}`);
  process.exit(1);
}
