/** File previews (pass 188 A) against the real Electron app: a chat whose
 * answer names a spreadsheet, a PDF, a deck and a Word file. A click on each
 * name grows its preview as the last card; a click widens the column; ×
 * folds it back. The model also reads the spreadsheet with read_file.
 *   xvfb-run -a -s "-screen 0 1600x1000x24" bun scripts/check-file-preview.ts
 * Run bun scripts/prepare-desktop.ts first. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/file-preview");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };

function zip(files: Record<string, string>): Buffer {
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
/// A real two-page PDF with text in Helvetica.
function pdf(pages: string[][]): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const lines of pages) {
    const stream = `BT /F1 20 Tf 60 740 Td (${lines[0]}) Tj /F1 12 Tf ${lines.slice(1).map((line) => `0 -28 Td (${line}) Tj`).join(" ")} ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length} 0 R /Resources << /Font << /F1 ${pages.length * 2 + 3} 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => { const at = body.length; body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

let lastAsk = "";
const f = await fixture({
  providerId: "test", modelId: "file-model", contextCapacity: 200000, maxOutputTokens: 4096,
  async listModels() { return [{ id: "file-model", provider: "test", contextWindow: 200000 }]; },
  async *stream(messages: ProviderMessage[]): AsyncGenerator<ProviderStreamEvent> {
    lastAsk = JSON.stringify(messages.at(-1));
    if (messages.at(-1)?.role === "user") {
      yield { type: "tool_call_delta", index: 0, idDelta: "call_1", nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: "out/q3-budget.xlsx" }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "The budget is in `out/q3-budget.xlsx`, and Marketing is over by $4,200. The lease is [lease.pdf](lease.pdf), the deck is `deck.pptx` and the guide is `guide.docx`." };
    yield { type: "finish", reason: "stop" };
  },
});
mkdirSync(join(f.workspace, "out"));
writeFileSync(join(f.workspace, "out/q3-budget.xlsx"), zip({
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="By month" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Team</t></si><si><t>Budget</t></si><si><t>Spent</t></si><si><t>Left</t></si><si><t>Design</t></si><si><t>Marketing</t></si><si><t>Total</t></si></sst>`,
  "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1">${[0, 1, 2, 3].map((s, i) => `<c r="${"ABCD"[i]}1" t="s"><v>${s}</v></c>`).join("")}</row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" s="1"><v>18000</v></c><c r="C2" s="1"><v>15240</v></c><c r="D2" s="1"><v>2760</v></c></row><row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" s="1"><v>22000</v></c><c r="C3" s="1"><v>26200</v></c><c r="D3" s="1"><v>-4200</v></c></row><row r="4"><c r="A4" t="s"><v>6</v></c><c r="B4" s="1"><v>40000</v></c><c r="C4" s="1"><v>41440</v></c><c r="D4" s="1"><v>-1440</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>Jul</v></c><c r="B1"><v>5100</v></c></row></sheetData></worksheet>`,
}));
writeFileSync(join(f.workspace, "lease.pdf"), pdf([["Residential Lease", "Between Acme and the tenant.", "Rent is due on the first."], ["2. Rent and notice", "Rent goes up 3%.", "Notice is 60 days."]]));
writeFileSync(join(f.workspace, "deck.pptx"), zip({
  "ppt/presentation.xml": `<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>`,
  "ppt/slides/slide1.xml": `<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Launch review</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Acme · November 2026</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`,
  "ppt/slides/slide2.xml": `<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Signups, week by week</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`,
}));
writeFileSync(join(f.workspace, "guide.docx"), zip({ "word/document.xml": `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Welcome to Acme</w:t></w:r></w:p><w:p><w:r><w:t>Monday is accounts and a walk around.</w:t></w:r></w:p></w:body></w:document>` }));

const app = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // The page's own CSP note about [::1] predates previews.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("'http://[::1]:*'")) errors.push(message.text()); });
  await page.setViewportSize({ width: 1400, height: 860 });
  const editor = page.locator("#composer [contenteditable], #composer textarea, [contenteditable='true']").first();
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("put last quarter's spend into a budget sheet");
  await page.keyboard.press("Enter");
  await page.getByText("Marketing is over by").first().waitFor({ timeout: 20_000 });
  expect(lastAsk.includes("Marketing") && lastAsk.includes("Summary"), "read_file gave the model the spreadsheet's text");
  const name = page.locator("#conversation code.file-link", { hasText: "out/q3-budget.xlsx" }).first();
  expect(await name.count() === 1, "the file name in the answer is a link");
  await page.getByText("1 step").first().click();
  await page.waitForTimeout(300);
  expect(await page.locator(".tool-row code.target[data-preview-path='out/q3-budget.xlsx']").count() >= 1, "so is the file in the read step");
  await page.screenshot({ path: join(output, "answer.png") });

  // Open: it grows out of the name.
  await name.click();
  const card = page.locator("#cards .card.fp");
  await card.waitFor({ state: "attached", timeout: 10_000 });
  await page.waitForTimeout(300);
  expect(await page.locator(".fp-ghost").count() === 1, "a copy of the file grows out of the name");
  await page.screenshot({ path: join(output, "growing.png") });
  await page.waitForTimeout(1800);
  expect(await page.locator(".fp-ghost").count() === 0, "the copy is gone once it lands");
  const order = await page.locator("#cards > .card").evaluateAll((cards) => cards.map((one) => (one as HTMLElement).dataset.card));
  expect(order.at(-1) === "file-preview", `the preview is the last card (${order.join(", ")})`);
  const table = await card.locator("table").innerText();
  expect(table.includes("Marketing") && table.includes("−$4,200"), `the sheet shows as a table: ${table.replace(/\s+/g, " ").slice(0, 120)}`);
  expect((await card.locator(".card-head").innerText()).includes("2 sheets"), "the head says how many sheets");
  await page.screenshot({ path: join(output, "sheet.png") });
  await card.locator(".fp-tabs button", { hasText: "By month" }).click();
  await page.waitForTimeout(200);
  expect((await card.locator("table").innerText()).includes("Jul"), "a sheet tab switches sheets");

  // Wider, then back.
  const narrow = await page.locator("#cards").evaluate((aside) => aside.getBoundingClientRect().width);
  await card.locator(".fp-box").click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(1400);
  const wide = await page.locator("#cards").evaluate((aside) => aside.getBoundingClientRect().width);
  expect(wide > narrow + 150, `a click widens the column (${Math.round(narrow)} → ${Math.round(wide)}px)`);
  await page.screenshot({ path: join(output, "wide.png") });
  await card.locator(".fp-box").click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(1400);

  // × folds it back into its name.
  await card.locator(".fp-x").click();
  await page.waitForTimeout(250);
  expect(await page.locator(".fp-ghost").count() === 1, "closing folds a copy back into the name");
  await page.screenshot({ path: join(output, "folding.png") });
  await page.waitForTimeout(1500);
  expect(await page.locator("#cards .card.fp").count() === 0, "and the card is gone");

  // A PDF, drawn with pdf.js.
  await page.locator("#conversation a.file-link", { hasText: "lease.pdf" }).click();
  await page.waitForTimeout(2600);
  const canvases = await page.locator("#cards .card.fp canvas").count();
  const inked = await page.locator("#cards .card.fp canvas").first().evaluate((canvas) => {
    const c = canvas as HTMLCanvasElement, data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0; for (let i = 0; i < data.length; i += 4) if (data[i]! < 200) dark++;
    return dark;
  }).catch(() => 0);
  expect(canvases === 2 && inked > 50, `the PDF's pages are drawn (${canvases} pages, ${inked} dark pixels)`);
  await page.screenshot({ path: join(output, "pdf.png") });

  // Another file replaces it: the deck.
  await page.locator("#conversation code.file-link", { hasText: "deck.pptx" }).click();
  await page.waitForTimeout(3000);
  const slide = await page.locator("#cards .card.fp .fp-slide").innerText().catch(() => "");
  expect(slide.includes("Launch review") && (await page.locator("#cards .card.fp").count()) === 1, `the deck replaces the PDF and shows its first slide: ${slide.replace(/\s+/g, " ")}`);
  await page.locator("#cards .fp-nav button[aria-label='Next slide']").click();
  await page.waitForTimeout(200);
  expect((await page.locator("#cards .fp-slide").innerText()).includes("Signups"), "› shows the next slide");
  await page.screenshot({ path: join(output, "slides.png") });

  // The Word file.
  await page.locator("#conversation code.file-link", { hasText: "guide.docx" }).click();
  await page.waitForTimeout(3000);
  const doc = await page.locator("#cards .card.fp .fp-page").innerText().catch(() => "");
  expect(doc.includes("Welcome to Acme") && doc.includes("Monday is accounts"), `the Word file shows as a page: ${doc.replace(/\s+/g, " ")}`);
  await page.screenshot({ path: join(output, "doc.png") });

  // The step's file name opens it too, and the same name again closes it.
  await page.locator(".tool-row code.target[data-preview-path='out/q3-budget.xlsx']").first().click();
  await page.waitForTimeout(3000);
  expect((await page.locator("#cards .card.fp table").innerText().catch(() => "")).includes("Marketing"), "the read step's file name opens the sheet");
  await page.locator("#conversation code.file-link", { hasText: "out/q3-budget.xlsx" }).click();
  await page.waitForTimeout(1500);
  expect(await page.locator("#cards .card.fp").count() === 0, "clicking the same name again closes it");
  expect(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} catch (error) {
  failures.push(String(error));
  console.log("FAIL", error);
} finally {
  await app.close();
  f.server.stop?.(true);
}
if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
