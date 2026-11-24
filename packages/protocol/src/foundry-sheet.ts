/// Step 3 of pass 273 A, sheets: a table people sort, type into and add up.
/// The model writes CSV (the first row names the columns) and Demesne draws
/// it (apps/desktop/electron/foundry-more-kinds.ts, sheetPage).

export const SHEET_MAX_COLUMNS = 40;
export const SHEET_MAX_ROWS = 2000;

export interface Sheet { head: string[]; rows: string[][] }

/// CSV as RFC 4180 writes it: commas, "quoted" cells with "" for a quote,
/// line breaks inside quotes, and \n or \r\n between rows. Blank lines are dropped.
export function parseCSV(source: string): string[][] {
  const text = source.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { cell += '"'; at++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      row.push(cell); cell = "";
      if (row.some((one) => one !== "")) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((one) => one !== "")) rows.push(row);
  return rows;
}

/// The sheet a CSV source holds: its column names and its rows, each as wide as the head.
export function parseSheet(source: string): Sheet {
  const [head = [], ...rest] = parseCSV(source);
  const width = head.length;
  return { head: head.map((name) => name.trim()), rows: rest.map((row) => Array.from({ length: width }, (_, at) => row[at] ?? "")) };
}

/// Why a sheet can't be kept, or null when it can.
export function sheetProblem(source: string): string | null {
  const rows = parseCSV(source);
  if (!rows.length) return "A sheet needs at least a row of column names. Hint: CSV, the first row names the columns: Plot,pH,Nitrogen";
  const head = rows[0]!;
  if (head.length > SHEET_MAX_COLUMNS) return `A sheet holds up to ${SHEET_MAX_COLUMNS} columns, not ${head.length}`;
  if (head.some((name) => !name.trim())) return "Every column needs a name in the first row. Hint: CSV, the first row names the columns";
  if (rows.length - 1 > SHEET_MAX_ROWS) return `A sheet holds up to ${SHEET_MAX_ROWS} rows, not ${rows.length - 1}`;
  const wide = rows.findIndex((row) => row.length > head.length);
  if (wide > 0) return `Row ${wide} has ${rows[wide]!.length} cells but there are ${head.length} columns. Hint: quote a cell that has a comma in it ("Smith, Ann")`;
  return null;
}

/// A cell's number, when it reads as one: 1200, 1,200, -3.5, $18, 12%, (40).
export function cellNumber(text: string): number | null {
  let clean = text.trim(), sign = 1;
  if (/^\(.*\)$/.test(clean)) { sign = -1; clean = clean.slice(1, -1).trim(); }
  clean = clean.replace(/^([-+]?)[$€£¥]/, "$1").replace(/%$/, "").replace(/,(?=\d{3}(?:\D|$))/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(clean)) return null;
  const value = Number(clean) * sign;
  return Number.isFinite(value) ? value : null;
}

/// A column is numbers when it has at least one and every filled cell is one.
export function numberColumns(sheet: Sheet): boolean[] {
  return sheet.head.map((_, at) => {
    const filled = sheet.rows.map((row) => row[at] ?? "").filter((cell) => cell.trim());
    return filled.length > 0 && filled.every((cell) => cellNumber(cell) !== null);
  });
}

/// The sheet back as CSV, quoting only the cells that need it.
export function sheetCSV(sheet: Sheet): string {
  const cell = (text: string) => /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  return [sheet.head, ...sheet.rows].map((row) => row.map(cell).join(",")).join("\n") + "\n";
}
