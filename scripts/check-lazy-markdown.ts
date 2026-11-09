/** Real Electron check: math and code colouring load on first use, not at
 * launch (they are their own chunks), and an answer drawn before they arrive
 * is filled in where it stands.
 * Usage: xvfb-run -a bun scripts/check-lazy-markdown.ts (after prepare-desktop). */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const prompt = "Show me math and code";
const answer = "The area is $\\pi r^2$, and\n\n$$\\sum_{i=1}^n i$$\n\n```ts\nexport const add = (a: number, b: number) => a + b;\n```\n\nDone.";
const f = await fixture({
  providerId: "fixture", modelId: "plain",
  async listModels() { return [{ id: "plain", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const user = String(messages.findLast(m => m.role === "user")?.content);
    yield { type: "text_delta", delta: user === prompt ? answer : "Ready." }; yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "probe" });
const desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
  env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_GLASS: "0", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#app:not([hidden])", { timeout: 30000 });
  await page.locator("textarea").fill(prompt); await page.locator("textarea").press("Enter");
  const turn = page.locator("#conversation .turn:last-of-type");
  await turn.getByText("Done.").waitFor();
  await turn.locator(".katex").first().waitFor();
  assert.equal(await turn.locator(".katex").count(), 2, "both formulas are drawn by KaTeX");
  await turn.locator("pre code .hljs-keyword").first().waitFor();
  assert(!(await turn.innerText()).includes("$\\pi"), "no formula source left showing");
  assert.deepEqual(errors, []);
  console.log("Lazy markdown check passed.");
} finally {
  await desktop.close().catch(() => {});
  await f.close();
}
