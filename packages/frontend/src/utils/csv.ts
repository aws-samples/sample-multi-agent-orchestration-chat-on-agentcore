/**
 * Minimal RFC 4180 parser for previews: quoted fields, escaped quotes ("")
 * and newlines inside quotes. Stops after `maxRows` rows.
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number
): { rows: string[][]; hasMore: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };

  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) {
        return { rows, hasMore: i + 1 < text.length };
      }
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, hasMore: false };
}
