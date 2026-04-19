export function parseCsv(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { headers: [], rows: [] };
  }
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { record.push(field); field = ""; i++; continue; }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      record.push(field); records.push(record); record = []; field = ""; i++; continue;
    }
    if (ch === "\n") {
      record.push(field); records.push(record); record = []; field = ""; i++; continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }
  const nonEmpty = records.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1);
  return { headers, rows };
}

const SKU_COLUMN_CANDIDATES = ["sku","variant_sku","variant sku","item_sku","item sku","product_sku","product sku"];

export function detectSkuColumn(headers) {
  const normalized = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of SKU_COLUMN_CANDIDATES) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function extractEnrichmentRows(content) {
  const { headers, rows } = parseCsv(content);
  if (headers.length === 0 || rows.length === 0) return null;
  const skuIdx = detectSkuColumn(headers);
  if (skuIdx === -1) return null;
  const seen = new Map();
  for (const row of rows) {
    const sku = (row[skuIdx] || "").trim();
    if (!sku) continue;
    const data = {};
    for (let j = 0; j < headers.length; j++) {
      if (j === skuIdx) continue;
      const key = headers[j];
      if (!key) continue;
      const value = row[j] !== undefined ? row[j] : "";
      data[key] = value;
    }
    seen.set(sku, data);
  }
  return {
    skuColumn: headers[skuIdx],
    rows: Array.from(seen, ([sku, data]) => ({ sku, data })),
  };
}
