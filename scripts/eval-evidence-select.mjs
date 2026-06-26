// Deterministic 2-3 card selection for condition/advisory recommendations.
// A condition_recommendation turn must NOT ship 6 broad scorer cards — it pins
// 2-3 distinct-family cards from the model's evidence, preferring the ones the
// model named in its text, so cardOwner=evidence-plan and text/cards align.

import assert from "node:assert/strict";
import { selectEvidenceCards } from "../app/lib/evidence-select.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fail++; }
}

const familyOf = (title) => String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";

const POOL6 = [
  { handle: "tamara", title: "Tamara Sandal" },
  { handle: "danika", title: "Danika Sneaker" },
  { handle: "mandy", title: "Mandy Slipper" },
  { handle: "millie", title: "Millie Wedge" },
  { handle: "misty", title: "Misty Flat" },
  { handle: "romy", title: "Romy Wedge" },
];

check("caps a 6-card pool to 3 (never the full scorer set)", () => {
  const picked = selectEvidenceCards(POOL6, "Take a look at these options.", { cap: 3, familyOf });
  assert.equal(picked.length, 3);
});

check("prefers the families the model NAMED in its text", () => {
  // Model named Mandy + Romy; they must be pinned even though they're last in pool.
  const text = "For standing all day I'd reach for the Mandy or the Romy — both have great arch support.";
  const picked = selectEvidenceCards(POOL6, text, { cap: 3, familyOf });
  const fams = picked.map((c) => familyOf(c.title));
  assert.ok(fams.includes("mandy"), "Mandy (named) pinned");
  assert.ok(fams.includes("romy"), "Romy (named) pinned");
  // Named-first ordering.
  assert.equal(familyOf(picked[0].title), "mandy");
  assert.equal(familyOf(picked[1].title), "romy");
});

check("distinct families only — never two cards of the same style", () => {
  const dupPool = [
    { handle: "a", title: "Tamara Sandal - Black" },
    { handle: "b", title: "Tamara Sandal - Tan" },
    { handle: "c", title: "Danika Sneaker - White" },
  ];
  const picked = selectEvidenceCards(dupPool, "", { cap: 3, familyOf });
  assert.equal(picked.length, 2, "Tamara collapses to one card");
  assert.deepEqual(picked.map((c) => familyOf(c.title)).sort(), ["danika", "tamara"]);
});

check("a 2-card pool returns 2 (selection never invents cards)", () => {
  const picked = selectEvidenceCards(POOL6.slice(0, 2), "", { cap: 3, familyOf });
  assert.equal(picked.length, 2);
});

check("empty pool → empty selection (caller falls back, never scorer)", () => {
  assert.deepEqual(selectEvidenceCards([], "anything", { cap: 3, familyOf }), []);
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  process.exit(1);
}
