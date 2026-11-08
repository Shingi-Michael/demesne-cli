/** Sub-agents that stay (pass 190 A) against the real Electron app: the chat
 * starts Codex and Claude Code in the background and keeps reading itself,
 * the crew line stays live above its own steps, Codex reports and is asked a
 * follow-up (pink "→ asked: …"), and Stop on Claude Code's line stops it.
 * bun scripts/check-background-agents.ts [dir]; run bun scripts/prepare-desktop.ts first. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import type { AgentProcess } from "../apps/daemon/src/agent-cli.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/background-agents");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");

function slowProcess(lines: unknown[], every = 700): AgentProcess {
  let timer: ReturnType<typeof setTimeout> | undefined, end: (code: number) => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({ start(controller) {
    let i = 0;
    const next = () => {
      if (i >= lines.length) { controller.close(); end(0); return; }
      controller.enqueue(new TextEncoder().encode(JSON.stringify(lines[i++]) + "\n"));
      timer = setTimeout(next, every);
    };
    timer = setTimeout(next, every);
  } });
  const exited = new Promise<number>((resolve) => { end = resolve; });
  return { stdout, stderr: new ReadableStream({ start(c) { c.close(); } }), exited, kill() { clearTimeout(timer); end(143); } };
}
const codex = (commands: string[], answer: string) => [
  { type: "thread.started", thread_id: "x1" },
  ...commands.map((command) => ({ type: "item.completed", item: { type: "command_execution", command } })),
  { type: "item.completed", item: { type: "agent_message", text: answer } },
];
const claude = (cwd: string) => [
  { type: "system", subtype: "init", session_id: "c1" },
  ...Array.from({ length: 40 }, (_, i) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: join(cwd, `web/checkout-${i}.tsx`) } }] } })),
  { type: "result", subtype: "success", is_error: false, result: "The page waits on POST /checkout." },
];

const toolResults = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));
const call = (index: number, id: string, name: string, args: unknown): ProviderStreamEvent => ({ type: "tool_call_delta", index, idDelta: id, nameDelta: name, argumentsDelta: JSON.stringify(args) });
const f = await fixture({
  providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages): AsyncGenerator<ProviderStreamEvent> {
    const results = toolResults(messages), n = results.length;
    if (n === 0) {
      yield call(0, "s1", "subagent", { description: "Trace the checkout API", prompt: "Trace POST /checkout down to the database.", background: true });
      yield call(1, "s2", "subagent", { description: "Profile the checkout page", prompt: "Profile the checkout page in the browser code.", background: true });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    // The chat reads code itself while they work.
    if (n === 2) { yield call(0, "r1", "list_files", { path: "." }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (n === 3) { yield call(0, "r2", "read_file", { path: "api/checkout.ts" }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (n === 4) { yield call(0, "w1", "agents", { action: "wait", ids: ["a1"] }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (n === 5) { yield call(0, "m1", "agents", { action: "message", id: "a1", message: "Does orders.user_id have an index?" }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (n === 6) { yield call(0, "w2", "agents", { action: "wait", ids: ["a1"] }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (n === 7) { yield call(0, "w3", "agents", { action: "wait", ids: ["a2"] }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: "Checkout is slow because orders by user_id takes 1.8 s: there's no index on that column." };
    yield { type: "finish", reason: "stop" };
  },
}, { agentCli: {
  which: (command) => command === "claude" || command === "codex" ? `/usr/local/bin/${command}` : null,
  spawn: (argv, cwd) => {
    if (argv[0]!.endsWith("claude")) return slowProcess(claude(cwd));
    return argv.some((arg) => arg.includes("Follow-up from the main agent"))
      ? slowProcess(codex(["rg -n user_id db/schema.sql", "sed -n 1,60p db/schema.sql"], "No index on orders.user_id. Adding one should bring it under 50 ms."))
      : slowProcess(codex(["sed -n 1,80p api/checkout.ts", "rg -n byUser db", "sed -n 1,40p db/queries/orders.ts"], "POST /checkout spends 1.8 s in one query: orders by user_id."));
  },
} });
mkdirSync(join(f.workspace, "api"), { recursive: true });
writeFileSync(join(f.workspace, "api/checkout.ts"), "export const checkout = () => db.orders.byUser();\n");
const browser = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
try {
  const page = await browser.firstWindow();
  await page.setViewportSize({ width: 1180, height: 760 });
  const editor = page.locator("#composer [contenteditable], #composer textarea, [contenteditable='true']").first();
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("why is checkout slow?");
  await page.keyboard.press("Enter");
  const crew = page.locator(".crew-row").last();
  await crew.waitFor({ timeout: 20_000 });
  expect((await crew.innerText()).includes("2 agents working"), "it says 2 agents working");
  // The chat's own steps come under the crew line while it stays live.
  await page.getByText("Explored").first().waitFor({ timeout: 20_000 });
  expect((await crew.getAttribute("class"))?.includes("running") === true, "the crew line is still working while the chat reads");
  const crewBox = await crew.boundingBox(), readBox = await page.getByText("Explored").first().boundingBox();
  const above = Boolean(crewBox && readBox && crewBox.y < readBox.y);
  expect(above, "the crew line sits above the chat's own steps");
  await page.getByText("Waiting for Codex").first().waitFor({ timeout: 20_000 }).then(() => expect(true, "the working line says Waiting for Codex"), () => expect(false, "the working line says Waiting for Codex"));
  await page.screenshot({ path: join(output, "1-working.png") });
  await crew.click();
  // Codex reports, then gets a follow-up in pink.
  const asked = page.locator(".crew-asked").first();
  await asked.waitFor({ timeout: 20_000 });
  expect((await asked.innerText()).includes("→ asked: Does orders.user_id have an index?"), "the follow-up shows under Codex");
  await page.screenshot({ path: join(output, "2-asked.png") });
  // Stop on Claude Code's line.
  const claudeLine = page.locator(".crew-line", { hasText: "Profile the checkout page" }).first();
  await claudeLine.hover();
  const stop = claudeLine.locator(".crew-stop");
  expect(await stop.isVisible(), "hovering a working agent shows Stop");
  await stop.click();
  await page.locator(".crew-task.struck").first().waitFor({ timeout: 10_000 });
  expect(true, "Stop strikes its task through");
  await page.getByText("there's no index on that column").first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(600);
  const steps = page.locator(".receipt-steps").last();
  if (await steps.count()) await steps.click();
  const done = page.locator(".crew-row").last();
  const text = await done.innerText();
  expect(!(await done.getAttribute("class"))?.includes("running"), `the line stops working when the answer is written (${text.replace(/\s+/g, " ")})`);
  if (!(await page.locator(".crew-lines").count())) await done.click();
  await page.locator(".crew-said").first().waitFor({ timeout: 5_000 }).catch(() => {});
  const said = await page.locator(".crew-said").allInnerTexts();
  expect(said.some((line) => line.includes("No index on orders.user_id")), "Codex's line ends with its follow-up answer");
  expect(text.includes("Codex found it"), "only Codex is said to have found it");
  expect(await page.locator(".tool-row", { hasText: "agents agents" }).count() === 0, "the chat's own agents calls have no rows of their own");
  await page.screenshot({ path: join(output, "3-done.png") });
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
