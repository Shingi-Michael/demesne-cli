import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { blocks, deckPPTX, docDOCX, sheetXLSX, slideNotes, zip } from "../electron/foundry-files.ts";
import { copyFormats, otherFormats } from "@demesne/protocol";

/// Reads a zip back by its central directory: every part, inflated and checked by size.
function unzip(file: Buffer): Record<string, string> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const parts: Record<string, string> = {};
  for (let n = 0; n < count; n++) {
    expect(file.readUInt32LE(at)).toBe(0x02014b50);
    const packed = file.readUInt32LE(at + 20), size = file.readUInt32LE(at + 24), nameLength = file.readUInt16LE(at + 28), local = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    const raw = inflateRawSync(file.subarray(start, start + packed));
    expect(raw.length).toBe(size);
    parts[name] = raw.toString("utf8");
    at += 46 + nameLength;
  }
  return parts;
}

const DECK = `---\ntitle: Online booking\ntheme: forest\nauthor: Amara Lind\n---\n# Online booking\n\nFirst quarter\n\n<!-- notes: Open with the phone queue. -->\n\n---\n# 3.1×\n\nMore visits booked online.\n\n---\n## What changed\n\n- Two taps to a **confirmed** time\n- A text the day before\n\n\`\`\`chart\ntitle: Bookings\nlabels: Jul, Aug\nOnline: 120, 210\n\`\`\`\n`;

describe("Foundry, out in the right file", () => {
  test("a zip reads back whole, in the order written", () => {
    const parts = unzip(zip([["[Content_Types].xml", "<Types/>"], ["a/b.xml", "é".repeat(4000)]]));
    expect(Object.keys(parts)).toEqual(["[Content_Types].xml", "a/b.xml"]);
    expect(parts["a/b.xml"]).toBe("é".repeat(4000));
    expect(zip([["x", "same"]]).equals(zip([["x", "same"]]))).toBe(true);
  });
  test("a sheet is an Excel file: numbers as numbers, the totals as SUM formulas", () => {
    const parts = unzip(sheetXLSX('Item,Cost,Share,Units\nRoom hire,"$1,200.00",40%,2\nCatering,$860.50,35.5%,48\n', "Launch: budget"));
    const sheet = parts["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain('<c r="B2" s="5"><v>1200</v></c>');
    expect(sheet).toContain('<c r="C2" s="2"><v>0.4</v></c>');
    expect(sheet).toContain('<c r="C3" s="3"><v>0.355</v></c>');
    expect(sheet).toContain('<c r="D2"><v>2</v></c>');
    expect(sheet).toContain("<f>SUM(B2:B3)</f><v>2060.5</v>");
    expect(sheet).toContain("<f>SUM(D2:D3)</f><v>50</v>");
    expect(sheet).toContain('<is><t xml:space="preserve">Total</t></is>');
    expect(sheet).toContain('state="frozen"');
    // A sheet name can't hold a colon.
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Launch  budget"');
    // Words only: no totals row.
    expect(unzip(sheetXLSX("Name,Team\nAmara,Design\n", "People"))["xl/worksheets/sheet1.xml"]).not.toContain("SUM(");
  });
  test("a deck is a PowerPoint file: a slide each, in its colours, with its notes", () => {
    const parts = unzip(deckPPTX(DECK, "Deck"));
    expect(Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length).toBe(3);
    expect(parts["ppt/slides/slide1.xml"]).toContain('<a:srgbClr val="1D3A2D"/>');
    expect(parts["ppt/slides/slide1.xml"]).toContain("<a:t>Online booking</a:t>");
    expect(parts["ppt/slides/slide1.xml"]).not.toContain("phone queue");
    expect(parts["ppt/notesSlides/notesSlide1.xml"]).toContain("<a:t>Open with the phone queue.</a:t>");
    expect(parts["ppt/notesSlides/notesSlide2.xml"]).toBeUndefined();
    expect(parts["ppt/slides/slide2.xml"]).toContain('sz="13800"');
    const third = parts["ppt/slides/slide3.xml"]!;
    expect(third).toContain('b="1"');
    expect(third).toContain("<a:buChar");
    // The chart's numbers come along as a table that can be edited.
    expect(third).toContain("<a:tbl>");
    expect(third).toContain("<a:t>210</a:t>");
    expect(parts["[Content_Types].xml"]).toContain("/ppt/notesMasters/notesMaster1.xml");
    // A deck with no notes carries no notes parts.
    expect(Object.keys(unzip(deckPPTX("# One\n\nWords\n", "Deck"))).some((name) => name.includes("notes"))).toBe(false);
  });
  test("a doc is a Word file: real headings, lists, tables and links", () => {
    const parts = unzip(docDOCX("---\ntitle: Report\nauthor: Amara\n---\n## Summary\n\nSee [the page](https://example.com/book) & `code`.\n\n1. One\n2. Two\n\nText\n\n1. Again\n\n| A | B |\n| - | - |\n| 1 | 2 |\n", "Doc"));
    const body = parts["word/document.xml"]!;
    expect(body).toContain('<w:pStyle w:val="Title"/>');
    expect(body).toContain('<w:pStyle w:val="Heading2"/>');
    expect(body).toContain('<w:hyperlink r:id="rLink1">');
    expect(parts["word/_rels/document.xml.rels"]).toContain('Target="https://example.com/book" TargetMode="External"');
    expect(body).toContain("&amp;");
    expect(body).toContain("<w:tbl>");
    // Each numbered list starts at 1 again.
    expect(body).toContain('<w:numId w:val="2"/>');
    expect(body).toContain('<w:numId w:val="3"/>');
  });
  test("speaker notes and blocks are read from the content", () => {
    expect(slideNotes("# A\n<!-- notes: say this -->\n<!-- layout: title -->\n<!--note: and this-->")).toBe("say this\n\nand this");
    expect(blocks("- a\n  - b\n\n> [!TIP]\n> Try it").map((block) => block.kind === "item" ? `item${block.level}` : block.kind === "quote" ? `quote:${block.label}` : block.kind)).toEqual(["item0", "item1", "quote:Tip"]);
  });
  test("each kind has its file, and the others are offered after", () => {
    expect(copyFormats("deck")[0]).toBe("pptx");
    expect(copyFormats("doc")[0]).toBe("docx");
    expect(copyFormats("sheet")[0]).toBe("xlsx");
    expect(otherFormats("deck", "pptx")).toEqual(["pdf", "html"]);
    expect(otherFormats("html", "html")).toEqual(["png"]);
    expect(otherFormats("svg", "svg")).toEqual([]);
  });
});
