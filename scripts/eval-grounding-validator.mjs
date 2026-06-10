// Grounding validator — locks down the contract that every load-
// bearing claim in the model's reply is supported by tool results
// from THIS turn. Mirrors the live-trace bugs we've hit:
//   - "Noelle has both technologies built in" (no Noelle in tool result)
//   - "Reagan boot is $89.95" (wrong price)
//   - "the Maui has BioRocker" (Maui has no BioRocker evidence)
//
// On every failure the validator returns a structured error the agent
// loop hands BACK to the model with a retry instruction. The
// validator never rewrites text silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGrounding,
  buildRetryInstruction,
  __TEST__,
} from "../app/lib/grounding-validator.server.js";

const { titleFamily, extractBoldedProductFamilies, extractFeatureClaims } = __TEST__;

// ─── Fixtures ──────────────────────────────────────────────────

const NOELLE = {
  title: "Noelle Arch Support Wedge - Navy",
  handle: "noelle-navy",
  price_formatted: "$90.97",
  _description: "Wedge sandal with arch support",
  _tags: ["wedge", "arch-support"],
  _attributes: { category: "Wedges Heels" },
  _claimFacts: { archSupport: { value: true, source: "tag" } },
};

const REAGAN = {
  title: "Reagan Boot - Black",
  handle: "reagan-black",
  price_formatted: "$179.95",
  _description: "Leather ankle boot built for everyday wear",
  _tags: ["boot", "leather"],
  _attributes: { category: "Boots" },
  _claimFacts: { leather: { value: true, source: "tag" } },
};

const DARCY = {
  title: "Darcy Slip-On Sneaker - Black",
  handle: "darcy-black",
  price_formatted: "$129.95",
  _description: "Slip-on sneaker with BioRocker rocker-bottom outsole and built-in arch support",
  _tags: ["sneaker", "biorocker"],
  _attributes: { category: "Sneakers" },
  _claimFacts: { archSupport: { value: true, source: "tag" } },
};

// ─── Title family ──────────────────────────────────────────────

test("titleFamily extracts the first non-stop-word token", () => {
  assert.equal(titleFamily("Noelle Arch Support Wedge - Navy"), "noelle");
  assert.equal(titleFamily("Reagan Boot - Black"), "reagan");
  assert.equal(titleFamily("The Whit Sport Sandal"), "whit");
});

// ─── Bolded product extraction filters tech/feature names ──────

test("bolded tech names (BioRocker™ Technology) are not treated as products", () => {
  const text = "Both **BioRocker™ Technology** and **UltraSKY™ Technology** are built into select styles.";
  const families = extractBoldedProductFamilies(text);
  assert.equal(families.length, 0, `tech bolds must not count as products; got ${JSON.stringify(families)}`);
});

test("bolded actual product names ARE captured", () => {
  const text = "The **Noelle Arch Support Wedge** is a great pick for foot pain.";
  const families = extractBoldedProductFamilies(text);
  assert.equal(families.length, 1);
  assert.equal(families[0].family, "noelle");
});

// ─── Rule 1: named-product grounding ───────────────────────────

test("ungrounded product name (no card with that family) → error", () => {
  // Live trace 2026-06-09: bot claimed Noelle has both technologies
  // but Noelle wasn't in the tool result (pool was Darcy/Savannah/etc.)
  const text = "The **Noelle Arch Support Wedge** has both technologies built in.";
  const out = validateGrounding({ text, pool: [DARCY] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "ungrounded_product_name" && /noelle/i.test(e.claim)),
    `expected ungrounded_product_name for Noelle; got ${JSON.stringify(out.errors)}`);
});

test("grounded product name (card with matching family) → ok", () => {
  const text = "The **Noelle Arch Support Wedge** is built for everyday wear.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true, `expected ok; got errors=${JSON.stringify(out.errors)}`);
});

test("variant color in reply (Noelle Arch Support Wedge - Navy) matches base card (Noelle ...) by family", () => {
  const text = "**Noelle Arch Support Wedge — Navy** at $90.97 — a wedge with arch support.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true, `family-level match should be enough; got ${JSON.stringify(out.errors)}`);
});

