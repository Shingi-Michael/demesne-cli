/** Real Electron check: the browser split is smooth to use.
 * A scripted model opens a long page whose top bar changes colour on every
 * wheel tick. You take the page and scroll: the check times each tick until
 * the changed bar is drawn in the split, and counts the pictures drawn per
 * second while scrolling without pause. It fails under 20 pictures a second or
 * over 120 ms from tick to picture (it measured 10 a second and 112 ms before
 * the page was sized to the split and paced for use; 30 and about 64 ms after).
 * Run bun scripts/prepare-desktop.ts first (Linux: xvfb-run -a). */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { electronBrowser } from "../apps/daemon/src/browser.ts";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, "..");
const electronBin = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const hostCommand = [electronBin, join(root, "apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
const html = `<!doctype html><meta charset="utf-8"><title>Long</title><body style="margin:0;background:#1d2530;color:#eee;font:20px system-ui"><header id="bar" style="position:sticky;top:0;height:120px;background:#ff0000"></header><script>let n=0;addEventListener("wheel",()=>{bar.style.background=(++n%2)?"#0000ff":"#ff0000"},{passive:true})</script>${Array.from({ length: 300 }, (_, i) => `<div style="padding:18px;margin:10px;background:hsl(${i * 9} 50% 30%);border-radius:10px">Row ${i} ${"lorem ipsum ".repeat(10)}</div>`).join("")}`;
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
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.env.DPR ? [`--force-device-scale-factor=${process.env.DPR}`] : []), `--user-data-dir=${join(f.root, "electron-browser-scroll")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
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
  await win.waitForTimeout(1500);
  await win.evaluate(() => {
    const w = window as any; w.__m = { draws: [] as number[], wheels: [] as number[], flips: [] as number[], way: [] as number[], last: "" };
    const orig = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
      (orig as any).apply(this, args);
      if (!this.canvas.classList.contains("bs-page")) return;
      const now = performance.now(); w.__m.draws.push(now);
      const [r, , b] = this.getImageData(Math.floor(this.canvas.width / 2), 20, 1, 1).data;
      const colour = r! > b! ? "red" : "blue";
      if (colour !== w.__m.last) { if (w.__m.last) { w.__m.flips.push(now); w.__m.way.push(Math.round(performance.timeOrigin + now - (w.__at ?? 0))); } w.__m.last = colour; }
    } as any;
    document.querySelector("#browser-split .bs-view")!.addEventListener("wheel", () => w.__m.wheels.push(performance.now()), { capture: true });
  });
  await win.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  // Latency: single wheel ticks, spaced out; the page's bar changes colour on each.
  for (let i = 0; i < 12; i++) { await win.mouse.wheel(0, 100); await win.waitForTimeout(700); }
  const lat = await win.evaluate(() => { const m = (window as any).__m; const out: number[] = []; for (const t of m.wheels) { const f = m.flips.find((x: number) => x > t); if (f) out.push(Math.round(f - t)); } return out; });
  // Rate: continuous scrolling for 3 s.
  await win.evaluate(() => { (window as any).__m.draws = []; });
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) { await win.mouse.wheel(0, 60); await win.waitForTimeout(16); }
  const draws = await win.evaluate(() => (window as any).__m.draws.length);
  console.log("latency ms", lat.join(" "), "| median", [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)]);
  console.log("host→screen ms", (await win.evaluate(() => (window as any).__m.way)).join(" "));
  console.log("picture", await win.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>("#browser-split .bs-page")!; return `${c.width}x${c.height} px shown ${c.clientWidth} wide at ${devicePixelRatio}x`; }));
  console.log("pictures/s while scrolling", (draws / 3).toFixed(1));
  const median = [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)]!;
  assert(lat.length >= 8, `enough ticks were seen on the page (${lat.length})`);
  assert(draws / 3 >= 20, `at least 20 pictures a second while scrolling (${(draws / 3).toFixed(1)})`);
  assert(median <= 120, `a tick shows within 120 ms (${median})`);
  console.log("PASS: the page keeps up while you scroll it.");
} finally {
  await desktop?.close();
  browser.close();
  await f.close();
  site.stop(true);
}
