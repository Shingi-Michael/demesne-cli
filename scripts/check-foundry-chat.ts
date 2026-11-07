/** Real Electron check: invoke Foundry in chat, open what it made in the
 * pane beside the conversation, and keep that page interactive through
 * streaming, turn completion, revisions and replay. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
    if (/^Build this for real/.test(request)) { yield { type: "text_delta", delta: "Building it in the project." }; yield { type: "finish", reason: "stop" }; return; }
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
  const pane = page.locator("#pane"), frame = pane.frameLocator("iframe.pane-frame");
  // While Foundry writes and tries the page, the pane stays shut.
  await page.locator("#conversation .turn").first().waitFor();
  assert(await pane.isHidden(), "nothing opens while Foundry works");
  making.resolve();
  // The page arrives as a link (its chip) in the chat; the pane opens only when it's clicked.
  await chips.first().filter({ hasText: "Idea garden" }).waitFor();
  await page.waitForTimeout(400);
  assert(await pane.isHidden(), "a new page waits for its link to be opened");
  await chips.first().click();
  await frame.getByRole("button", { name: "Plant an idea" }).waitFor();
  // The kit reached the page: its stylesheet and its anime.js, and no assembly beside it.
  const served = async (inline: number) => {
    const inner = page!.frames().find(item => item.url().startsWith("foundry://artifact/"));
    assert(inner, "the page's frame is reachable");
    await eventually(async () => inner.evaluate(() => (window as unknown as { anime?: unknown }).anime !== undefined));
    assert.equal(await inner.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--radius").trim()), "8px", "foundry://kit/base.css is served to the frame");
    assert.equal(await inner.evaluate(() => document.querySelectorAll("script:not([src])").length), inline, "the page is served as written (a revision carries only the what-changed outline)");
    assert.equal(await inner.evaluate(() => "__demesnePrevious" in window), false, "no assembly");
  };
  await served(1);
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
  // A page in place of the chat hides the chat's pane; going back brings it
  // back as it was, without reloading the page in it.
  await page.locator(".sidebar-settings").click();
  await page.locator('#page[data-kind="settings"]').waitFor();
  await eventually(async () => await pane.isHidden());
  await page.locator(".sidebar-settings").click();
  await eventually(async () => await page.locator("#page").isHidden());
  await eventually(async () => await pane.isVisible());
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Pane hides behind pages passed.");
  await frame.getByRole("textbox", { name: "Your idea" }).fill("Keep my idea");
  response.resolve();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Streaming completion kept the page's state.");
  assert.equal(await frame.getByRole("textbox", { name: "Your idea" }).inputValue(), "Keep my idea");
  await page.locator('[data-action="toggle-steps"]').first().click();
  await frame.getByRole("button", { name: "Planted 1" }).waitFor();
  console.log("Step folding kept the page's state.");
  // One line above the page and nothing below it (pass 189): the title, the
  // version arrows, point and close. No code, phone, copy, export or Revise.
  assert.equal(await pane.locator(".pane-foot").count(), 0, "the pane has no foot");
  assert.deepEqual(await pane.locator(".pane-head button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label") ?? item.textContent)),
    ["Idea garden", "Earlier version", "Later version", "Point at a part to change it", "Close"], "the pane's line holds only the title, versions, point and close");
  console.log("PASS: /foundry makes a link that opens the pane; the page's state survives streaming, completion and step folding.");

  await editor.fill("Make it blue"); await editor.press("Enter");
  // The turn that changed it ends with its own chip, a link to the newest version.
  await chips.nth(1).filter({ hasText: "Idea garden" }).filter({ hasText: "Prototype · v2" }).waitFor();
  assert.equal(await chips.nth(1).locator(".fd-chip-thumb").count(), 1, "a change gets a full link card, not a faint line");
  await eventually(async () => (await f.client.foundryGet(artifact.id)).version === 2);
  assert.equal(await chips.nth(1).getAttribute("data-artifact-id"), artifact.id);
  assert.match((await f.client.foundryGet(artifact.id)).source, /#3158ba/);
  assert.equal((await f.client.foundryGet(artifact.id)).versions[0]!.note, "Blue");
  // The pane follows the chat onto the new version; the arrows walk back.
  await pane.locator(".pane-v").filter({ hasText: "v2" }).waitFor();
  await frame.getByRole("heading", { name: "A little room to grow" }).waitFor();
  // A revision's first show is the page as written; the previous version rides along only to outline what changed.
  assert.match((await pane.locator("iframe.pane-frame").getAttribute("src"))!, /[?&]first=1$/, "a new version's first show asks for the what-changed outline");
  await served(3);
  assert.equal(await chips.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(await chips.nth(0).getAttribute("aria-pressed"), "false");
  await pane.getByRole("button", { name: "Earlier version" }).click();
  await pane.locator(".pane-v").filter({ hasText: "v1" }).waitFor();
  assert.equal(await chips.nth(0).getAttribute("aria-pressed"), "true");
  await pane.getByRole("button", { name: "Later version" }).click();
  await eventually(async () => (await pane.locator(".pane-v").getAttribute("title"))?.startsWith("Blue") ?? false);
  console.log("PASS: a follow-up edits the artifact in place (foundry_edit); the pane moves to v2 and walks the versions.");
  // Point at a part: the crosshair runs the picker in the pane's page; the
  // part clicked lands as a pink chip and goes with the next message.
  await pane.getByRole("button", { name: "Point at a part to change it" }).click();
  await pane.getByRole("button", { name: "Stop pointing (Esc)" }).waitFor();
  await frame.getByRole("heading", { name: "A little room to grow" }).hover();
  await frame.getByRole("heading", { name: "A little room to grow" }).click();
  const part = page.locator("#mention-chips .point-chip.foundry");
  await part.filter({ hasText: "A little room to grow" }).waitFor();
  await pane.getByRole("button", { name: "Point at a part to change it" }).waitFor();
  assert.match((await part.getAttribute("title"))!, /On Idea garden v2/);
  await part.click();
  await eventually(async () => await part.count() === 0);
  console.log("PASS: pointing at a part of a Foundry page puts it in the composer.");

  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await editor.fill("Make an SVG badge graphic"); await editor.press("Enter");
  await chips.nth(2).filter({ hasText: "Graphic · v1" }).waitFor();
  // Another new artifact doesn't take the pane over: its link opens it.
  await frame.getByRole("heading", { name: "A little room to grow" }).waitFor();
  await chips.nth(2).click();
  await frame.locator("img").waitFor();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  await editor.fill("Make a project brief document"); await editor.press("Enter");
  await chips.nth(3).filter({ hasText: "Document · v1" }).waitFor();
  await chips.nth(3).click();
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
  // Build this: a page from Just a chat first asks which project it's for,
  // then the chat moves there and starts on it with the page as its target.
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status === "completed");
  // Foundry is a place of mockups: the title opens the wall's open view, one
  // line above the page, and Build this is there.
  await pane.locator(".pane-title").click();
  const foundry = page.locator('#page[data-kind="foundry"]');
  await foundry.locator(".fd-line").waitFor();
  assert.deepEqual(await foundry.locator(".fd-line button").evaluateAll((items) => items.map((item) => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim())),
    ["Foundry", "Earlier version", "Later version", "Build this"], "the open mockup's line: back, versions, Build this");
  await foundry.locator(".fd-frame").waitFor();
  await page.screenshot({ path: join(output, "foundry-open.png") });
  await foundry.getByRole("button", { name: "Foundry" }).click();
  await foundry.locator(".fd-wall .fd-card").first().waitFor();
  assert.equal(await foundry.locator("form, input, .cp-tabs, .cp-lede").count(), 0, "the wall is only mockups: no make box, kinds or lede");
  await foundry.locator(".fd-card").filter({ hasText: "Idea garden" }).hover();
  await foundry.getByRole("button", { name: "Delete Idea garden" }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-wall.png") });
  await foundry.getByRole("button", { name: "Open Idea garden" }).click();
  await foundry.getByRole("button", { name: "Build this" }).click();
  const moveTo = page.locator("#plain-line .where-opt").filter({ hasText: basename(f.workspace) });
  await moveTo.first().click();
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.some(turn => turn.content.startsWith(`Build this for real: the Foundry page "Idea garden" (id ${artifact.id}`)));
  assert.equal((await f.client.getSessionState(artifact.sessionId!)).session.workspace?.root, f.workspace, "the chat moved into the project it builds in");
  console.log("PASS: Build this asks a plain chat for its project, moves it there and starts building.");
  // A deck is content Demesne draws: slides with a strip, and Play covers the window until Esc.
  // The move into the project reloads the window and then sends the build;
  // wait for its answer in the reloaded window, so Enter isn't lost to the reload.
  await page.locator("#conversation").getByText("Building it in the project.").waitFor();
  // Wait until the window too knows the turn is over, or Enter would steer the finished turn.
  await eventually(async () => (await f.client.getSessionState(artifact.sessionId!)).session.turns.at(-1)?.status !== "running" && !(await page!.locator("#composer.stopping").count()));
  await editor.fill("Make a slide deck for the launch"); await editor.press("Enter");
  await chips.filter({ hasText: "Deck · v1" }).first().waitFor();
  await chips.filter({ hasText: "Deck · v1" }).first().click();
  await eventually(async () => await frame.locator(".deck-stage > .slide").count() === 3 && await frame.locator(".deck-thumb").count() === 3);
  assert.equal(await frame.locator("html").getAttribute("data-look"), "forest");
  assert.equal(await frame.locator(".slide.on").getAttribute("data-layout"), "title");
  await pane.getByRole("button", { name: "Play the deck" }).click();
  await eventually(async () => (await pane.getAttribute("class"))?.includes("playing") === true && (await frame.locator("html").getAttribute("class"))?.includes("present") === true);
  await frame.locator("body").press("ArrowRight");
  await eventually(async () => await frame.locator(".slide.on").getAttribute("data-layout") === "number");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(output, "foundry-deck-play.png") });
  await frame.locator("body").press("Escape");
  await eventually(async () => !(await pane.getAttribute("class"))?.includes("playing"));
  assert(await pane.isVisible(), "Esc ends play, and the pane stays open");
  console.log("PASS: a deck is drawn from content, plays over the window and Esc ends it.");
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
