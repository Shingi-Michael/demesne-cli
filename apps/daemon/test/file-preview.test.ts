import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { previewable } from "@demesne/protocol";
import { documentText } from "../src/documents.ts";
import { previewFile } from "../src/file-preview.ts";
import { delimitedSheet, docxBlocks, formatNumber, officeText, pptxSlides, readZip, xlsxSheets } from "../src/office.ts";

/// A plain zip, the way Office writes one (deflated entries).
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), packed = deflateRawSync(raw), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const budget = () => zip({
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="By month" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Team</t></si><si><t>Budget</t></si><si><r><t>Mark</t></r><r><t>eting &amp; ads</t></r></si></sst>`,
  "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="10"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>22000</v></c><c r="C2" s="2"><v>46000</v></c><c r="D2" s="3"><v>0.125</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4"><v>0.30000000000000004</v></c><c r="E4" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>Jul</v></c></row></sheetData></worksheet>`,
});

describe("office files", () => {
  test("reads a zip's entries", () => {
    const files = readZip(zip({ "a.txt": "hello", "b/c.xml": "<x/>" }));
    expect([...files.keys()]).toEqual(["a.txt", "b/c.xml"]);
    expect(files.get("a.txt")!().toString()).toBe("hello");
    expect(() => readZip(Buffer.from("not a zip at all, just words"))).toThrow("not a zip");
  });

  test("a spreadsheet's sheets, with shared strings, formats and gaps", () => {
    const [summary, months] = xlsxSheets(budget());
    expect(summary!.name).toBe("Summary");
    expect(summary!.rows).toEqual([
      ["Team", "Budget", "", "", ""],
      ["Marketing & ads", "$22,000", "2025-12-09", "12.50%", ""],
      ["", "", "", "", ""],
      ["Total", "0.3", "", "", "TRUE"],
    ]);
    expect(months).toEqual({ name: "By month", rows: [["Jul"]], more: false });
  });

  test("numbers keep their format", () => {
    expect(formatNumber("-4200", '"$"#,##0')).toBe("−$4,200");
    expect(formatNumber("0.5", "h:mm")).toBe("12:00");
    expect(formatNumber("1234.5", "#,##0.00")).toBe("1,234.50");
    expect(formatNumber("3", undefined)).toBe("3");
  });

  test("csv and tsv, with quotes", () => {
    expect(delimitedSheet('team,note\nDesign,"says ""hi"", twice"\r\nOps,\n', "a.csv").rows).toEqual([["team", "note"], ["Design", 'says "hi", twice'], ["Ops", ""]]);
    expect(delimitedSheet("a\tb\n1\t2", "a.tsv").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  test("a Word file's paragraphs and headings", () => {
    const docx = zip({ "word/document.xml": `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Welcome</w:t></w:r></w:p><w:p/><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Your first week</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Monday is </w:t></w:r><w:r><w:t>accounts.</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Ask Sam</w:t></w:r></w:p></w:body></w:document>` });
    expect(docxBlocks(docx)).toEqual([
      { level: 1, text: "Welcome" }, { level: 0, text: "" }, { level: 2, text: "Your first week" },
      { level: 0, text: "Monday is accounts." }, { level: 0, text: "Ask Sam", bullet: true },
    ]);
    expect(officeText("docx", docx)).toBe("# Welcome\n\n## Your first week\nMonday is accounts.\n- Ask Sam");
  });

  test("a deck's slides in order", () => {
    const deck = zip({
      "ppt/presentation.xml": `<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`,
      "ppt/slides/slide1.xml": `<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Signups</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Up 3x</a:t></a:r></a:p><a:p/></p:txBody></p:sp></p:sld>`,
      "ppt/slides/slide2.xml": `<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Launch review</a:t></a:r></a:p><a:p><a:r><a:t>Acme</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`,
    });
    const { slides, ratio } = pptxSlides(deck);
    expect(slides).toEqual([{ title: "Launch review", lines: ["Acme"] }, { title: "Signups", lines: ["Up 3x"] }]);
    expect(ratio).toBeCloseTo(16 / 9);
  });
});

describe("file previews", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-preview-"));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out/q3-budget.xlsx"), budget());
  writeFileSync(join(root, "notes.md"), "# Launch\n\n- signups up\nplain line\n");
  writeFileSync(join(root, "lease.pdf"), "%PDF-1.4 tiny");
  writeFileSync(join(root, "deck.key"), zip({ "preview.jpg": Buffer.from([0xff, 0xd8, 0xff, 1, 2]) }));
  writeFileSync(join(root, "server.key"), "-----BEGIN PRIVATE KEY-----");
  writeFileSync(join(root, "fake.pdf"), "hello");

  test("which files have one", () => {
    expect(previewable("out/q3-budget.XLSX")).toBe(true);
    expect(previewable("src/app.ts")).toBe(false);
    expect(previewable("Makefile")).toBe(false);
  });

  test("a spreadsheet, a note, a PDF and a Keynote picture", () => {
    const sheet = previewFile(root, "out/q3-budget.xlsx");
    expect(sheet.kind === "sheet" && sheet.sheets.map((s) => s.name)).toEqual(["Summary", "By month"]);
    expect(sheet.absolute).toBe(join(root, "out/q3-budget.xlsx"));
    expect(previewFile(root, "./notes.md")).toMatchObject({ kind: "doc", blocks: [{ level: 1, text: "Launch" }, { level: 0, text: "" }, { level: 0, text: "signups up", bullet: true }, { level: 0, text: "plain line" }] });
    const pdf = previewFile(null, join(root, "lease.pdf"));
    expect(pdf.kind === "pdf" && Buffer.from(pdf.data, "base64").toString()).toBe("%PDF-1.4 tiny");
    expect(previewFile(root, "deck.key")).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
  });

  test("refuses secrets, other kinds, missing files and escapes", () => {
    expect(() => previewFile(root, "server.key")).toThrow("protected");
    expect(() => previewFile(root, "app.ts")).toThrow("no preview");
    expect(() => previewFile(root, "gone.xlsx")).toThrow("isn't there");
    expect(() => previewFile(root, "../x.pdf")).toThrow("outside");
    expect(() => previewFile(root, "fake.pdf")).toThrow("isn't a PDF");
    expect(() => previewFile(null, "notes.md")).toThrow("no folder");
  });

  test("read_file's text for office files", async () => {
    expect(await documentText(join(root, "out/q3-budget.xlsx"), 1000)).toContain("## Summary\nTeam\tBudget");
  });
});
