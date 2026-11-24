/** Real Electron check for pass 273 A, Foundry's front page: opened from the
 * sidebar it shows a card with a picture of everything made, newest first;
 * the search finds a mockup by a word only its page shows; This project,
 * Pinned and Shared filter the cards; a pin keeps a card on top and is kept
 * on disk; a card opens the long page for that one mockup, with a line back.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:15px Inter,sans-serif;background:#f6f3ee;color:#2a2622}main{padding:40px}h1{margin:0 0 18px;font-size:30px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{background:#fff;border-radius:12px;padding:20px;min-height:120px}.card.on{outline:2px solid #2a2622}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const MADE: Record<string, { kind: "html" | "markdown"; source: string; description: string }> = {
  "Plans page": { kind: "html", description: "Coffee subscription plans, yearly first.", source: page("Choose a plan", `<div class="cards"><div class="card">Monthly<br>$18</div><div class="card on">Yearly<br>$180</div><div class="card">Gift a bag<br>$22</div></div>`) },
  "Field guide": { kind: "markdown", description: "How to take a soil sample.", source: "# Field guide\n\nTake a sample from 15 cm down, and note the plot's nitrogen reading." },
  "Trail cards": { kind: "html", description: "A trail's length and climb, on a phone.", source: page("Ridge loop", `<div class="cards"><div class="card">7.4 km</div><div class="card">410 m climb</div><div class="card">3 h</div></div>`) },
};
const walk = [{ what: "The page as it would ship.", parts: [{ name: "The heading", says: "says what it is." }, { name: "The cards", says: "one each." }], why: "Plain and quick to scan." }];

const f = await fixture({
  providerId: "fixture", modelId: "foundry-gallery",
  async listModels() { return [{ id: "foundry-gallery", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Saved it to Foundry." }; yield { type: "finish", reason: "stop" }; return; }
    const asked = JSON.stringify(messages[at]?.content ?? "");
    const title = Object.keys(MADE).find((name) => asked.includes(name))!, made = MADE[title]!;
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title, kind: made.kind, description: made.description, note: "First take", source: made.source,
      why: { direction: "Calm and plain.", look_at: "The cards.", starts_from: "new", dropped: "Nothing.", ...(made.kind === "html" ? { walkthrough: walk } : {}) } }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
const data = join(f.root, "electron-data");
mkdirSync(data, { recursive: true });
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, window: Page | undefined;
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${data}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  window = await desktop.firstWindow();
  const app = window;
  app.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  app.on("pageerror", (error) => errors.push(error.message));
  await app.locator("#composer-model").waitFor();
  const editor = app.locator("textarea");
  const ready = () => app.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  for (const title of ["Field guide", "Trail cards", "Plans page"]) {
    await ready(); await app.waitForTimeout(200);
    await editor.fill(`/foundry make the ${title}`); await editor.press("Enter");
    await app.locator("#conversation .fd-chip").filter({ hasText: title }).waitFor();
  }
  await ready();
  const ids = Object.fromEntries((await f.client.foundryList()).artifacts.map((item) => [item.title, item.id]));
  // The Trail cards are shared to a link, as Share does.
  writeFileSync(join(data, "foundry-shares.json"), JSON.stringify({ [ids["Trail cards"]!]: { slug: "abcdefabcdefabcd1234", url: "https://someone.github.io/demesne-shares/abcdefabcdefabcd1234/", version: 1 } }));

  // The sidebar opens the front page: a card for each, newest first, each with a picture.
  await app.locator('[data-action="page-open"][data-args*="foundry"]').first().click();
  const cards = app.locator("#page .fg-card");
  await step(64, async () => await cards.count() === 3);
  assert.deepEqual(await app.locator("#page .fg-card .fg-name").allTextContents(), ["Plans page", "Trail cards", "Field guide"]);
  assert.equal(await app.locator("#page .fg-chip").count(), 4);
  assert.equal(await app.locator("#page .fd-item").count(), 0, "no long page on the front page");
  await step(69, async () => app.frames().some((frame) => frame.url().startsWith(`foundry://artifact/${ids["Plans page"]}?v=1`) && !frame.url().includes("stack=1")));
  const plansFrame = app.frames().find((frame) => frame.url().startsWith(`foundry://artifact/${ids["Plans page"]}?v=1`))!;
  await step(71, async () => (await plansFrame.evaluate(() => document.body?.innerText ?? "").catch(() => "")).includes("Gift a bag"));
  await step(72, async () => ((await app.locator("#page .fg-card").nth(2).locator(".fg-doc").textContent()) ?? "").includes("nitrogen"));
  assert.ok((await app.locator("#page .fg-card").nth(1).locator(".fg-meta").textContent())?.endsWith("Shared"));
  mkdirSync("output", { recursive: true });
  await app.screenshot({ path: "output/foundry-gallery.png" });
  console.log("PASS: the sidebar opens the front page, a card with a picture of each mockup, newest first.");

  // The search finds a page by a word only its page shows, then clears.
  const search = app.locator("#fg-q");
  await search.fill("gift");
  await step(80, async () => JSON.stringify(await app.locator("#page .fg-card .fg-name").allTextContents()) === JSON.stringify(["Plans page"]));
  await search.fill("nitrogen");
  await step(82, async () => JSON.stringify(await app.locator("#page .fg-card .fg-name").allTextContents()) === JSON.stringify(["Field guide"]));
  assert.equal(await app.evaluate(() => document.activeElement?.id), "fg-q", "the search keeps the keyboard");
  await search.fill("zebra");
  await step(85, async () => ((await app.locator("#page .fg-none").textContent()) ?? "").includes("Nothing matches “zebra”."));
  await search.fill("");
  await step(87, async () => await cards.count() === 3);
  console.log("PASS: the search finds a mockup by the words on its page.");

  // Shared, and a pin: the card goes to the top, kept on disk; Pinned shows it alone.
  await app.locator("#page .fg-chip").filter({ hasText: "Shared" }).click();
  await step(92, async () => JSON.stringify(await app.locator("#page .fg-card .fg-name").allTextContents()) === JSON.stringify(["Trail cards"]));
  await app.locator("#page .fg-chip").filter({ hasText: "All" }).click();
  await step(94, async () => await cards.count() === 3);
  const field = app.locator("#page .fg-card").filter({ hasText: "Field guide" });
  await field.hover();
  await field.locator(".fg-pin").click();
  await step(98, async () => JSON.stringify(await app.locator("#page .fg-group").allTextContents()) === JSON.stringify(["Pinned", "Recent"]));
  assert.equal(await app.locator("#page .fg-card").first().locator(".fg-name").textContent(), "Field guide");
  assert.deepEqual(JSON.parse(readFileSync(join(data, "foundry-pins.json"), "utf8")), [ids["Field guide"]]);
  await app.locator("#page .fg-chip").filter({ hasText: "Pinned" }).click();
  await step(102, async () => JSON.stringify(await app.locator("#page .fg-card .fg-name").allTextContents()) === JSON.stringify(["Field guide"]));
  await app.locator("#page .fg-chip").filter({ hasText: "This project" }).click();
  await step(104, async () => await cards.count() === 3);
  await app.mouse.move(5, 5);
  await app.screenshot({ path: "output/foundry-gallery-pinned.png" });
  console.log("PASS: Shared, This project and Pinned filter the cards; a pin keeps a card on top and is kept.");

  // A card opens that mockup's own long page, with a line back to the front page.
  await app.locator("#page .fg-card").filter({ hasText: "Plans page" }).locator(".fg-go").click();
  await app.locator(`#page [data-fd="${ids["Plans page"]}:1"]`).waitFor();
  assert.equal(await app.locator("#page .fd-item").count(), 1);
  assert.equal(await app.locator("#page .fg-one h1").textContent(), "Plans page");
  await app.waitForTimeout(600);
  await app.screenshot({ path: "output/foundry-gallery-one.png" });
  await app.locator("#page .fg-back").click();
  await step(116, async () => await cards.count() === 3);
  console.log("PASS: a card opens the long page for that one mockup, and the line goes back.");

  // A link in a chat still opens the mockup's own page.
  await app.locator('[data-action="page-open"][data-args*="foundry"]').first().click();
  await app.locator("#conversation .fd-chip").filter({ hasText: "Trail cards" }).click();
  await app.locator(`#page [data-fd="${ids["Trail cards"]}:1"]`).waitFor();
  assert.equal(await app.locator("#page .fd-item").count(), 1);
  console.log("PASS: a link in the chat opens that mockup's own page.");
  // Step 2: a kind starts a new chat in this project with its words ready, and nothing runs until you send.
  await app.locator("#page .fg-back").click();
  await app.locator("#page .fg-mk").first().waitFor();
  assert.deepEqual(await app.locator("#page .fg-mk").allTextContents(), ["Page", "Deck", "Doc", "Sheet", "Dashboard", "Diagram", "Whiteboard"]);
  assert.equal(await app.locator("#page .fg-make-t").textContent(), "Make something new in workspace");
  await app.screenshot({ path: "output/foundry-gallery-make.png" });
  const before = (await f.client.listSessions()).length;
  await app.locator("#page .fg-mk").filter({ hasText: "Deck" }).click();
  await step(124, async () => await app.locator("#page").isHidden() && await editor.inputValue() === "/foundry Make a deck about ");
  await step(125, async () => (await f.client.listSessions()).length === before + 1);
  assert.equal(await app.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  const newest = (await f.client.listSessions()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!;
  assert.equal(newest.turns.length, 0, "nothing runs until you send");
  assert.equal(newest.workspace?.root, f.workspace);
  await app.waitForTimeout(1200);
  await app.screenshot({ path: "output/foundry-gallery-make-chat.png" });
  console.log("PASS: a kind starts a new chat in this project with its words ready, and nothing runs until you send.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
