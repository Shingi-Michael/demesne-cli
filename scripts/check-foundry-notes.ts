/** Real Electron check for pass 242 A (notes since pass 233 A): on Foundry's
 * long page nothing is outlined. When the pointer rests on a mockup a small +
 * shows beside it; a click drops a pin exactly there with a one-line note.
 * A note says what to change, or what you like (a keep, read from its words;
 * Tab flips it). Enter adds it, the notes wait while you are elsewhere, and
 * the send key sends them together to the chat that made the mockup, with
 * each pin's part, spot and a picture around it. The mockup's own clicks are
 * the pins'. The new version comes back on the page, and later reads of the
 * mockup hand back what was liked. Run after `bun scripts/prepare-desktop.ts`,
 * under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
// A coffee subscription's plans page: a web app, not Demesne.
const style = `<style>body{margin:0;font:15px system-ui;background:#faf7f2;color:#2b211b}.w{padding:28px 32px 40px}h1{font:600 30px Georgia,serif;margin:0 0 6px}.sub{margin:0 0 18px;color:#7a6a5d}.sw{display:inline-flex;background:#efe7dd;border-radius:99px;padding:4px}.sw b{font-weight:400;padding:6px 14px;border-radius:99px;cursor:pointer}.sw b.on{background:#fff}.sw i{font-style:normal;color:#3d7a4b;font-size:13px;margin-left:6px}.plans{display:flex;gap:14px;margin-top:24px}.plan{flex:1;border:1px solid #e8dfd3;border-radius:12px;background:#fff;padding:16px;position:relative;height:150px}.choose{margin-top:12px;border:0;border-radius:8px;background:#b8653d;color:#fff;font:inherit;padding:7px 14px}.plan.best{border:2px solid #b8653d}.tag{position:absolute;top:-11px;left:14px;background:#b8653d;color:#fff;font-size:12px;padding:2px 10px;border-radius:99px}.plan h4{margin:6px 0 8px}.price{font:600 26px Georgia,serif}</style>`;
const script = `<script>document.addEventListener("click",(e)=>{const b=e.target.closest(".sw b");if(!b)return;document.querySelectorAll(".sw b").forEach((x)=>x.classList.toggle("on",x===b));});</script>`;
const plans = `<div class="w"><h1>Slow Pour subscriptions</h1><p class="sub">Fresh beans every few weeks. Pause or cancel any time.</p><div class="sw"><b class="m">Monthly</b><b class="y on">Yearly <i>2 months free</i></b></div>`
  + `<div class="plans"><div class="plan"><h4>Taster</h4><div class="price">€10</div></div><div class="plan best"><span class="tag">Most chosen</span><h4>Daily</h4><div class="price">€20</div><button class="choose" onclick="this.textContent='Chosen'">Choose Daily</button></div><div class="plan"><h4>Office</h4><div class="price">€50</div></div></div></div>`;
const plansPage = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${plans}${script}</body></html>`;
const optionsPage = `<!doctype html><html><head><meta charset="utf-8">${style}<script src="foundry://kit/parts.js"></script></head><body><d-compare recommended="A"><section data-option="A · Yearly first" note="calm">${plans}</section><section data-option="B · Monthly first">${plans}</section></d-compare>${script}</body></html>`;

const asked: { text: string; pictures: number }[] = [];
/// What a read of the mockup handed back as liked, after the notes were sent.
let liked: unknown = null;
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
    if (notes && /^apply my comment/.test(request)) {
      asked.push({ text: request, pictures: ((said as { imageArtifactIds?: unknown[] }).imageArtifactIds ?? []).length });
      yield { type: "text_delta", delta: "I see your note on the Office heading." }; yield { type: "finish", reason: "stop" }; return;
    }
    if (notes && /two ways/.test(request)) {
      asked.push({ text: request, pictures: ((said as { imageArtifactIds?: unknown[] }).imageArtifactIds ?? []).length });
      yield { type: "text_delta", delta: "Which one do you want?" }; yield { type: "finish", reason: "stop" }; return;
    }
    if (notes && id && !current.length) {
      asked.push({ text: request, pictures: ((said as { imageArtifactIds?: unknown[] }).imageArtifactIds ?? []).length });
      await held;
      yield call("foundry_read", { id }); yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (notes && id && current.length === 1) {
      const read = JSON.parse(current[0]!.content ?? "{}") as { version: number; liked?: unknown };
      liked = read.liked ?? null;
      yield call("foundry_edit", { id, base_version: read.version, note: "Save €40", why: { direction: "Same page, the saving in money.", look_at: "The switch.", dropped: "Nothing else moved." }, edits: [{ find: "2 months free", replace: "save €40" }, { find: "height:150px", replace: "height:170px" }] });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (current.length) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const options = /options/i.test(request);
    yield call("foundry_save", { title: options ? "Plans page, two ways" : "Plans page", kind: "html", description: "The plans page of a coffee subscription.", note: "First take",
      why: { direction: "Warm and plain.", look_at: "The switch and the Daily plan.", starts_from: "new", walkthrough: [{ option: "A · Yearly first", what: "A · Yearly first, for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check.", differs: "Its own way." }, { option: "B · Monthly first", what: "B · Monthly first, for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check.", differs: "Its own way." }] }, source: options ? optionsPage : plansPage, surface: options ? { frame: "window", width: 760, height: 420, title: "Slow Pour" } : { frame: "part", width: 720 } });
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
  await editor.fill("/foundry the plans page"); await editor.press("Enter");
  const chips = page.locator("#conversation .fd-chip");
  await chips.first().filter({ hasText: "Plans page" }).waitFor();
  const mockup = (await f.client.foundryList()).artifacts.find((item) => item.title === "Plans page")!;
  await eventually(async () => (await f.client.getSessionState(mockup.sessionId!)).session.turns.at(-1)?.status === "completed");
  await chips.first().click();
  const item = (version: number) => page!.locator(`#page [data-fd="${mockup.id}:${version}"]`);
  /// The frame of a version on the Foundry page (never a preview of it elsewhere in the window).
  const frame = async (version: number): Promise<Frame | null> => (await (await item(version).locator("iframe.fd-frame").first().elementHandle({ timeout: 5000 }).catch(() => null))?.contentFrame()) ?? null;
  const stage = item(1).locator(".fd-stage"), line = item(1).locator(".fd-notes"), plus = item(1).locator(".fn-plus"), box = item(1).locator(".fn-box"), pins = item(1).locator(".fn-pin[data-n]");
  await stage.waitFor();
  await step(80, async () => !!(await frame(1)) && await (await frame(1))!.evaluate(() => !!(window as { __demesneNote?: boolean }).__demesneNote).catch(() => false));

  // At rest the page shows nothing new, and the mockup has no pink edge.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#page").locator("button:not(.fd-link):not(.fd-hd-b):not(.fg-back):not(.fg-pin):visible, form:visible, input:visible").count(), 0, "nothing to press on Foundry at rest");
  assert.equal(await line.isHidden(), true, "no notes line at rest");
  assert.equal(await page.locator("#page .fn-layer").count(), 0, "nothing is added to the page at rest");
  assert.doesNotMatch(await stage.evaluate((el) => getComputedStyle(el).boxShadow), /242, 182, 200|228, 138, 166/, "no pink frame around the mockup");

  // Resting on the mockup shows a small + beside the pointer; nothing is outlined, and moving puts the + away.
  const spot = async (selector: string, dx = 0.5, dy = 0.5, version = 1) => { const at = (await (await frame(version))!.locator(selector).first().boundingBox())!; return { x: Math.round(at.x + at.width * dx), y: Math.round(at.y + at.height * dy) }; };
  const save = await spot(".sw i", 0.3, 0.5);
  await page.mouse.move(save.x - 30, save.y + 10, { steps: 4 });
  await page.mouse.move(save.x, save.y, { steps: 3 });
  await plus.waitFor();
  const plusBox = (await plus.boundingBox())!;
  assert.ok(plusBox.x > save.x && plusBox.x < save.x + 30 && plusBox.y < save.y && plusBox.y > save.y - 40, `the + sits beside the pointer: ${JSON.stringify({ plusBox, save })}`);
  assert.equal(await page.locator("#page .fn-out, #page .fn-tag").count(), 0, "nothing outlines the design");
  assert.equal(await (await frame(1))!.evaluate(() => document.querySelectorAll("[data-chrome], [class*=fn-]").length), 0, "nothing is drawn inside the mockup");
  await item(1).screenshot({ path: join(output, "foundry-pin-rest.png") });
  await page.mouse.move(save.x + 40, save.y + 40, { steps: 3 });
  await step(104, async () => await plus.isHidden(), 400);

  // A click drops a pin exactly there, with a note beside it. The mockup never sees the click.
  await page.mouse.click(save.x, save.y);
  await step(115, async () => await box.locator("input").isVisible());
  const fresh = (await item(1).locator(".fn-pin.fn-new").boundingBox())!;
  assert.ok(Math.abs(fresh.x - save.x) <= 2 && Math.abs(fresh.y + fresh.height - save.y) <= 2, `the pin's point is the spot: ${JSON.stringify({ fresh, save })}`);
  assert.equal(await box.locator("label").textContent(), "ChangeYearly 2 months free", "the note says it is a change, and what it is on");
  assert.equal(await box.locator("input").evaluate((el) => el === document.activeElement), true, "the note takes the typing");
  await page.keyboard.type("Say save €40 instead");
  await item(1).screenshot({ path: join(output, "foundry-pin-box.png") });
  await page.keyboard.press("Enter");
  await step(116, async () => await pins.count() === 1 && await box.count() === 0 && (await pins.first().textContent()) === "1");
  await step(117, async () => /^1 to change · send (⌘↵|Ctrl ↵)$/.test((await line.textContent()) ?? ""));

  // A keep: read from the words, with a heart on its pin.
  const tag = await spot(".tag", 0.7, 0.5);
  await page.mouse.click(tag.x, tag.y);
  await step(129, async () => await box.locator("input").isVisible());
  await page.keyboard.type("Keep this tag, it reads warm");
  await step(123, async () => (await box.locator(".fn-kind").textContent()) === "Keep");
  await page.keyboard.press("Enter");
  await step(125, async () => await pins.count() === 2 && await item(1).locator(".fn-pin.fn-keep svg").count() === 1);
  await step(126, async () => /^1 to change, 1 to keep · send/.test((await line.textContent()) ?? ""));

  // A control in the mockup still works when clicked, and no note opens.
  const choose = await spot(".choose", 0.6, 0.5);
  await page.mouse.click(choose.x, choose.y);
  await step(130, async () => (await (await frame(1))!.evaluate(() => document.querySelector(".choose")?.textContent)) === "Chosen");
  assert.equal(await box.count(), 0, "a control's click is the mockup's");
  // Resting on it shows the +; the + pins exactly where the pointer rested. ("Chosen" is narrower than "Choose Daily".)
  Object.assign(choose, await spot(".choose", 0.6, 0.5));
  await page.mouse.move(choose.x - 20, choose.y + 6, { steps: 3 });
  await page.mouse.move(choose.x, choose.y, { steps: 3 });
  await plus.waitFor();
  await plus.click();
  await step(138, async () => await box.locator("input").isVisible());
  const onButton = (await item(1).locator(".fn-pin.fn-new").boundingBox())!;
  assert.match((await box.locator("label").textContent()) ?? "", /^ChangeChosen button$/);
  assert.ok(Math.abs(onButton.x - choose.x) <= 2 && Math.abs(onButton.y + onButton.height - choose.y) <= 2, `the pin is where the pointer rested: ${JSON.stringify({ onButton, choose })}`);
  await item(1).screenshot({ path: join(output, "foundry-pin-control.png") });
  await page.keyboard.press("Escape");
  await step(144, async () => await box.count() === 0 && await pins.count() === 2);

  // On no part the page holds the pin; Tab flips keep and change; Esc lets the note go.
  const bare = await spot(".w", 0.5, 0.96);
  await page.mouse.click(bare.x, bare.y);
  await step(139, async () => await box.locator("input").isVisible());
  assert.match((await box.locator("label").textContent()) ?? "", /The page$/);
  await page.keyboard.type("More room at the top");
  await step(133, async () => (await box.locator(".fn-kind").textContent()) === "Change");
  await page.keyboard.press("Tab");
  await step(135, async () => (await box.locator(".fn-kind").textContent()) === "Keep");
  await page.keyboard.press("Tab");
  await step(137, async () => (await box.locator(".fn-kind").textContent()) === "Change");
  await page.keyboard.press("Escape");
  await step(139, async () => await box.count() === 0 && await pins.count() === 2 && await item(1).locator(".fn-pin.fn-new").count() === 0);
  // The mockup's own switch did not move: every click was a pin's.
  assert.equal(await (await frame(1))!.evaluate(() => document.querySelector(".sw b.on")?.className), "y on");
  // A pin opens its note again.
  await pins.first().click();
  await step(144, async () => await box.locator("input").inputValue() === "Say save €40 instead");
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await step(147, async () => await box.count() === 0 && await plus.isHidden());
  await item(1).screenshot({ path: join(output, "foundry-pin-pins.png") });

  // The notes wait while you are elsewhere, at their spots.
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await step(152, async () => await page!.locator("#page").isHidden());
  await chips.first().click();
  await stage.waitFor();
  await step(155, async () => /^1 to change, 1 to keep/.test((await line.textContent()) ?? "") && await pins.count() === 2);
  await step(164, async () => !!(await frame(1)) && await (await frame(1))!.evaluate(() => !!document.querySelector(".sw i")).catch(() => false));
  const again = await spot(".sw i", 0.3, 0.5), first = (await pins.first().boundingBox())!;
  assert.ok(Math.abs(first.x - again.x) <= 2 && Math.abs(first.y + first.height - again.y) <= 2, `the pin is still on its spot: ${JSON.stringify({ first, again })}`);

  // The send key sends them together, to the chat that made the mockup.
  await item(1).hover({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+Enter");
  await step(162, async () => asked.length === 1, 15000);
  // The line says where they went.
  const chatTitle = (await f.client.getSessionState(mockup.sessionId!)).session.title;
  await step(163, async () => (await line.textContent()) === `Working on 2 notes in “${chatTitle}”…` && await pins.count() === 0);
  // A note written while the first two are with the model waits, and moves to the version they make.
  const office = await spot(".plan:last-child h4");
  await page.mouse.click(office.x, office.y);
  await step(177, async () => await box.locator("input").isVisible());
  await page.keyboard.type("Shorter name");
  await page.keyboard.press("Enter");
  await step(170, async () => /^Working on 2 notes in “.+”…1 to change/.test((await line.textContent()) ?? "") && await pins.count() === 1);
  await page.mouse.move(5, 5);
  letGo();
  assert.match(asked[0]!.text, /On “Plans page”:\n1 · Yearly 2 months free: Say save €40 instead\n♥ · “Most chosen”: Keep this tag, it reads warm\n\n```parts\n/, "the message leads with what the person said, a keep with a heart");
  assert.match(asked[0]!.text, new RegExp(`Notes pinned on the Foundry mockup "Plans page" \\(id ${mockup.id}, v1\\)\\. Change only the part with the numbered note, as its note says; the ♥ note is what the person likes, so keep that exactly as it is`), "the model is told what to change and what to keep");
  assert.match(asked[0]!.text, /1\. change, Yearly 2 months free: Say save €40 instead\n\s+selector `[^`]*b\.y\.on[^`]*`, pinned \d+% across and \d+% down it\n\s+in its picture the pin is \d+% across and \d+% down\n\s+<b class="y on">Yearly <i>2 months free<\/i><\/b>/, "each pin comes with its part, its spot and its markup");
  assert.equal(asked[0]!.pictures, 2, "a picture around each pin goes with the notes");

  // One new version holds the change; the page goes to it, and the read handed back what was liked.
  await item(2).locator(".fd-stage").waitFor({ timeout: 20000 });
  await step(181, async () => !!(await frame(2)) && await (await frame(2))!.evaluate(() => document.querySelector(".sw i")?.textContent === "save €40").catch(() => false));
  assert.deepEqual(liked, ["“Most chosen”: Keep this tag, it reads warm"], "a later read of the mockup hands back what was liked");
  assert.equal(await item(1).locator(".fd-notes").count(), 0, "notes are for the newest version");
  await step(184, async () => /^1 to change/.test((await item(2).locator(".fd-notes").textContent()) ?? "") && await item(2).locator(".fn-pin[data-n]").count() === 1);
  await step(185, async () => { const at = await item(2).boundingBox(); return !!at && at.y < 400 && at.y > -50; });
  await item(2).screenshot({ path: join(output, "foundry-pin-back.png") });
  // In the chat the message is the notes, with the model's detail folded away.
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await step(189, async () => await page!.locator("#page").isHidden());
  const bubble = page.locator("#conversation .request").last();
  await step(191, async () => /Say save €40 instead/.test((await bubble.textContent()) ?? ""));
  await bubble.screenshot({ path: join(output, "foundry-pin-chat.png") });
  const pictures = await page.locator("#conversation .request-att img").evaluateAll((all) => all.map((img) => (img as HTMLImageElement).src));
  assert.equal(pictures.length, 2, "the pictures show with the message");
  pictures.forEach((url, index) => writeFileSync(join(output, `foundry-pin-picture-${index + 1}.png`), Buffer.from(url.slice(url.indexOf(",") + 1), "base64")));
  console.log("PASS: nothing is outlined; a + rests by the pointer, a click pins exactly there; changes and keeps wait and go together; the new version comes back and the keeps stay with the mockup.");

  // A note not sent is kept by the daemon (the model can read it), comes back after a reload,
  // shows as a chip in the composer, and rides with whatever you write next in the chat.
  await eventually(async () => (await f.client.foundryWaitingNotes()).waiting.some((item) => item.id === mockup.id && item.version === 2 && item.notes.length === 1));
  await page.reload();
  await page.locator("#composer-model").waitFor();
  const chip = page.locator("#mention-chips .foundry-notes-chip");
  await step(232, async () => (await chip.count()) === 1 && (await chip.textContent()) === "1 note on “Plans page”", 20000);
  await page.locator("#mention-chips").screenshot({ path: join(output, "foundry-pin-chip.png") });
  // The chip opens Foundry at the mockup, where the note is back on its pin.
  await chip.click();
  await step(236, async () => /^1 to change/.test((await item(2).locator(".fd-notes").textContent()) ?? "") && await item(2).locator(".fn-pin[data-n]").count() === 1, 20000);
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await step(238, async () => await page!.locator("#page").isHidden());
  await page.locator("textarea").fill("apply my comment please");
  await page.locator("textarea").press("Enter");
  await step(241, async () => asked.length === 2, 15000);
  assert.ok(asked[1]!.text.startsWith(`apply my comment please\n\nOn “Plans page”:\n1 · Office heading: Shorter name\n\n${"`".repeat(3)}parts\nNotes pinned on the Foundry mockup "Plans page" (id ${mockup.id}, v2)`), `the waiting note goes after your words: ${asked[1]!.text.slice(0, 300)}`);
  await step(243, async () => (await chip.count()) === 0, 5000);
  await eventually(async () => !(await f.client.foundryWaitingNotes()).waiting.some((item) => item.id === mockup.id));
  const asking = page.locator("#conversation .request").last();
  await step(246, async () => /apply my comment please/.test((await asking.textContent()) ?? ""));
  // The turn's end redraws the conversation: picture the message once it has settled.
  await eventually(async () => (await f.client.getSessionState(mockup.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.waitForTimeout(300);
  await asking.screenshot({ path: join(output, "foundry-pin-carried.png") });
  console.log("PASS: a note not sent is kept, comes back after a reload, shows in the composer and goes with your next message.");

  // A mockup with options: the note says which option, and goes at once with the send key.
  await eventually(async () => (await f.client.getSessionState(mockup.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.waitForTimeout(300);
  await editor.fill("/foundry the plans page, with options"); await editor.press("Enter");
  await chips.filter({ hasText: "Plans page, two ways" }).waitFor();
  const two = (await f.client.foundryList()).artifacts.find((found) => found.title === "Plans page, two ways")!;
  await eventually(async () => (await f.client.getSessionState(mockup.sessionId!)).session.turns.at(-1)?.status === "completed");
  await chips.filter({ hasText: "Plans page, two ways" }).click();
  const both = page.locator(`#page [data-fd="${two.id}:1"]`);
  // Pass 263 A: the variants are tabs over one stage; the second tab loads the second option there.
  await step(209, async () => await both.locator(".fd-tabs [role=tab]").count() === 2);
  await both.locator(".fd-tabs [role=tab]").nth(1).click();
  const second = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${two.id}?v=1`) && found.url().endsWith("&option=1"))!;
  await step(211, async () => !!second() && await second().evaluate(() => !!(window as { __demesneNote?: boolean }).__demesneNote && !!document.querySelector("d-compare > section:not([hidden]) .plan")).catch(() => false));
  assert.equal(await both.locator(".fd-stage").first().evaluate((el) => /242, 182, 200/.test(getComputedStyle(el).boxShadow)), false, "the recommended option has no pink edge");
  await both.locator(".fd-stage").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const daily = (await second().locator("section:not([hidden]) .plan.best h4").boundingBox())!;
  await page.mouse.click(daily.x + daily.width / 2, daily.y + daily.height / 2);
  await both.locator(".fn-box input").waitFor();
  await page.keyboard.type("Bigger price");
  await page.keyboard.press("Control+Enter");
  await step(220, async () => asked.length === 3, 15000);
  assert.match(asked[2]!.text, /On “Plans page, two ways”:\n1 · Daily heading in B · Monthly first: Bigger price\n\n```parts\nNotes pinned on the Foundry mockup "Plans page, two ways"/, "the note says which option");
  assert.equal(asked[2]!.pictures, 1);
  // The model answered in words: the line under the mockup says so instead of working on.
  await step(224, async () => /^No new version came back\. The chat has the answer\.$/.test((await both.locator(".fd-notes").textContent()) ?? ""), 20000);
  assert.deepEqual(errors, []);
  console.log("PASS: on a mockup with options the note says which option; an answer in words is said under the mockup.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
