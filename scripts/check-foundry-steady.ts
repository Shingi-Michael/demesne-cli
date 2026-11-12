/** Real Electron check: a Foundry turn says a few words, streams a page into
 * foundry_save, then answers. The turn redraws when a step starts or ends,
 * and each redraw moves the answer; words that already faded in must not
 * fade in again (the chat's text blinked on every Foundry step).
 * Usage: xvfb-run -a bun scripts/check-foundry-steady.ts (after prepare-desktop). */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const prompt = "Mock a calmer tab bar";
const source = `<!doctype html><link rel="stylesheet" href="foundry://kit/base.css"><main class="container"><h1>Calmer tabs</h1>${Array.from({ length: 40 }, (_, i) => `<button class="pill">Tab ${i}</button>`).join("")}</main>`;
const args = JSON.stringify({ title: "Calmer tab bar", kind: "html", description: "A calmer tab bar.", why: { direction: "Calm and plain, for a quick try.", look_at: "The main heading." }, source });
const PIECES = 30;
const f = await fixture({
  providerId: "fixture", modelId: "slow",
  async listModels() { return [{ id: "slow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const user = String(messages.findLast(m => m.role === "user")?.content);
    const done = messages.slice(messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "tool").length;
    if (user === prompt && !done) {
      for (const word of "I'll mock it in Foundry so you can try it.".split(" ")) { await Bun.sleep(60); yield { type: "text_delta", delta: `${word} ` }; }
      const step = Math.ceil(args.length / PIECES);
      for (let i = 0; i < args.length; i += step) {
        await Bun.sleep(100);
        yield { type: "tool_call_delta", index: 0, idDelta: i === 0 ? "save-1" : "", nameDelta: i === 0 ? "foundry_save" : "", argumentsDelta: args.slice(i, i + step) };
      }
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    for (const word of "Here it is: a quieter bar with pills, and a dot while a tab works. Open it from the link below.".split(" ")) {
      await Bun.sleep(80); yield { type: "text_delta", delta: `${word} ` };
    }
    yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "probe" });
const desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
  env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_GLASS: "0", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(30000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#app:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(1500);
  // A word whose fade ended and then starts again is a blink.
  await page.evaluate(() => {
    const w = window as any; w.faded = 0; w.again = 0;
    document.addEventListener("animationend", (e) => { if (e.animationName === "md-in") { w.faded++; (e.target as any).__faded = true; } }, true);
    document.addEventListener("animationstart", (e) => { if (e.animationName === "md-in" && (e.target as any).__faded) w.again++; }, true);
  });
  await page.locator("textarea").fill(prompt); await page.locator("textarea").press("Enter");
  await page.locator("#conversation .fd-chip").waitFor();
  await page.locator("#conversation .turn:last-of-type").getByText("Open it from the link below.").waitFor();
  await page.waitForTimeout(800);
  const { faded, again, left } = await page.evaluate(() => ({ faded: (window as any).faded, again: (window as any).again, left: document.querySelectorAll("#conversation .md-in").length }));
  console.log(`words faded in: ${faded}; faded in again: ${again}; still fading: ${left}`);
  assert.ok(faded > 0, "the answer's words fade in as they stream");
  assert.equal(again, 0, "no word fades in twice when the turn redraws around it");
  assert.equal(left, 0, "a finished turn has no fades left to replay");
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS: the chat's text stays still while Foundry works.");
} finally { await desktop.close(); await f.close(); }
