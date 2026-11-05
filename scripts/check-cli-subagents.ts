/** Sub-agents on your agent tools (pass 162 A) against the real Electron app:
 * a turn sends two sub-agents, Auto runs them on Claude Code and Codex, and
 * each shows as a row with the tool's face, "auto", and what it's on now;
 * the sidebar shows both helping. bun scripts/check-cli-subagents.ts [dir];
 * run bun scripts/prepare-desktop.ts first. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import type { AgentProcess } from "../apps/daemon/src/agent-cli.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/cli-subagents");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");

/// A tool run whose lines arrive slowly, like a real one.
function slowProcess(lines: unknown[], every = 700): AgentProcess {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) {
    let i = 0;
    const next = () => {
      if (i >= lines.length) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(JSON.stringify(lines[i++]) + "\n"));
      timer = setTimeout(next, every);
    };
    timer = setTimeout(next, every);
  } });
  const done = new Promise<number>((resolve) => setTimeout(() => resolve(0), every * (lines.length + 1)));
  return { stdout, stderr: new ReadableStream({ start(c) { c.close(); } }), exited: done, kill() { clearTimeout(timer); } };
}
const claudeLines = (cwd: string) => [
  { type: "system", subtype: "init", session_id: "c1" },
  ...["src/foundry-pane.ts", "src/live.ts", "src/workspace.css", "src/cards.ts", "src/tabs.ts"].map((file) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: join(cwd, file) } }] } })),
  { type: "result", subtype: "success", is_error: false, result: "paneHead() rebuilds the pane, iframe included, on every chat switch (live.ts:2410)." },
];
const codexLines = (cwd: string) => [
  { type: "thread.started", thread_id: "x1" },
  ...["rg -n switchChat", "sed -n 1,80p host.ts", "sed -n 2400,2440p live.ts", "rg -n mountPane", "sed -n 1,60p cards.ts", "sed -n 1,40p tabs.ts", "rg -n paging"].map((command) => ({ type: "item.completed", item: { type: "command_execution", command } })),
  { type: "item.completed", item: { type: "agent_message", text: `switchChat → renderCards → mountPane in ${cwd}; the pane is unmounted first, which is the blank frame.` } },
];

const results = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").length;
const f = await fixture({
  providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages): AsyncGenerator<ProviderStreamEvent> {
    if (!results(messages)) {
      yield { type: "tool_call_delta", index: 0, idDelta: "s1", nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: "Find what redraws the Foundry pane", prompt: "Where is the Foundry pane redrawn?" }) };
      yield { type: "tool_call_delta", index: 1, idDelta: "s2", nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: "Trace a chat switch end to end", prompt: "Trace the flow of a chat switch end to end." }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "A chat switch unmounts the pane and sets its page again, so it reloads." };
    yield { type: "finish", reason: "stop" };
  },
}, { agentCli: {
  which: (command) => command === "claude" || command === "codex" ? `/usr/local/bin/${command}` : null,
  spawn: (argv, cwd) => slowProcess(argv[0]!.endsWith("claude") ? claudeLines(cwd) : codexLines(cwd)),
} });
const browser = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
try {
  const page = await browser.firstWindow();
  await page.setViewportSize({ width: 1180, height: 760 });
  const editor = page.locator("#composer [contenteditable], #composer textarea, [contenteditable='true']").first();
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("Why does the Foundry pane flash when I switch chats?");
  await page.keyboard.press("Enter");
  await page.locator(".agent-now").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2200);
  const faces = await page.locator(".tool-row .step-face").evaluateAll((items) => items.map((item) => item.getAttribute("data-provider")));
  expect(faces.includes("claude") && faces.includes("codex"), `rows wear Claude Code's and Codex's faces (${faces.join(", ")})`);
  expect(await page.locator(".tool-row .auto-chip").count() === 2, "both say auto");
  expect(await page.locator(".agent-now").count() === 2, "each running row says what it's on now");
  const helping = await page.locator(".sidebar-housed-row", { hasText: "helping" }).count();
  expect(helping === 2, `the sidebar shows both helping (${helping})`);
  await page.screenshot({ path: join(output, "running.png") });
  await page.getByText("so it reloads").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(await page.locator(".agent-now").count() === 0, "the now lines go when they finish");
  expect(await page.locator(".sidebar-housed-row", { hasText: "helping" }).count() === 0, "the sidebar stops saying helping");
  await page.locator(".receipt-steps").last().click();
  await page.locator(".steps .tool-row", { hasText: "Codex" }).first().click();
  await page.locator(".agent-why").first().waitFor({ timeout: 5_000 });
  expect((await page.locator(".agent-why").first().innerText()).startsWith("Why Codex:"), "unfolding says why Codex");
  await page.screenshot({ path: join(output, "done-open.png") });
} catch (error) {
  failures.push(String(error));
  console.log("FAIL", error);
} finally {
  await browser.close();
  f.server.stop?.(true);
}
if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
