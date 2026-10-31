/// Tables in answers (pass 119 A, Quiet lines): alignment kept, number
/// columns on the right, one line per row that scrolls sideways when wide,
/// and Copy (Markdown) or CSV on hover.

export type Align = "left" | "right" | "center";

/// A cell that reads as a number: 281, -3.5, 3,412, 96%, $0.002, 0.8 s, 1.2k, 12 ms.
const NUMBER = /^[-+−]?[$€£¥]?\s?\d[\d,.]*\s?(?:%|[kKmMbB]|s|ms|min|h|d|x|×|GB|MB|KB|tok\/s)?$/;
const EMPTY = /^(?:|[-–—]|n\/a)$/i;

/// Columns whose body cells are all numbers (a dash or blank aside) line up on the right.
export function numericColumns(rows: string[][]): boolean[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, column) => {
    const cells = rows.map((row) => (row[column] ?? "").trim()).filter((cell) => !EMPTY.test(cell));
    return cells.length > 0 && cells.every((cell) => NUMBER.test(cell));
  });
}

/// Each column's alignment: what the Markdown asked for, else right for numbers.
export function columnAligns(asked: (Align | null)[], rows: string[][]): Align[] {
  const numbers = numericColumns(rows);
  const width = Math.max(asked.length, numbers.length);
  return Array.from({ length: width }, (_, column) => asked[column] ?? (numbers[column] ? "right" : "left"));
}

const pipe = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
/// The table as GitHub Markdown, alignment included.
export function tableMarkdown(head: string[], rows: string[][], aligns: Align[] = []): string {
  const rule = head.map((_, i) => aligns[i] === "right" ? "---:" : aligns[i] === "center" ? ":---:" : "---");
  return [head, rule, ...rows].map((row, i) => `| ${(i === 1 ? row : row.map(pipe)).join(" | ")} |`).join("\n");
}

const quote = (cell: string) => {
  const flat = cell.replace(/\s*\n\s*/g, " ").trim();
  return /[",\n]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
};
/// The table as CSV, for a spreadsheet.
export function tableCsv(head: string[], rows: string[][]): string {
  return [head, ...rows].map((row) => row.map(quote).join(",")).join("\n");
}

/// Reads a rendered table back into cells.
export function tableCells(table: HTMLTableElement): { head: string[]; rows: string[][]; aligns: Align[] } {
  const text = (cell: Element) => (cell.textContent ?? "").trim();
  const head = [...table.querySelectorAll("thead th")].map(text);
  const rows = [...table.querySelectorAll("tbody tr")].map((row) => [...row.children].map(text));
  const aligns = [...table.querySelectorAll("thead th")].map((cell): Align => cell.classList.contains("md-right") ? "right" : cell.classList.contains("md-center") ? "center" : "left");
  return { head, rows, aligns };
}

/// After sanitizing: alignment becomes a class on every cell, numbers go
/// right, and the table is wrapped to scroll with its Copy and CSV.
export function decorateTables(root: HTMLElement) {
  for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
    if (table.parentElement?.classList.contains("md-scroll")) continue;
    const headCells = [...table.querySelectorAll("thead th")];
    const asked = headCells.map((cell): Align | null => {
      const value = cell.getAttribute("align");
      return value === "right" || value === "center" || value === "left" ? value : null;
    });
    const rows = [...table.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => (cell.textContent ?? "").trim()));
    const aligns = columnAligns(asked, rows);
    for (const row of table.querySelectorAll("tr"))
      [...row.children].forEach((cell, column) => {
        cell.removeAttribute("align");
        const align = aligns[column];
        if (align === "right") cell.classList.add("md-right");
        if (align === "center") cell.classList.add("md-center");
      });
    const box = document.createElement("div");
    box.className = "md-table";
    const tools = document.createElement("div");
    tools.className = "md-table-tools";
    for (const [format, label] of [["markdown", "Copy"], ["csv", "CSV"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = "copy-table";
      button.dataset.args = JSON.stringify({ format });
      button.textContent = label;
      tools.append(button);
    }
    const scroll = document.createElement("div");
    scroll.className = "md-scroll";
    table.replaceWith(box);
    scroll.append(table);
    box.append(tools, scroll);
  }
}
