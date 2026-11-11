import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFKIT_SCRIPT, renderPdfPage } from "../src/pdf-pages.ts";
import { ToolRegistry, viewImageTool } from "../src/tools.ts";

/// A two-page PDF with no text at all, only a filled box on each page: what a scan looks like to a text reader.
function scannedPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
    "<< /Length 30 >>\nstream\n0 0 1 rg 20 20 160 60 re f\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R >>",
    "<< /Length 30 >>\nstream\n1 0 0 rg 20 20 160 60 re f\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const isPng = (bytes: Buffer) => bytes.subarray(1, 4).toString("ascii") === "PNG";

test("pdftoppm draws a page off the Mac, and says when the page isn't there", async () => {
  const pdftoppm = Bun.which("pdftoppm");
  if (!pdftoppm) return;
  const folder = mkdtempSync(join(tmpdir(), "demesne-pdf-")), path = join(folder, "scan.pdf");
  writeFileSync(path, scannedPdf());
  const { png } = await renderPdfPage(path, 2, { platform: "linux", width: 400 });
  expect(isPng(png)).toBe(true);
  expect(png.readUInt32BE(16)).toBe(400);
  await expect(renderPdfPage(path, 9, { platform: "linux" })).rejects.toThrow("the PDF has 2 pages; page 9");
});

test("on the Mac the page is drawn by PDFKit through osascript", async () => {
  const calls: string[][] = [];
  const spawn = async (argv: string[]) => { calls.push(argv); writeFileSync(argv[7]!, Buffer.from("\x89PNG fake")); return { code: 0, out: "OK 12\n" }; };
  const result = await renderPdfPage("/x/report.pdf", 3, { platform: "darwin", spawn });
  expect(calls[0]!.slice(0, 5)).toEqual(["/usr/bin/osascript", "-l", "JavaScript", "-e", PDFKIT_SCRIPT]);
  expect(calls[0]!.slice(5, 7)).toEqual(["/x/report.pdf", "3"]);
  expect(result.pages).toBe(12);
  const range = async () => ({ code: 0, out: "RANGE 2\n" });
  await expect(renderPdfPage("/x/report.pdf", 5, { platform: "darwin", spawn: range })).rejects.toThrow("the PDF has 2 pages");
  await expect(renderPdfPage("/x/a.pdf", 1, { platform: "linux", pdftoppm: null })).rejects.toThrow("needs a Mac");
});

test("read_file points a scan at view_image, and view_image shows a PDF page", async () => {
  const folder = mkdtempSync(join(tmpdir(), "demesne-pdf-tools-"));
  writeFileSync(join(folder, "scan.pdf"), scannedPdf());
  const tools = new ToolRegistry();
  tools.register(viewImageTool());
  const context = { workspaceRoot: folder, signal: new AbortController().signal };
  await expect(tools.get("read_file")!.execute({ path: "scan.pdf" }, context)).rejects.toThrow("view_image (path, page)");
  if (process.platform === "darwin" || !Bun.which("pdftoppm")) return;
  const seen = await tools.get("view_image")!.executeWithArtifacts!({ path: "scan.pdf", page: 2 }, context);
  expect(typeof seen === "object" && seen.text).toBe("Page 2 of 2 of scan.pdf");
  expect(typeof seen === "object" && seen.images?.[0]?.filename).toBe("scan-page-2.png");
});
