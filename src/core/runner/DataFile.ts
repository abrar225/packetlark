/** RFC 4180-style CSV records, preserving quoted newlines and escaped quotes. No evaluation. */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new Error("Unexpected quote in CSV field");
      quoted = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      closed = false;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      closed = false;
      continue;
    }
    if (closed) throw new Error("Unexpected text after a quoted CSV field");
    field += c;
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (row.length || field || closed) {
    row.push(field);
    records.push(row);
  }
  const headers = records.shift();
  if (
    !headers?.length ||
    headers.some((h) => !h) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("CSV needs unique, nonempty headers");
  return records.map((record, index) => {
    if (record.length !== headers.length)
      throw new Error(
        `CSV row ${index + 2} has ${record.length} columns; expected ${headers.length}`,
      );
    return Object.fromEntries(headers.map((header, i) => [header, record[i]]));
  });
}
