import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { extractText } from "unpdf";
import { odfText, officeText, rtfText } from "./office.ts";

/// Turns a file into plain text the model can read: text files as they are,
/// PDFs through pdf.js (via unpdf), and spreadsheets, Word files and slides
/// through office.ts. Anything else isn't readable yet.

export const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".eml", ".json", ".log", ".ics", ".vcf", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini"]);
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
/// Word, Excel and PowerPoint; OpenDocument (LibreOffice); Rich Text; and the
/// old binary Word format, which only the Mac can turn into text (textutil).
export const OFFICE_EXTENSIONS = new Set([".xlsx", ".docx", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".doc"]);

export function readable(path: string): "text" | "pdf" | "office" | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(extension)) return "office";
  return TEXT_EXTENSIONS.has(extension) || extension === "" ? "text" : null;
}

export class UnreadableError extends Error {}

/// The file's text. Throws UnreadableError for files that aren't text or PDF,
/// are too big, or a PDF with no text layer (a scan).
export async function documentText(absolute: string, size: number): Promise<string> {
  const kind = readable(absolute);
  if (kind === "pdf") {
    if (size > MAX_PDF_BYTES) throw new UnreadableError("over 30 MB");
    let text: string;
    try {
      ({ text } = await extractText(new Uint8Array(readFileSync(absolute)), { mergePages: true }));
    } catch {
      throw new UnreadableError("a PDF that couldn't be opened (damaged or password-protected)");
    }
    if (!text.trim()) throw new UnreadableError("a scanned PDF with no text in it");
    return text;
  }
  if (kind === "office") {
    if (size > MAX_PDF_BYTES) throw new UnreadableError("over 30 MB");
    let text: string;
    const extension = extname(absolute).slice(1).toLowerCase();
    if (extension === "doc") text = await oldWordText(absolute);
    else {
      try {
        const bytes = readFileSync(absolute);
        text = extension === "rtf" ? rtfText(bytes.toString("latin1"))
          : extension.startsWith("od") ? odfText(bytes)
          : officeText(extension as "xlsx" | "docx" | "pptx", bytes);
      } catch { throw new UnreadableError("an office file that couldn't be opened (damaged or password-protected)"); }
    }
    if (!text.trim()) throw new UnreadableError("an office file with no text in it");
    return text;
  }
  if (kind !== "text") throw new UnreadableError("not a text file, PDF, spreadsheet, Word file or deck (images can't be read here)");
  if (size > MAX_TEXT_BYTES) throw new UnreadableError("over 4 MB");
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw new UnreadableError("not a text file");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new UnreadableError("not UTF-8 text"); }
}

/// An old .doc, through the Mac's own textutil. Elsewhere there is no
/// converter to count on, so it asks for a .docx.
async function oldWordText(absolute: string): Promise<string> {
  if (process.platform !== "darwin") throw new UnreadableError("an old Word file (.doc), readable only on a Mac; save it as .docx");
  const child = Bun.spawn(["/usr/bin/textutil", "-convert", "txt", "-stdout", "--", absolute], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const out = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new UnreadableError("an old Word file (.doc) that couldn't be opened");
    return out;
  } finally { clearTimeout(timer); }
}
