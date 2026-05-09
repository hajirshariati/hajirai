// Unit eval for the CSV mapping module — round-trip serialize/parse,
// validation, and diff. Catches regressions in the masterIndex
// download/upload feature that powers the merchant's spreadsheet edit
// path on /app/recommenders.

import assert from "node:assert/strict";
import {
  serializeMasterIndexToCsv,
  parseCsvToMasterIndex,
  diffMasterIndex,
} from "../app/lib/mapping-csv.server.js";

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

function section(label) {
  console.log(`\n${label}`);
}

// =====================================================================
section("serializeMasterIndexToCsv");
// =====================================================================

test("empty array → header-only CSV", () => {
  const csv = serializeMasterIndexToCsv([]);
  assert.equal(csv, "masterSku,title,gender,useCase,arch,posted,metSupport\n");
});

test("single row serializes correctly", () => {
  const csv = serializeMasterIndexToCsv([
    { masterSku: "L100M", title: "Mens Dress", gender: "Men", useCase: "dress",
      arch: "Medium / High Arch", posted: false, metSupport: false },
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  // "Medium / High Arch" has slashes but no comma/quote/newline, so it
  // doesn't need RFC-4180 quoting. Excel and Sheets both parse it
  // correctly unquoted.
  assert.equal(lines[1], `L100M,Mens Dress,Men,dress,Medium / High Arch,FALSE,FALSE`);
});

test("title with comma is quoted", () => {
  const csv = serializeMasterIndexToCsv([
    { masterSku: "X", title: "A, B", gender: "Men", useCase: "casual",
      arch: "", posted: false, metSupport: false },
  ]);
  assert(csv.includes(`"A, B"`));
});

test("title with quote escapes correctly", () => {
  const csv = serializeMasterIndexToCsv([
    { masterSku: "X", title: 'He said "hi"', gender: "Men", useCase: "casual",
      arch: "", posted: false, metSupport: false },
  ]);
  assert(csv.includes(`"He said ""hi"""`));
});

test("posted=true → 'TRUE'", () => {
  const csv = serializeMasterIndexToCsv([
    { masterSku: "X", title: "T", gender: "Men", useCase: "casual",
      arch: "Flat / Low Arch", posted: true, metSupport: false },
  ]);
  assert(csv.includes(",TRUE,"));
});

// =====================================================================
section("parseCsvToMasterIndex — happy path");
// =====================================================================

test("round-trip: serialize → parse → identical", () => {
  const original = [
    { masterSku: "L100M", title: "Mens Dress", gender: "Men", useCase: "dress",
      arch: "Medium / High Arch", posted: false, metSupport: false },
    { masterSku: "L600W", title: "Womens Casual W/ Met", gender: "Women", useCase: "casual",
      arch: "Flat / Low Arch", posted: true, metSupport: true },
    { masterSku: "A100M", title: "Aetrex Mens InStyle", gender: "Men", useCase: "dress",
      arch: "", posted: false, metSupport: false },
  ];
  const csv = serializeMasterIndexToCsv(original);
  const parsed = parseCsvToMasterIndex(csv);
  assert(parsed.ok, `parse failed: ${(parsed.errors || []).join("; ")}`);
  assert.deepEqual(parsed.masterIndex, original);
});

test("CRLF line endings parse correctly", () => {
  const csv =
    "masterSku,title,gender,useCase,arch,posted,metSupport\r\n" +
    "X,Test,Men,casual,,FALSE,FALSE\r\n";
  const r = parseCsvToMasterIndex(csv);
  assert(r.ok);
  assert.equal(r.masterIndex.length, 1);
});

test("trailing blank lines are ignored", () => {
  const csv =
    "masterSku,title,gender,useCase,arch,posted,metSupport\n" +
    "X,T,Men,casual,,FALSE,FALSE\n" +
    "\n\n\n";
  const r = parseCsvToMasterIndex(csv);
  assert(r.ok);
  assert.equal(r.masterIndex.length, 1);
});

test("yes/no/1/0 boolean variants accepted", () => {
  const csv =
    "masterSku,title,gender,useCase,arch,posted,metSupport\n" +
    "A,A,Men,casual,,yes,no\n" +
    "B,B,Men,casual,,1,0\n" +
    "C,C,Men,casual,,Y,N\n";
  const r = parseCsvToMasterIndex(csv);
  assert(r.ok, (r.errors || []).join("; "));
  assert.equal(r.masterIndex[0].posted, true);
  assert.equal(r.masterIndex[0].metSupport, false);
  assert.equal(r.masterIndex[1].posted, true);
  assert.equal(r.masterIndex[2].posted, true);
});

// =====================================================================
section("parseCsvToMasterIndex — validation errors");
// =====================================================================

test("empty CSV → error", () => {
  const r = parseCsvToMasterIndex("");
  assert(!r.ok);
  assert(r.errors[0].includes("empty"));
});

test("missing column header → error", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted\nX,T,Men,casual,,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("metSupport")));
});

