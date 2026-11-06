/** Real Electron check for pages that remember (pass 164 A): a Foundry page
 * saves what you tick, still has it after the pane closes and the page is
 * shown again, and asks the chat's model a question from a button. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

// No script tag for the runtime: Demesne puts it in front of a page that calls it.
const checklist = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"></head>
<body><main class="container narrow"><h1>Lisbon checklist</h1><p id="count">…</p>
<label><input type="checkbox" data-item="flights"> Book the flights</label><br>
<label><input type="checkbox" data-item="camera"> Pack the camera</label><br>
<button id="forgot" class="primary">What did I forget?</button><p id="answer"></p></main>
<script>
const boxes = [...document.querySelectorAll("[data-item]")];
const count = () => document.getElementById("count").textContent = boxes.filter(b => b.checked).length + " of " + boxes.length + " done";
demesne.load("done", {}).then(done => { boxes.forEach(b => b.checked = !!done[b.dataset.item]); count(); document.body.dataset.ready = "1"; });
boxes.forEach(b => b.addEventListener("change", async () => {
  count(); await demesne.save("done", Object.fromEntries(boxes.map(x => [x.dataset.item, x.checked]))); document.body.dataset.saved = String(Number(document.body.dataset.saved || 0) + 1);
}));
document.getElementById("forgot").onclick = async () => { document.getElementById("answer").textContent = await demesne.ask("I packed: " + boxes.filter(b => b.checked).map(b => b.dataset.item).join(", ") + ". What did I forget?"); };
</script></body></html>`;

let asked = "";
const f = await fixture({
  providerId: "fixture", modelId: "foundry-remember",
  async listModels() { return [{ id: "foundry-remember", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    // A page's own question: the ask prompt, no tools.
    if (String(messages[0]?.content).startsWith("You answer a question asked from inside a page")) {
      asked = String(messages.at(-1)?.content);
      yield { type: "text_delta", delta: "A plug adapter, Portugal is type F." }; yield { type: "finish", reason: "stop" }; return;
    }
    const at = messages.findLastIndex(message => message.role === "user");
    if (messages.slice(at + 1).some(message => message.role === "tool")) { yield { type: "text_delta", delta: "Your checklist remembers what you tick." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: "save-1", nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Lisbon checklist", kind: "html", source: checklist }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  const executable = process.argv[2];
  desktop = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}),
    args: [...(executable ? [] : [resolve("apps/desktop/build/app")]), `--user-data-dir=${join(f.root, "electron-remember")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  await page.locator('.sidebar-nav button[aria-label="New chat"]').click();
  await eventually(async () => (await f.client.listSessions()).some(session => !session.workspace));
  const plain = (await f.client.listSessions()).find(session => !session.workspace)!;
  await page.waitForFunction(id => { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return host?.session === id && !host.busy; }, plain.id);
  await page.locator("textarea").fill("Make me a trip checklist that remembers what I tick");
  await page.locator("textarea").press("Enter");
  const pane = page.locator("#pane"), frame = pane.frameLocator("iframe.pane-frame");
  await frame.locator("body[data-ready='1']").waitFor();
  assert.equal(await frame.locator("#count").textContent(), "0 of 2 done");
  const artifact = (await f.client.foundryList()).artifacts[0]!;
  // Ticking saves to Demesne, kept with the artifact.
  await frame.getByLabel("Pack the camera").check();
  await frame.locator("body[data-saved='1']").waitFor();
  assert.deepEqual((await f.client.foundryData(artifact.id)).data, { done: { flights: false, camera: true } });
  console.log("PASS: a tick is saved with the artifact.");
  // Close the pane and open the page again from its chip: the tick is back.
  await pane.locator('[data-pane="close"]').click();
  await eventually(async () => (await page!.locator("#pane iframe.pane-frame").count()) === 0);
  await page.locator("#conversation .fd-chip").filter({ hasText: "Lisbon checklist" }).first().click();
  await frame.locator("body[data-ready='1']").waitFor();
  assert.equal(await frame.getByLabel("Pack the camera").isChecked(), true, "the tick survives closing the pane");
  assert.equal(await frame.locator("#count").textContent(), "1 of 2 done");
  console.log("PASS: the page remembers after closing.");
  // The page asks the chat's model from a button.
  await frame.getByRole("button", { name: "What did I forget?" }).click();
  await frame.locator("#answer").filter({ hasText: "plug adapter" }).waitFor();
  assert.match(asked, /The page: Lisbon checklist/);
  assert.match(asked, /I packed: camera/);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-remember.png") });
  console.log("PASS: the page asks the model and shows the answer.");
  // Another page can't reach this one's saves: a wrong key is refused.
  const refused = await page.evaluate(async () => { try { const response = await fetch("foundry://data/whatever", { method: "POST", body: JSON.stringify({ page: "nope" }) }); return response.status; } catch (error) { return String(error); } });
  assert(refused === 403 || typeof refused === "string", `a wrong key is refused (${refused})`);
  assert.deepEqual(errors, []);
  console.log("PASS: pages that remember.");
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "foundry-remember-failure.png") }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  await f.close();
}
