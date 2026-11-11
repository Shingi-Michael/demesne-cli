/** Deep research (pass 182 A) against the real Electron app: a turn asks the
 * research tool three questions, Claude Code and Codex research at once (one
 * falls back to the chat's model), a judge checks them, and the window shows
 * one quiet line with the faces and a page count that opens to who took what.
 * bun scripts/check-research.ts [dir]; run bun scripts/prepare-desktop.ts first. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import type { AgentProcess } from "../apps/daemon/src/agent-cli.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/research");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");

function slowProcess(lines: unknown[], every = 600, fail = false): AgentProcess {
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
  const done = new Promise<number>((resolve) => setTimeout(() => resolve(fail ? 1 : 0), every * (lines.length + 1)));
  return { stdout, stderr: new ReadableStream({ start(c) { c.close(); } }), exited: done, kill() { clearTimeout(timer); } };
}
const pages = ["https://huggingface.co/Qwen/Qwen3.8-27B", "https://github.com/ggml-org/llama.cpp/discussions/4167", "https://ollama.com/library/qwen3.8", "https://www.reddit.com/r/LocalLLaMA/comments/abc"];
const claudeLines = (question: string) => [
  { type: "system", subtype: "init", session_id: "c1" },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: question.slice(0, 40) } }] } },
  ...pages.map((url) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebFetch", input: { url } }] } })),
  { type: "result", subtype: "success", is_error: false, result: pages.map((url, i) => `- claim ${i} for ${question.slice(0, 30)} — ${url} — "quote"`).join("\n") },
];
const codexLines = [{ type: "thread.started", thread_id: "x1" }, { type: "item.completed", item: { type: "error", message: "usage limit reached" } }];

const system = (messages: ProviderMessage[]) => messages[0]?.role === "system" ? String(messages[0].content) : "";
const results = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").length;
const f = await fixture({
  providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages): AsyncGenerator<ProviderStreamEvent> {
    if (system(messages).startsWith("You are a fair judge")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      yield { type: "text_delta", delta: '{"agree": 9, "disagree": ["Scout speed: 25 vs 40 tokens a second"], "recheck": []}' };
      yield { type: "finish", reason: "stop" }; return;
    }
    if (system(messages).startsWith("You are a careful web researcher")) {
      if (!results(messages)) {
        yield { type: "tool_call_delta", index: 0, idDelta: "w1", nameDelta: "web_fetch", argumentsDelta: JSON.stringify({ url: "http://127.0.0.1:9/nothing" }) };
        yield { type: "finish", reason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: `- people report 20 tok/s — ${pages[3]} — "fast enough"` };
      yield { type: "finish", reason: "stop" }; return;
    }
    if (!results(messages)) {
      yield { type: "tool_call_delta", index: 0, idDelta: "r1", nameDelta: "research", argumentsDelta: JSON.stringify({ topic: "local coding models for a 32 GB Mac", questions: ["Which local models run well on a 32 GB Mac", "How fast is each one at coding tasks", "What people report from daily use"] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Qwen3.8 27B is the best fit for a 32 GB Mac. Sources disagree on Scout's speed." };
    yield { type: "finish", reason: "stop" };
  },
}, { agentCli: {
  which: (command) => command === "claude" || command === "codex" ? `/usr/local/bin/${command}` : null,
  spawn: (argv) => argv[0]!.endsWith("claude") ? slowProcess(claudeLines(argv.at(-1)!.split("\n")[1] ?? "")) : slowProcess(codexLines, 600, true),
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
  await page.keyboard.type("research which local models are best for coding on my 32 GB Mac");
  await page.keyboard.press("Enter");
  const row = page.locator(".research-row").first();
  await row.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1800);
  expect((await row.innerText()).includes("Researching"), "one line says Researching");
  expect(await page.locator(".research-row").count() === 1, "only one line for the whole research");
  await page.screenshot({ path: join(output, "running.png") });
  await page.getByText("Qwen3.8 27B is the best fit").first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(500);
  const done = page.locator(".research-row").first();
  const text = await done.innerText();
  expect(text.includes("Researched") && /\d+ pages/.test(text), `finished line: ${text.replace(/\s+/g, " ")}`);
  const faces = await done.locator(".agent-face").evaluateAll((items) => items.map((item) => item.getAttribute("data-provider")));
  expect(faces.includes("claude"), `faces include Claude Code (${faces.join(", ")})`);
  expect(await done.locator(".ask-d").count() === 1, "the chat's model has the d. face for the question Codex couldn't take");
  await page.screenshot({ path: join(output, "done.png") });
  await done.click();
  await page.locator(".research-lines").first().waitFor({ timeout: 5_000 });
  const lines = await page.locator(".research-lines").first().innerText();
  expect(lines.includes("Claude Code") && lines.includes("Demesne") && lines.includes("How fast is each one"), "opened: who took which question");
  expect(lines.includes("9 claims agree") && lines.includes("1 disagree"), "opened: the judge's check");
  await page.screenshot({ path: join(output, "open.png") });
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