// ─── Rule 2: price grounding ───────────────────────────────────

test("wrong price quoted next to product name → error", () => {
  const text = "The **Reagan Boot** is $89.95 in black.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "wrong_price"),
    `expected wrong_price; got ${JSON.stringify(out.errors)}`);
});

test("correct price quoted next to product name → ok", () => {
  const text = "The **Reagan Boot** is $179.95 in black.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, true, `expected ok; got ${JSON.stringify(out.errors)}`);
});

test("price within 50-cent rounding tolerance is accepted", () => {
  const text = "The **Reagan Boot** is $180.00.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, true);
});

// ─── Rule 3: feature/material grounding ────────────────────────

test("'Noelle has BioRocker' is rejected when Noelle's card has no BioRocker evidence", () => {
  const text = "The **Noelle Arch Support Wedge** has BioRocker technology built in.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "unsupported_feature_claim" && /biorocker/i.test(e.claim)),
    `expected unsupported_feature_claim for BioRocker; got ${JSON.stringify(out.errors)}`);
});

test("'Darcy has BioRocker' is accepted when Darcy's card description mentions BioRocker", () => {
  const text = "The **Darcy Slip-On Sneaker** has BioRocker for joint-friendly walking.";
  const out = validateGrounding({ text, pool: [DARCY] });
  assert.equal(out.ok, true, `expected ok; got ${JSON.stringify(out.errors)}`);
});

test("'Reagan has memory foam' is rejected when card has no memory foam evidence", () => {
  const text = "The **Reagan Boot** has memory foam for all-day comfort.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.kind === "unsupported_feature_claim" && /memory foam/i.test(e.claim)));
});

test("'Reagan has leather' is accepted because card description says leather", () => {
  const text = "The **Reagan Boot** is a leather ankle boot.";
  const out = validateGrounding({ text, pool: [REAGAN] });
  assert.equal(out.ok, true);
});

test("arch support claim is accepted when claim facts confirm it", () => {
  const text = "The **Noelle Arch Support Wedge** has arch support built in.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true);
});

// ─── Multiple errors at once ───────────────────────────────────

test("two ungrounded products produce two errors", () => {
  const text = "**Phantom Sneaker** and **Mirage Sandal** are both great.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, false);
  assert.equal(
    out.errors.filter((e) => e.kind === "ungrounded_product_name").length,
    2,
  );
});

// ─── No-op cases (pure prose, generic descriptions) ────────────

test("plain prose with no product/price/feature claims → ok regardless of pool", () => {
  const text = "Happy to help! Tell me more about what you're looking for and I'll narrow it down.";
  const out = validateGrounding({ text, pool: [] });
  assert.equal(out.ok, true);
});

test("generic adjectives (comfortable, stylish) without specific feature words → ok", () => {
  const text = "The **Noelle Arch Support Wedge** is comfortable and stylish for daily wear.";
  const out = validateGrounding({ text, pool: [NOELLE] });
  assert.equal(out.ok, true);
});

test("empty inputs → ok (no false positives)", () => {
  assert.equal(validateGrounding({ text: "", pool: [] }).ok, true);
  assert.equal(validateGrounding({ text: null, pool: null }).ok, true);
});

// ─── Retry instruction is well-formed ──────────────────────────

test("buildRetryInstruction lists each error and ends with the honesty cue", () => {
  const errors = [
    { kind: "ungrounded_product_name", claim: "Phantom", message: "Phantom isn't in any tool result." },
    { kind: "unsupported_feature_claim", claim: "Noelle has BioRocker", message: "Noelle has no BioRocker evidence." },
  ];
  const out = buildRetryInstruction(errors);
  assert.ok(out.includes("Phantom isn't in any tool result."));
  assert.ok(out.includes("Noelle has no BioRocker evidence."));
  assert.ok(/can't verify|that's a correct answer/i.test(out),
    `expected the honesty cue inviting "I can't verify"; got:\n${out}`);
});

test("empty errors → empty instruction", () => {
  assert.equal(buildRetryInstruction([]), "");
});

console.log("\nAll grounding-validator tests done.");
