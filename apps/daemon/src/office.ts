import { inflateRawSync } from "node:zlib";

/// Office files read without a library: spreadsheets (.xlsx), Word files
/// (.docx) and slides (.pptx) are zips of XML, and Apple's .numbers, .pages
/// and .key carry a picture of their first page. Used for file previews
/// (file-preview.ts) and so read_file can read them (documents.ts).

const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

/// The files in a zip, each unpacked on demand. Throws on anything that
/// isn't a plain zip (zip64 and encrypted entries included).
export function readZip(bytes: Uint8Array): Map<string, () => Buffer> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--)
    if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error("not a zip file");
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const files = new Map<string, () => Buffer>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw new Error("damaged zip file");
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const packed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extra + comment;
    if (flags & 1) continue;
    files.set(name, () => {
      if (size > MAX_ENTRY_BYTES) throw new Error(`${name} is too big`);
      if (data.readUInt32LE(local) !== 0x04034b50) throw new Error("damaged zip file");
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      const raw = data.subarray(start, start + packed);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`${name} uses an unsupported compression`);
    });
  }
  return files;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export const unescapeXml = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) =>
  code[0] === "#" ? String.fromCodePoint(code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ENTITIES[code] ?? whole);
const attributes = (tag: string) => {
  const out: Record<string, string> = {};
  for (const [, key, value] of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[key!] = unescapeXml(value!);
  return out;
};
const text = (files: Map<string, () => Buffer>, name: string) => files.get(name)?.().toString("utf8");
/// A part's relationships: id → target path inside the zip.
function relations(files: Map<string, () => Buffer>, folder: string, rels: string) {
  const out = new Map<string, string>();
  for (const [tag] of (text(files, rels) ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const { Id, Target } = attributes(tag);
    if (!Id || !Target) continue;
    const parts = (Target.startsWith("/") ? Target.slice(1) : `${folder}/${Target}`).split("/"), path: string[] = [];
    for (const part of parts) if (part === "..") path.pop(); else if (part && part !== ".") path.push(part);
    out.set(Id, path.join("/"));
  }
  return out;
}

export interface Sheet { name: string; rows: string[][]; more: boolean }
export const SHEET_ROWS = 200, SHEET_COLUMNS = 30, MAX_SHEETS = 20;

const column = (reference: string) => {
  let n = 0;
  for (const char of reference.replace(/\d+$/, "").toUpperCase()) n = n * 26 + char.charCodeAt(0) - 64;
  return n - 1;
};
/// A number as its cell format shows it, roughly: dates, percents,
/// thousands and currency; the rest without float noise.
export function formatNumber(raw: string, code: string | undefined): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || !code || code === "General") return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : raw;
  const plain = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  if (/[dy]|m{3,}|(^|[^0#])m+([^0#]|$)/i.test(plain) && !/[0#]/.test(plain)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000));
    const day = date.toISOString().slice(0, 10), time = date.toISOString().slice(11, 16);
    return /h/i.test(plain) ? (value >= 1 ? `${day} ${time}` : time) : day;
  }
  const decimals = /\.(0+)/.exec(plain)?.[1]?.length ?? 0;
  if (plain.includes("%")) return `${(value * 100).toFixed(decimals)}%`;
  const grouped = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: plain.includes(",") });
  const currency = /"?([$€£¥])/.exec(code)?.[1] ?? /\[\$([^\]-]+)/.exec(code)?.[1] ?? "";
  return `${value < 0 ? "−" : ""}${currency}${grouped}`;
}
const BUILT_IN_FORMATS: Record<number, string> = { 9: "0%", 10: "0.00%", 3: "#,##0", 4: "#,##0.00", 14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0" };

/// The sheets of an .xlsx, at most SHEET_ROWS × SHEET_COLUMNS each.
export function xlsxSheets(bytes: Uint8Array): Sheet[] {
  const files = readZip(bytes);
  const workbook = text(files, "xl/workbook.xml");
  if (!workbook) throw new Error("not a spreadsheet");
  const rels = relations(files, "xl", "xl/_rels/workbook.xml.rels");
  const shared = [...(text(files, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(([, item]) => unescapeXml([...item!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
  const styles = text(files, "xl/styles.xml") ?? "";
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*>/g)].map(([tag]) => { const a = attributes(tag); return [Number(a.numFmtId), a.formatCode ?? ""] as const; }));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const formats = [...xfs.matchAll(/<xf\b[^>]*>/g)].map(([tag]) => { const id = Number(attributes(tag).numFmtId ?? 0); return custom.get(id) ?? BUILT_IN_FORMATS[id]; });
  const sheets: Sheet[] = [];
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    if (sheets.length >= MAX_SHEETS) break;
    const a = attributes(tag), path = rels.get(a["r:id"] ?? "");
    const xml = path ? text(files, path) : undefined;
    if (!xml) continue;
    const rows: string[][] = [];
    let more = false;
    for (const [, rowTag, body] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const index = Number(attributes(rowTag!).r ?? rows.length + 1) - 1;
      if (index >= SHEET_ROWS) { more = true; break; }
      const row: string[] = [];
      for (const [, cellTag, inner] of (body ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const c = attributes(cellTag!), at = c.r ? column(c.r) : row.length;
        if (at >= SHEET_COLUMNS) { more = true; continue; }
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner ?? "")?.[1];
        let value = "";
        if (c.t === "s") value = shared[Number(v)] ?? "";
        else if (c.t === "inlineStr") value = unescapeXml([...(inner ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
        else if (c.t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = c.t === "str" || c.t === "e" ? unescapeXml(v) : formatNumber(v, formats[Number(c.s ?? 0)]);
        row[at] = value;
      }
      rows[index] = Array.from(row, (cell) => cell ?? "");
    }
    sheets.push({ name: a.name ?? `Sheet ${sheets.length + 1}`, rows: trimSheet(Array.from(rows, (row) => row ?? [])), more });
  }
  if (!sheets.length) throw new Error("no sheets in this spreadsheet");
  return sheets;
}
/// Rows padded to one width, empty rows and columns at the end dropped.
function trimSheet(rows: string[][]): string[][] {
  while (rows.length && rows.at(-1)!.every((cell) => !cell)) rows.pop();
  const width = Math.max(0, ...rows.map((row) => { let n = row.length; while (n && !row[n - 1]) n--; return n; }));
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}

/// A .csv or .tsv as one sheet.
export function delimitedSheet(source: string, name: string, separator = name.toLowerCase().endsWith(".tsv") ? "\t" : ","): Sheet {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, more = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === separator) { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell); rows.push(row.slice(0, SHEET_COLUMNS)); row = []; cell = "";
      if (rows.length >= SHEET_ROWS) { more = i < source.length - 1; break; }
    } else cell += char;
  }
  if (rows.length < SHEET_ROWS && (cell || row.length)) { row.push(cell); rows.push(row.slice(0, SHEET_COLUMNS)); }
  return { name, rows: trimSheet(rows), more };
}

export interface Block { level: 0 | 1 | 2 | 3; text: string; bullet?: boolean }
export const MAX_BLOCKS = 2000;

/// A Word file's paragraphs, headings marked.
export function docxBlocks(bytes: Uint8Array): Block[] {
  const xml = text(readZip(bytes), "word/document.xml");
  if (!xml) throw new Error("not a Word document");
  const blocks: Block[] = [];
  for (const [, body] of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    if (blocks.length >= MAX_BLOCKS) break;
    const inner = body ?? "";
    const words = unescapeXml(inner.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t>\n</w:t>").match(/<w:t\b[^>]*>[^<]*<\/w:t>/g)?.map((t) => t.replace(/<[^>]+>/g, "")).join("") ?? "");
    const style = /<w:pStyle w:val="([^"]+)"/.exec(inner)?.[1] ?? "";
    const level = /^title$/i.test(style) ? 1 : Math.min(3, Number(/^heading\s*(\d)/i.exec(style)?.[1] ?? 0)) as Block["level"];
    if (!words.trim()) { if (blocks.length && blocks.at(-1)!.text) blocks.push({ level: 0, text: "" }); continue; }
    blocks.push({ level, text: words, ...(/<w:numPr>/.test(inner) ? { bullet: true } : {}) });
  }
  while (blocks.at(-1)?.text === "") blocks.pop();
  return blocks;
}

export interface Slide { title: string; lines: string[] }
export const MAX_SLIDES = 100;

/// A deck's slides in order: each one's title and its other lines.
export function pptxSlides(bytes: Uint8Array): { slides: Slide[]; ratio: number } {
  const files = readZip(bytes);
  const deck = text(files, "ppt/presentation.xml");
  if (!deck) throw new Error("not a slide deck");
  const rels = relations(files, "ppt", "ppt/_rels/presentation.xml.rels");
  const size = attributes(/<p:sldSz\b[^>]*>/.exec(deck)?.[0] ?? "");
  const ratio = Number(size.cx) > 0 && Number(size.cy) > 0 ? Number(size.cx) / Number(size.cy) : 16 / 9;
  const slides: Slide[] = [];
  for (const [tag] of deck.matchAll(/<p:sldId\b[^>]*>/g)) {
    if (slides.length >= MAX_SLIDES) break;
    const path = rels.get(attributes(tag)["r:id"] ?? ""), xml = path ? text(files, path) : undefined;
    if (!xml) continue;
    let title = "";
    const lines: string[] = [];
    for (const [shape] of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
      const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(shape);
      const paragraphs = [...shape.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)]
        .map(([, body]) => unescapeXml((body ?? "").match(/<a:t>[^<]*<\/a:t>/g)?.map((t) => t.slice(5, -6)).join("") ?? "").trim()).filter(Boolean);
      if (isTitle && !title) title = paragraphs.join(" ");
      else lines.push(...paragraphs);
    }
    if (!title && lines.length) title = lines.shift()!;
    slides.push({ title, lines: lines.slice(0, 14) });
  }
  return { slides, ratio };
}

/// The picture Apple's apps save inside a .numbers, .pages or .key zip.
export function iworkPreview(bytes: Uint8Array): Buffer | null {
  const files = readZip(bytes);
  for (const name of ["preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg"]) {
    const entry = files.get(name);
    if (entry) return entry();
  }
  return null;
}

/// An office file as plain text, for the model: sheets as tab-separated
/// rows, Word files as paragraphs with # headings, slides one by one.
export function officeText(kind: "xlsx" | "docx" | "pptx", bytes: Uint8Array): string {
  if (kind === "xlsx") return xlsxSheets(bytes).map((sheet) => `## ${sheet.name}\n${sheet.rows.map((row) => row.join("\t")).join("\n")}${sheet.more ? `\n… (more rows or columns past ${SHEET_ROWS} × ${SHEET_COLUMNS})` : ""}`).join("\n\n");
  if (kind === "docx") return docxBlocks(bytes).map((block) => `${block.level ? `${"#".repeat(block.level)} ` : block.bullet ? "- " : ""}${block.text}`).join("\n");
  return pptxSlides(bytes).slides.map((slide, index) => `## Slide ${index + 1}: ${slide.title}${slide.lines.length ? `\n${slide.lines.join("\n")}` : ""}`).join("\n\n");
}

/// An OpenDocument file (.odt, .ods, .odp from LibreOffice, Google Docs
/// downloads) as plain text: headings marked, table cells tab-separated,
/// one line per paragraph.
export function odfText(bytes: Uint8Array): string {
  const xml = text(readZip(bytes), "content.xml");
  if (!xml) throw new Error("not an OpenDocument file");
  // Footnotes hold paragraphs of their own; they go before the paragraphs are read.
  const body = (/<office:body>([\s\S]*)<\/office:body>/.exec(xml)?.[1] ?? xml).replace(/<text:note\b[\s\S]*?<\/text:note>/g, "");
  const lines: string[] = [];
  const inline = (part: string) => unescapeXml(part
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, count) => " ".repeat(Number(count ?? 1)))
    .replace(/<text:tab\s*\/>/g, "\t").replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<[^>]+>/g, ""));
  for (const [, row, heading, level, paragraph] of body.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>|<text:h\b([^>]*)>([\s\S]*?)<\/text:h>|<text:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:p>)/g)) {
    if (lines.length >= MAX_BLOCKS) break;
    if (row !== undefined) {
      const cells = [...row.matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)].map(([, attrs, cell]) => {
        const repeat = Math.min(20, Number(/table:number-columns-repeated="(\d+)"/.exec(attrs ?? "")?.[1] ?? 1));
        const words = [...(cell ?? "").matchAll(/<text:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:p>)/g)].map(([, p]) => inline(p ?? "")).join(" ");
        return Array<string>(repeat).fill(words);
      }).flat();
      while (cells.length && !cells.at(-1)) cells.pop();
      if (cells.length) lines.push(cells.join("\t"));
      continue;
    }
    if (heading !== undefined) {
      const depth = Math.min(3, Math.max(1, Number(/text:outline-level="(\d+)"/.exec(heading)?.[1] ?? 1)));
      lines.push(`${"#".repeat(depth)} ${inline(level ?? "").trim()}`);
      continue;
    }
    lines.push(inline(paragraph ?? ""));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/// Groups an RTF reader skips whole: fonts, colours, styles, pictures and
