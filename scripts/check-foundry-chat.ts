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
// The page leans on the kit, as the brief asks: base.css for its look, anime.js for its motion.
const mockup = (blue = false) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/anime.js"></script><style>
:root{--accent:${blue ? "#3158ba" : "#285b48"}}body{padding:24px}h1{font-size:38px;margin:16px 0}input{margin:8px 0}
</style></head><body><main class="container narrow"><span class="eyebrow">Foundry · live mockup</span><h1>A little room to grow</h1>
<p>Try this mockup right inside the conversation.</p><input aria-label="Your idea" placeholder="Name your next idea">
<div class="row"><div class="card" data-option="A · Pills">A · Pills</div><div class="card" data-option="B · Joined">B · Joined</div></div>
<button id="counter" class="primary" onclick="this.textContent='Planted '+(++window.plants)">Plant an idea</button>
<script>window.plants=0;var tl=anime.createTimeline({autoplay:false});tl.add("h1",{opacity:[0,1],duration:400}).add("button",{y:[8,0],duration:300});demesne.motion("Arrive",tl);tl.play();</script></main></body></html>`;
const f = await fixture({
  providerId: "fixture", modelId: "foundry-chat",
  async listModels() { return [{ id: "foundry-chat", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    const at = messages.findLastIndex(message => message.role === "user");
    const request = messages[at]?.content ?? "";
    const current = messages.slice(at + 1).filter(message => message.role === "tool");
    if (/^I pick /.test(request)) { yield { type: "text_delta", delta: "Going with that." }; yield { type: "finish", reason: "stop" }; return; }
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
        edits: [{ find: "#285b48", replace: "#3158ba" }] });
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
  // Its first show asks for the assembly, but a page that moves by itself
  // (the kit's anime.js) is served plain: its own Arrive motion is the
  // arrival, and the assembly would cancel it and leave the page faded.
  const assembled = async () => {
    assert.match((await pane.locator("iframe.pane-frame").getAttribute("src"))!, /[?&]assemble=1$/, "a version's first show asks for the assembly");
    const inner = page!.frames().find(item => item.url().includes("assemble=1"));
    assert(inner, "the first-show frame is reachable");
    await eventually(async () => inner.evaluate(() => (window as unknown as { anime?: unknown }).anime !== undefined && document.documentElement.style.visibility === ""));
    // The kit reached the page: its stylesheet and its anime.js, and no assembly beside it.
    assert.equal(await inner.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--radius").trim()), "8px", "foundry://kit/base.css is served to the frame");
    assert.equal(await inner.evaluate(() => document.querySelectorAll("script:not([src])").length), 1, "a page that moves by itself is not served the assembly");
    assert.equal(await inner.evaluate(() => "__demesnePrevious" in window), false, "no assembly, no previous version to diff");
  };
  await assembled();
  // The page named a motion: the thin line under the page plays, scrubs and replays it.
  const motion = pane.locator(".pane-motion");
  await motion.getByRole("button", { name: "Arrive" }).waitFor();
  await eventually(async () => (await motion.locator(".mo-time").textContent())?.startsWith("0.70s / 0.70s") ?? false);
  await motion.getByRole("button", { name: "Replay" }).click();
  await eventually(async () => (await motion.getByRole("button", { name: "Pause", exact: true }).count()) === 1);
  await motion.getByRole("button", { name: "Pause", exact: true }).click();
  await eventually(async () => (await motion.getByRole("button", { name: "Play", exact: true }).count()) === 1);
  await motion.locator(".mo-scrub").fill("500");
  await eventually(async () => (await motion.locator(".mo-time").textContent())?.startsWith("0.35s") ?? false);
  console.log("Motion line passed.");
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
  // One line above the page and nothing below it: no foot, no Revise, Copy only in code view.
  assert.equal(await pane.locator(".pane-foot").count(), 0, "the pane has no foot");
  assert.equal(await pane.getByRole("button", { name: "Revise" }).count(), 0, "the composer revises, not the pane");
  assert.equal(await pane.getByRole("button", { name: "Copy the source" }).count(), 0, "Copy is only in code view");
  await pane.getByRole("button", { name: "Code", exact: true }).click();
  await pane.locator(".pane-code").filter({ hasText: "window.plants=0" }).waitFor();
  await pane.getByRole("button", { name: "Copy the source" }).waitFor();
  await pane.getByRole("button", { name: "Code", exact: true }).click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("PASS: /foundry makes a chip and opens the pane; the page's state survives streaming, completion, step folding and the pane's controls.");

  await editor.fill("Make it blue"); await editor.press("Enter");
  // The artifact keeps its one chip; the turn that changed it says so in a quiet line.
  await chips.nth(1).filter({ hasText: "Edited Idea garden · v2" }).waitFor();
  assert.equal(await chips.nth(1).locator(".fd-chip-ic").count(), 0, "a change is a line, not a second chip");
  await eventually(async () => (await f.client.foundryGet(artifact.id)).version === 2);
  assert.equal(await chips.nth(1).getAttribute("data-artifact-id"), artifact.id);
  assert.match((await f.client.foundryGet(artifact.id)).source, /#3158ba/);
  assert.equal((await f.client.foundryGet(artifact.id)).versions[0]!.note, "Blue");
  // The pane follows the chat onto the new version; the arrows walk back.
  await pane.locator(".pane-v").filter({ hasText: "v2" }).waitFor();
  await frame.getByRole("heading", { name: "A little room to grow" }).waitFor();
  // A revision's first show is the page's own motion again, with no assembly diff.
  await assembled();
  assert.equal(await chips.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(await chips.nth(0).getAttribute("aria-pressed"), "false");
  await pane.getByRole("button", { name: "Earlier version" }).click();
  await pane.getByRole("button", { name: "Make this the latest" }).waitFor();
  assert.equal(await chips.nth(0).getAttribute("aria-pressed"), "true");
  await pane.getByRole("button", { name: "Later version" }).click();
  await eventually(async () => (await pane.locator(".pane-v").getAttribute("title"))?.startsWith("Blue") ?? false);
  assert.equal(await pane.getByRole("button", { name: "Make this the latest" }).count(), 0, "the latest needs no Make this the latest");
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
  // Options the page marked get a Pick button on hover; it sends the choice to the chat.
  await frame.locator('[data-option="B · Joined"]').hover({ position: { x: 4, y: 4 } });
  const pick = frame.locator("button.demesne-pick");
  await pick.waitFor();
  assert.equal(await pick.textContent(), "Pick B", "the button names the option's letter");
  await pick.click();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.some(turn => turn.content === "I pick B · Joined"));
  await page.locator("#conversation .request").filter({ hasText: "I pick B · Joined" }).waitFor();
  console.log("PASS: Pick on a page's option sends the choice to the chat.");
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
