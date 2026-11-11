/** Settings › Agents (pass 206 A) against the real Electron app: the page
 * lists the agent tools with one switch for all; Off drops one from the
 * sidebar's Agents list, Some projects keeps it only where ticked, and the
 * switch hides the whole list.
 *   xvfb-run -a -s "-screen 0 1600x1000x24" bun scripts/check-agent-choice.ts
 * Run bun scripts/prepare-desktop.ts first. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/agent-choice");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");

const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
const f = await fixture(undefined, { agentCli: { which: (command) => ["claude", "codex", "agy"].includes(command) ? `/usr/bin/${command}` : null, spawn: () => { throw new Error("not run"); } } });

const app = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.locator("#composer textarea").first().waitFor({ timeout: 20_000 });
  const face = (id: string) => page.locator(`#sidebar-housed [data-provider="${id}"]`);
  await face("gemini").waitFor({ timeout: 15_000 });
  expect(await face("claude").count() === 1 && await face("codex").count() === 1, "all three agents in the sidebar to start");

  await page.locator(".sidebar-settings").click();
  await page.locator('#page[data-kind="settings"]').waitFor();
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Agents" }).click();
  await page.locator('#page h1.cp-title', { hasText: "Agents" }).waitFor();
  const text = await page.locator("#page").innerText();
  expect(text.includes("On: Claude Code, Codex and Gemini were found on this computer"), "the switch says what it found");
  expect((text.match(/In every project/g) ?? []).length === 3, "each agent starts everywhere");
  await page.screenshot({ path: join(output, "settings.png") });

  const row = (name: string) => page.locator("#page .st-row", { hasText: name });
  const seg = (name: string, label: string) => page.locator(`#page [aria-label="Where ${name} works"] button`, { hasText: label });
  // Gemini off: gone from the sidebar.
  await seg("Gemini", "Off").click();
  await row("Gemini").filter({ hasText: "Off everywhere" }).waitFor({ timeout: 5_000 });
  await face("gemini").waitFor({ state: "detached", timeout: 10_000 });
  expect(await face("claude").count() === 1, "Off takes Gemini out of the Agents list, the others stay");

  // Codex in some projects: none ticked yet, so it leaves; ticking this one brings it back.
  await seg("Codex", "Some projects").click();
  await row("Codex").filter({ hasText: "In no projects yet" }).waitFor({ timeout: 5_000 });
  await face("codex").waitFor({ state: "detached", timeout: 10_000 });
  expect(true, "Some projects with none ticked: Codex leaves");
  const name = f.workspace.split("/").at(-1)!;
  await page.locator('#page [aria-label="Projects for Codex"] button', { hasText: name }).click();
  await row("Codex").filter({ hasText: `In ${name}` }).waitFor({ timeout: 5_000 });
  await face("codex").waitFor({ state: "attached", timeout: 10_000 });
  expect(await page.locator('#page [aria-label="Projects for Codex"] button.on', { hasText: `✓ ${name}` }).count() === 1, "ticking this project brings Codex back here");
  await page.screenshot({ path: join(output, "some-projects.png") });

  // Each agent's model changes here: Codex's thinking level, picked and read back.
  await page.locator('#page button.st-word[data-args*="agent-model:codex"]').click();
  await page.locator('#page [aria-label="Codex thinking"]').waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(output, "models-open.png") });
  await page.locator('#page [aria-label="Codex thinking"] button', { hasText: "High" }).click();
  await page.locator('#page button.st-word[data-args*="agent-model:codex"]', { hasText: "· High" }).waitFor({ timeout: 5_000 });
  expect(true, "Codex's thinking level is picked in Settings and reads back");

  // The one switch: every agent off, and the Agents list goes.
  await page.locator('#page button[role="switch"][aria-label="Agents"]').click();
  await page.locator("#page", { hasText: "Off: no agent chats, side work, hand-offs or Today posts" }).waitFor({ timeout: 5_000 });
  await face("claude").waitFor({ state: "detached", timeout: 10_000 });
  expect(await page.locator("#sidebar-housed .sidebar-housed-row").count() === 0, "all off empties the Agents list, Today with it");
  expect(await page.locator('#page [aria-label="Where Codex works"]').count() === 0, "and the per-agent choices step back");
  await page.screenshot({ path: join(output, "all-off.png") });
  await page.locator('#page button[role="switch"][aria-label="Agents"]').click();
  await face("codex").waitFor({ state: "attached", timeout: 10_000 });
  expect(await face("gemini").count() === 0, "switching back on keeps each agent's choice");
  // Back in the chat, the sidebar shows what's on here.
  await page.locator("#settings-nav .st-nav").first().click().catch(() => {});
  await page.keyboard.press("Escape");
  await page.locator("#composer textarea").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(output, "sidebar.png") });
} catch (error) {
  failures.push(String(error));
  console.log("FAIL", error);
} finally {
  await app.close();
  f.server.stop?.(true);
}
if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
