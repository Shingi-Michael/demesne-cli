/** Real Electron check: while a turn works, the light on the panel's rim runs
 * without painting the panel again. The light used to be a gradient whose
 * angle moved, which repainted the whole chat on every frame; on a see-through
 * window that showed as the chat flickering for as long as a model ran.
 * Usage: xvfb-run -a bun scripts/check-rim-steady.ts (after prepare-desktop). */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const f = await fixture({
  providerId: "fixture", modelId: "slow",
  async listModels() { return [{ id: "slow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream() {
    // A long quiet stretch: the model is working and nothing else on the page moves.
    yield { type: "text_delta", delta: "Working on it. " };
    await Bun.sleep(6000);
    yield { type: "text_delta", delta: "Done." };
    yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "probe" });
const desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
  env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_GLASS: "0", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(30000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#app:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator("textarea").fill("Take your time"); await page.locator("textarea").press("Enter");
  await page.locator("#app.rim-work").waitFor();
  await page.waitForTimeout(1200);
  const rim = await page.evaluate(() => {
    const panel = document.getElementById("app")!.getBoundingClientRect();
    const all = document.getAnimations().filter((a) => a.playState === "running").map((a) => {
      const effect = a.effect as KeyframeEffect, target = effect.target as HTMLElement | null, box = target?.getBoundingClientRect();
      const props = [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key));
      return { name: (a as CSSAnimation).animationName ?? "", on: `${target?.id ? `#${target.id}` : target?.className ?? ""}${effect.pseudoElement ?? ""}`, area: (box?.width ?? 0) * (box?.height ?? 0), props };
    });
    const light = document.querySelector<HTMLElement>("#app > .rim-light > i");
    return { panel: panel.width * panel.height, all, lit: Boolean(light && getComputedStyle(light.parentElement!).opacity !== "0" && getComputedStyle(light).backgroundImage.includes("conic-gradient")) };
  });
  assert.ok(rim.lit, "the rim's light shows while the turn works");
  const turning = rim.all.find((a) => a.name === "rim-turn");
  assert.ok(turning, "the light moves");
  // Anything that animates over a large part of the panel may only move or fade.
  const heavy = rim.all.filter((a) => a.area > rim.panel / 4 && a.props.some((prop) => prop !== "transform" && prop !== "opacity"));
  assert.deepEqual(heavy, [], "no large animation changes anything but transform or opacity");
  // And the proof: count what the renderer paints while only the light moves.
  const cdp = await page.context().newCDPSession(page);
  const events: { name: string; args?: { data?: { clip?: number[]; nodeName?: string } } }[] = [];
  cdp.on("Tracing.dataCollected", (data: { value: typeof events }) => { events.push(...data.value); });
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline"] } });
  const SECONDS = 3;
  await page.waitForTimeout(SECONDS * 1000);
  assert.ok(await page.locator("#app.rim-work").count(), "the turn is still working while paints are counted");
  const ended = new Promise<void>((done) => cdp.once("Tracing.tracingComplete", () => done()));
  await cdp.send("Tracing.end"); await ended;
  const area = (clip?: number[]) => { if (!clip || clip.length < 8) return 0; const xs = [clip[0]!, clip[2]!, clip[4]!, clip[6]!], ys = [clip[1]!, clip[3]!, clip[5]!, clip[7]!]; return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)); };
  // A paint names the layer it redraws. The page's own root layer is redrawn
  // for small things too (the sidebar's ring), so it does not count here: what
  // must not happen is a layer the size of the panel painted again and again.
  const paints = events.filter((event) => event.name === "Paint");
  const large = paints.filter((event) => event.args?.data?.nodeName !== "#document" && area(event.args?.data?.clip) > rim.panel / 2);
  console.log(`paints: ${(paints.length / SECONDS).toFixed(1)}/s; of a layer over half the panel: ${(large.length / SECONDS).toFixed(1)}/s${large.length ? ` (${large[0]!.args?.data?.nodeName})` : ""}`);
  assert.ok(paints.length > 0, "the trace saw the page paint");
  assert.ok(large.length / SECONDS < 5, `the panel is not painted again while the light runs (${(large.length / SECONDS).toFixed(1)} large paints a second)`);
  await page.screenshot({ path: process.env.SHOT ?? "/dev/null" }).catch(() => {});
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS: the rim's light runs without repainting the chat.");
} finally { await desktop.close().catch(() => {}); await f.close?.(); }
process.exit(0);
