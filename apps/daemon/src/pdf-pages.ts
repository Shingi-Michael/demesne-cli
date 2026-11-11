import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocumentProxy } from "unpdf";

/// A PDF page as a picture, so the model can see scans, charts and diagrams
/// that have no text to read. The Mac draws it with its own PDFKit (through
/// osascript, nothing to install); elsewhere poppler's pdftoppm draws it when
/// it is installed. The page comes back as PNG bytes.

/// Wide enough to read body text, small enough for a model's image budget.
export const PAGE_WIDTH = 1400;
const TIMEOUT_MS = 30_000;

export class PdfPageError extends Error {}

/// PDFKit through JavaScript for Automation: open, draw one page at the asked
/// width onto a white sheet, write a PNG. Prints "OK <pages>" or "RANGE <pages>".
export const PDFKIT_SCRIPT = `
ObjC.import("PDFKit"); ObjC.import("AppKit");
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return "OPEN";
  const pages = doc.pageCount, wanted = parseInt(argv[1], 10);
  if (!(wanted >= 1 && wanted <= pages)) return "RANGE " + pages;
  const page = doc.pageAtIndex(wanted - 1);
  const box = page.boundsForBox(1);
  const turned = page.rotation % 180 !== 0;
  const w = turned ? box.size.height : box.size.width, h = turned ? box.size.width : box.size.height;
  const width = parseInt(argv[3], 10), height = Math.max(1, Math.round(width * h / w));
  const image = page.thumbnailOfSizeForBox($.NSMakeSize(width, height), 1);
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties(4, $({}));
  if (!png.writeToFileAtomically(argv[2], true)) return "WRITE";
  return "OK " + pages;
}`;

export type Spawn = (argv: string[]) => Promise<{ code: number; out: string }>;

const spawnText: Spawn = async (argv) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    const out = await new Response(child.stdout).text();
    return { code: await child.exited, out };
  } finally { clearTimeout(timer); }
};

export interface RenderOptions {
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  /// Where pdftoppm is, or null when it isn't installed.
  pdftoppm?: string | null;
  width?: number;
}

/// Page `page` (from 1) of the PDF at `absolute`, as PNG bytes.
export async function renderPdfPage(absolute: string, page: number, options: RenderOptions = {}): Promise<{ png: Buffer; pages: number | null }> {
  const platform = options.platform ?? process.platform, spawn = options.spawn ?? spawnText, width = options.width ?? PAGE_WIDTH;
  const folder = mkdtempSync(join(tmpdir(), "demesne-pdf-page-"));
  try {
    if (platform === "darwin") {
      const out = join(folder, "page.png");
      const result = await spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", PDFKIT_SCRIPT, absolute, String(page), out, String(width)]);
      const said = result.out.trim();
      if (said.startsWith("RANGE")) throw new PdfPageError(`the PDF has ${said.split(" ")[1]} pages; page ${page} isn't one of them`);
      if (result.code !== 0 || !said.startsWith("OK")) throw new PdfPageError(said === "OPEN" ? "the PDF couldn't be opened (damaged or password-protected)" : "the Mac couldn't draw that page");
      return { png: readFileSync(out), pages: Number(said.split(" ")[1]) || null };
    }
    const pdftoppm = options.pdftoppm === undefined ? Bun.which("pdftoppm") : options.pdftoppm;
    if (!pdftoppm) throw new PdfPageError("seeing PDF pages needs a Mac, or poppler's pdftoppm installed");
    let pages: number;
    try { const doc = await getDocumentProxy(new Uint8Array(readFileSync(absolute))); pages = doc.numPages; void doc.cleanup?.(); }
    catch { throw new PdfPageError("the PDF couldn't be opened (damaged or password-protected)"); }
    if (page > pages) throw new PdfPageError(`the PDF has ${pages} page${pages === 1 ? "" : "s"}; page ${page} isn't one of them`);
    const prefix = join(folder, "page");
    const result = await spawn([pdftoppm, "-f", String(page), "-l", String(page), "-png", "-singlefile", "-scale-to-x", String(width), "-scale-to-y", "-1", absolute, prefix]);
    let png: Buffer;
    try { png = readFileSync(`${prefix}.png`); }
    catch { throw new PdfPageError(result.code === 0 ? `page ${page} couldn't be drawn` : "pdftoppm couldn't draw the page"); }
    return { png, pages };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
