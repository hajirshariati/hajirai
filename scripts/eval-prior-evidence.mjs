// Prior-evidence availability — the deterministic answer text + card-ownership
// invariants for workflow=prior_evidence_availability ("do they come in black?"
// applied to the SET of products just shown). Routing is covered by
// eval-turn-plan; this locks the answer phrasing and the no-scorer / no-stray
// contract that stops a text/card mismatch.

import assert from "node:assert/strict";
import {
  buildPriorEvidenceAvailabilityText,
  buildPriorEvidenceMultiColorText,
  askedConstraintLabel,
  priorEvidenceCardOwnerViolation,
  priorEvidenceStrayCards,
  buildWidthSizeFallbackText,
} from "../app/lib/prior-evidence.js";
import { parseRequestedColors, familyOfTitle } from "../app/lib/availability-truth.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fail++; }
}

const familyOf = (title) => String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";

// ── width/size fallback (P4): no exact prior match → offer alternatives ──
check("buildWidthSizeFallbackText: frames wide alternatives, null when none", () => {
  assert.equal(
    buildWidthSizeFallbackText("wide", 3),
    "I don't see those exact styles in wide, but here are wide options you might like.",
  );
  assert.equal(
    buildWidthSizeFallbackText("wide", 1),
    "I don't see those exact styles in wide, but here's a wide option you might like.",
  );
  assert.equal(buildWidthSizeFallbackText("size 9", 2), "I don't see those exact styles in size 9, but here are size 9 options you might like.");
  // No alternatives found → null (keep the honest "I'm not seeing those" text).
  assert.equal(buildWidthSizeFallbackText("wide", 0), null);
});

// ── answer text (matches the PRD example wording) ──
check("some available → names which do and which don't, matching the carousel", () => {
  const txt = buildPriorEvidenceAvailabilityText(
    [{ name: "Tamara", ok: true }, { name: "Danika", ok: true }, { name: "Mandy", ok: false }],
    "in black", true,
  );
  assert.equal(txt, "Yes — Tamara and Danika come in black. I'm not seeing Mandy in black in the current catalog.");
});
check("all three available → 'all three come in black'", () => {
  const txt = buildPriorEvidenceAvailabilityText(
    [{ name: "Tamara", ok: true }, { name: "Danika", ok: true }, { name: "Mandy", ok: true }],
    "in black", true,
  );
  assert.equal(txt, "Yes — all three come in black.");
});
check("none available → no random replacements, offers alternatives", () => {
  const txt = buildPriorEvidenceAvailabilityText(
    [{ name: "Tamara", ok: false }, { name: "Danika", ok: false }],
    "in black", true,
  );
  assert.match(txt, /not seeing any of those in black/);
  assert.match(txt, /similar alternatives/);
});
check("two available (pair) → 'both'", () => {
  const txt = buildPriorEvidenceAvailabilityText(
    [{ name: "Jillian", ok: true }, { name: "Savannah", ok: true }],
    "in black", true,
  );
  assert.equal(txt, "Yes — both come in black.");
});
check("single product available → singular verb", () => {
  const txt = buildPriorEvidenceAvailabilityText([{ name: "Tamara", ok: true }], "in black", true);
  assert.equal(txt, "Yes — Tamara comes in black.");
});
check("size constraint → 'are available in size 8' verb", () => {
  const txt = buildPriorEvidenceAvailabilityText(
    [{ name: "Jillian", ok: true }, { name: "Savannah", ok: true }],
    "in size 8", false,
  );
  assert.equal(txt, "Yes — both are available in size 8.");
});

