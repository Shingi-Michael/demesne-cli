import { expect, test } from "bun:test";
import { fileChipHTML, fileKind, isPicture, refusal } from "../file-chips.ts";

test("a file's kind: Office and PDF on their colours, else its ending", () => {
  expect(fileKind("pricing.pdf")).toEqual({ label: "PDF", tone: "pdf" });
  expect(fileKind("Q3 plan.docx")).toEqual({ label: "DOC", tone: "doc" });
  expect(fileKind("orders.xlsx")).toEqual({ label: "XLS", tone: "xls" });
  expect(fileKind("board.pptx")).toEqual({ label: "PPT", tone: "ppt" });
  expect(fileKind("schema.sql")).toEqual({ label: "SQL", tone: "plain" });
  expect(fileKind("Makefile")).toEqual({ label: "FILE", tone: "plain" });
});

test("pictures stay pictures; everything else is a file", () => {
  expect(isPicture({ type: "image/png", name: "a.png" })).toBe(true);
  expect(isPicture({ type: "", name: "IMG_1.HEIC" })).toBe(true);
  expect(isPicture({ type: "application/pdf", name: "a.pdf" })).toBe(false);
  expect(isPicture({ type: "image/gif", name: "a.gif" })).toBe(false);
});

test("chips show size, or why a file can't go", () => {
  expect(fileChipHTML({ id: "1", filename: "a.pdf", size: 348_160 }, { remove: "detach" })).toContain("340 KB");
  expect(fileChipHTML({ filename: "assets.zip" }, { bad: "can’t be read · zip" })).toContain('class="fc bad"');
  expect(refusal("invalid_request: assets.zip can't be read: a zip file, not text", "assets.zip")).toBe("can’t be read · zip");
  expect(refusal("Files can be at most 30 MB", "big.pdf")).toBe("too big · up to 20 MB");
  expect(refusal("scan.pdf can't be read: a scanned PDF with no text in it", "scan.pdf")).toBe("can’t be read · a scan, no text");
});
