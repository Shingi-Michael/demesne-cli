/** Real Electron check: invoke Foundry in chat and keep its live preview
 * interactive through streaming, turn completion, revisions and replay. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const response = Promise.withResolvers<void>();
let first = true;
const mockup = (blue = false) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:40px;font:16px system-ui;background:${blue ? "#eaf2ff" : "#f4f1eb"};color:#18342c}
main{max-width:520px;margin:auto}small{letter-spacing:.15em}h1{font-size:38px;margin:16px 0}
button,input{font:inherit;border:1px solid #9aaea5;border-radius:10px;padding:12px;margin:8px 0}
button{background:${blue ? "#3158ba" : "#285b48"};color:white;cursor:pointer}input{display:block;width:90%}
</style></head><body><main><small>FOUNDRY · LIVE MOCKUP</small><h1>A little room to grow</h1>
<p>Try this mockup right inside the conversation.</p><input aria-label="Your idea" placeholder="Name your next idea">
<button id="counter" onclick="this.textContent='Planted '+(++window.plants)">Plant an idea</button>
<script>window.plants=0;</script></main></body></html>`;
const f = await fixture({
  providerId: "fixture", modelId: "foundry-chat",
  async listModels() { return [{ id: "foundry-chat", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    if (tools.some(tool => tool.name === "proof_marks")) { yield { type: "finish", reason: "stop" }; return; }
    const at = messages.findLastIndex(message => message.role === "user");
    const request = messages[at]?.content ?? "";
    const current = messages.slice(at + 1).filter(message => message.role === "tool");
    const blue = /blue/i.test(request);
    const previous = messages.slice(0, at).filter(message => message.role === "tool").map(message => {
      try { return JSON.parse(message.content ?? "{}"); } catch { return {}; }
    }).findLast(value => value.kind === "html" && value.id);
    const call = (name: string, input: unknown) => ({ type: "tool_call_delta" as const, index: 0,
      idDelta: `${name}-${at}-${current.length}`, nameDelta: name, argumentsDelta: JSON.stringify(input) });
    if (blue && !current.length) {
      yield call("foundry_read", { id: previous.id });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (!current.length || (blue && current.length === 1)) {
      assert(tools.some(tool => tool.name === "foundry_save"));
      const graphic = /graphic/i.test(request), document = /document/i.test(request);
      yield call("foundry_save", { ...(blue ? { id: previous.id } : {}), title: graphic ? "A simple badge" : document ? "Project brief" : "Idea garden",
        kind: graphic ? "svg" : document ? "markdown" : "html",
        source: graphic ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#285b48"/></svg>'
          : document ? "# Project brief\n\nA document created in chat.\n\n<script>window.injected=true</script>" : mockup(blue) });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Here is your mockup. " };
    if (first) { first = false; await response.promise; }
    yield { type: "text_delta", delta: "Try it below and tell me what to change." };
    yield { type: "finish", reason: "stop" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  const executable = process.argv[2];
  desktop = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}),
    args: [...(executable ? [] : [resolve("apps/desktop/build/app")]), `--user-data-dir=${join(f.root, "electron-foundry")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  await page.bringToFront();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  await page.locator('.sidebar-nav button[aria-label="New chat"]').click();
  await eventually(async () => (await f.client.listSessions()).some(session => !session.workspace));
  const plain = (await f.client.listSessions()).find(session => !session.workspace)!;
  await page.waitForFunction(id => {
    const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host;
    return host?.session === id && !host.busy;
  }, plain.id);
  const editor = page.locator("textarea");
  await editor.fill("/foundry make me a small interactive mockup");
  await editor.press("Enter");
  const cards = page.locator("#conversation .fd-chat-artifact");
  const card = cards.first(), frame = card.frameLocator("iframe");
  await frame.getByRole("button", { name: "Plant an idea" }).waitFor();
  assert(await page.locator("#page").isHidden(), "Foundry stays in the chat");
  const artifact = (await f.client.foundryList()).artifacts[0]!;
  assert.equal(artifact.workspace, null, "No project is required");
  await frame.getByRole("button", { name: "Plant an idea" }).click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Initial inline interaction passed.");
  await frame.getByRole("textbox", { name: "Your idea" }).fill("Keep my idea");
  response.resolve();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Streaming completion kept preview state.");
  assert.equal(await frame.getByRole("textbox", { name: "Your idea" }).inputValue(), "Keep my idea");
  await page.locator('[data-action="toggle-steps"]').first().click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Step folding kept preview state.");
  await card.getByRole("button", { name: "Phone", exact: true }).click();
  await card.getByRole("button", { name: "Code", exact: true }).click();
  await card.locator(".fd-chat-code").filter({ hasText: "window.plants=0" }).waitFor();
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("PASS: /foundry creates in chat; form and button state survive streaming, completion, step folding and preview controls.");

  await editor.fill("Make it blue"); await editor.press("Enter");
  await cards.nth(1).frameLocator("iframe").getByRole("heading", { name: "A little room to grow" }).waitFor();
  await eventually(async () => (await f.client.foundryGet(artifact.id)).version === 2);
  assert.equal(await cards.nth(1).getAttribute("data-artifact-id"), artifact.id);
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  await cards.nth(1).getByRole("button", { name: "Revise", exact: true }).click();
  await eventually(async () => (await editor.inputValue()).includes(artifact.id));
  console.log("PASS: natural follow-up revises the artifact in the same chat; the earlier preview keeps its state.");

  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await editor.fill("Make an SVG badge graphic"); await editor.press("Enter");
  await cards.nth(2).frameLocator("iframe").locator("img").waitFor();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await editor.fill("Make a project brief document"); await editor.press("Enter");
  await cards.nth(3).getByRole("heading", { name: "Project brief" }).waitFor();
  assert.equal(await cards.nth(3).locator("script").count(), 0);
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.reload();
  await page.locator(`#sidebar-chats [data-action="select-session"][data-args*="${artifact.sessionId}"]`).click();
  await cards.nth(3).getByRole("heading", { name: "Project brief" }).waitFor();
  assert.equal(await cards.count(), 4, "Artifact previews return with the conversation history");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "foundry-chat.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: SVG and sanitized Markdown render inline; all saved previews return when the chat is reopened.");
} catch (error) {
  if (page) {
    console.error("HOST", await page.evaluate(() => (window.demesneInspect?.() as { host?: unknown })?.host));
    console.error("ARTIFACTS", (await f.client.foundryList()).artifacts);
    await page.screenshot({ path: join(output, "foundry-chat-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  response.resolve();
  await desktop?.close();
  await f.close();
}