test("invalid gender → row error", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted,metSupport\nX,T,Mans,casual,,FALSE,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("gender") && e.includes("Mans")));
});

test("invalid useCase → row error", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted,metSupport\nX,T,Men,bogus,,FALSE,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("useCase")));
});

test("invalid arch → row error", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted,metSupport\nX,T,Men,casual,Tall,FALSE,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("arch")));
});

test("blank arch is allowed (cross-arch SKU like A100M)", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted,metSupport\nX,T,Men,casual,,FALSE,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(r.ok);
});

test("duplicate masterSku → error", () => {
  const csv =
    "masterSku,title,gender,useCase,arch,posted,metSupport\n" +
    "X,T1,Men,casual,,FALSE,FALSE\n" +
    "X,T2,Men,dress,,FALSE,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("duplicate")));
});

test("empty masterSku → error", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted,metSupport\n,Mystery,Men,casual,,FALSE,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("masterSku")));
});

test("invalid posted boolean → error", () => {
  const csv = "masterSku,title,gender,useCase,arch,posted,metSupport\nX,T,Men,casual,,maybe,FALSE\n";
  const r = parseCsvToMasterIndex(csv);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("posted")));
});

// =====================================================================
section("diffMasterIndex");
// =====================================================================

test("identical → all empty", () => {
  const a = [{ masterSku: "X", title: "T", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false }];
  const b = [{ masterSku: "X", title: "T", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false }];
  const d = diffMasterIndex(a, b);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.modified.length, 0);
});

test("added row detected", () => {
  const a = [{ masterSku: "A", title: "A", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false }];
  const b = [
    { masterSku: "A", title: "A", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false },
    { masterSku: "B", title: "B", gender: "Women", useCase: "dress", arch: "", posted: false, metSupport: false },
  ];
  const d = diffMasterIndex(a, b);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].masterSku, "B");
});

test("removed row detected", () => {
  const a = [
    { masterSku: "A", title: "A", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false },
    { masterSku: "B", title: "B", gender: "Women", useCase: "dress", arch: "", posted: false, metSupport: false },
  ];
  const b = [{ masterSku: "A", title: "A", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false }];
  const d = diffMasterIndex(a, b);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].masterSku, "B");
});

test("modified row detected with field-level changes", () => {
  const a = [{ masterSku: "X", title: "Old", gender: "Men", useCase: "casual", arch: "", posted: false, metSupport: false }];
  const b = [{ masterSku: "X", title: "New", gender: "Men", useCase: "casual", arch: "", posted: true, metSupport: false }];
  const d = diffMasterIndex(a, b);
  assert.equal(d.modified.length, 1);
  assert.deepEqual(d.modified[0].changes.title, { from: "Old", to: "New" });
  assert.deepEqual(d.modified[0].changes.posted, { from: false, to: true });
});

// =====================================================================
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.err?.message || f.err}`);
  }
  process.exit(1);
}