// ── multi-color follow-up ("do either of those come in champagne or rose?") ──
check("parseRequestedColors finds every requested color, in order", () => {
  assert.deepEqual(parseRequestedColors("Do either of those come in champagne or rose?", ["champagne", "rose"]), ["champagne", "rose"]);
  assert.deepEqual(parseRequestedColors("black or navy?", []), ["black", "navy"]);
  assert.deepEqual(parseRequestedColors("pink/rose", []), ["pink", "rose"]);
  assert.deepEqual(parseRequestedColors("tan or taupe", []), ["tan", "taupe"]);
});
check("multi-color answer names each requested color honestly per family", () => {
  // Tamara has neither; Savannah has champagne but not rose (the PRD example).
  const txt = buildPriorEvidenceMultiColorText([
    { name: "Tamara", available: [], missing: ["champagne", "rose"] },
    { name: "Savannah", available: ["champagne"], missing: ["rose"] },
  ]);
  assert.equal(txt, "Tamara does not come in Champagne or Rose. Savannah comes in Champagne, but I'm not seeing Rose.");
});
check("multi-color: a family with both colors lists both with 'and'", () => {
  const txt = buildPriorEvidenceMultiColorText([
    { name: "Savannah", available: ["champagne", "rose"], missing: [] },
  ]);
  assert.equal(txt, "Savannah comes in Champagne and Rose.");
});

// ── asked-constraint label ──
check("askedConstraintLabel: color wins over inherited size", () => {
  assert.equal(askedConstraintLabel({ reqColor: "black", inheritedSize: "8" }), "in Black");
});
check("askedConstraintLabel: color-only follow-up inherits size label when no color", () => {
  assert.equal(askedConstraintLabel({ askedSize: "8" }), "in size 8");
  assert.equal(askedConstraintLabel({ inheritedSize: "9" }), "in size 9");
  assert.equal(askedConstraintLabel({ askedWidth: "wide" }), "in wide");
});

// ── card-owner invariant: scorer must never own this turn ──
check("cardOwner=scorer on prior_evidence is a VIOLATION", () => {
  assert.equal(priorEvidenceCardOwnerViolation({ workflow: "prior_evidence_availability", finalCards: 2, cardOwner: "scorer" }), true);
});
check("cardOwner=prior-evidence is fine; availability-truth is fine", () => {
  assert.equal(priorEvidenceCardOwnerViolation({ workflow: "prior_evidence_availability", finalCards: 2, cardOwner: "prior-evidence" }), false);
  assert.equal(priorEvidenceCardOwnerViolation({ workflow: "prior_evidence_availability", finalCards: 1, cardOwner: "availability-truth" }), false);
});
check("text-only prior_evidence (0 cards) is never a violation", () => {
  assert.equal(priorEvidenceCardOwnerViolation({ workflow: "prior_evidence_availability", finalCards: 0, cardOwner: "none" }), false);
});

// ── stray-card invariant: cards must be a subset of the prior families ──
check("cards remapped to prior families → no strays", () => {
  const finalCards = [{ title: "Tamara Sandal - Black" }, { title: "Danika Sneaker - Black" }];
  const strays = priorEvidenceStrayCards(finalCards, ["tamara", "danika", "mandy"], familyOf);
  assert.equal(strays.length, 0);
});
check("a random alternate product is flagged as a stray", () => {
  const finalCards = [{ title: "Tamara Sandal - Black" }, { title: "Millie Wedge - Black" }];
  const strays = priorEvidenceStrayCards(finalCards, ["tamara", "danika", "mandy"], familyOf);
  assert.equal(strays.length, 1);
  assert.match(strays[0].title, /Millie/);
});

// ── familyOfTitle: prior-evidence family extraction (PRD 2026-06-28 bug 4) ──
// Generic/gender tokens must never be a family. Log leaked
// families=[women's,jocelyn,danika] — "women's" is not a product family.
check("gender prefix ('Women's') is stripped, real family wins", () => {
  assert.equal(familyOfTitle("Women's Jocelyn Slingback Sandal - Black"), "jocelyn");
  assert.equal(familyOfTitle("Women’s Danika Lace-Up Sneaker"), "danika"); // curly apostrophe
  assert.equal(familyOfTitle("Men's Jillian Quarter Strap"), "jillian");
});
check("category / orthotic / descriptor tokens are not families", () => {
  assert.equal(familyOfTitle("Men's Orthotic Insole"), "");
  assert.equal(familyOfTitle("Active Arch Support Insole"), "");
  assert.equal(familyOfTitle("Women's Comfort Sandal"), "");
});
check("a real family token still resolves", () => {
  assert.equal(familyOfTitle("Lynco L600 Orthotic"), "lynco");
  assert.equal(familyOfTitle("Savannah Wedge - Tan"), "savannah");
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  process.exit(1);
}
