/** Real Electron check for piece 6 of pass 274, out in the right file: Save
 * a copy gives a deck as PowerPoint (.pptx) with its speaker notes, a doc as
 * Word (.docx), a sheet as Excel (.xlsx) with its totals as formulas, and a
 * page as HTML with a picture (.png) offered after. The files are read back
 * here with python-pptx, python-docx and openpyxl when they are installed.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 15000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const WHY = { direction: "Calm, for the clinic's partners.", look_at: "The one number.", starts_from: "new", dropped: "Nothing." };
const SAVES: Record<string, { title: string; kind: string; source: string; description: string; why?: unknown }> = {
  deck: { title: "Booking review", kind: "deck", description: "The first quarter of online booking.", why: WHY,
    source: "---\ntitle: Online booking\ntheme: forest\nauthor: Amara Lind\n---\n# Online booking\n\nThe first quarter\n\n<!-- notes: Open with the phone queue. -->\n\n---\n# 3.1×\n\nMore visits are booked online than by phone.\n\n---\n## What changed\n\n- Two taps to a confirmed time\n- A text the day before\n" },
  doc: { title: "Booking report", kind: "doc", description: "A report on online booking.", why: WHY,
    source: "---\ntitle: Online booking, first quarter\nauthor: Amara Lind\n---\n## Summary\n\nOnline booking now takes **more bookings than the phone**.\n\n- Two taps to a confirmed time\n- A text the day before\n\n| Month | Online |\n| --- | ---: |\n| July | 120 |\n| August | 210 |\n" },
  sheet: { title: "Launch budget", kind: "sheet", description: "What the launch costs.", source: 'Item,Owner,Cost,Units\nRoom hire,Amara,"$1,200.00",2\nCatering,Jo,$860.50,48\nPrinting,,$95,300\n' },
  page: { title: "Booking page", kind: "html", description: "Pick a time and book it.", why: { ...WHY, walkthrough: [{ what: "A booking page for the clinic's patients.", parts: [{ name: "Times", says: "The free times." }, { name: "Book button", says: "Books the time." }], why: "One decision." }] },
    source: `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"><style>body{margin:0;padding:40px 48px;background:#fbfaf7;color:#1c2422} h1{font-family:Georgia,serif} .go{display:inline-block;padding:11px 18px;border-radius:10px;background:#0f766e;color:#fff;font-weight:600} .tall{height:1100px}</style></head><body><h1>Book a visit</h1><p>Harbor Clinic · Dr. Okafor</p><span class="go">Book 10:30</span><div class="tall"></div><p id="end">The end of the page</p></body></html>` },
};

const f = await fixture({
  providerId: "fixture", modelId: "foundry-files",
  async listModels() { return [{ id: "foundry-files", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user"), request = String(messages[at]?.content ?? "");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const save = SAVES[Object.keys(SAVES).find((key) => request.includes(`make ${key}`))!]!;
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ ...save, note: "First take" }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-files")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  const app = page;
  app.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const downloads = join(f.root, "downloads");
  mkdirSync(downloads, { recursive: true });
  await desktop.evaluate(({ app }, path) => app.setPath("downloads", path), downloads);
  const errors: string[] = [];
  app.on("pageerror", (error) => errors.push(error.message));
  await app.locator("#composer-model").waitFor();
  const editor = app.locator("textarea");
  const ready = () => app.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await ready(); await app.waitForTimeout(200);
  const chips = app.locator("#conversation .fd-chip");
  for (const key of Object.keys(SAVES)) {
    await editor.fill(`/foundry make ${key}`); await editor.press("Enter");
    await chips.filter({ hasText: SAVES[key]!.title }).waitFor();
    await ready(); await app.waitForTimeout(300);
  }
  const list = (await f.client.foundryList()).artifacts;
  const idOf = (key: string) => list.find((item) => item.title === SAVES[key]!.title)!.id;
  const openIt = async (key: string) => {
    if (await app.locator("#page .fd-open").count()) await app.keyboard.press("Escape");
    await app.locator("#sidebar-sessions .sidebar-session, #sidebar-chats [data-action=select-session]").first().click();
    await chips.filter({ hasText: SAVES[key]!.title }).first().click();
    const item = app.locator(`#page [data-fd="${idOf(key)}:1"]`);
    await step(60, async () => (await item.getAttribute("class").catch(() => ""))!.includes("fd-open"));
  };
  const said = () => app.locator(".fd-said").textContent().then((text) => text ?? "");
  const save = async (name: string) => {
    await app.getByRole("button", { name: "Save a copy to Downloads" }).click();
    await step(65, async () => (await said()).includes(`Saved ${name} to Downloads`) && existsSync(join(downloads, name)));
    return readFileSync(join(downloads, name));
  };
  const also = async (label: string, name: string) => {
    await app.getByRole("button", { name: `Also as ${label}`, exact: true }).click();
    await step(70, async () => existsSync(join(downloads, name)) && statSync(join(downloads, name)).size > 20);
  };
  const office = (file: Buffer) => file.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  // Read the files back with other people's code, when it is here.
  const python = (code: string) => { const ran = spawnSync("python3", ["-c", code], { encoding: "utf8", cwd: downloads }); return ran.status === 0 ? ran.stdout.trim() : null; };
  const can = python("import pptx, docx, openpyxl; print('yes')") === "yes";

  await openIt("deck");
  assert.ok(office(await save("Booking review v1.pptx")), "a deck saves as a PowerPoint file");
  assert.deepEqual(await app.locator(".fd-said .fd-said-b").allInnerTexts(), ["Show", "Also as PDF", "Also as a web page"]);
  if (can) assert.equal(python(`from pptx import Presentation\np = Presentation("Booking review v1.pptx")\nprint(len(p.slides), "|", p.slides[0].notes_slide.notes_text_frame.text, "|", p.slides[0].has_notes_slide and not p.slides[1].has_notes_slide)`), "3 | Open with the phone queue. | True");
  await also("PDF", "Booking review v1.pdf");
  assert.equal(readFileSync(join(downloads, "Booking review v1.pdf")).subarray(0, 4).toString(), "%PDF");
  console.log(`PASS: a deck saves as PowerPoint with its speaker notes${can ? " (read back with python-pptx)" : ""}, then as a PDF when asked.`);

  // Present: the deck alone over the whole window; the arrow keys move, N shows the notes, Esc gives the window back.
  await app.getByRole("button", { name: "Present (Esc to leave)" }).click();
  const layer = app.locator(".fd-present");
  await layer.waitFor();
  const deck = () => app.frames().find((one) => one.url().includes(idOf("deck")) && one.url().includes("present=1"));
  const shown = () => deck()!.evaluate(() => ({ present: document.documentElement.classList.contains("present"), slide: document.querySelector(".slide.on")?.getAttribute("data-index"), strip: getComputedStyle(document.querySelector(".deck-strip")!).display,
    notes: (() => { const el = document.querySelector<HTMLElement>(".deck-notes")!; return el.hidden ? null : el.textContent; })() }));
  await step(90, async () => !!deck() && (await shown().catch(() => null))?.slide === "1");
  assert.deepEqual(await shown(), { present: true, slide: "1", strip: "none", notes: null });
  assert.deepEqual(await layer.evaluate((el) => { const box = el.getBoundingClientRect(); return [box.left, box.top, box.width === innerWidth, box.height === innerHeight]; }), [0, 0, true, true]);
  await step(93, async () => await app.evaluate(() => document.activeElement?.classList.contains("fd-present-frame") ?? false));
  await app.keyboard.press("n");
  await step(95, async () => (await shown()).notes === "Open with the phone queue.");
  mkdirSync("output", { recursive: true });
  await app.waitForTimeout(300);
  await app.screenshot({ path: "output/foundry-present.png" });
  await app.keyboard.press("ArrowRight");
  await step(99, async () => (await shown()).slide === "2");
  assert.equal((await shown()).notes, "No notes for this slide.");
  await app.keyboard.press("Escape");
  await layer.waitFor({ state: "detached" });
  assert.equal(await app.locator("#page .fd-open").count(), 1, "the opened deck is still there");
  console.log("PASS: Present puts the deck over the whole window; arrows move, N shows the speaker notes, Esc leaves.");

  await openIt("doc");
  assert.ok(office(await save("Booking report v1.docx")), "a doc saves as a Word file");
  assert.deepEqual(await app.locator(".fd-said .fd-said-b").allInnerTexts(), ["Show", "Also as PDF", "Also as a web page"]);
  if (can) assert.equal(python(`from docx import Document\nd = Document("Booking report v1.docx")\nprint([p.style.name for p in d.paragraphs][:3], len(d.tables), d.tables[0].cell(2, 1).text)`), "['Title', 'Byline', 'Heading 2'] 1 210");
  console.log(`PASS: a doc saves as Word, with real headings and tables${can ? " (read back with python-docx)" : ""}.`);

  await openIt("sheet");
  assert.ok(office(await save("Launch budget v1.xlsx")), "a sheet saves as an Excel file");
  if (can) assert.equal(python(`from openpyxl import load_workbook\nw = load_workbook("Launch budget v1.xlsx").active\nprint(w["C2"].value, w["A5"].value, w["C5"].value, w["D5"].value)`), "1200 Total =SUM(C2:C4) =SUM(D2:D4)");
  await also("CSV", "Launch budget v1.csv");
  console.log(`PASS: a sheet saves as Excel with its totals as formulas${can ? " (read back with openpyxl)" : ""}, then as CSV when asked.`);

  await openIt("page");
  assert.ok((await save("Booking page v1.html")).toString("utf8").includes("Book a visit"));
  await also("a picture", "Booking page v1.png");
  const png = readFileSync(join(downloads, "Booking page v1.png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  // The whole page at real size: 1440 wide, and taller than one screen because the page is.
  assert.equal(png.readUInt32BE(16), 1440);
  assert.ok(png.readUInt32BE(20) > 1200, `the picture holds the whole page (${png.readUInt32BE(20)} high)`);
  mkdirSync("output", { recursive: true });
  await app.mouse.move(5, 5);
  console.log("PASS: a page saves as HTML, then as a picture of the whole page at real size.");
  assert.deepEqual(errors, []);
} finally {
  await page?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
