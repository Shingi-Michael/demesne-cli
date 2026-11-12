/** Real Electron check: a chat makes a routine with the routine tool (loaded
 * through tool_search), the step row says what it made, a quiet Routine card
 * shows on the right, and the Scheduled page lists it. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const f = await fixture({
  providerId: "fixture", modelId: "routine",
  async listModels() { return [{ id: "routine", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    const at = messages.findLastIndex(message => message.role === "user");
    const done = messages.slice(at + 1).filter(message => message.role === "tool").length;
    const call = (name: string, input: unknown) => ({ type: "tool_call_delta" as const, index: 0, idDelta: `${name}-${at}-${done}`, nameDelta: name, argumentsDelta: JSON.stringify(input) });
    if (!tools.some(tool => tool.name === "routine")) { yield call("tool_search", { names: ["routine"] }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (!messages.slice(at + 1).some(message => message.role === "tool" && /"routine":"added"|CANT_READ|NOT_FOUND/.test(String(message.content)))) {
      yield call("routine", { action: "add", text: "Every weekday at 9, list the PRs waiting on me" });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Done: weekdays at 9 a new chat lists the PRs waiting on you." };
    yield { type: "finish", reason: "stop" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "electron-routine")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  await editor.fill("check my PRs every weekday morning at 9");
  await editor.press("Enter");
  // Auto approves it; on Ask the approval would say "Make a routine: Weekdays · 9:00, …".
  const approve = page.locator("#conversation button", { hasText: /^(Allow|Approve|Yes)/ }).first();
  await Promise.race([page.locator("#conversation .turn").filter({ hasText: "Done: weekdays at 9" }).waitFor(), approve.waitFor().then(() => approve.click())]);
  await page.locator("#conversation .turn").filter({ hasText: "Done: weekdays at 9" }).waitFor();
  const card = page.locator('#cards [data-card="routines"]');
  await card.waitFor();
  assert.match((await card.textContent())!, /Routine · Weekdays · 9:00/);
  await card.locator(".card-head").click();
  await card.and(page.locator(".open")).waitFor();
  assert.match((await card.textContent())!, /List the PRs waiting on me/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, "routine-card.png") });
  console.log("PASS: the chat made a routine and its card shows on the right.");
  await card.locator('button[data-action="page-open"]').click();
  await page.locator("#page", { hasText: "List the PRs waiting on me" }).waitFor();
  await page.screenshot({ path: join(output, "routine-scheduled.png") });
  console.log("PASS: the Scheduled page lists it.");
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "routine-failure.png") }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  await f.close();
}
