/** Real Electron check: while the model works through its checklist
 * (update_plan), the ribbon and the chat's words stay the same nodes: no
 * rebuild on each step, no animation starting over. (Mike: "when the model
 * uses a checklist there is a stutter in the chat and the ribbon".)
 * Usage: xvfb-run -a bun scripts/check-plan-steady.ts (after prepare-desktop). */
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
    const user = String(messages.findLast(m => m.role === "user")?.content);
    if (user !== prompt) { yield { type: "text_delta", delta: "Ready." }; yield { type: "finish", reason: "stop" }; return; }
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
    w.ribbons = new Set(); w.segs = new Set(); w.slides = 0;
    const sample = () => { const r = turn.querySelector(".plan-ribbon"); if (r && !r.classList.contains("ended")) { w.ribbons.add(r); for (const i of r.querySelectorAll(".pr-segs i")) w.segs.add(i); } };
    // Each time the light (re)starts, where it is must follow the clock, so a
    // redraw never sends it back to the start.
    w.phaseOff = [];
    document.addEventListener("animationstart", (event) => {
      if ((event as AnimationEvent).animationName !== "pr-slide") return;
      w.slides++;
      requestAnimationFrame(() => { for (const a of document.getAnimations() as CSSAnimation[]) if (a.animationName === "pr-slide") {
        const phase = ((Number(a.currentTime) - Number(a.effect!.getTiming().delay)) % 1400 + 1400) % 1400, clock = performance.now() % 1400;
        const off = Math.abs(phase - clock); w.phaseOff.push(Math.round(Math.min(off, 1400 - off)));
      } });
    }, true);
    w.jumps = 0; let last = turn.getBoundingClientRect().top;
    const tick = () => { sample(); const top = turn.getBoundingClientRect().top; if (Math.abs(top - last) > 0.5) w.jumps++; last = top; w.frame = requestAnimationFrame(tick); }; tick();
  });
  await page.locator("#conversation .turn:last-of-type").getByText("All done.").waitFor({ timeout: 60000 });
  const seen = await page.evaluate(() => { const w = window as any; cancelAnimationFrame(w.frame); return { ribbons: w.ribbons.size, segments: w.segs.size, slideStarts: w.slides, worstPhaseOff: Math.max(0, ...w.phaseOff), jumps: w.jumps }; });
  console.log(JSON.stringify(seen));
  assert.deepEqual(errors, []);
  if (process.env.REPORT_ONLY) process.exit(0);
  // While it ran (the turn ending may redraw it once, as the ribbon folds into its pill):
  assert.equal(seen.ribbons, 1, `the checklist ribbon was drawn anew ${seen.ribbons - 1} times while the turn worked`);
  assert.equal(seen.segments, STEPS.length, "its segments are the same elements throughout (so they fill rather than snap)");
  assert(seen.worstPhaseOff < 120, `the ribbon's moving light jumped back by up to ${seen.worstPhaseOff}ms when the turn redrew`);
  console.log("Plan steady check passed.");
} finally {
  await desktop.close().catch(() => {});
  await f.close();
}
