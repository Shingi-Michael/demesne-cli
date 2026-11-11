/** Real Electron check: while a sub-agent works, the turn stays put, folded
 * or unfolded. Only its row's words and its own guide's new lines change; the
 * turn isn't rebuilt on each of its steps (it flickered).
 * Usage: xvfb-run -a bun scripts/check-agent-steady.ts (after prepare-desktop). */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const prompt = "Ask an agent to look around", task = "Look around", ask = "Read the files one by one";
const READS = 10;
const f = await fixture({
  providerId: "fixture", modelId: "slow",
  async listModels() { return [{ id: "slow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const user = String(messages.findLast(m => m.role === "user")?.content);
    const done = messages.slice(messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "tool").length;
    if (user === prompt) {
      if (done) { yield { type: "text_delta", delta: "The agent looked around." }; yield { type: "finish", reason: "stop" }; return; }
      yield { type: "text_delta", delta: "Sending an agent." };
      yield { type: "tool_call_delta", index: 0, idDelta: "agent-1", nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: task, prompt: ask }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (user === ask) {
      if (done >= READS) { yield { type: "text_delta", delta: "Every file says hello." }; yield { type: "finish", reason: "stop" }; return; }
      await Bun.sleep(350);
      yield { type: "tool_call_delta", index: 0, idDelta: `read-${done}`, nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: `f${done}.txt` }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Ready." }; yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "probe" });
for (let i = 0; i < READS; i++) writeFileSync(join(f.workspace, `f${i}.txt`), `hello ${i}\n`);
const desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
  env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_GLASS: "0", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#app:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator("textarea").fill(prompt); await page.locator("textarea").press("Enter");
  // Sub-agents at work (pass 183 A): one crew line; open, a line for the
  // agent; that line opens its guide.
  const row = page.locator("#conversation .turn:last-of-type .crew-row").last();
  await row.waitFor();
  const newest = () => page.evaluate(() => document.querySelector("#conversation .turn:last-of-type .crew-row .crew-now")?.textContent ?? "");
  await page.waitForFunction(() => /Read f\d/.test(document.querySelector("#conversation .turn:last-of-type .crew-row .crew-now")?.textContent ?? ""));
  // Folded first, then unfolded to watch its steps: count what leaves the
  // turn, and whether the line and the guide are the same nodes throughout.
  const watch = () => page.evaluate(() => {
    const w = window as any, turn = document.querySelector("#conversation .turn:last-of-type")!;
    w.removed = []; w.row = turn.querySelector("button.crew-row"); w.guide = turn.querySelector(".agent-steps");
    w.observer?.disconnect();
    w.observer = new MutationObserver((list) => { for (const m of list) for (const n of m.removedNodes) if (n instanceof HTMLElement) w.removed.push(n.className || n.tagName); });
    w.observer.observe(turn, { childList: true, subtree: true });
  });
  const seen = () => page.evaluate(() => { const w = window as any; return { removed: w.removed as string[], row: w.row?.isConnected as boolean, guide: w.guide ? w.guide.isConnected as boolean : null }; });
  const steps = () => page.evaluate(() => Number(/(\d+) step/.exec(document.querySelector("#conversation .turn:last-of-type .crew-line .meta")?.textContent ?? "")?.[1] ?? 0));
  await watch();
  const first = await newest();
  await page.waitForFunction((was) => { const now = document.querySelector("#conversation .turn:last-of-type .crew-row .crew-now")?.textContent ?? ""; return /Read f\d/.test(now) && now !== was; }, first);
  const second = await newest();
  await page.waitForFunction((was) => (document.querySelector("#conversation .turn:last-of-type .crew-row .crew-now")?.textContent ?? "") !== was, second);
  const folded = await seen();
  await row.click();
  await page.locator(".crew-line", { hasText: task }).last().click();
  await page.locator(".agent-steps").waitFor();
  await page.waitForTimeout(100);
  await watch();
  const openFrom = await steps();
  await page.waitForFunction((n) => document.querySelectorAll(".agent-steps .tool-row.quiet, .agent-steps details.explored").length > 0 && Number(/(\d+) step/.exec(document.querySelector("#conversation .turn:last-of-type .crew-line .meta")?.textContent ?? "")?.[1] ?? 0) >= n + 3, openFrom);
  const open = await seen();
  console.log("folded:", JSON.stringify(folded));
  console.log("open:", JSON.stringify(open));
  const rebuilt = (removed: string[]) => removed.filter((name) => /\b(tool-row|steps|agent-steps|crew-line|crew(?!-)|answer|request)\b/.test(name) && !/\bquiet\b/.test(name));
  assert.equal(folded.row, true, "while folded, the crew line is never rebuilt");
  assert.deepEqual(rebuilt(folded.removed), [], "while folded, nothing in the turn is rebuilt");
  assert.equal(open.row, true, "while open, the crew line is never rebuilt");
  assert.equal(open.guide, true, "while open, the agent's guide is never rebuilt");
  assert.deepEqual(rebuilt(open.removed), [], "while open, nothing in the turn is rebuilt");
  assert.deepEqual(errors, [], "no page errors while the agent works");
  console.log("Agent steady check passed.");
} finally { await desktop.close(); await f.close(); }
