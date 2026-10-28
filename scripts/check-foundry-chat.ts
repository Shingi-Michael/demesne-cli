/** Real Electron check: invoke Foundry in chat, open what it made in the
 * pane beside the conversation, and keep that page interactive through
 * streaming, turn completion, revisions and replay. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const response = Promise.withResolvers<void>();
/// The first save's arguments arrive in two parts: the title, then the page,
/// once the pane has opened on the title.
const making = Promise.withResolvers<void>();
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
    if (blue && current.length === 1) {
      // A small change goes through foundry_edit against the version just read.
      assert(tools.some(tool => tool.name === "foundry_edit"));
      const read = JSON.parse(current[0]!.content ?? "{}") as { version: number };
      yield call("foundry_edit", { id: previous.id, base_version: read.version, note: "Blue",
        edits: [{ find: "#f4f1eb", replace: "#eaf2ff" }, { find: "#285b48", replace: "#3158ba" }] });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (!current.length) {
      assert(tools.some(tool => tool.name === "foundry_save"));
      const graphic = /graphic/i.test(request), document = /document/i.test(request);
      const save = call("foundry_save", { title: graphic ? "A simple badge" : document ? "Project brief" : "Idea garden",
        kind: graphic ? "svg" : document ? "markdown" : "html",
        source: graphic ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#285b48"/></svg>'
          : document ? "# Project brief\n\nA document created in chat.\n\n<script>window.injected=true</script>" : mockup() });
      if (first) {
        const cut = save.argumentsDelta.indexOf('"source"');
        yield { ...save, argumentsDelta: save.argumentsDelta.slice(0, cut) };
        await making.promise;
        yield { type: "tool_call_delta", index: 0, idDelta: "", nameDelta: "", argumentsDelta: save.argumentsDelta.slice(cut) };
      } else yield save;
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
  const chips = page.locator("#conversation .fd-chip");
  const pane = page.locator("#pane"), frame = pane.frameLocator("iframe.pane-frame");
  // While Foundry writes the page, the pane opens on its title alone.
  await pane.locator(".pane-head").filter({ hasText: "making…" }).filter({ hasText: "Idea garden" }).waitFor();
  assert.equal(await pane.locator("iframe").count(), 0, "nothing shows until the page is written");
  making.resolve();
  // A new artifact is a chip in the chat and opens in the pane beside it by itself.
  await chips.first().filter({ hasText: "Idea garden" }).waitFor();
  await frame.getByRole("button", { name: "Plant an idea" }).waitFor();
  // Its first show assembles the page: the frame is served with anime.js and
  // the assembly; the pieces end up in place with no inline styles left.
  const assembled = async (previous: "none" | "string") => {
    assert.match((await pane.locator("iframe.pane-frame").getAttribute("src"))!, /[?&]assemble=1$/, "a version's first show asks for the assembly");
    const inner = page!.frames().find(item => item.url().includes("assemble=1"));
    assert(inner, "the assembling frame is reachable");
    await eventually(async () => inner.evaluate(() => (window as unknown as { anime?: unknown }).anime !== undefined && document.documentElement.style.visibility === "" && [...document.querySelectorAll("main, main > *")].every(el => !(el as HTMLElement).style.transform)));
    assert.equal(await inner.evaluate(() => typeof (window as unknown as { __demesnePrevious: unknown }).__demesnePrevious), previous === "none" ? "object" : "string");
  };
  await assembled("none");
  assert(await page.locator("#page").isHidden(), "Foundry stays beside the chat");
  assert.equal(await page.locator("#conversation iframe").count(), 0, "Nothing live runs in the conversation");
  assert.equal(await chips.first().getAttribute("aria-pressed"), "true", "The open chip is marked");
  const artifact = (await f.client.foundryList()).artifacts[0]!;
  assert.equal(artifact.workspace, null, "No project is required");
  await frame.getByRole("button", { name: "Plant an idea" }).click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Initial pane interaction passed.");
  await frame.getByRole("textbox", { name: "Your idea" }).fill("Keep my idea");
  response.resolve();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Streaming completion kept the page's state.");
  assert.equal(await frame.getByRole("textbox", { name: "Your idea" }).inputValue(), "Keep my idea");
  await page.locator('[data-action="toggle-steps"]').first().click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Step folding kept the page's state.");
  await pane.getByRole("button", { name: "Phone width" }).click();
  assert.equal(await pane.getByRole("button", { name: "Phone width" }).getAttribute("aria-pressed"), "true");
  await pane.getByRole("button", { name: "Code", exact: true }).click();
  await pane.locator(".pane-code").filter({ hasText: "window.plants=0" }).waitFor();
  await pane.getByRole("button", { name: "Preview", exact: true }).click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("PASS: /foundry makes a chip and opens the pane; the page's state survives streaming, completion, step folding and the pane's controls.");

  await editor.fill("Make it blue"); await editor.press("Enter");
  await chips.nth(1).filter({ hasText: "Prototype · v2" }).waitFor();
  await eventually(async () => (await f.client.foundryGet(artifact.id)).version === 2);
  assert.equal(await chips.nth(1).getAttribute("data-artifact-id"), artifact.id);
  assert.match((await f.client.foundryGet(artifact.id)).source, /#3158ba/);
  assert.equal((await f.client.foundryGet(artifact.id)).versions[0]!.note, "Blue");
  // The pane follows the chat onto the new version; the arrows walk back.
  await pane.locator(".pane-foot").filter({ hasText: "v2" }).waitFor();
  await frame.getByRole("heading", { name: "A little room to grow" }).waitFor();
  // A revision assembles against the version before it: only what changed moves.
  await assembled("string");
  assert.equal(await chips.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(await chips.nth(0).getAttribute("aria-pressed"), "false");
  await pane.getByRole("button", { name: "Earlier version" }).click();
  await pane.locator(".pane-foot").filter({ hasText: "Make this the latest" }).waitFor();
  assert.equal(await chips.nth(0).getAttribute("aria-pressed"), "true");
  await pane.getByRole("button", { name: "Later version" }).click();
  await pane.locator(".pane-foot").filter({ hasText: "Blue" }).waitFor();
  await pane.getByRole("button", { name: "Revise", exact: true }).click();
  await eventually(async () => (await editor.inputValue()).includes(artifact.id));
  console.log("PASS: a follow-up edits the artifact in place (foundry_edit); the pane moves to v2 and walks the versions.");

  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await editor.fill("Make an SVG badge graphic"); await editor.press("Enter");
  await chips.nth(2).filter({ hasText: "Graphic · v1" }).waitFor();
  await frame.locator("img").waitFor();
  assert.equal(await pane.getByRole("button", { name: "Phone width" }).count(), 0, "A graphic has no phone width");
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await editor.fill("Make a project brief document"); await editor.press("Enter");
  await chips.nth(3).filter({ hasText: "Document · v1" }).waitFor();
  await pane.locator(".pane-doc").getByRole("heading", { name: "Project brief" }).waitFor();
  assert.equal(await pane.locator(".pane-doc script").count(), 0);
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.reload();
  await page.locator(`#sidebar-chats [data-action="select-session"][data-args*="${artifact.sessionId}"]`).click();
  await chips.nth(3).filter({ hasText: "Document · v1" }).waitFor();
  assert.equal(await chips.count(), 4, "Chips return with the conversation history");
  // The pane remembers what this chat had open; Esc closes it; a chip reopens it.
  await pane.locator(".pane-doc").getByRole("heading", { name: "Project brief" }).waitFor();
  await page.screenshot({ path: join(output, "foundry-chat.png") });
  await page.keyboard.press("Escape");
  await pane.waitFor({ state: "hidden" });
  await chips.first().click();
  await frame.getByRole("button", { name: "Plant an idea" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: graphics and sanitized documents open in the pane; chips and the pane return when the chat is reopened; Esc closes it.");
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