/// anything marked optional with \\*.
const RTF_SKIP = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer", "headerl", "headerr", "footerl", "footerr", "listtable", "listoverridetable", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "rsidtbl", "generator"]);

/// A Rich Text file (.rtf, TextEdit's default) as plain text.
export function rtfText(source: string): string {
  if (!source.startsWith("{\\rtf")) throw new Error("not an RTF file");
  let out = "", skip = 0, depth = 0, unicodeSkip = 1, pendingSkip = 0;
  const skipAt: number[] = [];
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!;
    if (char === "{") { depth++; continue; }
    if (char === "}") { if (skipAt.at(-1) === depth) { skipAt.pop(); skip--; } depth--; continue; }
    if (char === "\\") {
      const next = source[at + 1] ?? "";
      if (next === "\\" || next === "{" || next === "}") { if (!skip) out += next; at++; continue; }
      if (next === "'") { const code = parseInt(source.slice(at + 2, at + 4), 16); if (pendingSkip) pendingSkip--; else if (!skip && !Number.isNaN(code)) out += new TextDecoder("windows-1252").decode(new Uint8Array([code])); at += 3; continue; }
      if (next === "*") { if (!skip || skipAt.at(-1) !== depth) { skip++; skipAt.push(depth); } at++; continue; }
      if (next === "~") { if (!skip) out += "\u00a0"; at++; continue; }
      if (next === "\n" || next === "\r") { if (!skip) out += "\n"; at++; continue; }
      const word = /^([a-z]+)(-?\d+)? ?/.exec(source.slice(at + 1));
      if (!word) { at++; continue; }
      at += word[0].length;
      const [, name, value] = word;
      if (RTF_SKIP.has(name!) && source[at - word[0].length - 1] === "{") { skip++; skipAt.push(depth); continue; }
      if (skip) continue;
      if (name === "par" || name === "line" || name === "row") out += "\n";
      else if (name === "tab" || name === "cell") out += "\t";
      else if (name === "uc") unicodeSkip = Number(value ?? 1);
      else if (name === "u") { const code = Number(value); out += String.fromCharCode(code < 0 ? code + 65536 : code); pendingSkip = unicodeSkip; }
      else if (name === "emdash") out += "—"; else if (name === "endash") out += "–";
      else if (name === "lquote") out += "‘"; else if (name === "rquote") out += "’";
      else if (name === "ldblquote") out += "“"; else if (name === "rdblquote") out += "”";
      else if (name === "bullet") out += "•";
      continue;
    }
    if (char === "\n" || char === "\r") continue;
    if (skip) continue;
    if (pendingSkip) { pendingSkip--; continue; }
    out += char;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
