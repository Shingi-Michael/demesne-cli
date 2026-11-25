/** Real Electron check for pass 221 A: on Foundry's long page a mockup sits on
 * the surface the model chose and plays the demo it wrote, with a drawn
 * pointer and the words under the stage; moving in stops it; options get a
 * stage each, named above it; nothing is drawn into the page. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const chats = ["Tidy the sidebar", "Drive picks", "Release notes"];
const list = (cls = "") => `<div class="w ${cls}"><h3>Pinned</h3><div class="pins"></div><h3>Chats</h3><div class="list">${chats.map((name) => `<div class="r"><span>${name}</span><button class="pin" aria-label="Pin ${name}">📌</button></div>`).join("")}</div></div>`;
const style = `<style>body{margin:0;font:14px system-ui;background:#232326;color:#eee}.w{padding:8px;width:340px}h3{font-size:11px;color:#999;margin:8px}.r{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:7px}.r span{flex:1}.r:hover{background:#2d2d31}.pin{all:unset;cursor:pointer;opacity:0}.r:hover .pin,.pins .pin{opacity:1}</style>`;
const script = `<script>document.addEventListener("click",(e)=>{const p=e.target.closest(".pin");if(!p)return;const r=p.closest(".r"),w=r.closest(".w");(r.parentElement.classList.contains("pins")?w.querySelector(".list"):w.querySelector(".pins")).append(r);});</script>`;
const pinPage = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${list()}${script}</body></html>`;
const optionsPage = `<!doctype html><html><head><meta charset="utf-8">${style}<script src="foundry://kit/parts.js"></script></head><body><d-compare recommended="A"><section data-option="A · Pin on hover" note="quiet">${list()}</section><section data-option="B · Pin always showing">${list("alw")}</section></d-compare>${script}</body></html>`;
const demo = [{ hover: "Drive picks", say: "Point at a chat and its pin shows" }, { click: "Pin Drive picks", say: "Click the pin" }, { wait: 300, say: "It moves up to Pinned" }];

// Pass 246 A, a range of styles: one checkout page, written once on the kit's values, in three styles.
const styleOf = (name: string, made: string, vars: string) => `<d-style name="${name}" made="${made}" vars="${vars}"></d-style>`;
const stylesPage = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script><style>
body{padding:28px 32px}.sub{color:var(--muted);margin:0 0 20px}.g{display:grid;grid-template-columns:1.35fr 1fr;gap:18px;align-items:start}.plans{display:flex;flex-direction:column;gap:10px}
.row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:14px 16px;border-radius:var(--radius-lg);background:var(--tone);box-shadow:inset 0 0 0 1px var(--hair)}.row.on{box-shadow:inset 0 0 0 2px var(--accent)}
.row small{display:block;color:var(--muted)}.row strong,.sum strong{font-family:var(--head)}.sum{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:var(--radius-lg);background:var(--tone);box-shadow:inset 0 0 0 1px var(--hair)}.sum strong{font-size:var(--text-lg)}
</style></head><body><d-styles recommended="Clean counter">`
  + styleOf("Clean counter", "Inter throughout · 8px corners · hairlines", "--paper:#ffffff; --ink:#111417; --accent:#1f6f4a; --head:Inter,sans-serif; --font:Inter,sans-serif; --radius:8px")
  + styleOf("Roastery label", "Mono headings, Inter under them · square corners", "--paper:#1d1613; --ink:#f3e9da; --accent:#e0a93b; --head:'JetBrains Mono',monospace; --font:Inter,sans-serif; --radius:2px")
  + styleOf("Warm paper", "Georgia and Inter · round corners · the look today", "--paper:#fbf7f2; --ink:#2a211b; --accent:#b9643c; --head:Georgia,serif; --font:Inter,sans-serif; --radius:14px")
  + `</d-styles><h1>Checkout</h1><p class="sub">Daily · two bags a month, any roast</p><div class="g"><div class="plans"><div class="row on"><span><b>Yearly</b><small>€200 a year · save €40</small></span><strong>€200</strong></div>`
  + `<div class="row"><span><b>Monthly</b><small>€20 a month</small></span><strong>€20</strong></div></div><div class="sum"><small>Due today</small><strong>€200</strong><button class="primary">Pay €200</button></div></div></body></html>`;

const f = await fixture({
  providerId: "fixture", modelId: "foundry-demo",
  async listModels() { return [{ id: "foundry-demo", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const request = messages[at]?.content ?? "";
    const done = messages.slice(at + 1).some((message) => message.role === "tool");
    if (done) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const options = /options/i.test(request);
    if (/styles/i.test(request)) {
      yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({
        title: "Checkout page, three styles", kind: "html", description: "One checkout in three styles.",
        why: { direction: "One checkout in three styles. Only the style changes.", look_at: "The price and the Pay button in each.", starts_from: "new", walkthrough: [{ option: "A · Pin on hover", what: "A · Pin on hover, for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check.", differs: "Its own way." }, { option: "B · Pin always showing", what: "B · Pin always showing, for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check.", differs: "Its own way." }] },
        source: stylesPage, surface: { frame: "browser", width: 760, height: 380, title: "slowpour.example/checkout" } }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({
      title: options ? "Pin a chat, two ways" : "Pin a chat", kind: "html", description: "Pinning a chat from the sidebar.", note: "First take",
      why: { direction: "Quiet.", look_at: "The pin.", starts_from: "new", walkthrough: [{ option: "A · Pin on hover", what: "A · Pin on hover, for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check.", differs: "Its own way." }, { option: "B · Pin always showing", what: "B · Pin always showing, for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check.", differs: "Its own way." }] },
      source: options ? optionsPage : pinPage, surface: options ? { frame: "window", width: 520, height: 320, title: "Demesne" } : { frame: "part", width: 360 }, demo }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-demo")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const idle = () => page!.waitForFunction(() => !(window.demesneInspect?.() as { host?: { busy?: boolean } })?.host?.busy);
  // Enter is lost while the window has no chat yet: send once it has one and is idle.
  await page.waitForFunction(() => { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; });
  await page.waitForTimeout(200);
  await editor.fill("/foundry pin a chat"); await editor.press("Enter");
  const chips = page.locator("#conversation .fd-chip");
  await chips.first().filter({ hasText: "Pin a chat" }).waitFor();
  const pin = (await f.client.foundryList()).artifacts.find((item) => item.title === "Pin a chat")!;
  const stored = (await f.client.foundryGet(pin.id)).versions[0]!.stage;
  assert.deepEqual(stored?.surface, { frame: "part", width: 360 }, "the surface is kept with the version");
  assert.equal(stored?.demo?.length, 3, "the demo is kept with the version");
  await chips.first().click();
  // Opened, it runs edge to edge (pass 263 A): the pointer left on the chip would be resting on it, which hands the page over.
  await page.mouse.move(5, 5);
  const item = page.locator(`#page [data-fd="${pin.id}:1"]`), stage = item.locator(".fd-stage");
  await stage.waitFor();
  assert.match((await stage.getAttribute("class"))!, /fd-s s-part b-paper/, "the stage is the part on paper");
  const frame = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${pin.id}?v=1`))!;
  await step(63, async () => !!frame());
  // A part grows to its content: the stage takes the height the page says.
  await step(65, async () => Number(await stage.getAttribute("data-oh")) !== 480);
  // The demo plays with the words under the stage, and really pins the chat.
  const line = item.locator(".fd-demo");
  await step(68, async () => /Point at a chat/.test((await line.textContent()) ?? ""));
  assert.equal(await line.locator(".fd-ticks i").count(), 3, "a tick per beat");
  await step(70, async () => frame().evaluate(() => !!document.querySelector(".pins .r") && document.querySelector(".pins .r span")!.textContent === "Drive picks"), 12000);
  await step(71, async () => /moves up to Pinned/.test((await line.textContent()) ?? ""));
  assert.equal(await frame().evaluate(() => document.querySelectorAll("[data-chrome][aria-hidden=true]").length), 1, "the pointer is the only thing Foundry adds to the page");
  await item.screenshot({ path: join(output, "foundry-demo.png") });
  // It starts again from a fresh page.
  await step(75, async () => /Point at a chat/.test((await line.textContent()) ?? ""), 15000);
  await step(76, async () => frame().evaluate(() => !document.querySelector(".pins .r")));
  // Moving in stops it and hands the page over.
  const box = (await stage.boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await step(81, async () => /Yours now/.test((await line.textContent()) ?? ""));
  await step(82, async () => frame().evaluate(() => getComputedStyle(document.querySelector("[data-chrome][aria-hidden=true]")!).opacity === "0"));
  // Resting on a part shows its tag (pass 233 A); nothing else is there to press.
  assert.equal(await page.locator("#page").locator("button:not(.fd-link):not(.fn-plus):not(.fd-hd-b):not(.fg-back):not(.fg-pin):visible, form:visible, input:visible").count(), 0, "nothing to press on Foundry");
  console.log("PASS: a mockup sits on its surface and plays its demo under it; moving in stops it.");
  await page.mouse.move(5, 5);

  // Options (pass 263 A): tabs over one stage, the pick first with a dot, nothing drawn inside.
  // Pass 277 B: an opened mockup folds the sidebar; unfold it to reach a chat.
  await page.evaluate(() => { if (document.getElementById("desktop-shell")?.classList.contains("sidebar-collapsed")) document.getElementById("desktop-toggle-sidebar")?.click(); });
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await idle(); await page.waitForTimeout(300);
  await editor.fill("/foundry pin a chat, with options"); await editor.press("Enter");
  await chips.filter({ hasText: "Pin a chat, two ways" }).waitFor();
  const two = (await f.client.foundryList()).artifacts.find((found) => found.title === "Pin a chat, two ways")!;
  await chips.filter({ hasText: "Pin a chat, two ways" }).click();
  const both = page.locator(`#page [data-fd="${two.id}:1"]`);
  await step(95, async () => await both.locator(".fd-tabs [role=tab]").count() === 2);
  assert.deepEqual(await both.locator(".fd-tabs [role=tab]").allTextContents(), ["A · Pin on hover", "B · Pin always showing"]);
  assert.equal(await both.locator(".fd-tabs [role=tab]").first().locator(".fd-tab-pick").count(), 1, "the recommended one says so");
  assert.equal(await both.locator(".fd-stage").count(), 1, "one stage, the variants as tabs over it");
  assert.match((await both.locator(".fd-stage").first().getAttribute("class"))!, /s-window b-desk/);
  assert.equal(await both.locator(".fd-chrome span").first().textContent(), "Demesne", "the window's title on Foundry's frame");
  const optionFrame = (n: number) => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${two.id}?v=1`) && (n ? found.url().endsWith("&option=1") : !found.url().includes("option=")));
  await step(103, async () => !!optionFrame(0));
  await step(104, async () => optionFrame(0)!.evaluate(() => [...document.querySelectorAll("d-compare > section")].map((el) => (el as HTMLElement).hidden).join()) .then((value) => value === "false,true"));
  assert.equal(await optionFrame(0)!.evaluate(() => document.querySelectorAll(".dp-strip, .dp-opt").length), 0, "no strip or label inside the page");
  await both.locator(".fd-tabs [role=tab]").nth(1).click();
  await step(108, async () => !!optionFrame(1) && await optionFrame(1)!.evaluate(() => [...document.querySelectorAll("d-compare > section")].map((el) => (el as HTMLElement).hidden).join()).then((value) => value === "true,false").catch(() => false));
  assert.equal(await both.locator(".fd-walk-v:not([hidden])").getAttribute("data-option"), "B · Pin always showing", "its walkthrough under it");
  await both.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await both.screenshot({ path: join(output, "foundry-options.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: options are tabs over one stage, each with its walkthrough, nothing drawn inside.");

  // Pass 246 A: a page of styles is drawn once per style. A row of small ones to compare, then each at full size under its name, its colours and what it is made of.
  // Pass 277 B: an opened mockup folds the sidebar; unfold it to reach a chat.
  await page.evaluate(() => { if (document.getElementById("desktop-shell")?.classList.contains("sidebar-collapsed")) document.getElementById("desktop-toggle-sidebar")?.click(); });
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await idle(); await page.waitForTimeout(300);
  await editor.fill("/foundry the checkout page in a few styles"); await editor.press("Enter");
  await chips.filter({ hasText: "Checkout page, three styles" }).waitFor();
  const range = (await f.client.foundryList()).artifacts.find((found) => found.title === "Checkout page, three styles")!;
  await chips.filter({ hasText: "Checkout page, three styles" }).click();
  const styled = page.locator(`#page [data-fd="${range.id}:1"]`);
  await step(120, async () => await styled.locator(".fd-opt").count() === 3);
  assert.deepEqual(await styled.locator(".fd-opt b").allTextContents(), ["Clean counter", "Roastery label", "Warm paper"]);
  assert.equal(await styled.locator(".fd-opt .fd-rec-pill").count(), 1, "one pick, in words");
  assert.equal(await styled.locator(".fd-opt").first().locator(".fd-rec-pill").count(), 1);
  assert.deepEqual(await styled.locator(".fd-opt").evaluateAll((heads) => heads.map((head) => head.querySelectorAll(".fd-sw i").length)), [3, 3, 3], "each style shows its colours");
  assert.equal(await styled.locator(".fd-opt").nth(1).locator(".fd-sw i").first().evaluate((dot) => getComputedStyle(dot).backgroundColor), "rgb(29, 22, 19)", "paper first");
  assert.equal(await styled.locator(".fd-opt").nth(2).locator("span").last().textContent(), "Georgia and Inter · round corners · the look today", "and what it is made of");
  assert.equal(await styled.locator(".fd-stage").count(), 3, "a stage per style");
  // The row of small ones: the same page in each style, scaled to the room, taking no pointer.
  assert.equal(await styled.locator(".fd-glance").count(), 1);
  assert.deepEqual(await styled.locator(".fd-glance figcaption b").allTextContents(), ["Clean counter", "Roastery label", "Warm paper"]);
  assert.deepEqual(await styled.locator(".fd-mini-frame").evaluateAll((frames) => frames.map((frame) => /&option=(\d)$/.exec(frame.getAttribute("src")!)?.[1])), ["0", "1", "2"]);
  const small = await styled.locator(".fd-mini").first().evaluate((mini) => { const frame = mini.querySelector("iframe")!; return { k: Number(getComputedStyle(mini).getPropertyValue("--k")), wide: mini.clientWidth, drawn: Math.round(frame.getBoundingClientRect().width), pointer: getComputedStyle(frame).pointerEvents }; });
  assert.ok(small.k > 0.1 && small.k < 0.6, `scaled down (${small.k})`);
  assert.ok(Math.abs(small.drawn - small.wide) <= 1, "each small one fills its place");
  assert.equal(small.pointer, "none");
  assert.ok(await styled.evaluate((item) => item.querySelector(".fd-glance")!.compareDocumentPosition(item.querySelector(".fd-opt")!) & Node.DOCUMENT_POSITION_FOLLOWING), "the row comes first");
  // Each stage is the one page in its style: the values are set on its root, the kit follows, nothing is drawn in it.
  const styleFrame = (n: number) => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${range.id}?v=1`) && (n ? found.url().endsWith(`&option=${n}`) : !found.url().includes("option=")))!;
  await step(135, async () => [0, 1, 2].every((n) => !!styleFrame(n)));
  const look = (n: number) => styleFrame(n).evaluate(() => ({ style: document.documentElement.dataset.style, paper: getComputedStyle(document.body).backgroundColor, head: getComputedStyle(document.querySelector("h1")!).fontFamily, button: getComputedStyle(document.querySelector("button")!).backgroundColor, on: getComputedStyle(document.querySelector("button")!).color, corner: getComputedStyle(document.querySelector("button")!).borderRadius, drawn: getComputedStyle(document.querySelector("d-styles")!).display, words: document.body.innerText.replace(/\s+/g, " ").trim() }));
  await step(137, async () => (await look(1)).style === "Roastery label");
  const [clean, label, paper] = [await look(0), await look(1), await look(2)];
  assert.deepEqual([clean.style, label.style, paper.style], ["Clean counter", "Roastery label", "Warm paper"]);
  assert.deepEqual([clean.paper, label.paper, paper.paper], ["rgb(255, 255, 255)", "rgb(29, 22, 19)", "rgb(251, 247, 242)"]);
  assert.match(label.head, /JetBrains Mono/); assert.match(paper.head, /Georgia/);
  assert.deepEqual([clean.button, label.button], ["rgb(31, 111, 74)", "rgb(224, 169, 59)"]);
  assert.deepEqual([clean.on, label.on], ["rgb(255, 255, 255)", "rgb(17, 17, 17)"], "the words on the accent are light or dark as it needs");
  assert.deepEqual([clean.corner, label.corner, paper.corner], ["8px", "2px", "14px"]);
  assert.equal(label.drawn, "none", "the styles themselves draw nothing");
  assert.equal(clean.words, label.words, "the same words in every style");
  await styled.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(output, "foundry-styles.png") });
  await styled.locator(".fd-opt").nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(output, "foundry-styles-2.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: a range of styles is one page drawn in each: a row to compare, then a stage per style with its colours and what it is made of.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
