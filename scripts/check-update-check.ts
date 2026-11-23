/** Real Electron check for checking for updates yourself (pass 193 A): the
 * pink release line checks when clicked, says "Checking…", then what it
 * found for a few seconds; Settings › Updates has Check now and says when it
 * last looked. The updater's answers are sent the way the main process
 * sends them, since a source build has no updater of its own. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { eventually, fixture } from "../apps/desktop/workspace/test/fixture.ts";

const f = await fixture({
  providerId: "fixture", modelId: "update-check",
  async listModels() { return [{ id: "update-check", provider: "fixture", contextWindow: 262144 }]; },
  async *stream() { yield { type: "text_delta", delta: "ok" }; yield { type: "finish", reason: "stop" }; },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  const chat = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  await f.client.submitTurn(chat, { content: "Check the desktop update." });
  await eventually(async () => (await f.client.getSessionState(chat)).session.turns.at(-1)?.status === "completed");
  const executable = process.argv[2];
  desktop = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}),
    args: [...(executable ? [] : [resolve("apps/desktop/build/app")]), `--user-data-dir=${join(f.root, "electron-update")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  await page.evaluate(id => window.demesneDesktop!.core.invoke("desktop_request", { method: "select-session", args: { id } }), chat);
  await page.locator("#conversation").getByText("Check the desktop update.", { exact: true }).waitFor();
  const send = (status: unknown) => desktop!.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send("demesne:app-update", value), status);
  const line = page.locator(".sidebar-release");
  const idle = { state: "idle", version: "0.8.8", enabled: true, checked: Date.now() - 12 * 60_000 };
  // The release line and the folded fallback never announce ready together.
  const ready = { state: "ready", version: idle.version, to: "0.8.9" };
  const toggle = page.locator("#desktop-toggle-sidebar"), restart = line.locator("[data-update-restart]");
  const notice = page.locator(".seat-pill.middle").filter({ hasText: "0.8.9 is ready" });
  await send(ready);
  await restart.waitFor();
  assert.equal(await page.locator(".seat-pill").filter({ hasText: "0.8.9 is ready" }).count(), 0);
  await page.screenshot({ path: join(output, "update-ready-expanded.png") });
  await toggle.click();
  await notice.waitFor();
  assert.equal(await line.isVisible(), false);
  assert.equal(await notice.locator("button").count(), 0);
  // Wait for the entrance animation, then check the notice sits above the composer.
  await notice.evaluate(el => Promise.all(el.getAnimations().filter(a => a.effect?.getTiming().iterations === 1).map(a => a.finished)));
  const box = (await notice.boundingBox())!, composer = (await page.locator("#composer").boundingBox())!;
  assert(Math.abs(box.x + box.width / 2 - composer.x - composer.width / 2) < 2, "notice centred on the composer");
  assert(Math.abs(composer.y - box.y - box.height - 10) < 2, "10px gap above composer");
  await page.screenshot({ path: join(output, "update-ready-folded.png") });
  await toggle.click();
  await restart.waitFor();
  assert.equal(await notice.count(), 0, "unfold removes the notice immediately");
  await toggle.click();
  await notice.waitFor();
  await send(ready);
  assert.equal(await notice.count(), 1);
  await notice.waitFor({ state: "detached", timeout: 10000 });
  await toggle.click(); await toggle.click();
  assert.equal(await notice.count(), 0, "folding again does not replay an expired notice");
  const newer = { ...ready, to: "0.8.10" };
  await send(newer);
  const newerNotice = page.locator(".seat-pill.middle").filter({ hasText: "0.8.10 is ready" });
  await newerNotice.waitFor();
  await send({ ...newer, waiting: true });
  await newerNotice.waitFor({ state: "detached" });
  await page.locator("#rail-search").click();
  await line.filter({ hasText: "0.8.10 restarts when this finishes" }).waitFor();
  assert.equal(await restart.count(), 0);
  console.log("PASS: one ready notice, folded timeout, immediate dismissal, and waiting restart.");
  await send(idle);
  // The name is the button that checks.
  const check = line.locator("button[data-update-check]");
  await check.waitFor();
  assert.equal((await check.textContent())?.trim(), "Demesne · Milky Way");
  await check.click();
  await send({ ...idle, checking: true });
  await line.filter({ hasText: "Checking for updates…" }).waitFor();
  await line.screenshot({ path: join(output, "update-checking.png") });
  await send({ ...idle, checked: Date.now(), problem: "Couldn't reach GitHub" });
  await line.filter({ hasText: "Couldn't reach GitHub" }).waitFor();
  await page.locator(".sidebar").screenshot({ path: join(output, "update-problem.png") }).catch(() => line.screenshot({ path: join(output, "update-problem.png") }));
  // It goes back to the name by itself.
  await line.locator("button[data-update-check]").filter({ hasText: "Demesne · Milky Way" }).waitFor({ timeout: 8000 });
  console.log("PASS: the pink line checks when clicked and says why it couldn't.");
  await check.click();
  await send({ ...idle, checking: true });
  await send({ ...idle, checked: Date.now() });
  await line.filter({ hasText: "Up to date · 0.8.8" }).waitFor();
  console.log("PASS: an asked check that finds nothing says Up to date.");
  // A plain scheduled check says nothing.
  await line.locator("button[data-update-check]").filter({ hasText: "Demesne · Milky Way" }).waitFor({ timeout: 8000 });
  await send({ ...idle, checking: true });
  await send({ ...idle, checked: Date.now() });
  await page.waitForTimeout(300);
  assert.equal((await line.textContent())?.trim(), "Demesne · Milky Way", "an unasked check is quiet");
  // Settings › General › Updates: when it last looked, and Check now.
  await send(idle);
  await page.locator(".sidebar-settings").click();
  await page.locator('#page[data-kind="settings"]').waitFor();
  await page.locator("#settings-nav .st-nav").filter({ hasText: "General" }).click();
  await page.locator("#settings-nav .st-nav.on").filter({ hasText: "General" }).waitFor();
  const row = page.locator("#page .st-row").filter({ hasText: "Demesne 0.8.8" });
  await row.waitFor();
  assert.match((await row.textContent())!, /Checked 12 min ago · this is the newest/);
  await row.getByRole("button", { name: "Check now" }).click();
  await send({ ...idle, checking: true });
  await row.filter({ hasText: "Checking for updates…" }).waitFor();
  assert.equal(await row.getByRole("button", { name: "Check now" }).count(), 0, "no second check while one runs");
  await send({ ...idle, checked: Date.now(), problem: "GitHub needs a login: run gh auth login" });
  await row.locator("small.bad").filter({ hasText: "gh auth login" }).waitFor();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "update-settings.png") });
  console.log("PASS: Settings › Updates says when it last looked and has Check now.");
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "update-check-failure.png") }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  await f.close();
}
