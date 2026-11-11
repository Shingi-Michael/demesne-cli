import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { documentText, readable } from "../src/documents.ts";
import { odfText, rtfText } from "../src/office.ts";

/// A plain zip with the given files, deflated.
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content)), raw = Buffer.from(content), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const ODT = `<?xml version="1.0"?><office:document-content><office:body><office:text>
<text:h text:outline-level="1">Q3 plan</text:h>
<text:p>Ship the <text:span>greeting</text:span>,<text:s text:c="2"/>then rest.<text:note><text:p>a footnote</text:p></text:note></text:p>
<text:p/>
<table:table><table:table-row><table:table-cell><text:p>Owner</text:p></table:table-cell><table:table-cell><text:p>Mike &amp; Ana</text:p></table:table-cell><table:table-cell table:number-columns-repeated="3"/></table:table-row></table:table>
</office:text></office:body></office:document-content>`;

test("an OpenDocument file reads as headings, paragraphs and tab-separated rows", () => {
  expect(odfText(zip({ "mimetype": "application/vnd.oasis.opendocument.text", "content.xml": ODT }))).toBe("# Q3 plan\nShip the greeting,  then rest.\n\nOwner\tMike & Ana");
});

test("a Rich Text file reads as its words, without fonts, colours or pictures", () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2761{\fonttbl\f0\fswiss Helvetica;}{\colortbl;\red255\green255\blue255;}{\*\expandedcolortbl;;}
\f0\fs24 \cf0 Caf\'e9 plan\par
Ship it 舒? now\tab done\par
{\*\generator Riched20}{\pict\pngblip 89504e47}Last line \{braces\}}`;
  expect(rtfText(rtf)).toBe("Café plan\nShip it — now\tdone\nLast line {braces}");
  expect(() => rtfText("hello")).toThrow();
});

test("read_file reaches .odt, .ods, .odp and .rtf; an old .doc says what to do off a Mac", async () => {
  for (const name of ["a.odt", "b.ods", "c.odp", "d.rtf", "e.doc"]) expect(readable(name)).toBe("office");
  const folder = mkdtempSync(join(tmpdir(), "demesne-docs-"));
  const odt = join(folder, "plan.odt"), rtf = join(folder, "note.rtf"), doc = join(folder, "old.doc");
  writeFileSync(odt, zip({ "content.xml": ODT })); writeFileSync(rtf, String.raw`{\rtf1 Hello\par world}`); writeFileSync(doc, "not really a doc");
  expect(await documentText(odt, 100)).toContain("Mike & Ana");
  expect(await documentText(rtf, 20)).toBe("Hello\nworld");
  if (process.platform !== "darwin") await expect(documentText(doc, 16)).rejects.toThrow("save it as .docx");
});
