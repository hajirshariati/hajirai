// CSV serializer / parser / validator for the orthotic decision-tree
// masterIndex. Powers the admin "Download CSV" / "Upload CSV" feature.
//
// Why CSV: merchants want to edit SKU mappings in Excel/Sheets without
// touching JSON. The masterIndex is a flat array of records — perfect
// fit. Other parts of the tree (chip questions, derivations, attribute
// prompts) stay untouched on upload — only masterIndex is replaced.
//
// Columns (header line, in this order):
//   masterSku, title, gender, useCase, arch, posted, metSupport
//
// Validation rules enforced on upload:
//   - All rows have a non-empty masterSku (must be unique within file)
//   - Title is non-empty string
//   - gender ∈ {Men, Women, Kids, Unisex}
//   - useCase ∈ allowed enum values
//   - arch ∈ {"Flat / Low Arch", "Medium / High Arch", ""}
//     (blank for cross-arch SKUs like A100M)
//   - posted/metSupport coerced from TRUE/FALSE/yes/no/1/0
//
// Any row that fails validation produces a line-level error message
// returned to the UI. The DB write happens only if every row passes.

const ALLOWED_USE_CASES = new Set([
  "dress",
  "dress_no_removable",
  "dress_premium",
  "casual",
  "athletic_running",
  "athletic_training",
  "athletic_general",
  "cleats",
  "skates",
  "winter_boots",
  "work_all_day",
  "comfort",
  "kids",
]);

const ALLOWED_GENDERS = new Set(["Men", "Women", "Kids", "Unisex"]);
const ALLOWED_ARCHES = new Set(["Flat / Low Arch", "Medium / High Arch", ""]);

const COLUMNS = ["masterSku", "title", "gender", "useCase", "arch", "posted", "metSupport"];

function escapeCsvCell(v) {
  const s = v == null ? "" : String(v);
  // RFC 4180 quoting: wrap in quotes if cell contains comma, quote, or newline.
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Serialize a masterIndex array into a CSV string.
 *
 * @param {Array<Object>} masterIndex
 * @returns {string} CSV text with header row + data rows
 */
export function serializeMasterIndexToCsv(masterIndex) {
  const rows = Array.isArray(masterIndex) ? masterIndex : [];
  const lines = [COLUMNS.join(",")];
  for (const r of rows) {
    const cells = COLUMNS.map((c) => {
      const v = r?.[c];
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      return escapeCsvCell(v ?? "");
    });
    lines.push(cells.join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse a CSV string into rows. Accepts RFC 4180 quoting with
 * embedded commas/quotes/newlines.
 */
function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      // Skip \r\n pair
      if (ch === "\r" && text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // Flush trailing cell/row
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  // Drop trailing empty rows (blank lines)
  while (out.length > 0 && out[out.length - 1].every((c) => c === "")) {
    out.pop();
  }
  return out;
}

function coerceBool(v) {
  if (v === true || v === false) return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "y" || s === "1") return true;
  if (s === "false" || s === "no" || s === "n" || s === "0" || s === "") return false;
  return null; // invalid
}

/**
 * Parse + validate CSV text into a masterIndex array.
 * Returns { ok, masterIndex?, errors? }.
 */
export function parseCsvToMasterIndex(csvText) {
  const errors = [];
  const rows = parseCsv(String(csvText || ""));
  if (rows.length === 0) {
    return { ok: false, errors: ["CSV is empty."] };
  }
  const header = rows[0].map((h) => String(h || "").trim());
  // Validate header matches expected columns (case-insensitive, order
  // matters — keeps Excel-edited files predictable).
  for (let i = 0; i < COLUMNS.length; i++) {
    if ((header[i] || "").toLowerCase() !== COLUMNS[i].toLowerCase()) {
      errors.push(
        `Header column ${i + 1} expected "${COLUMNS[i]}" but got "${header[i] || "(empty)"}".`,
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const out = [];
  const seenSkus = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lineNo = r + 1; // 1-indexed header + 1
    const cells = COLUMNS.map((_, i) => String(row[i] ?? "").trim());
    const [sku, title, gender, useCase, arch, postedRaw, metRaw] = cells;
    if (!sku && !title && !gender && !useCase && !arch && !postedRaw && !metRaw) {
      // skip fully blank rows
      continue;
    }
    if (!sku) {
      errors.push(`Row ${lineNo}: masterSku is empty.`);
      continue;
    }
    if (seenSkus.has(sku)) {
      errors.push(`Row ${lineNo}: duplicate masterSku "${sku}".`);
      continue;
    }
    seenSkus.add(sku);
    if (!title) {
      errors.push(`Row ${lineNo}: title is empty for SKU "${sku}".`);
    }
    if (!ALLOWED_GENDERS.has(gender)) {
      errors.push(
        `Row ${lineNo}: gender "${gender}" invalid for SKU "${sku}". Expected one of ${[...ALLOWED_GENDERS].join(" / ")}.`,
      );
    }
    if (!ALLOWED_USE_CASES.has(useCase)) {
      errors.push(
        `Row ${lineNo}: useCase "${useCase}" invalid for SKU "${sku}". Expected one of ${[...ALLOWED_USE_CASES].join(" / ")}.`,
      );
    }
    if (!ALLOWED_ARCHES.has(arch)) {
      errors.push(
        `Row ${lineNo}: arch "${arch}" invalid for SKU "${sku}". Expected "Flat / Low Arch", "Medium / High Arch", or blank.`,
      );
    }
    const posted = coerceBool(postedRaw);
    if (posted === null) {
      errors.push(`Row ${lineNo}: posted "${postedRaw}" invalid for SKU "${sku}". Use TRUE / FALSE.`);
    }
    const metSupport = coerceBool(metRaw);
    if (metSupport === null) {
      errors.push(`Row ${lineNo}: metSupport "${metRaw}" invalid for SKU "${sku}". Use TRUE / FALSE.`);
    }
    if (errors.length === 0) {
      out.push({ masterSku: sku, title, gender, useCase, arch, posted, metSupport });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (out.length === 0) {
    return { ok: false, errors: ["No data rows after the header."] };
  }
  return { ok: true, masterIndex: out };
}

/**
 * Compute a diff between two masterIndex arrays. Used for the
 * "X added / Y removed / Z modified" pre-flight summary the UI
 * shows before applying the upload.
 */
export function diffMasterIndex(oldIndex, newIndex) {
  const oldMap = new Map();
  for (const r of oldIndex || []) oldMap.set(r.masterSku, r);
  const newMap = new Map();
  for (const r of newIndex || []) newMap.set(r.masterSku, r);
  const added = [];
  const removed = [];
  const modified = [];
  for (const [sku, r] of newMap) {
    const old = oldMap.get(sku);
    if (!old) {
      added.push(r);
      continue;
    }
    // Compare every column except masterSku itself.
    const fields = ["title", "gender", "useCase", "arch", "posted", "metSupport"];
    let changed = false;
    const changes = {};
    for (const f of fields) {
      if (old[f] !== r[f]) {
        changed = true;
        changes[f] = { from: old[f], to: r[f] };
      }
    }
    if (changed) modified.push({ masterSku: sku, changes });
  }
  for (const [sku, r] of oldMap) {
    if (!newMap.has(sku)) removed.push(r);
  }
  return { added, removed, modified };
}
