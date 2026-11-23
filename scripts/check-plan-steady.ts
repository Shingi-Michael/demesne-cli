/** Real Electron check: while the model works through its checklist
 * (update_plan), the ribbon and the chat's words stay the same nodes: no
 * rebuild on each step, no animation starting over. (Mike: "when the model
 * uses a checklist there is a stutter in the chat and the ribbon".) When the
 * turn ends the same ribbon becomes the pill, which opens the list.
 * Usage: xvfb-run -a bun scripts/check-plan-steady.ts (after prepare-desktop).
 * SHOTS=dir saves pictures of the ribbon running, the pill, and the pill open. */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const prompt = "Work through the checklist";
const STEPS = ["Read the notes", "Check the files", "Write it up", "Wrap up"];
const plan = (at: number) => ({ steps: STEPS.map((step, i) => ({ step, status: i < at ? "completed" : i === at ? "in_progress" : "pending" })) });
// The turn: plan, then per step a read and an updated plan, words between.
const script: Array<[string, unknown] | string> = [["update_plan", plan(0)]];
for (let i = 0; i < STEPS.length; i++) script.push(`Working on step ${i + 1}.`, ["read_file", { path: `f${i}.txt` }], ["update_plan", plan(i + 1)]);
const f = await fixture({
  providerId: "fixture", modelId: "slow",
  async listModels() { return [{ id: "slow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    // The message may carry more than the words typed (context the app adds).
    const said = messages.findLast(m => m.role === "user")?.content;
    if (!(typeof said === "string" ? said : JSON.stringify(said)).includes(prompt)) { yield { type: "text_delta", delta: "Ready." }; yield { type: "finish", reason: "stop" }; return; }
    let at = messages.slice(messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "tool").length;
    // Each round: any words, then one tool call.
    let words = "", n = 0, call: [string, unknown] | undefined;
    for (const item of script) { if (typeof item === "string") { if (n === at) words += item; } else { if (n === at) { call = item; break; } n++; } }
    await Bun.sleep(400);
    if (words) for (const word of words.split(" ")) { yield { type: "text_delta", delta: word + " " }; await Bun.sleep(40); }
    if (!call) { yield { type: "text_delta", delta: "All done." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `call-${at}`, nameDelta: call[0], argumentsDelta: JSON.stringify(call[1]) };
    yield { type: "finish", reason: "tool_calls" };
  },
}, { workspaceName: "probe" });
for (let i = 0; i < STEPS.length; i++) writeFileSync(join(f.workspace, `f${i}.txt`), `hello ${i}\n`);
const desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
  env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_GLASS: "0", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(30000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#app:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator("textarea").fill(prompt); await page.locator("textarea").press("Enter");
  await page.locator("#conversation .turn:last-of-type .plan-ribbon .pr-segs").waitFor();
  await page.evaluate(() => {
    const w = window as any, turn = document.querySelector("#conversation .turn:last-of-type")!;
    // Each distinct ribbon element seen, sampled every frame (a move keeps it).
    w.ribbons = new Set(); w.all = new Set(); w.names = new Set(); w.segs = new Set(); w.slides = 0;
    const sample = () => {
      const r = turn.querySelector(".plan-ribbon"); if (!r) return;
      w.all.add(r);
      if (r.classList.contains("ended")) return;
      w.ribbons.add(r); w.names.add(r.querySelector(".pr-name")); for (const i of r.querySelectorAll(".pr-segs i")) w.segs.add(i);
    };
    // The light round the edge starts once when the ribbon appears, and once
    // more for its last lap. A redraw in between must never start it again.
    // Nothing else moves by itself: the step's name has no shimmer.
    w.shines = 0; w.fills = 0; w.folds = 0;
    document.addEventListener("animationstart", (event) => {
      if ((event as AnimationEvent).animationName === "plan-light") w.slides++;
      if ((event.target as Element).classList.contains("pr-name")) w.shines++;
    }, true);
    // Each part fills (a transition), and the list folds open (another).
    document.addEventListener("transitionrun", (event) => {
      const what = (event as TransitionEvent).propertyName, on = event.target as Element;
      if (what === "background-size" && on.parentElement?.classList.contains("pr-segs")) w.fills++;
      if (what === "grid-template-rows" && on.classList.contains("pr-fold")) w.folds++;
    }, true);
    w.jumps = 0; let last = turn.getBoundingClientRect().top;
    const tick = () => { sample(); const top = turn.getBoundingClientRect().top; if (Math.abs(top - last) > 0.5) w.jumps++; last = top; w.frame = requestAnimationFrame(tick); }; tick();
  });
  const shots = process.env.SHOTS, ribbon = page.locator("#conversation .turn:last-of-type .plan-ribbon");
  if (shots) { await page.locator("#conversation .turn:last-of-type .pr-ct", { hasText: "3 of 4" }).waitFor(); await page.waitForTimeout(250); await page.screenshot({ path: join(shots, "ribbon-running.png") }); }
  await page.locator("#conversation .turn:last-of-type").getByText("All done.").waitFor({ timeout: 60000 });
  const seen = await page.evaluate(() => { const w = window as any; cancelAnimationFrame(w.frame); return { ribbons: w.ribbons.size, all: w.all.size, names: w.names.size, segments: w.segs.size, slideStarts: w.slides, shineStarts: w.shines, fills: w.fills, jumps: w.jumps }; });
  console.log(JSON.stringify(seen));
  assert.deepEqual(errors, []);
  if (process.env.REPORT_ONLY) process.exit(0);
  assert.equal(seen.ribbons, 1, `the checklist ribbon was drawn anew ${seen.ribbons - 1} times while the turn worked`);
  assert.equal(seen.all, 1, "the ribbon that ran is the element that became the pill (so it shrinks rather than being swapped)");
  assert.equal(seen.names, 1, "the step's name is the same element throughout (so it rolls rather than snaps)");
  assert.equal(seen.segments, STEPS.length, "the parts of its line are the same elements throughout (so they fill rather than snap)");
  assert(seen.slideStarts >= 1 && seen.slideStarts <= 2, `the light round the ribbon's edge started ${seen.slideStarts} times (once running, once for its last lap): a redraw started it over`);
  assert.equal(seen.shineStarts, 0, "the step's name does not shimmer: the edge light is the one thing that moves");
  assert.equal(seen.fills, STEPS.length, "each part of the line fills as its step is done, rather than snapping to green");
  // Ended, it is a pill that says how many steps and opens the same list.
  await ribbon.locator(".pr-name", { hasText: `${STEPS.length} steps` }).waitFor();
  assert.match(await ribbon.getAttribute("class") ?? "", /\bended all\b/);
  await page.waitForTimeout(700);
  const pill = await ribbon.locator(".pr-card").boundingBox();
  assert(pill && pill.width < 160 && pill.height < 40, `the ended ribbon is a small pill: ${JSON.stringify(pill)}`);
  if (shots) await page.screenshot({ path: join(shots, "ribbon-pill.png") });
  await ribbon.locator(".pr-bar").click();
  await page.waitForTimeout(700);
  assert.equal(await ribbon.locator(".pr-row.d").count(), STEPS.length, "the open pill lists every step, ticked");
  assert.equal(await page.evaluate(() => (window as any).folds), 1, "the list folds open rather than snapping");
  const open = await ribbon.locator(".pr-card").boundingBox(), last = await ribbon.locator(".pr-row").last().boundingBox();
  assert(open && last && open.height > 120 && last.y + last.height <= open.y + open.height, `the list shows inside the pill: ${JSON.stringify(open)}`);
  if (shots) await page.screenshot({ path: join(shots, "ribbon-pill-open.png") });
  console.log("Plan steady check passed.");
} finally {
  await desktop.close().catch(() => {});
  await f.close();
}
