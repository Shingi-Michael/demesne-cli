/** Real Electron check: the Assistant row under New chat opens the
 * assistant's one chat. A routine's question there is a quiet line with its
 * time and name, each day starts with a day line, the chat never joins the
 * list of chats, and a routine written from it runs there. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DemesneStore } from "../packages/storage/src/index.ts";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const f = await fixture(undefined, { workspaceName: "garden" });
// Nothing exists until the row is first clicked.
assert.equal((await f.client.assistant()).sessionId, null);

let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  const executable = process.argv[2];
  desktop = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}),
    args: [...(executable ? [] : [resolve("apps/desktop/build/app")]), `--user-data-dir=${join(f.root, "electron-assistant")}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath, XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("heading", { name: "Make room for your next idea." }).waitFor({ timeout: 30000 });
  await desktop.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); }, f.workspace);
  await page.getByRole("button", { name: "Open a project", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("sidebar-sessions")?.dataset.workspace);
  const row = page.locator("#sidebar-assistant");
  await row.waitFor();
  // It sits right under New chat.
  assert.equal(await page.locator(".sidebar-nav > *").nth(1).getAttribute("id"), "sidebar-assistant");
  await row.click();
  await eventually(async () => (await page!.locator("#workspace-title").textContent()) === "Assistant");
  assert.equal(await row.getAttribute("aria-current"), "page", "the row is selected while its chat is open");
  const sessionId = (await f.client.assistant()).sessionId!;
  assert.ok(sessionId);
  // Empty, it is still its chat, not Home.
  assert.equal(await page.locator("textarea").getAttribute("placeholder"), "Ask your assistant…");
  await page.screenshot({ path: join(output, "assistant-empty.png") });
  // The 8:00 routine asks in the assistant's chat while you're elsewhere.
  await page.locator('.sidebar-nav [data-action="new-session"]').click();
  await eventually(async () => (await page!.locator("#workspace-title").textContent()) !== "Assistant");
  const store = new DemesneStore(join(f.root, "data/state.sqlite"));
  const { turn } = store.createTurn(sessionId, "What's on today and this week?", "deny", false, false, "chat", [], false, "What's on today");
  store.startTurn(turn.id);
  store.completeTurn(turn.id);
  store.close();
  await row.click();
  await eventually(async () => (await page!.locator("#workspace-title").textContent()) === "Assistant");
  const routine = page.locator("#conversation .routine-asked");
  await routine.waitFor();
  assert.equal(await routine.locator("b").textContent(), "What's on today");
  assert.equal(await page.locator("#conversation .request").count(), 0, "a routine's question is not a bubble of yours");
  assert.equal(await page.locator("#conversation .day-line").first().textContent(), "Today");
  // You talk to it like any chat, and the day line isn't repeated.
  const editor = page.locator("textarea");
  await eventually(async () => {
    if (await page!.locator("#conversation .request").count()) return true;
    if (!(await editor.inputValue())) { await editor.fill("Remind me about the dentist"); await editor.press("Enter"); }
    await page!.waitForTimeout(300);
    return (await page!.locator("#conversation .request").count()) > 0;
  }, 10000);
  await page.locator("#conversation").getByText("Ready.").last().waitFor();
  assert.equal(await page.locator("#conversation .day-line").count(), 1);
  await page.screenshot({ path: join(output, "assistant-chat.png") });
  // It isn't one of your chats, and New chat never lands in it.
  assert.equal(await page.locator("#sidebar-sessions .sidebar-session", { hasText: "Assistant" }).count(), 0);
  await page.locator('.sidebar-nav [data-action="new-session"]').click();
  await eventually(async () => (await page!.locator("#workspace-title").textContent()) !== "Assistant");
  assert.equal(await row.getAttribute("aria-current"), null);
  await row.click();
  await eventually(async () => (await page!.locator("#conversation .request").count()) === 1);
  assert.equal((await f.client.assistant()).sessionId, sessionId, "the same chat comes back");
  // A routine written from its chat runs in its chat.
  await page.locator('.sidebar-nav [data-args=\'{"page":"scheduled"}\']').click();
  await page.locator("#routine-new input").fill("Every day at 8, what's on today");
  await page.locator("#routine-new input").press("Enter");
  await page.locator(".sp-row .sp-where", { hasText: "Assistant" }).waitFor();
  assert.equal((await f.client.routines()).routines[0]?.assistant, true);
  assert.deepEqual(errors, []);
  console.log("Assistant check passed.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
