/** Real Electron check for Foundry's edit in place (step 3 after pass 262
 * C): the opened doc's pencil makes its text editable where it sits; a
 * changed heading and a changed word inside formatted text land in the
 * content; text that repeats goes back and says why; Done keeps the
 * changes as one new version, "Edited by you", and shows it. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const DOC = `---
title: Q3 review
author: The counter
---
Revenue grew **18%** on the quarter, led by the new counter app.

## What went well

- Orders through the app doubled
- Two new cafés opened

## Next

- Orders through the app doubled
`;

const f = await fixture({
  providerId: "fixture", modelId: "foundry-edit",
  async listModels() { return [{ id: "foundry-edit", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Q3 review", kind: "doc", description: "The quarter, in one page.", note: "First take", source: DOC }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-edit")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const ready = () => page!.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await ready(); await page.waitForTimeout(200);
  await editor.fill("/foundry a q3 review doc"); await editor.press("Enter");
  const chip = page.locator("#conversation .fd-chip").filter({ hasText: "Q3 review" });
  await chip.waitFor();
  await ready(); await page.waitForTimeout(300);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Q3 review")!.id;
  await chip.click();
  const item = page.locator(`#page [data-fd="${id}:1"]`);
  await step(57, async () => (await item.getAttribute("class").catch(() => ""))!.includes("fd-open"));
  const frame = () => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${id}?v=1`) && found.url().includes("edit=1")) as Frame | undefined;

  // The pencil: the text becomes editable where it sits, and the line under it says how.
  await item.getByRole("button", { name: "Edit the text" }).click();
  await step(62, async () => !!frame() && await frame()!.evaluate(() => document.querySelectorAll("[data-edit]").length > 4).catch(() => false));
  assert.match((await item.locator(".fd-said").textContent())!, /Click any text to change it/);
  assert.equal(await item.getByRole("button", { name: "Show the code" }).count(), 0, "no code view while editing");
  const edit = async (selector: string, from: string, to: string) => {
    const piece = frame()!.locator(selector).filter({ hasText: from }).first();
    await piece.click();
    await piece.evaluate((el, text) => { el.textContent = text; }, to);
    await page!.keyboard.press("Enter");
  };
  // A heading.
  await edit("h2", "What went well", "What worked");
  await step(72, async () => /^1 change\./.test((await item.locator(".fd-said").textContent()) ?? ""));
  // A word after bold text keeps the bold.
  await edit("p", "Revenue grew", "Revenue grew 18% on the quarter, led by the new ordering app.");
  await step(75, async () => /^2 changes\./.test((await item.locator(".fd-said").textContent()) ?? ""));
  // Text that repeats can't be placed: it goes back and says why.
  await edit("li", "Orders through the app doubled", "Orders tripled");
  await step(78, async () => /went back/.test((await item.locator(".fd-said").textContent()) ?? ""));
  await step(79, async () => frame()!.evaluate(() => [...document.querySelectorAll("li")].filter((li) => li.textContent === "Orders through the app doubled").length === 2));
  await page.screenshot({ path: join(output, "foundry-edit.png") });

  // Done: one new version, edited by you, shown.
  await item.getByRole("button", { name: "Done editing" }).click();
  await step(84, async () => (await f.client.foundryList()).artifacts.find((one) => one.id === id)?.version === 2);
  const saved = await f.client.foundryGet(id);
  assert.equal(saved.source, DOC.replace("## What went well", "## What worked").replace("new counter app", "new ordering app"));
  assert.equal(saved.versions.find((one) => one.version === 2)?.note, "Edited by you");
  const two = page.locator(`#page [data-fd="${id}:2"]`);
  await step(89, async () => (await two.getAttribute("class").catch(() => ""))!.includes("fd-open"));
  await step(90, async () => /Kept your 2 changes as v2/.test((await two.locator(".fd-said").textContent()) ?? ""));
  assert.equal(await two.getByRole("button", { name: "Edit the text" }).count(), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: a doc's text is edited where it sits; changes land in its content, formatting kept; repeats go back; Done keeps them as one new version.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
