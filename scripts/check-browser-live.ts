/** Real Electron check: the chat's browser as a real page in the window.
 * While the desktop app is open, the model's browser lives in the app's own
 * window (browser-inapp.ts), and the split shows the page itself, not pictures
 * of it. The page sits exactly on the split's page area. There are no buttons
 * to take it or give it back: your first scroll, click or key on the page makes
 * it yours, and going back to the chat gives it to the model. It is put away
 * when the split closes. Find, zoom and pointing at it work on the page and leave it the model's.
 * Run bun scripts/prepare-desktop.ts first (Linux: xvfb-run -a). */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { electronBrowser } from "../apps/daemon/src/browser.ts";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, "..");
const electronBin = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const hostCommand = [electronBin, join(root, "apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:18px Georgia,serif;background:#fbf7f2;color:#2a211b"><main style="padding:48px 56px">${body}</main></body>`, { headers: { "Content-Type": "text/html" } });
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/admin") return page("Sign in", `<h1 style="font:600 30px system-ui">Sign in to Slow Pour admin</h1><p><input id="email" placeholder="Email" style="font:20px system-ui;padding:12px;width:300px;border:1px solid #ccc;border-radius:8px"></p><button id="go" style="font:600 18px system-ui;padding:12px 40px;border:0;border-radius:10px;background:#111417;color:#fff">Sign in</button><p id="said"></p><div style="height:3000px"></div>
    <script>let n = 0; go.onclick = () => { n++; said.textContent = "Signed in as " + email.value + " (" + n + ")"; document.title = "Orders"; document.querySelector("h1").textContent = "Orders"; };</script>`);
  if (url.pathname === "/report.csv") return new Response("order,total\n1042,96\n", { headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="report.csv"' } });
  if (url.pathname === "/cart") return page("Cart", `<h1 style="font:600 30px system-ui">Cart</h1><p>One yearly plan, £96.</p><p><a id="google" href="https://accounts.google.com/o/oauth2/v2/auth?client_id=check" style="display:inline-block;padding:10px 0">Sign in with Google</a></p>`);
  return new Response("not here", { status: 404 });
} });
const base = `http://localhost:${site.port}`;
// Where the app says its window can hold the browser; the daemon reads it.
const pointer = join(mkdtempSync(join(tmpdir(), "demesne-live-")), "desktop-browser.json");
const browser = electronBrowser(hostCommand, undefined, pointer);

let release = () => {};
const gate = new Promise<void>((done) => { release = done; });
const f = await fixture({
  providerId: "fixture", modelId: "browser-live", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "browser-live", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const steps = messages.slice(at + 1).filter((message) => message.role === "tool").length;
    if (steps === 0) {
      assert(tools.some((tool) => tool.name === "browser"), "the browser is offered");
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `open-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "open", url: `${base}/admin` }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (steps === 1) {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `hand-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "hand_over", reason: "Sign in to the Slow Pour admin" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    const last = JSON.stringify(messages.at(-1)?.content ?? "");
    if (steps === 2) {
      assert.match(last, /handed the page back/, "the model hears the page came back");
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `click-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "click", ref: "Sign in" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (steps === 3) {
      assert.match(last, /\(2\)/, "the model's own click reaches the page");
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `pic-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "picture" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    await gate;
    yield { type: "text_delta", delta: /Orders/.test(last) ? "Signed in. Order #1042 is at the top of Orders." : "The sign-in did not go through." };
    yield { type: "finish", reason: "stop" };
  },
}, { browser });

let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, win: Page | undefined;
const output = resolve(process.argv[2] ?? "test-results/browser-live");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "electron-browser-live")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_DESKTOP_BROWSER: pointer }, timeout: 30000 });
  const app = desktop;
  win = await desktop.firstWindow();
  win.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  const errors: string[] = [];
  win.on("pageerror", (error) => errors.push(error.message));
  /// The real page of the chat's browser, as the app's main process sees it: where it is in the window, and what it shows.
  const real = (match: string) => app.evaluate(async ({ BrowserWindow, webContents }, match) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const contents = webContents.getAllWebContents().find((one) => one !== window.webContents && one.getURL().includes(match));
    if (!contents) return null;
    const mine = window.contentView.children.find((child) => (child as unknown as { webContents?: unknown }).webContents === contents);
    // On show means more than the one point a put-away page keeps inside the window.
    const at = mine?.getBounds(), [wide, high] = window.getContentSize();
    const inside = at ? Math.max(0, Math.min(at.x + at.width, wide!) - Math.max(at.x, 0)) * Math.max(0, Math.min(at.y + at.height, high!) - Math.max(at.y, 0)) : 0;
    const shown = inside > 1 ? mine : undefined;
    return { url: contents.getURL(), title: contents.getTitle(), shown: shown ? shown.getBounds() : null, inner: await contents.executeJavaScript("[innerWidth, innerHeight, devicePixelRatio, scrollY]") as number[], said: await contents.executeJavaScript("document.querySelector('#said')?.textContent ?? ''") as string };
  }, match);
  /// What you do on the real page with the mouse and keys (the same road your own input takes).
  const act = (match: string, events: Record<string, unknown>[], text?: string) => app.evaluate(async ({ BrowserWindow, webContents }, { match, events, text }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const contents = webContents.getAllWebContents().find((one) => one !== window.webContents && one.getURL().includes(match))!;
    for (const event of events) contents.sendInputEvent(event as never);
    if (text) { await new Promise((done) => setTimeout(done, 150)); await contents.insertText(text); }
  }, { match, events, text });
  const click = (x: number, y: number) => [{ type: "mouseMove", x, y }, { type: "mouseDown", x, y, button: "left", clickCount: 1 }, { type: "mouseUp", x, y, button: "left", clickCount: 1 }];
  const until = async <T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 10000) => {
    const end = Date.now() + ms; let value = await read();
    while (!ok(value) && Date.now() < end) { await new Promise((done) => setTimeout(done, 150)); value = await read(); }
    assert(ok(value), `${what}: ${JSON.stringify(value)}`);
    return value;
  };

  await win.locator("#composer-model").waitFor();
  // The start screen can take a moment to be ready for typing: send again if nothing started.
  for (let tries = 0; tries < 3; tries++) {
    await win.locator("textarea").fill("Check that the admin sign-in works.");
    await win.locator("textarea").press("Enter");
    if (await win.locator("#conversation .turn").first().waitFor({ timeout: 4000 }).then(() => true, () => false)) break;
  }

  // The model opens the page: the window splits, and the page itself sits on the split's page area.
  const split = win.locator("#browser-split");
  await split.waitFor();
  assert(browser.inApp(), "the daemon drives the browser inside the app's window");
  const area = async () => (await split.locator(".bs-view").boundingBox())!;
  const first = await until("the real page is on show", () => real("/admin"), (page) => Boolean(page?.shown));
  let box = await area();
  const near = (a: number, b: number) => Math.abs(a - b) <= 5;
  await until("the page sits on the split's page area", async () => { box = await area(); return real("/admin"); }, (page) => Boolean(page?.shown && near(page.shown.x, box.x) && near(page.shown.y, box.y) && near(page.shown.width, box.width) && near(page.shown.height, box.height)));
  assert.match(await split.locator(".bs-url").inputValue(), /localhost:\d+\/admin/);
  assert.equal(await split.locator(".bs-page").isVisible(), false, "no picture is drawn over the real page");
  assert(first && near((await real("/admin"))!.inner[0]!, box.width), "the page is laid out for the room it has");
  console.log("PASS: when the model starts browsing, the window splits and the real page sits in the split.");

  // The model hands it over: your mouse and keys reach the real page.
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("yours"));
  assert.equal(await split.locator(".bs-foot").isVisible(), false, "no line under the page, and no button to take it or give it back");
  assert.match(await split.locator(".bs-doing").innerText(), /Sign in to the Slow Pour admin, then go back to the chat/);
  await act("/admin", click(56 + 150, 150), "ada@slowpour.test");
  await act("/admin", click(56 + 60, 232));
  await until("your click signed in", () => real("/admin"), (page) => /Signed in as ada@slowpour.test \(1\)/.test(page?.said ?? ""));
  // The wheel scrolls it, as in any browser.
  await act("/admin", [{ type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: -400 }]);
  await until("your wheel scrolled the page", () => real("/admin"), (page) => (page?.inner[3] ?? 0) > 100);
  await act("/admin", [{ type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 4000 }]);
  await until("and back up", () => real("/admin"), (page) => page?.inner[3] === 0);
  // A picture of the whole screen, where there is a tool for it (the window's own picture leaves the real page out).
  const shot = (name: string) => { try { Bun.spawnSync(["import", "-window", "root", join(output, name)], { stderr: "ignore" }); } catch { /* no tool: no picture */ } };
  shot("yours.png");
  // Back to the chat: the page goes back to the model.
  await win.locator("textarea").click();
  console.log("PASS: a page handed to you takes your typing, clicks and wheel directly, and a click in the chat hands it back.");

  // Handed back, the model clicks (its click gets through), and takes a picture of the real page.
  release();
  await win.locator("#conversation .turn").filter({ hasText: "Order #1042 is at the top of Orders" }).waitFor();
  await until("the model's click reached the page", () => real("/admin"), (page) => /\(2\)/.test(page?.said ?? ""));
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("done"));
  // The model's own click did not make the page yours.
  await win.waitForTimeout(600);
  assert.equal(await win.locator("#browser-split.yours").count(), 0, "the model's click does not hand the page to you");
  // Done: no line under the page, no words in the bar; the bar's buttons are all there.
  assert.equal(await split.locator(".bs-foot").isVisible(), false, "no line under the page once the model is done");
  assert.equal(await split.locator(".bs-doing").isVisible(), false, "no words in the bar once the model is done");
  for (const label of ["Back", "Forward", "Reload", "New tab", "Open in your browser", "Close the browser"]) assert.equal(await split.getByRole("button", { name: label, exact: true }).count(), 1, `the bar has ${label}`);
  console.log("PASS: the model's clicks reach the page and leave it the model's.");

  // You scroll it: it is yours, your click counts, and your own address goes where you say.
  // Up, at the top: it does not move the page, but it is still you using it.
  await act("/admin", [{ type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 200 }]);
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("yours"), undefined, { timeout: 5000 });
  assert.match(await split.locator(".bs-doing").innerText(), /Yours · the model waits/);
  await act("/admin", click(56 + 60, 232));
  await until("your click counts once you took the page", () => real("/admin"), (page) => /\(3\)/.test(page?.said ?? ""));
  await split.locator(".bs-url").fill("localhost:" + site.port + "/cart");
  await split.locator(".bs-url").press("Enter");
  await win.waitForFunction(() => /\/cart$/.test((document.querySelector<HTMLInputElement>("#browser-split .bs-url"))?.value ?? ""), undefined, { timeout: 10000 });
  await until("the real page went to the cart", () => real("/cart"), (page) => Boolean(page?.shown && page.title === "Cart"));
  assert.equal(await split.locator(".bs-pages").count(), 0, "no Pages strip under the page");
  // The window changes size: the page follows its place.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1240, 820));
  await win.waitForTimeout(700);
  box = await area();
  await until("the page follows the split when the window changes size", async () => { box = await area(); return real("/cart"); }, (page) => Boolean(page?.shown && near(page.shown.x, box.x) && near(page.shown.width, box.width) && near(page.shown.height, box.height)));
  shot("cart.png");
  // A new tab: the home screen is just the logo, the real page steps aside, and an address opens in a tab of its own.
  await split.getByRole("button", { name: "New tab", exact: true }).click();
  await split.locator(".bs-home svg").waitFor();
  await until("the real page steps aside for the home screen", () => real("/cart"), (page) => Boolean(page && !page.shown));
  assert.equal(await split.locator(".bs-url").inputValue(), "");
  await win.screenshot({ path: join(output, "home.png") });
  await split.locator(".bs-url").fill("localhost:" + site.port + "/admin");
  await split.locator(".bs-url").press("Enter");
  await until("the address opened in a new tab", () => real("/admin"), (page) => Boolean(page?.shown));
  await until("two tabs show as chips", () => split.locator(".bs-tab").count(), (n) => n === 2);
  assert.equal(await split.locator(".bs-home").isVisible(), false, "the home screen goes once you go somewhere");
  await split.locator(".bs-tab", { hasText: "Cart" }).click();
  await until("a chip switches back to the cart", () => real("/cart"), (page) => Boolean(page?.shown));
  // Each tab closes with its own ×.
  await split.locator(".bs-chip:not(.on)").hover();
  await win.screenshot({ path: join(output, "tabs.png"), clip: { x: 760, y: 40, width: 480, height: 100 } });
  await split.locator(".bs-chip:not(.on) .bs-tab-x").click();
  await until("the tab's × closed it", () => real("/admin"), (page) => page === null);
  await until("one tab left, so no chips", () => split.locator(".bs-tab").count(), (n) => n === 0);
  await until("the cart is still on show", () => real("/cart"), (page) => Boolean(page?.shown));
  await win.locator("#conversation").click({ position: { x: 20, y: 20 } });
  await win.waitForFunction(() => !document.querySelector("#browser-split")?.classList.contains("yours"));
  console.log("PASS: a scroll makes the page yours; you can go to your own address, open a new tab from its logo home screen, close it with its ×, and come back.");

  // Find on the page: ⌘F (Ctrl here) pressed on the page opens a thin find bar under the toolbar; it counts, and Esc closes it.
  const mod = process.platform === "darwin" ? "meta" : "control";
  const chord = (key: string) => [{ type: "keyDown", keyCode: key, modifiers: [mod] }, { type: "keyUp", keyCode: key, modifiers: [mod] }];
  await act("/cart", click(400, 400));
  await win.locator("#conversation").click({ position: { x: 20, y: 20 } });
  await win.waitForFunction(() => !document.querySelector("#browser-split")?.classList.contains("yours"));
  const zoomOf = () => app.evaluate(({ BrowserWindow, webContents }) => { const window = BrowserWindow.getAllWindows()[0]!; return webContents.getAllWebContents().find((one) => one !== window.webContents && one.getURL().includes("/cart"))?.getZoomFactor() ?? 0; });
  // (The daemon hears the page went back a moment after the split does.)
  await win.waitForTimeout(800);
  await act("/cart", chord("F"));
  await split.locator(".bs-find-text").waitFor();
  await until("the find field takes your typing", () => win!.evaluate(() => document.activeElement?.className ?? ""), (name) => name === "bs-find-text");
  await win.keyboard.type("yearly");
  await until("the find bar counts the match", () => split.locator(".bs-find-count").innerText(), (words) => words === "1 of 1");
  const below = await area();
  await until("the page moves down for the find bar, not under it", () => real("/cart"), (page) => Boolean(page?.shown && near(page.shown.y, below.y) && near(page.shown.height, below.height)));
  await win.screenshot({ path: join(output, "find.png") });
  await split.locator(".bs-find-text").fill("nowhere at all");
  await until("and says when there is none", () => split.locator(".bs-find-count").innerText(), (words) => words === "No matches");
  await split.locator(".bs-find-text").press("Escape");
  await split.locator(".bs-find").waitFor({ state: "hidden" });
  assert.equal(await win.locator("#browser-split.yours").count(), 0, "finding does not take the page from the model");
  console.log("PASS: ⌘F on the page opens a find bar under the toolbar that counts matches; Esc closes it, and the page stays the model's.");

  // Zoom: ⌘+ on the page zooms it (not the app), a chip says how far, and a click on the chip goes back to 100%.
  const appZoom = await win.evaluate(() => devicePixelRatio);
  await act("/cart", chord("="));
  await until("the page zoomed in", zoomOf, (zoom) => near(zoom * 100, 110));
  await until("the chip says how far", () => split.locator(".bs-zoom").innerText(), (words) => words === "110%");
  assert.equal(await win.evaluate(() => devicePixelRatio), appZoom, "the app itself did not zoom");
  await act("/cart", chord("-"));
  await act("/cart", chord("-"));
  await until("and out", zoomOf, (zoom) => near(zoom * 100, 90));
  await split.locator(".bs-zoom").click();
  await until("the chip goes back to 100%", zoomOf, (zoom) => zoom === 1);
  await split.locator(".bs-zoom").waitFor({ state: "hidden" });
  console.log("PASS: ⌘+ and ⌘− zoom the page, not the app; the chip shows it and takes it back to 100%.");

  // Point at it: the bar's Point button, then a click on the page picks what is under it; it rides with the next message as a chip.
  await split.getByRole("button", { name: "Point at something on the page", exact: true }).click();
  await until("the Point button is on", () => split.locator('[data-go="point"]').getAttribute("aria-pressed"), (on) => on === "true");
  await win.waitForTimeout(300);
  await act("/cart", click(90, 80));
  const chip = win.locator(".point-chip");
  await chip.waitFor();
  assert.match(await chip.innerText(), /Cart heading/);
  assert.match((await chip.getAttribute("title")) ?? "", /On http:\/\/localhost:\d+\/cart/);
  assert.equal(await split.locator('[data-go="point"]').getAttribute("aria-pressed"), "false");
  assert.equal(await win.locator("#browser-split.yours").count(), 0, "pointing does not take the page from the model");
  assert.equal((await real("/cart"))!.title, "Cart", "the click picked; it did not reach the page");
  // The pick carries a picture of the element as drawn (on the chip, small) and what it measures.
  const picture = chip.locator("img.point-pic");
  await until("the chip shows the pick's picture", () => picture.evaluate((img: HTMLImageElement) => img.complete ? img.naturalWidth : 0).catch(() => 0), (wide) => wide > 20);
  assert.match((await chip.getAttribute("title")) ?? "", /selector, measurements and a picture of it go with your message/);
  writeFileSync(join(output, "pointed.png"), Buffer.from(((await picture.getAttribute("src")) ?? "").split(",")[1] ?? "", "base64"));
  await win.screenshot({ path: join(output, "point.png") });
  // Esc stops pointing with nothing picked.
  await split.getByRole("button", { name: "Point at something on the page", exact: true }).click();
  await until("pointing again", () => split.locator('[data-go="point"]').getAttribute("aria-pressed"), (on) => on === "true");
  await act("/cart", [{ type: "keyDown", keyCode: "Escape" }, { type: "keyUp", keyCode: "Escape" }]);
  await until("Esc stops it", () => split.locator('[data-go="point"]').getAttribute("aria-pressed"), (on) => on === "false");
  assert.equal(await win.locator(".point-chip").count(), 1, "nothing more was picked");
  await chip.click();
  await chip.waitFor({ state: "detached" });
  console.log("PASS: Point picks what you click on the page into the next message as a chip, without taking the page; Esc stops it.");

  // A file the page downloads lands in the project's downloads folder, and the bar shows it.
  await app.evaluate(({ BrowserWindow, webContents }, address) => { const window = BrowserWindow.getAllWindows()[0]!; webContents.getAllWebContents().find((one) => one !== window.webContents && one.getURL().includes("/cart"))!.downloadURL(address); }, `${base}/report.csv`);
  const saved = split.locator(".bs-down");
  await saved.waitFor();
  assert.equal(await saved.innerText(), "report.csv");
  assert.match((await saved.getAttribute("title")) ?? "", /report\.csv · 1 KB[\s\S]*\.demesne\/downloads/);
  assert(existsSync(join(f.workspace, ".demesne", "downloads", "report.csv")), "the file is in the project's downloads folder");
  await win.screenshot({ path: join(output, "download.png"), clip: { x: 760, y: 40, width: 480, height: 60 } });
  console.log("PASS: a file the page downloads lands in the project and shows in the bar.");

  // Google refuses sign-in inside an app's browser: its sign-in opens in your own browser instead, and the page stays where it was.
  await app.evaluate(({ shell }) => { const opened: string[] = []; (globalThis as { opened?: string[] }).opened = opened; shell.openExternal = async (url: string) => { opened.push(url); }; });
  const link = await app.evaluate(async ({ BrowserWindow, webContents }) => { const window = BrowserWindow.getAllWindows()[0]!; const contents = webContents.getAllWebContents().find((one) => one !== window.webContents && one.getURL().includes("/cart"))!; return await contents.executeJavaScript("(() => { const r = document.getElementById('google').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()") as number[]; });
  await act("/cart", click(link[0]!, link[1]!));
  const opened = await until("Google's sign-in opened in your own browser", () => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []), (list) => list.length === 1);
  assert.match(opened[0]!, /^https:\/\/accounts\.google\.com\/o\/oauth2/);
  await win.waitForTimeout(500);
  assert.equal((await real("/cart"))?.title, "Cart", "the page did not go to Google's sign-in");
  await win.locator("#conversation").click({ position: { x: 20, y: 20 } });
  await win.waitForTimeout(800);
  console.log("PASS: Google's sign-in opens in your own browser instead of being refused in Demesne's.");

  // Settings over the chat, and ×: the real page is put away, and still there for the model.
  await split.locator(".bs-close").click();
  await split.waitFor({ state: "hidden" });
  const away = await until("× puts the real page away", () => real("/cart"), (page) => Boolean(page && !page.shown));
  assert(away!.inner[0] === 1280, `put away, the page is the model's own width again (${away!.inner[0]})`);
  console.log("PASS: × gives the chat the whole window back, and the page stays open for the model.");
  assert.deepEqual(errors, []);
} catch (error) {
  if (win) await win.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  release();
  await desktop?.close();
  browser.close();
  await f.close();
  site.stop(true);
}
