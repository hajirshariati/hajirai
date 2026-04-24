function escapeCell(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const head = headers.map(escapeCell).join(",");
  const body = rows.map((r) => r.map(escapeCell).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

export function csvResponse(filename, csv) {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
