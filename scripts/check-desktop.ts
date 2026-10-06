/** Real Linux WebKitGTK smoke test; all app actions use normal WebDriver input. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture } from "../apps/graphics/test/fixture.ts";

if (process.platform !== "linux") {
  console.error("desktop:check uses Linux WebKitWebDriver. Run it in a Linux desktop or under dbus-run-session + xvfb-run; macOS requires native app validation.");
  process.exit(1);
}
const args = process.argv.slice(2).filter(arg => arg !== "--");
const application = resolve(args[0] ?? "apps/desktop/src-tauri/target/debug/demesne-desktop");
assert(existsSync(application), `Build the test executable first: bun run build:desktop -- --debug --no-bundle\nMissing: ${application}`);
assert(Bun.which("tauri-driver"), "Install the native bridge with cargo install tauri-driver --locked");
assert(Bun.which("WebKitWebDriver"), "Install webkit2gtk-driver before running desktop:check");
assert(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "A graphical session is required. In CI use dbus-run-session -- xvfb-run -a bun run desktop:check");
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
const prompt = "Desktop smoke: update hello.ts and run its check";
const followUp = "Desktop smoke: continue while the window is closed";
const completed = "Verified the desktop change.";
const afterClose = "Daemon work completed after the window closed.";
let round = 0, release: (() => void) | undefined;
const gate = new Promise<void>(done => { release = done; });
const f = await fixture({
  providerId: "test", modelId: "desktop-test", contextCapacity: 262144,
  async listModels() { return [{ id: "desktop-test", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages, _tools, signal) {
    const user = messages.findLast(message => message.role === "user")?.content;
    if (user === followUp) {
      yield { type: "text_delta", delta: "The daemon is still working.\n\n" };
      await gate;
      if (signal.aborted) throw signal.reason;
      yield { type: "text_delta", delta: afterClose };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user !== prompt) {
      // NEXT can ask this processor for proposals independently of the coder.
      yield { type: "text_delta", delta: "{\"proposals\":[]}" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    const operation = [
      { name: "edit_file", input: { path: "hello.ts", edits: [{ oldText: "'before'", newText: "'after'" }] } },
      { name: "run_command", input: { argv: [process.execPath, "run", "check"] } },
    ][round++];
    if (operation) {
      yield { type: "tool_call_delta", index: 0, idDelta: `desktop-operation-${round}`, nameDelta: operation.name, argumentsDelta: JSON.stringify(operation.input) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: `${completed}\n\n**Results**\n- Updated \`hello.ts\`.\n- Check passed.\n\nMath: $x^2 + y^2 = r^2$.\n\n\`\`\`typescript\nexport const greeting = 'after';\n\`\`\`\n` };
      yield { type: "finish", reason: "stop" };
    }
  },
});
writeFileSync(join(f.workspace, "hello.ts"), "export const greeting = 'before';\n");
writeFileSync(join(f.workspace, "package.json"), JSON.stringify({ scripts: { check: "bun check.ts" } }));
writeFileSync(join(f.workspace, "check.ts"), "import {readFileSync} from 'node:fs';if(!readFileSync('hello.ts','utf8').includes(\"'after'\"))throw new Error('Wrong file');console.log('DESKTOP_CHECK_PASSED');\n");
const git = (...values: string[]) => execFileSync("git", ["-C", f.workspace, ...values], { stdio: "pipe" });
git("init", "-q"); git("add", ".");
git("-c", "user.name=Desktop Test", "-c", "user.email=test@example.com", "commit", "-qm", "Fixture baseline");

// Reserve two ephemeral loopback ports before spawning this test's driver.
// tauri-driver itself binds loopback. Never attach to an existing automation service.
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
const nativeReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
const port = reservation.port, nativePort = nativeReservation.port;
await reservation.stop(true); await nativeReservation.stop(true);
const endpoint = `http://127.0.0.1:${port}`;
const driver = Bun.spawn(["tauri-driver", "--port", String(port), "--native-port", String(nativePort)], {
  env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
let log = "", session = "";
async function collect(stream: ReadableStream<Uint8Array>) {
  for await (const bytes of stream) log = (log + new TextDecoder().decode(bytes)).slice(-64 * 1024);
}
const collectors = [collect(driver.stdout), collect(driver.stderr)];
async function request<T = unknown>(method: string, path: string, body?: unknown, timeout = 20_000): Promise<T> {
  const response = await fetch(endpoint + path, {
    method, headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json() as { value: T & { error?: string; message?: string } };
  if (!response.ok || result.value?.error) throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
async function until<T>(check: () => Promise<T>, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    if (driver.exitCode !== null) throw new Error(`WebDriver exited (${driver.exitCode}): ${log}`);
    await Bun.sleep(100);
  }
  throw new Error(`${label} did not settle: ${String(lastError ?? "condition false")}\n${log}`);
}
const evaluate = <T = unknown>(script: string, values: unknown[] = []) => request<T>("POST", `/session/${session}/execute/sync`, { script, args: values });
interface ElementReference { "element-6066-11e4-a52e-4f735466cecf": string }
const elementId = (element: ElementReference) => element["element-6066-11e4-a52e-4f735466cecf"];
async function find(selector: string): Promise<ElementReference> {
  return request("POST", `/session/${session}/element`, { using: "css selector", value: selector });
}
async function click(action: string, expected: Record<string, unknown> = {}) {
  await until(async () => {
    const element = await evaluate<ElementReference | null>(`
      return Array.from(document.querySelectorAll('button[data-action]')).find(element => {
        if (element.dataset.action !== arguments[0] || element.disabled || !element.getBoundingClientRect().width) return false;
        const data = JSON.parse(element.dataset.args || '{}');
        return Object.entries(arguments[1]).every(([key,value]) => data[key] === value);
      }) || null;`, [action, expected]);
    if (!element) return false;
    await request("POST", `/session/${session}/element/${elementId(element)}/click`, {});
    return true;
  }, `click ${action} ${JSON.stringify(expected)}`);
}
async function type(text: string) {
  const editor = await find("textarea");
  await request("POST", `/session/${session}/element/${elementId(editor)}/value`, { text, value: Array.from(text) });
  await request("POST", `/session/${session}/element/${elementId(editor)}/value`, { text: "\uE007", value: ["\uE007"] });
}
async function textIncludes(text: string) {
  return until(() => evaluate<boolean>("return document.body.innerText.includes(arguments[0]);", [text]), `visible text ${text}`);
}
async function capture(name: string) {
  const encoded = await request<string>("GET", `/session/${session}/screenshot`);
  const bytes = Buffer.from(encoded, "base64"), metadata = await sharp(bytes).metadata(), statistics = await sharp(bytes).stats();
  assert(metadata.width && metadata.width >= 900 && metadata.height && metadata.height >= 500, "Desktop capture has the expected usable viewport");
  assert(statistics.channels.slice(0, 3).some(channel => channel.stdev > 5), "Desktop capture contains rendered content rather than a blank surface");
  writeFileSync(join(output, `${name}.png`), bytes);
}
async function open(workspace = false) {
  const result = await request<{ sessionId: string }>("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application, args: [...(workspace ? [`--workspace=${f.workspace}`] : []), `--server=${f.server.url}`] } } },
  }, 45_000);
  session = result.sessionId;
  assert(session, "WebDriver created a desktop application session");
  await request("POST", `/session/${session}/window/rect`, { width: 1280, height: 900 });
  await until(() => evaluate<boolean>("const editor=document.querySelector('textarea');return !!editor && editor.getBoundingClientRect().width>0 && document.body.innerText.includes('desktop-test');"), "connected desktop project", 30_000);
  assert.equal(await evaluate("return document.getElementById('desktop-project-path')?.textContent;"), f.workspace);
}
async function close() {
  if (!session) return;
  const closing = session; session = "";
  // Closing the native window exercises normal application lifecycle. WebKit
  // may delete its session when the last window closes, so DELETE can then 404.
  await request("DELETE", `/session/${closing}/window`, undefined, 10_000);
  try { await request("DELETE", `/session/${closing}`, undefined, 3000); }
  catch (error) { if (!/invalid session id|no such window/i.test(String(error))) throw error; }
}
let sessionId = "";
try {
  await until(async () => { const value = await request<{ ready: boolean }>("GET", "/status", undefined, 1000); return value.ready; }, "native WebDriver ready", 15_000);
  await open(true);
  await capture("01-start");
  await type(prompt);
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('.approval-card .approval-title')).some(element => element.textContent.includes(arguments[0]));", ["edit_file"]), "file approval visible");
  await click("permission", { decision: "allow_once" });
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('.approval-card .approval-title')).some(element => element.textContent.includes(arguments[0]));", ["Allow this command?"]), "command approval visible");
  assert(await evaluate<boolean>("const details = document.querySelector('.approval-card .approval-details'); return !!details && !details.open;"), "Command details start collapsed");
  const commandDetails = await find(".approval-card .approval-details > summary");
  await request("POST", `/session/${session}/element/${elementId(commandDetails)}/click`, {});
  await until(() => evaluate<boolean>("const details = document.querySelector('.approval-card .approval-details'); return !!details?.open && details.innerText.includes('run check');"), "command details can be inspected");
  await capture("02-command-approval");
  await click("permission", { decision: "allow_once" });
  await textIncludes(completed);
  assert.equal(readFileSync(join(f.workspace, "hello.ts"), "utf8"), "export const greeting = 'after';\n");
  const sessions = await f.client.listSessions();
  const completedSession = sessions.find(item => item.turns.some(turn => turn.content === prompt));
  assert(completedSession, "The desktop submitted its turn to the real daemon");
  sessionId = completedSession.id;
  assert.equal(completedSession.turns.at(-1)?.status, "completed");
  const commands = await f.client.commands(sessionId);
  assert(commands.commands.some(command => command.status === "completed" && command.exitCode === 0 && command.stdout.includes("DESKTOP_CHECK_PASSED")), "Approved command output was recorded");
  assert(await evaluate<boolean>("return !!document.querySelector('.katex') && !!document.querySelector('pre code');"), "Markdown, code and math rendered in WebKit");
  await capture("02-completed");
  await click("panel", { name: "changes" });
  await textIncludes("hello.ts");
  await until(() => evaluate<boolean>("return document.getElementById('panel')?.innerText.includes('after');"), "recorded diff visible");
  await capture("03-changes");
  await click("panel", { name: "history" });
  await textIncludes("TURNS");
  await capture("04-history");
  await close();
  assert.equal((await f.client.health()).model, "desktop-test", "Closing the app leaves the daemon alive");
  await open(); // No workspace/session args: private preferences must restore both.
  await textIncludes(completed);
  const preferences = JSON.parse(readFileSync(join(f.home, ".demesne/desktop-ui.json"), "utf8"));
  assert.equal(preferences.lastWorkspace, f.workspace);
  await capture("05-restored");
  await type(followUp);
  await textIncludes("The daemon is still working.");
  await until(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "running", "daemon turn running");
  await close();
  release!();
  await until(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "completed", "daemon completes after window closes");
  await open();
  await textIncludes(afterClose);
  await capture("06-work-survived-close");
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["native WebKit rendering", "composer submission", "file and command approvals", "actual edit and successful check", "Markdown/code/math", "changes and history panels", "persisted project/session restore", "daemon work survives app closure"] }, null, 2));
  writeFileSync(join(output, "result.json"), JSON.stringify({ result: "passed", platform: process.platform, application, sessionId }, null, 2));
} catch (error) {
  if (session) {
    try { writeFileSync(join(output, "failure.txt"), await evaluate<string>("return document.body.innerText;")); await capture("failure"); } catch {}
  }
  throw error;
} finally {
  release?.();
  try { await close(); } catch {}
  driver.kill("SIGTERM");
  await Promise.race([driver.exited, Bun.sleep(5000)]);
  if (driver.exitCode === null) { driver.kill("SIGKILL"); await driver.exited; }
  await Promise.allSettled(collectors);
  writeFileSync(join(output, "webdriver.log"), log);
  await f.close();
}
