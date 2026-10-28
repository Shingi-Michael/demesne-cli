import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { extractText } from "unpdf";

/// Turns a file into plain text the model can read: text files as they are,
/// PDFs through pdf.js (via unpdf). Anything else isn't readable yet.

export const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".eml", ".json", ".log", ".ics", ".vcf", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini"]);
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_BYTES = 30 * 1024 * 1024;

export function readable(path: string): "text" | "pdf" | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") return "pdf";
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
  if (kind !== "text") throw new UnreadableError("not a text file or PDF (Word files and images can't be read yet)");
  if (size > MAX_TEXT_BYTES) throw new UnreadableError("over 4 MB");
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw new UnreadableError("not a text file");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new UnreadableError("not UTF-8 text"); }
}
