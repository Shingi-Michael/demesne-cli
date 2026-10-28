/** Real Electron check: while the model writes a command, the turn stays put.
 * Only the step's words change; the turn isn't rebuilt (it flickered). */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const f = await fixture({
  providerId: "fixture", modelId: "slow",
  async listModels() { return [{ id: "slow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const done = messages.slice(messages.findLastIndex(m => m.role === "user") + 1).some(m => m.role === "tool");
    if (!done) {
      yield { type: "text_delta", delta: "Let me check." };
      const args = JSON.stringify({ argv: ["git", "log", "--oneline", "-n", "5", "--decorate", "--graph", "--all"] });
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "run-1", nameDelta: "run_command", argumentsDelta: "" };
      for (let i = 0; i < args.length; i += 3) { await Bun.sleep(60); yield { type: "tool_call_delta" as const, index: 0, argumentsDelta: args.slice(i, i + 3) }; }
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Done." }; yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "probe" });
const desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--server=${f.server.url}`],
  env: { ...f.env, DEMESNE_BUN: process.execPath, XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  await page.getByRole("heading", { name: "Make room for your next idea." }).waitFor({ timeout: 30000 });
  await desktop.evaluate(({ dialog }, w) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [w] }); }, f.workspace);
  await page.getByRole("button", { name: "Open a project", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("sidebar-sessions")?.dataset.workspace);
  await page.waitForTimeout(800);
  await page.locator("textarea").fill("look at the log"); await page.locator("textarea").press("Enter");
  await page.locator("#conversation").getByText("Let me check.").waitFor();
  await page.evaluate(() => {
    const w = window as any; w.replaced = 0; w.removed = [];
    // What leaves the conversation while the command is still being written.
    new MutationObserver((list) => {
      const writing = [...document.querySelectorAll(".live-activity")].some((node) => node.textContent?.includes("Writing a command"));
      for (const m of list) for (const n of m.removedNodes) if (n instanceof HTMLElement && writing) w.removed.push(n.className || n.tagName);
    }).observe(document.getElementById("conversation")!, { childList: true, subtree: true });
  });
  await page.waitForTimeout(2500);
  const removed: string[] = await page.evaluate(() => (window as any).removed);
  assert(removed.filter((name) => name === "target").length >= 5, `the command's words grew in place: ${removed.join(", ")}`);
  assert.deepEqual(removed.filter((name) => name !== "target"), [], "nothing else is rebuilt while the command is written");
  console.log("Draft steady check passed.");
} finally { await desktop.close(); await f.close(); }
