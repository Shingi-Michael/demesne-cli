/** Real Electron check for pass 233 A: on Foundry's long page nothing shows
 * until the pointer rests on a part of a mockup; then the part is outlined
 * with a small tag. The tag opens a one-line note, Enter keeps it as a
 * numbered pin, the notes wait while you are elsewhere, and the send key
 * sends them together to the chat that made the mockup, with each part's
 * place, markup and picture. The new version comes back on the page with
 * what changed outlined. Run after `bun scripts/prepare-desktop.ts`, under
 * xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const chats = ["Tidy the sidebar", "Drive picks", "Release notes"];
const style = `<style>body{margin:0;font:14px system-ui;background:#232326;color:#eee}.w{padding:8px;width:340px}h3{font-size:11px;color:#999;margin:8px}.r{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:7px}.r span{flex:1}.r:hover{background:#2e2e33}.pin{all:unset;cursor:pointer;opacity:.6}</style>`;
const script = `<script>document.addEventListener("click",(e)=>{const p=e.target.closest(".pin");if(!p)return;const r=p.closest(".r"),w=r.closest(".w");(r.parentElement.classList.contains("pins")?w.querySelector(".list"):w.querySelector(".pins")).append(r);});</script>`;
const list = `<div class="w"><h3>Pinned</h3><div class="pins"></div><h3>Chats</h3><div class="list">${chats.map((name) => `<div class="r"><span>${name}</span><button class="pin" aria-label="Pin ${name}">📌</button></div>`).join("")}</div></div>`;
const pinPage = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${list}${script}</body></html>`;
const optionsPage = `<!doctype html><html><head><meta charset="utf-8">${style}<script src="foundry://kit/parts.js"></script></head><body><d-compare recommended="A"><section data-option="A · Pin on hover" note="quiet">${list}</section><section data-option="B · Pin always showing">${list}</section></d-compare>${script}</body></html>`;

const asked: { text: string; pictures: number }[] = [];
/// The model holds the first notes until the check lets go, so a note can be written while they are with it.
let letGo = () => {};
const held = new Promise<void>((done) => { letGo = done; });
const f = await fixture({
  providerId: "fixture", modelId: "foundry-notes",
  async listModels() { return [{ id: "foundry-notes", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const said = messages[at], request = typeof said?.content === "string" ? said.content : JSON.stringify(said?.content ?? "");
    const current = messages.slice(at + 1).filter((message) => message.role === "tool");
    const call = (name: string, input: unknown) => ({ type: "tool_call_delta" as const, index: 0, idDelta: `${name}-${at}-${current.length}`, nameDelta: name, argumentsDelta: JSON.stringify(input) });
    const notes = /```parts\n/.test(request), id = /\(id ([\w-]+), v\d+\)/.exec(request)?.[1];
    if (notes && /two ways/.test(request)) {
      asked.push({ text: request, pictures: ((said as { imageArtifactIds?: unknown[] }).imageArtifactIds ?? []).length });
      yield { type: "text_delta", delta: "Which size do you want?" }; yield { type: "finish", reason: "stop" }; return;
    }
    if (notes && id && !current.length) {
      asked.push({ text: request, pictures: ((said as { imageArtifactIds?: unknown[] }).imageArtifactIds ?? []).length });
      await held;
      yield call("foundry_read", { id }); yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (notes && id && current.length === 1) {
      const read = JSON.parse(current[0]!.content ?? "{}") as { version: number };
      yield call("foundry_edit", { id, base_version: read.version, note: "Taller rows", why: { direction: "Same list, a little roomier.", look_at: "The taller rows.", dropped: "Nothing else moved." }, edits: [{ find: "height:32px", replace: "height:40px" }, { find: "<h3>Pinned</h3>", replace: "<h3>Favourites</h3>" }] });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (current.length) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const options = /options/i.test(request);
    yield call("foundry_save", { title: options ? "Pin a chat, two ways" : "Pin a chat", kind: "html", description: "Pinning a chat from the sidebar.", note: "First take",
      why: { direction: "Quiet.", look_at: "The pin.", starts_from: "new" }, source: options ? optionsPage : pinPage, surface: options ? { frame: "window", width: 520, height: 320, title: "Demesne" } : { frame: "part", width: 360 } });
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-notes")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  await page.waitForFunction(() => { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; });
  await page.waitForTimeout(200);
  await editor.fill("/foundry pin a chat"); await editor.press("Enter");
  const chips = page.locator("#conversation .fd-chip");
  await chips.first().filter({ hasText: "Pin a chat" }).waitFor();
  const pin = (await f.client.foundryList()).artifacts.find((item) => item.title === "Pin a chat")!;
  await eventually(async () => (await f.client.getSessionState(pin.sessionId!)).session.turns.at(-1)?.status === "completed");
  await chips.first().click();
  const item = (version: number) => page!.locator(`#page [data-fd="${pin.id}:${version}"]`);
  const frame = (version: number): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${pin.id}?v=${version}`))!;
  const stage = item(1).locator(".fd-stage"), line = item(1).locator(".fd-notes"), tag = item(1).locator(".fn-tag"), out = item(1).locator(".fn-out"), box = item(1).locator(".fn-box"), pins = item(1).locator(".fn-pin");
  await stage.waitFor();
  await step(69, async () => !!frame(1) && await frame(1).evaluate(() => !!(window as { __demesneNote?: boolean }).__demesneNote).catch(() => false));

  // At rest the page shows nothing new.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#page").locator("button:not(.fd-link):visible, form:visible, input:visible").count(), 0, "nothing to press on Foundry at rest");
  assert.equal(await line.isHidden(), true, "no notes line at rest");
  assert.equal(await page.locator("#page .fn-layer").count(), 0, "nothing is added to the page at rest");

  // Resting on a part outlines it and names it.
  const centre = async (selector: string, version = 1) => { const at = (await frame(version).locator(selector).boundingBox())!; return { x: at.x + at.width / 2, y: at.y + at.height / 2, at }; };
  const rest = async (selector: string) => { const to = await centre(selector); await page!.mouse.move(to.x - 6, to.y, { steps: 4 }); await page!.mouse.move(to.x, to.y, { steps: 3 }); return to.at; };
  const row = await rest(".list .r:nth-child(2) span");
  await tag.waitFor();
  assert.equal(await tag.textContent(), "Drive picks · Comment", "the tag names the part");
  const rowBox = (await frame(1).locator(".list .r:nth-child(2)").boundingBox())!, outline = (await out.boundingBox())!;
  assert.ok(Math.abs(outline.x - (rowBox.x - 3)) < 3 && Math.abs(outline.y - (rowBox.y - 3)) < 3 && Math.abs(outline.width - (rowBox.width + 6)) < 4 && Math.abs(outline.height - (rowBox.height + 6)) < 4, `the outline is on the part: ${JSON.stringify({ outline, rowBox })}`);
  assert.equal(await frame(1).evaluate(() => document.querySelectorAll("[data-chrome], .fn-out, .fn-tag").length), 0, "nothing is drawn inside the mockup");
  await item(1).screenshot({ path: join(output, "foundry-note-hover.png") });
  void row;

  // The mockup's own clicks still work: the pin moves its chat up.
  const pinButton = await centre(".list .r:nth-child(2) .pin");
  await page.mouse.move(pinButton.x, pinButton.y, { steps: 4 });
  await step(88, async () => (await tag.textContent()) === "Pin Drive picks button · Comment");
  await page.mouse.click(pinButton.x, pinButton.y);
  await step(90, async () => frame(1).evaluate(() => document.querySelector(".pins .r span")?.textContent === "Drive picks"));

  // The tag opens a one-line note. Enter keeps it as a numbered pin.
  await rest(".pins .r span");
  await step(94, async () => (await tag.textContent()) === "Drive picks · Comment");
  await tag.click();
  await box.locator("input").waitFor();
  assert.equal(await box.locator("label").textContent(), "Drive picks");
  assert.equal(await box.locator("input").evaluate((el) => el === document.activeElement), true, "the note takes the typing");
  await page.keyboard.type("Make this row taller");
  await item(1).screenshot({ path: join(output, "foundry-note-box.png") });
  await page.keyboard.press("Enter");
  await step(102, async () => await pins.count() === 1 && await box.count() === 0);
  await step(103, async () => /^1 note waiting · send (⌘↵|Ctrl ↵)$/.test((await line.textContent()) ?? ""));
  // A second note on another part.
  await rest("h3:first-of-type");
  await step(106, async () => (await tag.textContent()) === "Pinned heading · Comment");
  await tag.click();
  await page.keyboard.type("Call it Favourites");
  await page.keyboard.press("Enter");
  await step(110, async () => await pins.count() === 2);
  await step(111, async () => /^2 notes waiting/.test((await line.textContent()) ?? ""));
  // A pin opens its note again; Esc leaves it as it was.
  await pins.first().click();
  await step(114, async () => await box.locator("input").inputValue() === "Make this row taller");
  await page.keyboard.press("Escape");
  await step(116, async () => await box.count() === 0 && await pins.count() === 2);
  await page.mouse.move(5, 5);
  await step(118, async () => await tag.isHidden() && await out.isHidden());
  await item(1).screenshot({ path: join(output, "foundry-note-pins.png") });

  // The notes wait while you are elsewhere.
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await step(123, async () => await page!.locator("#page").isHidden());
  await chips.first().click();
  await stage.waitFor();
  await step(126, async () => /^2 notes waiting/.test((await line.textContent()) ?? ""));
  // The demo of this fresh page moved nothing: the first note's row is back in Chats, and its pin with it.
  await step(128, async () => await pins.count() >= 1);

  // The send key sends them together, to the chat that made the mockup.
  await item(1).hover({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+Enter");
  await step(133, async () => asked.length === 1, 15000);
  await step(134, async () => (await line.textContent()) === "Working on 2 notes…" && await pins.count() === 0);
  // A note written while the first two are with the model waits, and moves to the version they make.
  await rest(".list .r:last-child span");
  await step(137, async () => (await tag.textContent()) === "Release notes · Comment");
  await tag.click();
  await page.keyboard.type("Shorter name");
  await page.keyboard.press("Enter");
  await step(141, async () => /^Working on 2 notes…1 note waiting/.test((await line.textContent()) ?? "") && await pins.count() === 1);
  await page.mouse.move(5, 5);
  letGo();
  assert.match(asked[0]!.text, /On “Pin a chat”:\n1 · Drive picks: Make this row taller\n2 · Pinned heading: Call it Favourites\n\n```parts\n/, "the message leads with what the person said");
  assert.match(asked[0]!.text, new RegExp(`Notes on parts of the Foundry mockup "Pin a chat" \\(id ${pin.id}, v1\\)\\. Change only these parts`), "the model is told which mockup and to change only those parts");
  assert.match(asked[0]!.text, /selector `[^`]*div\.r[^`]*`\n\s+<div class="r"><span>Drive picks<\/span>/, "each part comes with its place and markup");
  assert.equal(asked[0]!.pictures, 2, "each part's picture goes with the notes");
  assert.match(asked[0]!.text, /The attached pictures show parts 1, 2 as the person saw them, in that order\./);

  // One new version holds both corrections; the page goes to it, with what changed outlined.
  await item(2).locator(".fd-stage").waitFor({ timeout: 20000 });
  assert.match((await item(2).locator("iframe.fd-frame").getAttribute("src"))!, /&first=1$/, "the new version shows what changed");
  await step(142, async () => !!frame(2) && await frame(2).evaluate(() => document.querySelector("h3")?.textContent === "Favourites" && getComputedStyle(document.querySelector(".r")!).height === "40px").catch(() => false));
  assert.match((await item(2).locator(".fd-ask").textContent()) ?? "", /^You asked On “Pin a chat”: 1 · Drive picks: Make this row taller 2 · Pinned heading: Call it Favourites$/, "the notes are the new version's ask");
  assert.equal(await item(1).locator(".fd-notes").count(), 0, "notes are for the newest version");
  await step(145, async () => /^1 note waiting/.test((await item(2).locator(".fd-notes").textContent()) ?? "") && await item(2).locator(".fn-pin").count() === 1);
  await step(146, async () => { const at = await item(2).boundingBox(); return !!at && at.y < 400 && at.y > -50; });
  await item(2).screenshot({ path: join(output, "foundry-note-back.png") });
  // In the chat the message is the notes, with the model's detail folded away.
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await step(150, async () => await page!.locator("#page").isHidden());
  const bubble = page.locator("#conversation .request").last();
  await step(152, async () => /Make this row taller/.test((await bubble.textContent()) ?? ""));
  assert.equal(await bubble.locator(".parts-chip summary").textContent(), "⌖Marked parts · 2");
  await bubble.screenshot({ path: join(output, "foundry-note-chat.png") });
  const pictures = await page.locator("#conversation .request-att img").evaluateAll((all) => all.map((img) => (img as HTMLImageElement).src));
  assert.equal(pictures.length, 2, "the pictures show with the message");
  pictures.forEach((url, index) => writeFileSync(join(output, `foundry-note-picture-${index + 1}.png`), Buffer.from(url.slice(url.indexOf(",") + 1), "base64")));
  console.log("PASS: resting on a part outlines it; notes pin, wait, and go together to the chat that made the mockup; the new version comes back with what changed.");

  // A mockup with options: the note says which option, and goes at once with the send key.
  await eventually(async () => (await f.client.getSessionState(pin.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.waitForTimeout(300);
  await editor.fill("/foundry pin a chat, with options"); await editor.press("Enter");
  await chips.filter({ hasText: "Pin a chat, two ways" }).waitFor();
  const two = (await f.client.foundryList()).artifacts.find((found) => found.title === "Pin a chat, two ways")!;
  await eventually(async () => (await f.client.getSessionState(pin.sessionId!)).session.turns.at(-1)?.status === "completed");
  await chips.filter({ hasText: "Pin a chat, two ways" }).click();
  const both = page.locator(`#page [data-fd="${two.id}:1"]`);
  await step(171, async () => await both.locator(".fd-stage").count() === 2);
  const second = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${two.id}?v=1`) && found.url().endsWith("&option=1"))!;
  await step(173, async () => !!second() && await second().evaluate(() => !!(window as { __demesneNote?: boolean }).__demesneNote && !!document.querySelector("d-compare > section:not([hidden]) .r")).catch(() => false));
  await both.locator(".fd-stage").nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const spot = (await second().locator("section:not([hidden]) .list .r:nth-child(2) span").boundingBox())!;
  await page.mouse.move(spot.x + spot.width / 2 - 6, spot.y + spot.height / 2, { steps: 4 });
  await page.mouse.move(spot.x + spot.width / 2, spot.y + spot.height / 2, { steps: 3 });
  await step(179, async () => (await both.locator(".fn-tag").textContent()) === "Drive picks · Comment");
  await both.locator(".fn-tag").click();
  await page.keyboard.type("Bigger pin");
  await page.keyboard.press("Control+Enter");
  await step(183, async () => asked.length === 2, 15000);
  assert.match(asked[1]!.text, /On “Pin a chat, two ways”:\n1 · Drive picks in B · Pin always showing: Bigger pin\n\n```parts\nNotes on one part of the Foundry mockup "Pin a chat, two ways"/, "the note says which option");
  assert.equal(asked[1]!.pictures, 1);
  // The model answered in words: the line under the mockup says so instead of working on.
  await step(187, async () => /^No new version came back\. The chat has the answer\.$/.test((await both.locator(".fd-notes").textContent()) ?? ""), 20000);
  assert.deepEqual(errors, []);
  console.log("PASS: on a mockup with options the note says which option; an answer in words is said under the mockup.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
