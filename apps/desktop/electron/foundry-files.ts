/// Piece 6 of pass 274, out in the right file: Save a copy gives each kind the
/// file the rest of the world opens. A deck is a PowerPoint (.pptx) with its
/// speaker notes, a doc a Word file (.docx), a sheet an Excel file (.xlsx)
/// whose totals are real formulas. They are written here from the content,
/// as plain Office Open XML in a zip, so nothing is installed and nothing
/// leaves the computer. The words stay words: every heading, bullet, table
/// and number can be edited in the other program.
///
/// Read more:
///   https://learn.microsoft.com/office/open-xml/about-the-open-xml-sdk
///   https://en.wikipedia.org/wiki/ZIP_(file_format)#Design
import { deflateRawSync } from "node:zlib";
import { Marked, type Token, type Tokens } from "marked";
import { cellNumber, numberColumns, parseSheet } from "@demesne/protocol";
import { frontMatter, parseChart, slideLayout, slideNotes, splitSlides } from "./foundry-kinds.ts";
export { slideNotes };

// ---------------------------------------------------------------- zip

const CRC = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(data: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/// A zip of the given files, in the order given (an Office file wants [Content_Types].xml first).
/// The date is fixed, so the same content always gives the same bytes.
export function zip(files: readonly (readonly [string, string | Uint8Array])[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content), packed = deflateRawSync(raw), path = Buffer.from(name, "utf8"), crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(path.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, path, packed); central.push(entry, path);
    offset += local.length + path.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const x = (value: unknown) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: readonly (readonly [string, string, string] | readonly [string, string, string, "External"])[]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${x(target)}"${mode ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
const core = (title: string) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(title)}</dc:title><dc:creator>Demesne Foundry</dc:creator></cp:coreProperties>`;
const CORE_REL = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

// ---------------------------------------------------------------- sheet → .xlsx

const column = (index: number) => { let name = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
/// How a number cell is written: its value, and the format that shows it as the sheet did ("$18", "12%").
function numberCell(text: string): { value: number; style: number } {
  const value = cellNumber(text) ?? 0, clean = text.trim();
  if (/%\)?$/.test(clean)) return { value: value / 100, style: 2 + Math.min(2, /\.(\d+)/.exec(clean)?.[1]?.length ?? 0) };
  const money = /^[-+(]?([$€£¥])/.exec(clean)?.[1];
  return { value, style: money ? 5 + "$€£¥".indexOf(money) : 0 };
}
const SHEET_FORMATS = ["0%", "0.0%", "0.00%", '"$"#,##0.00', '"€"#,##0.00', '"£"#,##0.00', '"¥"#,##0'];
/// A style's bold twin, for the totals row.
const boldStyle = (style: number) => style === 0 ? 1 : style + SHEET_FORMATS.length;

/// A sheet as an Excel workbook: the head row bold and frozen, numbers as
/// numbers, and under every number column a total that is a real SUM formula.
export function sheetXLSX(source: string, title: string): Buffer {
  const sheet = parseSheet(source), numeric = numberColumns(sheet), last = sheet.rows.length + 1;
  const text = (ref: string, value: string, style = 0) => value === "" ? "" : `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${x(value)}</t></is></c>`;
  const rows = [`<row r="1">${sheet.head.map((name, at) => text(`${column(at)}1`, name, 1)).join("")}</row>`];
  sheet.rows.forEach((row, at) => {
    rows.push(`<row r="${at + 2}">${sheet.head.map((_, col) => {
      const cell = row[col] ?? "", ref = `${column(col)}${at + 2}`;
      if (!numeric[col] || !cell.trim()) return text(ref, cell);
      const { value, style } = numberCell(cell);
      return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;
    }).join("")}</row>`);
  });
  // The totals row: a label where the first column is words, a SUM under each number column, in that column's own format.
  const totals = sheet.rows.length > 0 && numeric.some(Boolean);
  if (totals) {
    const at = last + 1;
    rows.push(`<row r="${at}">${sheet.head.map((_, col) => {
      const ref = `${column(col)}${at}`;
      if (!numeric[col]) return col === 0 ? text(ref, "Total", 1) : "";
      const sample = sheet.rows.map((row) => row[col] ?? "").find((cell) => cell.trim()) ?? "0", { style } = numberCell(sample);
      const sum = sheet.rows.reduce((all, row) => all + (cellNumber(row[col] ?? "") ?? 0), 0) / (style >= 2 && style <= 4 ? 100 : 1);
      return `<c r="${ref}" s="${boldStyle(style)}"><f>SUM(${column(col)}2:${column(col)}${last})</f><v>${sum}</v></c>`;
    }).join("")}</row>`);
  }
  const widths = sheet.head.map((name, col) => Math.max(8, Math.min(48, Math.max(name.length, ...sheet.rows.slice(0, 200).map((row) => (row[col] ?? "").length)) + 3)));
  const range = `A1:${column(Math.max(0, sheet.head.length - 1))}${last}`;
  const formats = SHEET_FORMATS;
  // Styles: 0 plain, 1 bold, then one per number format, then the same formats in bold for the totals row.
  const xf = (format: number, bold: boolean) => `<xf numFmtId="${format}" fontId="${bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${format ? ' applyNumberFormat="1"' : ""}${bold ? ' applyFont="1"' : ""}/>`;
  const cellXfs = [xf(0, false), xf(0, true), ...formats.map((_, at) => xf(164 + at, false)), ...formats.map((_, at) => xf(164 + at, true))];
  const styles = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${formats.length}">${formats.map((code, at) => `<numFmt numFmtId="${164 + at}" formatCode="${x(code)}"/>`).join("")}</numFmts>`
    + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const name = (title.replace(/[\\/?*[\]:]/g, " ").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim() || "Sheet").slice(0, 31);
  const page = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${widths.map((width, at) => `<col min="${at + 1}" max="${at + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.join("")}</sheetData>${sheet.rows.length ? `<autoFilter ref="${range}"/>` : ""}</worksheet>`;
  return zip([
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", rels([["rId1", "officeDocument", "xl/workbook.xml"], ["rId2", CORE_REL, "docProps/core.xml"]])],
    ["docProps/core.xml", core(title)],
    ["xl/workbook.xml", `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="${x(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "styles", "styles.xml"]])],
    ["xl/styles.xml", styles],
    ["xl/worksheets/sheet1.xml", page],
  ]);
}

// ---------------------------------------------------------------- Markdown → blocks

export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }
export type Block =
  | { kind: "heading"; level: number; runs: Run[] }
  | { kind: "para"; runs: Run[] }
  | { kind: "item"; ordered: boolean; level: number; first: boolean; runs: Run[] }
  | { kind: "quote"; label: string; runs: Run[] }
  | { kind: "code"; text: string }
  | { kind: "table"; head: string[]; rows: string[][]; caption: string }
  | { kind: "rule" };

const lexer = new Marked({ gfm: true });
const plain = (runs: readonly Run[]) => runs.map((run) => run.text).join("");

function inline(tokens: readonly Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const runs: Run[] = [];
  for (const token of tokens ?? []) {
    if (token.type === "strong") runs.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
    else if (token.type === "em") runs.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }));
    else if (token.type === "del") runs.push(...inline((token as Tokens.Del).tokens, style));
    else if (token.type === "codespan") runs.push({ ...style, code: true, text: unescape((token as Tokens.Codespan).text) });
    else if (token.type === "link") { const link = token as Tokens.Link; runs.push(...inline(link.tokens, /^https?:\/\//i.test(link.href) ? { ...style, href: link.href } : style)); }
    else if (token.type === "image") runs.push({ ...style, text: (token as Tokens.Image).text || "" });
    else if (token.type === "br") runs.push({ ...style, text: "\n" });
    else if (token.type === "html") continue;
    else if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length) runs.push(...inline(token.tokens, style));
    else runs.push({ ...style, text: unescape("text" in token ? String(token.text) : token.raw) });
  }
  return runs.filter((run) => run.text !== "");
}
const unescape = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const CALLOUT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
/// The content as blocks a document or a slide is made of. A chart becomes its numbers as a table, a stats block its tiles as one.
export function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  const list = (token: Tokens.List, level: number) => {
    token.items.forEach((item, at) => {
      const own = item.tokens.filter((child) => child.type !== "list");
      out.push({ kind: "item", ordered: token.ordered, level, first: at === 0, runs: inline(own.flatMap((child) => "tokens" in child && Array.isArray(child.tokens) ? child.tokens : [child])) });
      for (const child of item.tokens) if (child.type === "list") list(child as Tokens.List, Math.min(3, level + 1));
    });
  };
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "heading") out.push({ kind: "heading", level: Math.min(4, (token as Tokens.Heading).depth), runs: inline((token as Tokens.Heading).tokens) });
      else if (token.type === "paragraph") out.push({ kind: "para", runs: inline((token as Tokens.Paragraph).tokens) });
      else if (token.type === "text") out.push({ kind: "para", runs: inline("tokens" in token && Array.isArray(token.tokens) ? token.tokens : [token]) });
      else if (token.type === "list") list(token as Tokens.List, 0);
      else if (token.type === "hr") out.push({ kind: "rule" });
      else if (token.type === "blockquote") {
        const quote = token as Tokens.Blockquote, said = CALLOUT.exec(quote.text)?.[1] ?? "";
        const runs = inline(lexer.lexer(quote.text.replace(CALLOUT, "")).flatMap((child) => "tokens" in child && Array.isArray(child.tokens) ? [...child.tokens, { type: "br", raw: "\n" } as Token] : []));
        while (runs.at(-1)?.text === "\n") runs.pop();
        out.push({ kind: "quote", label: said ? said[0]!.toUpperCase() + said.slice(1).toLowerCase() : "", runs });
      } else if (token.type === "code") {
        const code = token as Tokens.Code, lang = (code.lang ?? "").trim().toLowerCase();
        if (lang === "chart") {
          const spec = parseChart(code.text), count = Math.max(spec.labels.length, ...spec.series.map((series) => series.values.length));
          out.push({ kind: "table", caption: [spec.title, spec.note].filter(Boolean).join(" · "), head: ["", ...spec.series.map((series, at) => series.name || (spec.series.length > 1 ? `Series ${at + 1}` : "Value"))],
            rows: Array.from({ length: count }, (_, row) => [spec.labels[row] ?? "", ...spec.series.map((series) => series.values[row] === undefined ? "" : `${series.values[row]}${spec.unit === "%" ? "%" : ""}`)]) });
        } else if (lang === "stats" || lang === "stat") {
          const rows = code.text.split("\n").map((line) => line.split("|").map((cell) => cell.trim())).filter((cells) => cells.length >= 2 && cells[1]).slice(0, 8);
          const wide = Math.max(2, ...rows.map((row) => row.length));
          out.push({ kind: "table", caption: "", head: ["", "Value", "Change", "Note"].slice(0, Math.min(4, wide)), rows: rows.map((row) => Array.from({ length: Math.min(4, wide) }, (_, at) => row[at] ?? "")) });
        } else out.push({ kind: "code", text: code.text });
      } else if (token.type === "table") {
        const table = token as Tokens.Table;
        out.push({ kind: "table", caption: "", head: table.header.map((cell) => plain(inline(cell.tokens))), rows: table.rows.map((row) => row.map((cell) => plain(inline(cell.tokens)))) });
      }
    }
  };
  walk(lexer.lexer(markdown.replace(/<!--[\s\S]*?-->/g, "")));
  return out;
}

// ---------------------------------------------------------------- doc → .docx

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/// A doc as a Word file: its title block, headings as real heading styles (so Word's outline and contents work),
/// lists as real lists, tables as tables, links as links.
export function docDOCX(source: string, fallbackTitle: string): Buffer {
  const { meta, body } = frontMatter(source), all = blocks(body);
  // The first # heading is the title, as on the page.
  const lead = all[0]?.kind === "heading" && all[0].level === 1 ? all.shift() as Extract<Block, { kind: "heading" }> : null;
  const title = meta.title || (lead ? plain(lead.runs) : "") || fallbackTitle;
  const links: string[] = [];
  const run = (one: Run) => {
    const props = `${one.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : ""}${one.bold ? "<w:b/>" : ""}${one.italic ? "<w:i/>" : ""}${one.href ? '<w:color w:val="1F5FBF"/><w:u w:val="single"/>' : ""}`;
    const pieces = one.text.split("\n").map((piece, at) => `${at ? "<w:br/>" : ""}<w:t xml:space="preserve">${x(piece)}</w:t>`).join("");
    const made = `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${pieces}</w:r>`;
    if (!one.href) return made;
    links.push(one.href);
    return `<w:hyperlink r:id="rLink${links.length}">${made}</w:hyperlink>`;
  };
  const para = (style: string, runs: readonly Run[], more = "") => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${more}</w:pPr>${runs.map(run).join("")}</w:p>`;
  // Every numbered list starts at 1: each gets a numbering of its own.
  let numbered = 0, current = 0;
  const cellText = (value: string, bold: boolean) => `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${x(value)}</w:t></w:r></w:p>`;
  const table = (block: Extract<Block, { kind: "table" }>) => {
    const cols = Math.max(1, block.head.length, ...block.rows.map((row) => row.length)), width = Math.floor(9000 / cols);
    const row = (cells: readonly string[], head: boolean) => `<w:tr>${Array.from({ length: cols }, (_, at) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F1EFEA"/>' : ""}</w:tcPr>${cellText(cells[at] ?? "", head)}</w:tc>`).join("")}</w:tr>`;
    const edge = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C9C5BC"/>`;
    return `${block.caption ? para("Caption", [{ text: block.caption }]) : ""}<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(edge).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`
      + `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${block.head.some(Boolean) ? row(block.head, true) : ""}${block.rows.map((cells) => row(cells, false)).join("")}</w:tbl><w:p/>`;
  };
  const parts: string[] = [para("Title", [{ text: title }])];
  if (meta.subtitle) parts.push(para("Subtitle", [{ text: meta.subtitle }]));
  if (meta.author || meta.date) parts.push(para("Byline", [{ text: [meta.author, meta.date].filter(Boolean).join(" · ") }]));
  for (const block of all) {
    if (block.kind === "heading") parts.push(para(`Heading${block.level}`, block.runs));
    else if (block.kind === "para") parts.push(para("", block.runs));
    else if (block.kind === "item") {
      if (block.ordered && block.first && block.level === 0) current = ++numbered;
      parts.push(para("ListParagraph", block.runs, `<w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="${block.ordered ? 1 + Math.max(1, current) : 1}"/></w:numPr>`));
    } else if (block.kind === "quote") parts.push(para("Quote", block.label ? [{ text: `${block.label}: `, bold: true }, ...block.runs] : block.runs));
    else if (block.kind === "code") parts.push(...block.text.split("\n").map((line) => para("Code", [{ text: line }])));
    else if (block.kind === "table") parts.push(table(block));
    else if (block.kind === "rule") parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9C5BC"/></w:pBdr></w:pPr></w:p>');
  }
  const document = `${XML}<w:document ${W} xmlns:r="${REL}"><w:body>${parts.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const style = (id: string, name: string, pPr: string, rPr: string, based = "Normal", outline = -1) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${id === "Normal" ? "" : `<w:basedOn w:val="${based}"/><w:next w:val="Normal"/>`}<w:qFormat/><w:pPr>${pPr}${outline >= 0 ? `<w:outlineLvl w:val="${outline}"/>` : ""}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  const sized = (half: number, more = "") => `${more}<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
  const styles = `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + style("Title", "Title", '<w:spacing w:after="80"/>', sized(56, "<w:b/>"))
    + style("Subtitle", "Subtitle", '<w:spacing w:after="80"/>', sized(28, '<w:color w:val="5F5A52"/>'))
    + style("Byline", "Byline", '<w:spacing w:after="360"/>', sized(20, '<w:color w:val="7A756C"/>'))
    + style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="360" w:after="120"/>', sized(36, "<w:b/>"), "Normal", 0)
    + style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="320" w:after="100"/>', sized(30, "<w:b/>"), "Normal", 1)
    + style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="260" w:after="80"/>', sized(26, "<w:b/>"), "Normal", 2)
    + style("Heading4", "heading 4", '<w:keepNext/><w:spacing w:before="220" w:after="60"/>', sized(22, "<w:b/>"), "Normal", 3)
    + style("ListParagraph", "List Paragraph", '<w:spacing w:after="60"/><w:contextualSpacing/>', "")
    + style("Quote", "Quote", '<w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="C9C5BC"/></w:pBdr><w:ind w:left="360"/>', '<w:color w:val="4A463F"/>')
    + style("Code", "Code", '<w:shd w:val="clear" w:color="auto" w:fill="F4F2EE"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>${sized(19)}`)
    + style("Caption", "caption", '<w:keepNext/><w:spacing w:before="200" w:after="80"/>', sized(20, '<w:b/><w:color w:val="4A463F"/>'))
    + "</w:styles>";
  const level = (at: number, format: string, text: string) => `<w:lvl w:ilvl="${at}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (at + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const numbering = `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3].map((at) => level(at, "bullet", ["•", "–", "•", "–"][at]!)).join("")}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3].map((at) => level(at, at % 2 ? "lowerLetter" : "decimal", `%${at + 1}.`)).join("")}</w:abstractNum>`
    + `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
    + Array.from({ length: Math.max(1, numbered) }, (_, at) => `<w:num w:numId="${at + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join("") + "</w:numbering>";
  return zip([
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", rels([["rId1", "officeDocument", "word/document.xml"], ["rId2", CORE_REL, "docProps/core.xml"]])],
    ["docProps/core.xml", core(title)],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", rels([["rId1", "styles", "styles.xml"], ["rId2", "numbering", "numbering.xml"], ...links.map((href, at) => [`rLink${at + 1}`, "hyperlink", href, "External"] as const)])],
    ["word/styles.xml", styles],
    ["word/numbering.xml", numbering],
  ]);
}

// ---------------------------------------------------------------- deck → .pptx

const LOOKS: Record<string, { ink: string; paper: string; accent: string }> = {
  paper: { ink: "1F1C17", paper: "F7F2E8", accent: "C4542E" }, sand: { ink: "2D2318", paper: "EEE3CD", accent: "A8571A" }, ink: { ink: "ECEBE7", paper: "151517", accent: "A9C4FF" },
  forest: { ink: "EEF0E6", paper: "1D3A2D", accent: "8FD6A9" }, ocean: { ink: "E8F1FB", paper: "0F2236", accent: "6CB8FF" }, plum: { ink: "F5EDF6", paper: "2A1C2F", accent: "E6A4C4" },
};
const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const WIDE = 12192000, HIGH = 6858000, EDGE = 762000;
const mix = (a: string, b: string, t: number) => [0, 2, 4].map((at) => Math.round(parseInt(a.slice(at, at + 2), 16) * (1 - t) + parseInt(b.slice(at, at + 2), 16) * t).toString(16).padStart(2, "0")).join("").toUpperCase();

/// A deck as a PowerPoint file: a slide per slide in the deck's own colours, its words as editable text
/// (titles, bullets, tables for charts and stats), and each slide's speaker notes in the notes pane.
export function deckPPTX(source: string, fallbackTitle: string): Buffer {
  const { meta, body } = frontMatter(source), slides = splitSlides(body);
  const look = { ...(LOOKS[(meta.theme ?? "").toLowerCase()] ?? LOOKS.paper!) };
  if (/^#[0-9a-f]{6}$/i.test(meta.accent ?? "")) look.accent = meta.accent!.slice(1).toUpperCase();
  const muted = mix(look.ink, look.paper, 0.4), hair = mix(look.ink, look.paper, 0.82);
  const title = meta.title || /^#\s+(.+)$/m.exec(slides[0] ?? "")?.[1]?.trim() || fallbackTitle;
  const rPr = (one: Run, size: number, colour: string, bold = false) => `<a:rPr lang="en-US" sz="${size}"${bold || one.bold ? ' b="1"' : ""}${one.italic ? ' i="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${one.href ? look.accent : colour}"/></a:solidFill>${one.code ? '<a:latin typeface="Consolas"/>' : ""}</a:rPr>`;
  const runsXML = (runs: readonly Run[], size: number, colour: string, bold = false) => runs.flatMap((one) => one.text.split("\n").map((piece, at) => `${at ? "<a:br/>" : ""}<a:r>${rPr(one, size, colour, bold)}<a:t>${x(piece)}</a:t></a:r>`)).join("");
  const para = (runs: readonly Run[], size: number, colour: string, options: { bold?: boolean; bullet?: string; level?: number; after?: number; align?: string } = {}) => {
    const level = options.level ?? 0, indent = options.bullet ? ` marL="${342900 + level * 342900}" indent="-342900"` : "";
    return `<a:p><a:pPr${indent}${options.align ? ` algn="${options.align}"` : ""}><a:spcAft><a:spcPts val="${options.after ?? 900}"/></a:spcAft>${options.bullet ? `<a:buClr><a:srgbClr val="${look.accent}"/></a:buClr>${options.bullet === "auto" ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>' : '<a:buFont typeface="Arial"/><a:buChar char="•"/>'}` : "<a:buNone/>"}</a:pPr>${runsXML(runs, size, colour, options.bold) || `<a:endParaRPr lang="en-US" sz="${size}"/>`}</a:p>`;
  };
  let shape = 1;
  const box = (name: string, at: { x: number; y: number; w: number; h: number }, paras: string, anchor = "t") =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${++shape}" name="${x(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${at.x}" y="${at.y}"/><a:ext cx="${at.w}" cy="${at.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras || "<a:p/>"}</p:txBody></p:sp>`;
  const tableXML = (block: Extract<Block, { kind: "table" }>, at: { x: number; y: number; w: number }) => {
    const cols = Math.max(1, block.head.length, ...block.rows.map((row) => row.length)), width = Math.floor(at.w / cols), rows = [...(block.head.some(Boolean) ? [{ cells: block.head, head: true }] : []), ...block.rows.slice(0, 12).map((cells) => ({ cells, head: false }))];
    const line = (side: string, colour: string) => `<a:${side} w="9525"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></a:${side}>`;
    const cell = (text: string, head: boolean) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"${head ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${head ? muted : look.ink}"/></a:solidFill></a:rPr><a:t>${x(text)}</a:t></a:r></a:p></a:txBody><a:tcPr marL="91440" marR="91440" marT="64008" marB="64008">${line("lnL", look.paper)}${line("lnR", look.paper)}${line("lnT", look.paper)}${line("lnB", hair)}<a:noFill/></a:tcPr></a:tc>`;
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${++shape}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${at.x}" y="${at.y}"/><a:ext cx="${width * cols}" cy="${rows.length * 370840}"/></p:xfrm>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${width}"/>`).join("")}</a:tblGrid>`
      + rows.map((row) => `<a:tr h="370840">${Array.from({ length: cols }, (_, col) => cell(row.cells[col] ?? "", row.head)).join("")}</a:tr>`).join("") + "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>";
  };
  const slideXML = (slide: string, index: number) => {
    shape = 1;
    const layout = slideLayout(slide, index), all = blocks(slide), shapes: string[] = [];
    const headAt = all.findIndex((block) => block.kind === "heading"), head = headAt >= 0 ? all.splice(headAt, 1)[0] as Extract<Block, { kind: "heading" }> : null;
    const tables = all.filter((block): block is Extract<Block, { kind: "table" }> => block.kind === "table"), rest = all.filter((block) => block.kind !== "table" && block.kind !== "rule");
    const inner = WIDE - 2 * EDGE;
    const words = (size: number, colour = look.ink) => rest.map((block) => block.kind === "item" ? para(block.runs, size, colour, { bullet: block.ordered ? "auto" : "char", level: block.level, after: 600 })
      : block.kind === "quote" ? para(block.label ? [{ text: `${block.label}: `, bold: true }, ...block.runs] : block.runs, size, colour)
      : block.kind === "code" ? para([{ text: block.text, code: true }], Math.round(size * 0.8), colour)
      : block.kind === "heading" ? para(block.runs, Math.round(size * 1.1), colour, { bold: true }) : para((block as Extract<Block, { kind: "para" }>).runs, size, colour)).join("");
    if (layout === "title") {
      shapes.push(box("Title", { x: EDGE, y: 1905000, w: inner, h: 1905000 }, head ? para(head.runs, 5400, look.ink, { bold: true, after: 0 }) : "", "b"));
      const sub = [...(meta.subtitle && index === 0 && !rest.length ? [para([{ text: meta.subtitle }], 2400, muted)] : []), words(2400, muted)].join("");
      if (sub) shapes.push(box("Subtitle", { x: EDGE, y: 3962400, w: inner, h: 1371600 }, sub));
    } else if (layout === "number") {
      shapes.push(box("Number", { x: EDGE, y: 1447800, w: inner, h: 2209800 }, head ? para(head.runs, 13800, look.accent, { bold: true, after: 0 }) : "", "b"));
      shapes.push(box("What it means", { x: EDGE, y: 3810000, w: Math.round(inner * 0.75), h: 1905000 }, words(2800)));
    } else if (layout === "statement") {
      shapes.push(box("Statement", { x: EDGE, y: 1524000, w: Math.round(inner * 0.86), h: 2743200 }, head ? para(head.runs, 4800, look.ink, { bold: true, after: 0 }) : "", "ctr"));
      if (rest.length) shapes.push(box("More", { x: EDGE, y: 4419600, w: Math.round(inner * 0.75), h: 1295400 }, words(2200, muted)));
    } else if (layout === "quote") {
      const quotes = rest.filter((block): block is Extract<Block, { kind: "quote" }> => block.kind === "quote"), said = quotes.flatMap((quote) => quote.runs), cut = said.findLastIndex((run) => run.text === "\n");
      // A last line that starts with a dash is who said it.
      const who = cut >= 0 && /^\s*[—–-]/.test(plain(said.slice(cut + 1))) ? said.slice(cut + 1) : [];
      shapes.push(box("Quote", { x: EDGE, y: 1371600, w: Math.round(inner * 0.86), h: 3048000 }, para((who.length ? said.slice(0, cut) : said).map((run) => ({ ...run, italic: true })), 3600, look.ink, { after: 0 }), "ctr"));
      if (who.length) shapes.push(box("Who said it", { x: EDGE, y: 4572000, w: inner, h: 609600 }, para(who, 2000, muted)));
    } else {
      if (head) shapes.push(box("Title", { x: EDGE, y: 533400, w: inner, h: 990600 }, para(head.runs, 3200, look.ink, { bold: true, after: 0 }), "b"));
      const top = head ? 1752600 : 762000, side = tables.length > 0 && rest.length > 0;
      if (rest.length) shapes.push(box("Words", { x: EDGE, y: top, w: side ? Math.round(inner * 0.44) : inner, h: HIGH - top - 990600 }, words(side ? 2000 : 2400)));
      let y = top;
      for (const table of tables.slice(0, 2)) {
        const left = side ? EDGE + Math.round(inner * 0.5) : EDGE, width = side ? Math.round(inner * 0.5) : inner;
        if (table.caption) { shapes.push(box("Caption", { x: left, y, w: width, h: 381000 }, para([{ text: table.caption }], 1400, muted, { bold: true, after: 0 }))); y += 419100; }
        shapes.push(tableXML(table, { x: left, y, w: width }));
        y += (Math.min(12, table.rows.length) + 1) * 370840 + 304800;
      }
    }
    // The foot, as on the page: the deck's name and where you are.
    const foot = index === 0 && (meta.author || meta.date) ? [meta.author, meta.date].filter(Boolean).join(" · ") : `${title}   ${index + 1} / ${slides.length}`;
    shapes.push(box("Foot", { x: EDGE, y: HIGH - 685800, w: inner, h: 304800 }, para([{ text: foot }], 1100, muted, { after: 0 })));
    return `${XML}<p:sld ${P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${look.paper}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  };
  const tree = (inner: string) => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${inner}</p:spTree></p:cSld>`;
  const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  const dark = parseInt(look.paper.slice(0, 2), 16) < 128;
  const theme = (name: string) => `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements><a:clrScheme name="${name}"><a:dk1><a:srgbClr val="${dark ? look.paper : look.ink}"/></a:dk1><a:lt1><a:srgbClr val="${dark ? look.ink : look.paper}"/></a:lt1><a:dk2><a:srgbClr val="${muted}"/></a:dk2><a:lt2><a:srgbClr val="${hair}"/></a:lt2>`
    + `${[1, 2, 3, 4, 5, 6].map((n) => `<a:accent${n}><a:srgbClr val="${n === 1 ? look.accent : mix(look.accent, look.ink, n * 0.12)}"/></a:accent${n}>`).join("")}<a:hlink><a:srgbClr val="${look.accent}"/></a:hlink><a:folHlink><a:srgbClr val="${muted}"/></a:folHlink></a:clrScheme>`
    + `<a:fontScheme name="${name}"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${name}"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>`
    + `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>`
    + `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>`
    + `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const notes = slides.map(slideNotes);
  const noted = notes.map((text, at) => text ? at : -1).filter((at) => at >= 0);
  const notesBody = (text: string) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${text.split(/\n+/).map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${x(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
  const notesMaster = `${XML}<p:notesMaster ${P}>${tree(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`)}${clrMap}</p:notesMaster>`;
  const files: [string, string][] = [
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`
      + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
      + (noted.length ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` : "")
      + slides.map((_, at) => `<Override PartName="/ppt/slides/slide${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")
      + noted.map((at) => `<Override PartName="/ppt/notesSlides/notesSlide${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("")
      + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"], ["rId2", CORE_REL, "docProps/core.xml"]])],
    ["docProps/core.xml", core(title)],
    ["ppt/presentation.xml", `${XML}<p:presentation ${P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${noted.length ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slides.length + 3}"/></p:notesMasterIdLst>` : ""}`
      + `<p:sldIdLst>${slides.map((_, at) => `<p:sldId id="${256 + at}" r:id="rId${at + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${WIDE}" cy="${HIGH}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "theme", "theme/theme1.xml"], ...slides.map((_, at) => [`rId${at + 3}`, "slide", `slides/slide${at + 1}.xml`] as const),
      ...(noted.length ? [[`rId${slides.length + 3}`, "notesMaster", "notesMasters/notesMaster1.xml"] as const] : [])])],
    ["ppt/theme/theme1.xml", theme("Foundry")],
    ["ppt/slideMasters/slideMaster1.xml", `${XML}<p:sldMaster ${P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${look.paper}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>${clrMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]])],
    ["ppt/slideLayouts/slideLayout1.xml", `${XML}<p:sldLayout ${P} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])],
  ];
  if (noted.length) files.push(["ppt/notesMasters/notesMaster1.xml", notesMaster], ["ppt/notesMasters/_rels/notesMaster1.xml.rels", rels([["rId1", "theme", "../theme/theme2.xml"]])], ["ppt/theme/theme2.xml", theme("Foundry notes")]);
  slides.forEach((slide, at) => {
    files.push([`ppt/slides/slide${at + 1}.xml`, slideXML(slide, at)]);
    files.push([`ppt/slides/_rels/slide${at + 1}.xml.rels`, rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ...(notes[at] ? [["rId2", "notesSlide", `../notesSlides/notesSlide${at + 1}.xml`] as const] : [])])]);
    if (notes[at]) {
      files.push([`ppt/notesSlides/notesSlide${at + 1}.xml`, `${XML}<p:notes ${P}>${tree(notesBody(notes[at]!))}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`]);
      files.push([`ppt/notesSlides/_rels/notesSlide${at + 1}.xml.rels`, rels([["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"], ["rId2", "slide", `../slides/slide${at + 1}.xml`]])]);
    }
  });
  return zip(files);
}
