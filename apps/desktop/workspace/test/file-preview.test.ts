import { expect, test } from "bun:test";
import type { FilePreview } from "@demesne/protocol";
import { fileBodyHTML, PREVIEW_CARD, previewCardHTML, previewSummary, type OpenPreview } from "../file-preview.ts";

const base = { path: "out/q3-budget.xlsx", absolute: "/w/out/q3-budget.xlsx", name: "q3-budget.xlsx", size: 10, modifiedAt: "2026-11-07T00:00:00Z" };
const sheet: FilePreview = { ...base, kind: "sheet", sheets: [
  { name: "Summary", rows: [["Team", "Left"], ["Marketing", "−$4,200"], ["<b>x</b>", "1,380"]], more: true },
  { name: "By month", rows: [["Jul"]], more: false },
] };
const open = (data?: FilePreview, extra: Partial<OpenPreview> = {}): OpenPreview => ({ sessionId: "s", path: base.path, name: base.name, data, wide: false, sheet: 0, slide: 0, ...extra });

test("a spreadsheet card: name, sheets, the table, tabs and Open", () => {
  const html = previewCardHTML(open(sheet));
  expect(html).toContain(`data-card="${PREVIEW_CARD}"`);
  expect(html).toContain('<span class="card-line" title="out/q3-budget.xlsx">q3-budget.xlsx</span><span class="card-sum">2 sheets</span>');
  expect(html).toContain("<th>A</th><th>B</th>");
  expect(html).toContain('<td class="n neg">−$4,200</td>');
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).toContain('data-action="preview-sheet"');
  expect(html).toContain("More rows past here");
  expect(html).toContain('data-action="preview-wide"');
  expect(html).toContain("Click to enlarge");
  expect(html).toContain('data-action="preview-open"');
  const second = fileBodyHTML(open(sheet, { sheet: 1 }));
  expect(second).toContain("<td class=\"\">Jul</td>");
  expect(second).toContain('class="on" data-action="preview-sheet" data-args="{&quot;index&quot;:1}">By month');
});

test("wide says how to narrow it; loading and errors say so", () => {
  expect(previewCardHTML(open(sheet, { wide: true }))).toContain('class="card fp wide"');
  expect(previewCardHTML(open(sheet, { wide: true }))).toContain("Click to narrow");
  const loading = previewCardHTML(open());
  expect(loading).toContain("Opening…");
  expect(loading).not.toContain("preview-open");
  expect(previewCardHTML(open(undefined, { error: "The file isn't there anymore" }))).toContain("The file isn&#39;t there anymore");
});

test("slides show one slide, the strip when wide, and ‹ › that stop at the ends", () => {
  const deck: FilePreview = { ...base, name: "launch.pptx", kind: "slides", ratio: 16 / 9, slides: [{ title: "Launch review", lines: ["Acme"] }, { title: "Signups", lines: [] }] };
  expect(previewSummary(deck)).toBe("2 slides");
  const first = fileBodyHTML(open(deck));
  expect(first).toContain("<h5>Launch review</h5><p>Acme</p>");
  expect(first).toContain('aria-label="Previous slide" disabled');
  expect(first).toContain("1 of 2");
  expect(first).not.toContain("fp-strip");
  const wide = fileBodyHTML(open(deck, { wide: true, slide: 1 }));
  expect(wide).toContain("fp-strip");
  expect(wide).toContain('aria-label="Next slide" disabled');
});

test("documents, PDFs and pictures", () => {
  const doc: FilePreview = { ...base, name: "onboarding.docx", kind: "doc", more: false, blocks: [{ level: 1, text: "Welcome" }, { level: 0, text: "Ask Sam", bullet: true }] };
  expect(fileBodyHTML(open(doc))).toContain('<h3>Welcome</h3><p class="li">Ask Sam</p>');
  expect(previewSummary(doc)).toBe("Word");
  expect(fileBodyHTML(open({ ...base, kind: "pdf", data: "JVBERg==" }))).toContain("data-pdf");
  expect(fileBodyHTML(open({ ...base, kind: "image", data: "AA==", mimeType: "image/jpeg" }))).toContain('src="data:image/jpeg;base64,AA=="');
});
