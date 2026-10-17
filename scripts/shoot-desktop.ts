/** Capture the real Electron app against an isolated deterministic daemon.
 * bun scripts/shoot-desktop.ts [dir]; --readme updates the published images.
 * Run bun scripts/prepare-desktop.ts first.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fixture } from "../apps/graphics/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop"), graphics = join(root, "apps/graphics");
const readme = process.argv.includes("--readme");
const output = readme ? join(root, "docs/assets") : resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "test-results/shots");
const { _electron: electron } = await import("playwright");
mkdirSync(output, { recursive: true });

const prompt = "Make the greeting configurable and check it";
// A fixed, readable project path for the published images.
const demoRoot = join(tmpdir(), "demesne-demo");
if (readme) rmSync(demoRoot, { recursive: true, force: true });
let round = 0;
const f = await fixture({
  providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }, { id: "llama4-scout", provider: "test", contextWindow: 131072 }]; },
  async *stream(messages, tools) {
    if (tools?.some(tool => tool.name === "propose_next")) {
      const { signals } = JSON.parse(String(messages.at(-1)?.content)) as { signals: { id: string }[] };
      const ids = signals.map(signal => signal.id);
      const proposals = [
        { kind: "fix", title: "Handle an empty name in greet()", why: "greet('') returns 'Hello, !' and the TODO next to it says so.", evidence: ids.slice(0, 1), minutes: 15, coders: 1, confidence: "high", value: 4 },
        { kind: "tidy", title: "Move the greeting text into config", why: "The string is duplicated in two files.", evidence: ids.slice(0, 2), minutes: 25, coders: 1, confidence: "medium", value: 3 },
        { kind: "investigate", title: "Find why the check is slow on CI", why: "The last runs took over a minute for one file.", evidence: ids.slice(-1), minutes: 40, coders: 1, confidence: "low", value: 3 },
      ];
      yield { type: "tool_call_delta", index: 0, idDelta: "next-1", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    const user = messages.findLast(message => message.role === "user")?.content;
    // A proposal run (in its own worktree): one edit, then done.
    if (String(user).includes("Handle an empty name in greet()")) {
      if (!messages.some(message => message.role === "tool")) {
        yield { type: "tool_call_delta", index: 0, idDelta: "fix-1", nameDelta: "edit_file", argumentsDelta: JSON.stringify({ path: "hello.ts", edits: [{ oldText: "`${greeting}, ${name}!`", newText: "name ? `${greeting}, ${name}!` : `${greeting}!`" }] }) };
        yield { type: "finish", reason: "tool_calls" };
      } else { yield { type: "text_delta", delta: "greet('') now returns 'Hello!'." }; yield { type: "finish", reason: "stop" }; }
      return;
    }
    if (user !== prompt) { yield { type: "text_delta", delta: "Ready." }; yield { type: "finish", reason: "stop" }; return; }
    const operation = [
      { name: "edit_file", input: { path: "hello.ts", edits: [{ oldText: "export const greeting = 'Hello';", newText: "export const greeting = process.env.GREETING ?? 'Hello';" }] } },
      { name: "run_command", input: { argv: [process.execPath, "run", "check"] } },
    ][round++];
    if (operation) {
      yield { type: "tool_call_delta", index: 0, idDelta: `op-${round}`, nameDelta: operation.name, argumentsDelta: JSON.stringify(operation.input) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "The greeting now reads `GREETING` from the environment and falls back to `Hello`.\n\n- Updated `hello.ts`.\n- `bun run check` passed.\n" };
      yield { type: "finish", reason: "stop" };
    }
  },
}, readme ? { root: demoRoot, workspaceName: "greeter" } : {});
writeFileSync(join(f.workspace, "hello.ts"), "export const greeting = 'Hello';\n// TODO: greet('') returns 'Hello, !'\nexport const greet = (name: string) => `${greeting}, ${name}!`;\n");
writeFileSync(join(f.workspace, "package.json"), JSON.stringify({ name: "hello", scripts: { check: "bun check.ts" } }));
mkdirSync(join(f.workspace, ".demesne/workflows"), { recursive: true });
writeFileSync(join(f.workspace, ".demesne/workflows/fix-bug.md"), "# Fix a bug\n\nReproduce, fix, prove it.\n\n## Reproduce\nWrite a failing test.\ncheck: bun check.ts\nexpect: fail\n\n## Fix\nMake the smallest change.\ncheck: bun check.ts\n\n## Tidy\nRemove dead code.\n");
writeFileSync(join(f.workspace, "check.ts"), "import {greet} from './hello.ts';if(!greet('a').includes('a'))throw new Error('bad');console.log('CHECK_PASSED');\n");
const git = (...values: string[]) => execFileSync("git", ["-C", f.workspace, ...values], { stdio: "pipe" });
git("init", "-q"); git("add", ".");
git("-c", "user.name=Shots", "-c", "user.email=shots@example.com", "commit", "-qm", "Baseline");

const browser = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
const page = await browser.firstWindow();
await browser.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), readme ? { width: 1280, height: 800 } : { width: 1440, height: 900 });
await page.emulateMedia({ colorScheme: (process.env.THEME ?? "dark") as "dark" | "light" });
const pageErrors: string[] = [];
page.on("pageerror", (error: Error) => { pageErrors.push(error.message); console.error("page:", error.message); });
await page.waitForSelector("#app:not([hidden])", { timeout: 30_000 });
await page.waitForTimeout(3000);
const shot = async (name: string) => { await page.screenshot({ path: join(output, `${name}.png`) }); console.log("shot", name); };
const toggle = async (selector: string, name: string) => {
  if (!(await page.locator(selector).count())) return;
  await page.locator(selector).first().click(); await page.waitForTimeout(800);
  await shot(name);
  await page.locator(selector).first().click(); await page.waitForTimeout(400);
};
const named = (scratch: string, published: string) => readme ? `demesne-${published}` : scratch;
await shot(named("01-start", "start"));
if (!readme) {
  // Drive's ideas unfold under the composer (there is no Drive panel); run
  // the top one in its worktree and the start screen says a branch waits.
  await page.locator('#sidebar-drive').click(); await page.waitForTimeout(800);
  await shot(named("01-start-ideas", "start-ideas"));
  await page.locator('#hero .proposal-row button[data-action="next-run"]').first().click(); await page.waitForTimeout(400);
  for (let i = 0; i < 60 && !(await page.locator('#hero button[data-action="review-open"]').count()); i++) {
    const approve = page.locator(".approval-row button.allow").first();
    if (await approve.count() && await approve.isVisible()) await approve.click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  await shot("01-start-review");
  if (await page.locator('#hero button[data-action="review-open"]').count()) {
    await page.locator('#hero button[data-action="review-open"]').click(); await page.waitForTimeout(800);
    await shot("01-start-review-open");
    await page.locator('#hero button[data-action="review-open"]').click();
  }
}
await page.fill("textarea", prompt); await page.keyboard.press("Enter");
for (let i = 0; i < 40; i++) {
  const approve = page.locator(".approval-row button.allow").first();
  if (await approve.count() && await approve.isVisible()) { await approve.click(); await page.waitForTimeout(500); }
  if (await page.evaluate(() => document.body.innerText.includes("falls back to"))) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1500);
if (readme) {
  // The finished turn, with Drive's next ideas unfolded above the composer.
  await page.locator('#briefing button[data-action="ideas-show"]').click(); await page.waitForTimeout(800);
  await shot("demesne-drive");
  await page.locator('#briefing button[data-action="ideas-show"]').click(); await page.waitForTimeout(400);
} else {
  await shot("02-turn");
  await page.locator("#sidebar-sessions .sidebar-item").first().hover(); await page.waitForTimeout(300);
  await shot("02-sidebar-delete");
  // The briefing line above the composer, each part opened; then the
  // sidebar folded to its rail, and the project switcher.
  await toggle('#briefing button[data-action="review-open"]', "02-review-open");
  await toggle('#briefing button[data-action="ideas-show"]', "02-ideas");
  await toggle('.turn-receipt button[data-action="toggle-steps"]', "02-steps");
  await page.locator("#desktop-toggle-sidebar").click(); await page.waitForTimeout(500);
  await shot("02-rail");
  await page.locator("#rail-expand").click(); await page.waitForTimeout(500);
  await page.locator("#sidebar-search").focus(); await page.waitForTimeout(500);
  await shot("02-projects");
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  // The slash list: your workflows first, then what you used recently.
  await page.locator("textarea").click(); await page.keyboard.type("/"); await page.waitForTimeout(900);
  await shot("02-slash");
  await page.fill("textarea", ""); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
}
// The turn's steps open and the edit's row unfolds its diff in place; the
// top bar's ⋯ is the conversation's menu.
await page.locator('.turn-receipt button[data-action="toggle-steps"]').first().click(); await page.waitForTimeout(500);
await page.locator('.steps button[data-action="step"]').first().click(); await page.waitForTimeout(800);
await shot(named("03-inline-diff", "review"));
if (!readme) {
  await page.locator(".header-more").click(); await page.waitForTimeout(600);
  await shot("03-menu");
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
}
if (!readme) {
  // A workflow running as a Drive mission: the conversation's newest turn.
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  // Starting a workflow switches sessions; nothing may fail or leave a
  // stray "The session changed" notice behind.
  const before = pageErrors.length;
  await page.evaluate(() => {
    const notes: string[] = ((window as unknown as { notices: string[] }).notices = []);
    const notice = document.getElementById("notice")!;
    new MutationObserver(() => { if (!notice.hidden) notes.push(notice.textContent ?? ""); }).observe(notice, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  await page.fill("textarea", "/fix-bug Handle an empty name in greet()"); await page.keyboard.press("Enter");
  for (let i = 0; i < 20 && !(await page.locator("#drive-turn:not([hidden])").count()); i++) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
  await shot("04-drive-live");
  const stray = [...(await page.evaluate(() => (window as unknown as { notices: string[] }).notices)), ...pageErrors.slice(before)].filter((text) => text.includes("session changed"));
  if (stray.length) throw new Error(`Stray error after starting a workflow: ${stray.join(" | ")}`);
}
} finally { await browser.close(); await f.close(); }
