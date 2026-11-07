import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { previewable, type FilePreview } from "@demesne/protocol";
import { delimitedSheet, docxBlocks, iworkPreview, MAX_BLOCKS, pptxSlides, xlsxSheets, type Block } from "./office.ts";
import { isSensitivePath, resolveWorkspacePath } from "./tools.ts";

/// A file for its preview card (pass 188 A). Paths are the chat's own:
/// relative to its folder, or absolute when the answer named one. Only the
/// kinds a card can show are read, and never secrets.

export const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export class PreviewError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function locate(root: string | null, path: string): string {
  const asked = path.trim();
  if (!asked || asked.includes("\0")) throw new PreviewError("No file named");
  if (!previewable(asked)) throw new PreviewError("This kind of file has no preview");
  if (isAbsolute(asked)) return asked;
  if (!root) throw new PreviewError("This chat has no folder to find the file in", 404);
  // Answers often name a file from the folder's root, sometimes with ./
  try { return resolveWorkspacePath(root, asked.replace(/^\.\//, ""), false); }
  catch (error) { throw new PreviewError(error instanceof Error && /exist/.test(error.message) ? "The file isn't there anymore" : "That file is outside this chat's folder", 404); }
}

const textBlocks = (source: string, markdown: boolean): { blocks: Block[]; more: boolean } => {
  const blocks: Block[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (blocks.length >= MAX_BLOCKS) return { blocks, more: true };
    const heading = markdown ? /^(#{1,3})\s+(.*)$/.exec(line) : null;
    const bullet = markdown ? /^\s*[-*+]\s+(.*)$/.exec(line) : null;
    if (!line.trim()) { if (blocks.at(-1)?.text) blocks.push({ level: 0, text: "" }); continue; }
    blocks.push(heading ? { level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! } : bullet ? { level: 0, text: bullet[1]!, bullet: true } : { level: 0, text: line });
  }
  while (blocks.at(-1)?.text === "") blocks.pop();
  return { blocks, more: false };
};

export function previewFile(root: string | null, path: string): FilePreview {
  const absolute = locate(root, path);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(absolute); } catch { throw new PreviewError("The file isn't there anymore", 404); }
  if (!stat.isFile()) throw new PreviewError("That isn't a file");
  const extension = extname(absolute).slice(1).toLowerCase();
  const shown = path.trim();
  if (stat.size > (["md", "markdown", "txt", "csv", "tsv"].includes(extension) ? MAX_TEXT_BYTES : MAX_PREVIEW_BYTES)) throw new PreviewError("Too big to preview. Open it in its own app.");
  const bytes = readFileSync(absolute);
  // A Keynote deck is a zip that ends in .key, which secrets also do.
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isSensitivePath(absolute) && !(extension === "key" && zipped)) throw new PreviewError("That file is protected", 403);
  const base = { path: shown, absolute, name: basename(absolute), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  const text = () => {
    if (bytes.includes(0)) throw new PreviewError("That isn't a text file");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new PreviewError("That isn't UTF-8 text"); }
  };
  try {
    switch (extension) {
      case "xlsx": return { ...base, kind: "sheet", sheets: xlsxSheets(bytes) };
      case "csv": case "tsv": return { ...base, kind: "sheet", sheets: [delimitedSheet(text(), base.name)] };
      case "docx": return { ...base, kind: "doc", blocks: docxBlocks(bytes), more: false };
      case "md": case "markdown": case "txt": return { ...base, kind: "doc", ...textBlocks(text(), extension !== "txt") };
      case "pptx": return { ...base, kind: "slides", ...pptxSlides(bytes) };
      case "pdf":
        if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PreviewError("That isn't a PDF");
        return { ...base, kind: "pdf", data: bytes.toString("base64") };
      case "numbers": case "pages": case "key": {
        const picture = zipped ? iworkPreview(bytes) : null;
        if (!picture) throw new PreviewError("This file has no picture saved in it. Open it in its own app.");
        return { ...base, kind: "image", data: picture.toString("base64"), mimeType: "image/jpeg" };
      }
      default: return { ...base, kind: "image", data: bytes.toString("base64"), mimeType: IMAGE_TYPES[extension]! };
    }
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError("This file couldn't be read. It may be damaged or password-protected.");
  }
}
