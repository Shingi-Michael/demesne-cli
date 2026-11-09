/** Any file in the composer (pass 205 A) against the real Electron app: a
 * Markdown file and a PDF-less zip picked with +, the zip refused on its chip,
 * the file sent with the message as text, a "Read" line for it, its chip in
 * the sent message, and the file kept on the Sources line.
 *   xvfb-run -a -s "-screen 0 1600x1000x24" bun scripts/check-files.ts
 * Run bun scripts/prepare-desktop.ts first. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/files");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
let asked = "";
const f = await fixture({
  providerId: "test", modelId: "test-model", contextCapacity: 200000, maxOutputTokens: 4096,
  async listModels() { return [{ id: "test-model", provider: "test", contextWindow: 200000 }]; },
  async *stream(messages: ProviderMessage[]): AsyncGenerator<ProviderStreamEvent> {
    asked = messages.findLast((message) => message.role === "user")?.content ?? "";
    yield { type: "text_delta", delta: asked.includes("Pro: $29") ? "Pro goes from $24 to $29." : "Send it over." };
    yield { type: "finish", reason: "stop" };
  },
});
const app = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 });
  const editor = page.locator("#composer textarea").first();
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("I'll send you this week's pricing.");
  await page.keyboard.press("Enter");
  await page.getByText("Send it over.").first().waitFor({ timeout: 20_000 });
  expect((await page.locator("#attach-input").getAttribute("accept")) === null, "the + takes any file");
  await page.locator("#attach-input").setInputFiles([
    { name: "pricing-2026.md", mimeType: "text/markdown", buffer: Buffer.from("# Pricing 2026\n\nPro: $29 a month (was $24)\n") },
    { name: "assets.zip", mimeType: "application/zip", buffer: Buffer.from([80, 75, 3, 4, 20, 0, 0, 0, 8, 0]) },
  ]);
  const good = page.locator("#attach-row .fc:not(.bad)"), bad = page.locator("#attach-row .fc.bad");
  await good.waitFor({ timeout: 10_000 });
  await bad.waitFor({ timeout: 10_000 });
  expect((await good.innerText()).includes("pricing-2026.md") && (await good.locator(".fc-k").innerText()) === "MD", `the file's chip: ${(await good.innerText()).replace(/\s+/g, " ")}`);
  expect((await bad.innerText()).includes("can’t be read · zip"), `the zip says it can't be read: ${(await bad.innerText()).replace(/\s+/g, " ")}`);
  await page.screenshot({ path: join(output, "composer.png") });
  await editor.click();
  await page.keyboard.type("What changed in pricing?");
  await page.keyboard.press("Enter");
  await page.getByText("Pro goes from $24 to $29.").first().waitFor({ timeout: 20_000 });
  expect(asked.includes('<file name="pricing-2026.md">') && asked.includes("Pro: $29 a month"), "the model got the file's text with the message");
  expect(!asked.includes("assets.zip"), "the zip wasn't sent");
  expect(await page.locator("#attach-row .fc").count() === 0, "the composer is clear after sending");
  expect(await page.locator(".request-att .fc", { hasText: "pricing-2026.md" }).count() === 1, "the sent message shows the file");
  expect(await page.locator(".file-read", { hasText: "pricing-2026.md" }).count() === 1, "a Read line for it");
  const sources = page.locator('#cards [data-card="sources"]');
  await sources.waitFor({ timeout: 5_000 });
  expect((await sources.locator(".src-marks").innerText()).includes("MD"), "it's kept on the Sources line");
  expect(await page.locator("#cards .card.pile").count() === 0, "a file isn't a screenshot: no pile");
  await page.mouse.move(10, 10);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, "sent.png") });
} catch (error) {
  failures.push(String(error));
  console.log("FAIL", error);
} finally {
  await app.close();
  f.server.stop?.(true);
}
if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
