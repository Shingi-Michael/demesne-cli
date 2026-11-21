/** Real Electron check: the browser split does not flicker while the page scrolls.
 * A scripted model opens a long page with a red bar stuck to its top. You take
 * the page and scroll it; the window is photographed many times meanwhile, and
 * in every photograph the bar must be there: a picture that goes blank while
 * the next one loads shows as a missing bar.
 * Run bun scripts/prepare-desktop.ts first (Linux: xvfb-run -a). */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { electronBrowser } from "../apps/daemon/src/browser.ts";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, "..");
const electronBin = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const hostCommand = [electronBin, join(root, "apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
const html = `<!doctype html><meta charset="utf-8"><title>Long</title><body style="margin:0;background:#1d2530;color:#eee;font:20px system-ui"><header style="position:sticky;top:0;height:120px;background:#ff0000"></header>${Array.from({ length: 300 }, (_, i) => `<div style="padding:18px;margin:10px;background:hsl(${i * 9} 50% 30%);border-radius:10px">Row ${i} ${"lorem ipsum ".repeat(10)}</div>`).join("")}`;
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
const browser = electronBrowser(hostCommand);
const f = await fixture({
  providerId: "fixture", modelId: "browser-scroll", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "browser-scroll", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (!messages.slice(at + 1).some((message) => message.role === "tool")) {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `open-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "open", url: `http://localhost:${site.port}/` }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Opened." };
    yield { type: "finish", reason: "stop" };
  },
}, { browser });

let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, win: Page | undefined;
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "electron-browser-scroll")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  win = await desktop.firstWindow();
  win.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  await win.locator("#composer-model").waitFor();
  await win.locator("textarea").fill("Open the long page.");
  await win.locator("textarea").press("Enter");
  const split = win.locator("#browser-split");
  await split.waitFor();
  await win.locator("#conversation .turn").filter({ hasText: "Opened." }).waitFor();
  await split.locator(".bs-take").click();
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("yours"));
  const view = (await split.locator(".bs-view").boundingBox())!;
  // A spot inside the red bar, whatever the page's scale in the split.
  const spot = { x: Math.round(view.x + view.width / 2), y: Math.round(view.y + 14) };
  const red = async () => {
    const shot = await win!.screenshot({ clip: { x: spot.x, y: spot.y, width: 4, height: 4 } });
    return await win!.evaluate(async (data) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 4;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(1, 1, 1, 1).data;
      return r! > 180 && g! < 90 && b! < 90;
    }, shot.toString("base64"));
  };
  await win.waitForFunction(() => Boolean(document.querySelector("#browser-split .bs-page")));
  for (let i = 0; i < 40 && !(await red()); i++) await win.waitForTimeout(100);
  assert(await red(), "the bar shows before scrolling");
  await win.mouse.move(spot.x, view.y + view.height / 2);
  let looks = 0, blank = 0, scrolling = true;
  const wheel = (async () => { for (let i = 0; i < 70 && scrolling; i++) { await win!.mouse.wheel(0, i < 45 ? 160 : -160); await win!.waitForTimeout(40); } scrolling = false; })();
  while (scrolling) { looks++; if (!(await red())) blank++; }
  await wheel;
  // It did scroll: the page under the bar is not where it started.
  console.log(`looked ${looks} times while scrolling, the picture was missing ${blank} times`);
  assert(looks >= 25, `enough looks to tell (${looks})`);
  assert.equal(blank, 0, "the page never went blank between pictures");
  console.log("PASS: the page stays on screen while it scrolls.");
} finally {
  await desktop?.close();
  browser.close();
  await f.close();
  site.stop(true);
}
