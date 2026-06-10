// Gender-lock eval suite.
//
// injectLockedGender enforces the customer's established gender onto
// search tool calls, overriding the AI when it drifts. That override
// is correct MOST of the time — but it caused a production dead-end:
// the lock was stuck on "men" while the AI (correctly) searched a
// women-only category like heels. Forcing gender=men onto men's heels
// returns zero results and the bot says "we don't have men's", which
// baffles a customer who was shopping for their mom.
//
// The guard under test: when forcing the locked gender onto a category
// the catalog does NOT carry in that gender — but DOES carry in the
// AI's gender — the lock is provably wrong for THIS query. Trust the
// AI's gender instead of guaranteeing an empty search.
//
// Pure-function tests — no DB, no Anthropic.

import assert from "node:assert/strict";
import { injectLockedGender } from "../app/lib/chat-tool-rewrite.server.js";

// This file tests the LEGACY gender-lock injector, which no-ops when
// LLM_OWNS_ALL_TURNS is active (production default). Pin the flag OFF
// so the kill-switch path's contract stays covered.
process.env.LLM_OWNS_ALL_TURNS = "false";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

// Aetrex-shaped availability map: heels are women-only, sneakers exist
// in both, boots women-only here.
const CATEGORY_GENDER_MAP = {
  heels: { display: "Heels", genders: ["women"] },
  wedges: { display: "Wedges", genders: ["women"] },
  sneakers: { display: "Sneakers", genders: ["men", "women"] },
  sandals: { display: "Sandals", genders: ["women"] },
};

const call = (filters) => ({ name: "search_products", input: { filters } });

await test("G1 — locked men + women-only heels + AI said women → do NOT override (trust AI)", async () => {
  const ctx = { sessionGender: "men", categoryGenderMap: CATEGORY_GENDER_MAP };
  const out = injectLockedGender(call({ gender: "women", category: "heels" }), ctx);
  assert.equal(out.input.filters.gender, "women", "must keep AI's women on a women-only category");
});

await test("G1b — canonical 'wedges-heels' resolves to the women-only heels/wedges keys", async () => {
  const ctx = { sessionGender: "men", categoryGenderMap: CATEGORY_GENDER_MAP };
  const out = injectLockedGender(call({ gender: "women", category: "wedges-heels" }), ctx);
  assert.equal(out.input.filters.gender, "women", "canonical category must map to raw heels/wedges keys");
});

await test("G2 — locked men + shared sneakers → override stands (normal lock behavior)", async () => {
  const ctx = { sessionGender: "men", categoryGenderMap: CATEGORY_GENDER_MAP };
  const out = injectLockedGender(call({ gender: "women", category: "sneakers" }), ctx);
  assert.equal(out.input.filters.gender, "men", "shared category → lock still wins");
});

await test("G3 — unknown category → conservative, override stands", async () => {
  const ctx = { sessionGender: "men", categoryGenderMap: CATEGORY_GENDER_MAP };
  const out = injectLockedGender(call({ gender: "women", category: "espadrilles" }), ctx);
  assert.equal(out.input.filters.gender, "men", "can't confirm impossibility → keep existing lock behavior");
});

await test("G4 — no category on the call → conservative, override stands", async () => {
  const ctx = { sessionGender: "men", categoryGenderMap: CATEGORY_GENDER_MAP };
  const out = injectLockedGender(call({ gender: "women" }), ctx);
  assert.equal(out.input.filters.gender, "men", "no category to check → keep existing lock behavior");
});

await test("G5 — AI omitted gender → inject the lock (unchanged)", async () => {
  const ctx = { sessionGender: "men", categoryGenderMap: CATEGORY_GENDER_MAP };
  const out = injectLockedGender(call({ category: "sneakers" }), ctx);
  assert.equal(out.input.filters.gender, "men", "omitted gender still gets the lock injected");
});

await test("G6 — no map available → conservative, override stands", async () => {
  const ctx = { sessionGender: "men" };
  const out = injectLockedGender(call({ gender: "women", category: "heels" }), ctx);
  assert.equal(out.input.filters.gender, "men", "no map → keep existing lock behavior");
});

// 2026-06-02 Railway live failure: live category map keyed
// "wedges heels" (raw merchant label, lowercased with space). Lookup
// received the canonical hyphenated form "wedges-heels" and missed
// both the full key and per-token entries. Gender-lock then
// overrode women → men three times in a row on a women-only category.
await test("G7 — map keyed with SPACE only (no hyphen, no per-token entries) still resolves canonical hyphenated category", async () => {
  // No "wedges" or "heels" individual keys — only the space-joined
  // raw label, which mirrors the f031fc-3 production catalog.
  const spaceOnlyMap = {
    "wedges heels": { display: "Wedges Heels", genders: ["women"] },
    sneakers: { display: "Sneakers", genders: ["men", "women"] },
  };
  const ctx = { sessionGender: "men", categoryGenderMap: spaceOnlyMap };
  const out = injectLockedGender(call({ gender: "women", category: "wedges-heels" }), ctx);
  assert.equal(out.input.filters.gender, "women",
    `gender-lock must yield to women-only category even when only space-form key exists; got ${out.input.filters.gender}`);
});

console.log("");
if (failed > 0) {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`  ${f.name}:\n    ${f.err.stack || f.err.message}`);
  process.exit(1);
} else {
  console.log(`PASS  ${passed} passed, 0 failed`);
}
