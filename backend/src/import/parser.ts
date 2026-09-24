/**
 * Parse delimited text (TSV/CSV). Quotes are honoured only when a field *starts* with a quote,
 * so stray quote characters inside Google-Sheets TSV cells do not swallow following rows.
 */
export function parseDelimited(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = src.length;
  let atFieldStart = true;
  // Google Sheets TSV exports never quote fields; only CSV honours quoting.
  const quoting = delim !== '\t';

  while (i < n) {
    const ch = src[i];
    if (quoting && atFieldStart && ch === '"') {
      // quoted field
      i++;
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        field += c;
        i++;
      }
      if (!closed) {
        // Unterminated quote: treat the opening quote as literal text.
        field = '"' + field;
      }
      atFieldStart = false;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      atFieldStart = true;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      if (ch === '\r' && src[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    atFieldStart = false;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, delimiter: delim };
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20000).split(/\r?\n/).slice(0, 20);
  const score = (d: string) => sample.reduce((a, line) => a + (line.split(d).length - 1), 0);
  const tabs = score('\t');
  const commas = score(',');
  const semis = score(';');
  if (tabs >= commas && tabs >= semis) return '\t';
  return commas >= semis ? ',' : ';';
}
