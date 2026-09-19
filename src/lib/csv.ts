/**
 * A small, dependency-free RFC 4180 CSV reader.
 *
 * Handles quoted fields, embedded commas/newlines/quotes, CRLF and LF, a UTF-8
 * BOM, and ragged rows. It never throws on malformed input — a row with an
 * unterminated quote is returned as best it can be read and reported instead.
 */

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** Non-fatal problems worth showing the user before they import. */
  warnings: string[];
  delimiter: string;
}

const DELIMITERS = [',', '\t', ';', '|'];

export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    // Count only delimiters outside quotes.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseCsv(input: string, delimiterOverride?: string): CsvTable {
  const warnings: string[] = [];
  let text = input ?? '';
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const delimiter = delimiterOverride ?? detectDelimiter(text);

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      // A quote mid-field ("6" prop) is data, not a quoted field.
      if (field.trim() === '') {
        inQuotes = true;
        field = '';
      } else {
        field += ch;
      }
      sawAnyChar = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = '';
      sawAnyChar = true;
      continue;
    }

    if (ch === '\r') continue;

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
      continue;
    }

    field += ch;
    sawAnyChar = true;
  }

  if (inQuotes) {
    warnings.push('The file ends inside a quoted value. The last row may be incomplete.');
  }
  if (field !== '' || sawAnyChar || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop rows that are entirely empty (trailing newlines, blank separator lines).
  const meaningful = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const blankCount = rows.length - meaningful.length;
  if (blankCount > 0) {
    warnings.push(`${blankCount} blank ${blankCount === 1 ? 'row was' : 'rows were'} skipped.`);
  }

  if (meaningful.length === 0) {
    return { headers: [], rows: [], warnings: [...warnings, 'No rows found in this file.'], delimiter };
  }

  const rawHeaders = meaningful[0].map((h) => h.trim());
  const headers = dedupeHeaders(rawHeaders, warnings);
  const body = meaningful.slice(1);

  let ragged = 0;
  const normalized = body.map((r) => {
    if (r.length !== headers.length) ragged++;
    const copy = r.slice(0, headers.length).map((c) => c.trim());
    while (copy.length < headers.length) copy.push('');
    return copy;
  });
  if (ragged > 0) {
    warnings.push(
      `${ragged} ${ragged === 1 ? 'row has' : 'rows have'} a different number of columns than the header. Missing values were left blank; extra values were dropped.`,
    );
  }

  return { headers, rows: normalized, warnings, delimiter };
}

function dedupeHeaders(headers: string[], warnings: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const name = h || `Column ${i + 1}`;
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) {
      warnings.push(`Duplicate column "${name}" was renamed to "${name} (${count + 1})".`);
      return `${name} (${count + 1})`;
    }
    return name;
  });
}

/** Quote a value for CSV output. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n');
}
