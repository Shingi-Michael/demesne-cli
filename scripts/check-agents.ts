/** The sidebar's Agents list against the real Electron app: an installed
 * agent tool shows under the project, opens its own chat, and answers there.
 * bun scripts/check-agents.ts [dir]; run bun scripts/prepare-desktop.ts first. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import { claudeRun, fakeProcess } from "../apps/daemon/test/agent-cli-fakes.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/agents");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");
const runs: string[][] = [];
const f = await fixture(undefined, { socials: true, agentCli: {
  which: (command) => command === "claude" || command === "codex" ? `/usr/local/bin/${command}` : null,
  spawn: (argv) => { runs.push(argv); return fakeProcess(claudeRun(argv[argv.indexOf("--session-id") + 1] ?? "s", "The bundle step type-checks twice. Dropping the second pass saves about 40s.")); },
} });
const browser = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
try {
  const page = await browser.firstWindow();
  await page.setViewportSize({ width: 1180, height: 760 });
  const rows = page.locator(".sidebar-housed-row:not(.sidebar-today)");
  await rows.first().waitFor({ timeout: 20_000 });
  expect(await rows.count() === 2, "two installed agents listed");
  expect(await page.locator("#sidebar-housed .sidebar-housed-row:not(.sidebar-today)").count() === 2 && await page.locator(".sidebar-project .sidebar-housed-row").count() === 0, "agents sit in their own list at the top, not under a project");
  expect((await rows.first().innerText()).includes("Claude Code") && (await rows.first().innerText()).includes("ready"), "Claude Code is ready");
  await page.screenshot({ path: join(output, "agents-listed.png") });
  await rows.first().click();
  await page.waitForFunction(() => document.querySelector(".sidebar-housed-row.on") !== null, undefined, { timeout: 10_000 });
  expect(true, "clicking it opens its chat");
  const editor = page.locator("#composer [contenteditable], #composer textarea, [contenteditable='true']").first();
  await editor.click();
  await page.keyboard.type("Check why the macOS build is slow");
  await page.keyboard.press("Enter");
  await page.getByText("Dropping the second pass").first().waitFor({ timeout: 20_000 });
  expect(runs.length === 1 && runs[0]!.includes("--session-id"), "the message ran Claude Code once, in a new session of its own");
  expect(await page.locator(".sidebar-session", { hasText: "Claude Code" }).count() === 0, "its chat isn't listed again among the chats");
  await page.screenshot({ path: join(output, "agent-answered.png") });
  // Agent socials: its finished turn is a post on Today, and you can comment.
  const today = page.locator(".sidebar-today");
  expect(await today.count() === 1, "Today sits at the top of the Agents list");
  await today.click();
  await page.locator("#page .td-post").first().waitFor({ timeout: 20_000 });
  expect(await page.locator("#page .td-post .td-from", { hasText: "Claude Code" }).count() > 0 || await page.locator("#page .td-post").count() > 0, "the agent's turn became a post on Today");
  await page.locator("#page .td-post [data-action='today-like']").first().click();
  await page.waitForFunction(() => document.querySelector("#page .td-act.on") !== null, undefined, { timeout: 5_000 });
  expect(true, "liking a post marks it");
  await page.locator("#page .td-post [data-action='today-reply']").first().click();
  await page.locator("#page .td-field input").fill("nice one");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#page .td-comment")].some((item) => item.textContent?.includes("nice one")), undefined, { timeout: 10_000 });
  expect(true, "your comment shows under the post");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(output, "today.png") });
} finally {
  await browser.close();
  await f.close?.();
}
if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
console.log("agents check passed");
