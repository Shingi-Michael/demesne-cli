/** Real Electron check for pass 241 A: built like the mockup. A web app's
 * plans page is mocked on Foundry with two options; the person says "build
 * Yearly first". The chat builds it (the stand-in model writes the file),
 * looks at it through look_at_page, sees the pick drawn by Foundry beside
 * it, records two differences, fixes them, looks again and records a match.
 * Foundry then holds one look-only record: the pick beside the result, and
 * the first look with its two rings, each marked fixed; the chat ends with
 * one chip, "Built like the mockup · matches". Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, "..");
// The daemon in this process draws picks and opens the web page with the real app, off screen.
const binary = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
process.env.DEMESNE_ELECTRON_APP ??= join(root, "apps/desktop/build/app");
// As root (a container) Electron runs only without its sandbox: a wrapper passes the switch.
if (process.getuid?.() === 0) {
  const wrapper = join(mkdtempSync(join(tmpdir(), "demesne-built-")), "electron");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${binary}" --no-sandbox "$@"\n`, { mode: 0o755 });
  process.env.DEMESNE_ELECTRON = wrapper;
} else process.env.DEMESNE_ELECTRON = binary;
const step = async (line: number, check: () => Promise<boolean>, ms = 20000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };

/// Slow Pour's plans page, laid out at fixed places so the stand-in model knows
/// where each piece sits in a 1280px look (pictures are 960 wide: 0.75 a point).
const STYLE = `body{margin:0;background:#f6f2ea;color:#2a2018;font:15px/1.45 Georgia,serif}
.sp{position:relative;width:1184px;height:640px;margin:0 48px}
.sp h1{position:absolute;left:0;top:28px;margin:0;font-size:34px;font-weight:600}
.sw{position:absolute;left:0;top:120px;width:260px;height:48px;display:flex;gap:4px;padding:4px;box-sizing:border-box;border-radius:24px;background:#e6ddcf;font:500 14px/40px system-ui,sans-serif}
.sw span{flex:1;text-align:center;border-radius:20px;color:#6b5a48}.sw span.on{background:#2a2018;color:#f6f2ea}
.sw em{font-style:normal;font-size:11px;margin-left:4px;opacity:.8}
.plans{position:absolute;left:0;top:200px;width:1184px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.plan{height:320px;box-sizing:border-box;padding:28px;border-radius:16px;background:#fffdf8;box-shadow:0 0 0 1px #e2d7c6}
.plan.most{box-shadow:0 0 0 3px #b4532a}
.plan b{display:block;font-size:22px}.plan .price{font-size:30px;margin:18px 0 8px}.plan .tag{display:inline-block;margin-top:14px;padding:2px 10px;border-radius:99px;background:#b4532a;color:#fff;font:600 12px/20px system-ui,sans-serif}`;
const plans = (yearly: boolean, marked: boolean) => `<div class="sp"><h1>Coffee, on your schedule</h1>
<div class="sw"><span${yearly ? "" : ' class="on"'}>Monthly</span><span${yearly ? ' class="on"' : ""}>Yearly<em>2 months free</em></span></div>
<div class="plans"><div class="plan"><b>Weekly</b><div class="price">${yearly ? "$150" : "$15"}</div>One bag a week.</div>
<div class="plan${marked ? " most" : ""}"><b>Daily</b><div class="price">${yearly ? "$290" : "$29"}</div>A bag every few days.${marked ? '<br><span class="tag">Most chosen</span>' : ""}</div>
<div class="plan"><b>Office</b><div class="price">${yearly ? "$590" : "$59"}</div>Five bags for the team.</div></div></div>`;
const project = (yearly: boolean, marked: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Slow Pour plans</title><style>${STYLE}</style></head><body>${plans(yearly, marked)}</body></html>`;
// The mockup draws the page in the project's own look, over the kit's.
const mockup = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script><style>${STYLE}
html,body{background:#f6f2ea!important;color:#2a2018!important;font:15px/1.45 Georgia,serif!important}.sp h1,.plan b,.plan .price{font-family:Georgia,serif}</style></head><body>
<d-compare recommended="Yearly first"><section data-option="Yearly first" note="Opens on the yearly price">${plans(true, true)}</section>
<section data-option="Monthly first" note="As it is now">${plans(false, false)}</section></d-compare></body></html>`;
// The two differences in the first build, in its picture's pixels: the switch, and the Daily plan.
const SWITCH = "33,87,201,42", DAILY = "330,144,290,246";

const f = await fixture({
  providerId: "fixture", modelId: "foundry-built",
  async listModels() { return [{ id: "foundry-built", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const ask = String(messages[at]!.content);
    const tools = messages.slice(at + 1).filter((message) => message.role === "tool");
    const call = (name: string, input: unknown) => [{ type: "tool_call_delta" as const, index: 0, idDelta: `${name}-${at}-${tools.length}`, nameDelta: name, argumentsDelta: JSON.stringify(input) }, { type: "finish" as const, reason: "tool_calls" }];
    const said = (text: string) => [{ type: "text_delta" as const, delta: text }, { type: "finish" as const, reason: "stop" }];
    const picture = () => /Image artifact ([\w-]+): page-look-1\.png/.exec(String(tools.at(-1)?.content))?.[1] ?? "none";
    if (!/build/i.test(ask)) {
      yield* tools.length ? said("Two ways to open the plans page; I'd open on Yearly.") : call("foundry_save", { title: "Plans page", kind: "html", description: "Two ways the plans page could open.", note: "Two openings",
        why: { direction: "Open on the saving.", look_at: "The switch.", starts_from: "new" }, source: mockup, recommended: true });
      return;
    }
    const made = (await f.client.foundryList()).artifacts.find((item) => item.title === "Plans page")!;
    const looks = tools.filter((tool) => String(tool.content).includes("page-look-1.png"));
    switch (tools.length) {
      // Built (the stand-in writes the file a model would), then looked at.
      case 0: writeFileSync(join(f.workspace, "pricing.html"), project(false, false)); yield* call("look_at_page", { url: "pricing.html" }); return;
      case 1: yield* call("foundry_built", { id: made.id, option: "Yearly", picture: picture(), where: "pricing.html" }); return;
      case 2: yield* call("foundry_built", { id: made.id, option: "Yearly", picture: /Image artifact ([\w-]+)/.exec(String(looks[0]!.content))![1], where: "pricing.html",
        differences: [{ box: SWITCH, what: "Opens on Monthly; the pick opens on Yearly, with 2 months free beside it." }, { box: DAILY, what: "Daily is plain; the pick edges it and tags it Most chosen." }] }); return;
      case 3: writeFileSync(join(f.workspace, "pricing.html"), project(true, true)); yield* call("look_at_page", { url: "pricing.html" }); return;
      case 4: yield* call("foundry_built", { id: made.id, option: "Yearly", picture: picture(), where: "pricing.html", differences: [] }); return;
      default: yield* said("Built. The plans page opens on Yearly and Daily is marked as the one most people choose, as in your pick. My first build opened on Monthly and left Daily plain; both are fixed.");
    }
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-built")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  await page.waitForTimeout(800);
  const editor = page.locator("textarea"), chips = page.locator("#conversation .fd-chip");
  const send = async (text: string, chip: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await editor.fill(text); await editor.press("Enter");
      if (await eventually(async () => (await page!.locator("#conversation .request").last().innerText().catch(() => "")).includes(text), 8000).then(() => true, () => false)) break;
    }
    await chips.filter({ hasText: chip }).first().waitFor({ timeout: 60000 }).catch(async (error) => { if (process.env.DEBUG_BUILT) console.error("CONVERSATION", await page!.locator("#conversation").innerText()); throw error; });
  };
  await send("show me the plans page for Slow Pour", "Plans page");
  await send("build Yearly first", "Built like the mockup");
  // The chat ends with one chip for the build: what it is and how it came out.
  const chip = chips.filter({ hasText: "Built like the mockup" }).first();
  assert.match((await chip.innerText()).replace(/\s+/g, " "), /Plans page, built .*Built like the mockup · matches/);
  const record = (await f.client.foundryList()).artifacts.find((item) => item.title === "Plans page, built")!;
  const plansPage = (await f.client.foundryList()).artifacts.find((item) => item.title === "Plans page")!;
  assert.ok(record?.built, "the record is a build's");
  assert.deepEqual(record.basedOn, { id: plansPage.id, version: 1 });
  const detail = await f.client.foundryGet(record.id);
  assert.equal(detail.versions.length, 1, "every look in the build lands on one record");
  assert.equal(detail.versions[0]!.note, "matches");
  assert.equal(detail.shots?.length, 3, "the pick and both looks are kept with the record");
  await page.locator("#conversation .turn").last().screenshot({ path: join(output, "foundry-built-chat.png") });
  await chip.click();
  const item = page.locator(`#page [data-fd="${record.id}:1"]`);
  await item.waitFor();
  assert.match((await item.locator(".fd-ln").innerText()).replace(/\s+/g, " "), /Plans page, built.*Built · /);
  assert.match((await item.locator(".fd-ver").innerText()).replace(/\s+/g, " "), /Built like the mockup · matches from Plans page v1/);
  assert.match(await item.locator(".fd-ask").innerText(), /build Yearly first/);
  assert.equal(await item.locator(".fd-notes").count(), 0, "a record takes no notes");
  const frame = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${record.id}?v=1`))!;
  await step(108, async () => !!frame());
  // The pick (only the Yearly option, drawn by Foundry) beside what was built, both real pictures served from inside the app.
  await step(110, async () => frame().evaluate(() => [...document.querySelectorAll("d-built d-shot img")].filter((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 960 && (image as HTMLImageElement).src.startsWith("foundry://shot/")).length === 3));
  const words = await frame().evaluate(() => (document.querySelector("d-built") as HTMLElement).innerText.replace(/\s+/g, " "));
  assert.match(words, /Yearly first your pick Plans page, v1/);
  assert.match(words, /Built, after its fix pricing\.html matches your pick/);
  assert.match(words, /Built, first look 2 things differed from your pick/);
  assert.match(words, /1 Opens on Monthly.*fixed 2 Daily is plain.*fixed/);
  // The first look's two differences are ringed and numbered where they sit; the fixed result has none.
  const rings = await frame().evaluate(() => [...document.querySelectorAll("d-built d-shot")].map((shot) => [...shot.querySelectorAll(".ds-spot")].map((spot) => spot.getAttribute("data-mark")).join()));
  assert.deepEqual(rings, ["", "", "1,2"]);
  const [x, , w] = SWITCH.split(",").map(Number);
  await step(121, async () => frame().evaluate(([x, w]) => {
    const shots = document.querySelectorAll("d-built d-shot"), shot = shots[2]!.getBoundingClientRect(), ring = shots[2]!.querySelector(".ds-spot")!.getBoundingClientRect(), k = shot.width / 960;
    return shot.width > 300 && Math.abs(ring.left - shot.left - x! * k) < 3 && Math.abs(ring.width - w! * k) < 3;
  }, [x, w]));
  // The pick and the result sit side by side at the same width.
  const sizes = await frame().evaluate(() => [...document.querySelectorAll("d-built > .bt-row:first-child d-shot")].map((shot) => Math.round(shot.getBoundingClientRect().width)));
  assert.equal(sizes.length, 2); assert.ok(Math.abs(sizes[0]! - sizes[1]!) <= 1 && sizes[0]! > 300, `side by side: ${sizes.join(", ")}`);
  // Look only: nothing to press on the record.
  assert.equal(await frame().evaluate(() => document.querySelectorAll("button, a, input, select, textarea").length), 0);
  await page.waitForTimeout(1200);
  await item.scrollIntoViewIfNeeded();
  await item.screenshot({ path: join(output, "foundry-built.png") });
  await page.screenshot({ path: join(output, "foundry-built-window.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: a build is compared with its pick: Foundry keeps the pick beside the result, the first look's differences ringed and fixed, and the chat ends with Built like the mockup · matches.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
