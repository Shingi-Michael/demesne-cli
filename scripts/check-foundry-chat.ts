/** Real Electron check: invoke Foundry in chat, and its link opens what it
 * made on the Foundry page itself: clean, with only back and its versions,
 * and no split view beside the chat. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const response = Promise.withResolvers<void>();
/// The first save's arguments arrive in two parts: the title, then the page,
/// once the turn has started.
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
      const graphic = /graphic/i.test(request), document = /document/i.test(request), deck = /slide deck/i.test(request);
      const save = call("foundry_save", { title: graphic ? "A simple badge" : document ? "Project brief" : deck ? "Q1 launch" : "Idea garden",
        kind: graphic ? "svg" : document ? "markdown" : deck ? "deck" : "html",
        source: deck ? "---\ntheme: forest\n---\n# Q1 launch\nWhat the free tier did.\n\n---\n\n# 3.1×\nSign-ups a week.\n\n---\n\n## Sign-ups\n```chart\nlabels: W1, W2, W3\nvalues: 1200, 2400, 3700\n```"
          : graphic ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#285b48"/></svg>'
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
  const foundry = page.locator('#page[data-kind="foundry"]'), frame = page.frameLocator('#page iframe.fd-frame');
  const chat = page.locator(`#sidebar-chats [data-action="select-session"][data-args*="${plain.id}"]`);
  /// Sends once the window knows the last turn is over, so Enter isn't lost.
  const send = async (text: string) => {
    await page!.waitForFunction(() => !(window.demesneInspect?.() as { host?: { busy?: boolean } })?.host?.busy);
    await page!.waitForTimeout(200);
    await editor.fill(text); await editor.press("Enter");
  };
  /// Back to the conversation from the Foundry page.
  const backToChat = async () => { await chat.first().click(); await eventually(async () => await page!.locator("#page").isHidden()); };
  // While Foundry writes and tries the page, nothing opens.
  await page.locator("#conversation .turn").first().waitFor();
  assert(await page.locator("#page").isHidden(), "nothing opens while Foundry works");
  making.resolve();
  // The page arrives as a link (its chip) in the chat; it opens only when clicked.
  await chips.first().filter({ hasText: "Idea garden" }).waitFor();
  await page.waitForTimeout(400);
  assert(await page.locator("#page").isHidden(), "a new page waits for its link to be opened");
  // Foundry works quietly: its own checks (foundry_try) are never a step row.
  assert.equal(await page.locator("#conversation .tool-row").filter({ hasText: /^Tried/ }).count(), 0, "no Tried rows");
  // There is no split view any more: the link opens the Foundry page itself.
  assert.equal(await page.locator("#pane").count(), 0, "no pane beside the chat");
  assert.equal(await page.locator("#conversation iframe").count(), 0, "Nothing live runs in the conversation");
  await chips.first().click();
  await foundry.locator(".fd-open").waitFor();
  await frame.getByRole("button", { name: "Plant an idea" }).waitFor();
  // The kit reached the page: its stylesheet and its anime.js, and no assembly beside it.
  const served = async (inline: number) => {
    const inner = page!.frames().find(item => item.url().startsWith("foundry://artifact/"));
    assert(inner, "the page's frame is reachable");
    await eventually(async () => inner.evaluate(() => (window as unknown as { anime?: unknown }).anime !== undefined));
    assert.equal(await inner.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--radius").trim()), "8px", "foundry://kit/base.css is served to the frame");
    assert.equal(await inner.evaluate(() => document.querySelectorAll("script:not([src])").length), inline, "the page is served as written");
    assert.equal(await inner.evaluate(() => "__demesnePrevious" in window), false, "no assembly");
    assert.equal(await inner.evaluate(() => document.querySelectorAll("button.demesne-pick").length), 0, "no Pick button on the page");
  };
  await served(1);
  // The page is clean: one line above it holds back, its name and its version. Nothing else.
  assert.deepEqual(await foundry.locator(".fd-line button").evaluateAll((items) => items.map((item) => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim())),
    ["Foundry", "Earlier version", "Later version"], "the open mockup's line: back and versions only");
  assert.equal(await foundry.locator(".fd-line .fd-title").textContent(), "Idea garden");
  const artifact = (await f.client.foundryList()).artifacts[0]!;
  assert.equal(artifact.workspace, null, "No project is required");
  await frame.getByRole("button", { name: "Plant an idea" }).click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-open.png") });
  console.log("PASS: /foundry makes a link that opens the Foundry page, clean, with the page live.");
  await backToChat();
  response.resolve();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-chat.png") });

  await send("Make it blue");
  // The turn that changed it ends with its own chip, a link to the newest version.
  await chips.nth(1).filter({ hasText: "Idea garden" }).filter({ hasText: "Prototype · v2" }).waitFor();
  assert.equal(await chips.nth(1).locator(".fd-chip-thumb").count(), 1, "a change gets a full link card, not a faint line");
  await eventually(async () => (await f.client.foundryGet(artifact.id)).version === 2);
  assert.equal(await chips.nth(1).getAttribute("data-artifact-id"), artifact.id);
  assert.match((await f.client.foundryGet(artifact.id)).source, /#3158ba/);
  assert.equal((await f.client.foundryGet(artifact.id)).versions[0]!.note, "Blue");
  assert(await page.locator("#page").isHidden(), "a new version doesn't take the window over");
  await chips.nth(1).click();
  await foundry.locator(".fd-vers").filter({ hasText: "v2" }).waitFor();
  await frame.getByRole("heading", { name: "A little room to grow" }).waitFor();
  await foundry.getByRole("button", { name: "Earlier version" }).click();
  await foundry.locator(".fd-vers").filter({ hasText: "v1" }).waitFor();
  await foundry.getByRole("button", { name: "Later version" }).click();
  await foundry.locator(".fd-vers").filter({ hasText: "v2" }).waitFor();
  console.log("PASS: a follow-up edits the artifact in place (foundry_edit); its link opens v2 and the arrows walk the versions.");
  await backToChat();

  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await send("Make an SVG badge graphic");
  await chips.nth(2).filter({ hasText: "Graphic · v1" }).waitFor();
  await chips.nth(2).click();
  await frame.locator("img").waitFor();
  await backToChat();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await send("Make a project brief document");
  await chips.nth(3).filter({ hasText: "Document · v1" }).waitFor();
  await chips.nth(3).click();
  await foundry.locator(".fd-doc").getByRole("heading", { name: "Project brief" }).waitFor();
  assert.equal(await foundry.locator(".fd-doc script").count(), 0);
  await backToChat();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await page.reload();
  await chat.first().click();
  await chips.nth(3).filter({ hasText: "Document · v1" }).waitFor();
  assert.equal(await chips.count(), 4, "Chips return with the conversation history");
  // The wall: only mockups, with nothing to press on them but the mockup itself.
  await chips.first().click();
  await foundry.getByRole("button", { name: "Foundry" }).click();
  await foundry.locator(".fd-wall .fd-card").first().waitFor();
  assert.equal(await foundry.locator("form, input, .cp-tabs, .cp-lede").count(), 0, "the wall is only mockups: no make box, kinds or lede");
  await foundry.locator(".fd-card").filter({ hasText: "Idea garden" }).hover();
  assert.equal(await foundry.locator(".fd-card button:not(.fd-card-open)").count(), 0, "no export or delete on the wall");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-wall.png") });
  await backToChat();
  // A deck is content Demesne draws: slides with a strip.
  await send("Make a slide deck for the launch");
  await chips.filter({ hasText: "Deck · v1" }).first().waitFor();
  await chips.filter({ hasText: "Deck · v1" }).first().click();
  await eventually(async () => await frame.locator(".deck-stage > .slide").count() === 3 && await frame.locator(".deck-thumb").count() === 3);
  assert.equal(await frame.locator("html").getAttribute("data-look"), "forest");
  assert.equal(await frame.locator(".slide.on").getAttribute("data-layout"), "title");
  assert.equal(await foundry.getByRole("button", { name: "Play the deck" }).count(), 0, "no Play button");
  await frame.locator(".deck-thumb").nth(1).click();
  await eventually(async () => await frame.locator(".slide.on").getAttribute("data-layout") === "number");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-deck.png") });
  console.log("PASS: a deck is drawn from content and walks with its strip.");
  assert.deepEqual(errors, []);
  console.log("PASS: graphics, documents and decks open on the Foundry page; chips return when the chat is reopened.");
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
