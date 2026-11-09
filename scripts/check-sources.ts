/** The Sources line (pass 204 A, refined) against the real Electron app: no
 * card until there is a source (a dashed line of its own while dragging), a
 * link dropped on it, a file in the project and one from elsewhere, the +
 * field refusing words and keeping a link, the model told and reading one
 * (its step says "your source", the mark gets a ring, the row a dot), and ×.
 *   xvfb-run -a -s "-screen 0 1600x1000x24" bun scripts/check-sources.ts
 * Run bun scripts/prepare-desktop.ts first. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/sources");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");

const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
let system = "", readBack = "";
const f = await fixture({
  providerId: "test", modelId: "test-model", contextCapacity: 200000, maxOutputTokens: 4096,
  async listModels() { return [{ id: "test-model", provider: "test", contextWindow: 200000 }]; },
  async *stream(messages: ProviderMessage[]): AsyncGenerator<ProviderStreamEvent> {
    system = messages[0]?.content ?? "";
    const asked = JSON.stringify(messages.at(-1));
    const id = /- ([a-z0-9-]+): file schema\.sql/.exec(system)?.[1];
    const tool = messages.findLast((message) => message.role === "tool");
    if (asked.includes("checkout") && id && !tool) {
      yield { type: "tool_call_delta", index: 0, idDelta: "src-1", nameDelta: "read_source", argumentsDelta: JSON.stringify({ id }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (tool) readBack = tool.content ?? "";
    yield { type: "text_delta", delta: tool ? "Orders by user_id has no index in your schema.sql." : "I’ll check them whenever a question needs them." };
    yield { type: "finish", reason: "stop" };
  },
});
mkdirSync(join(f.workspace, "db"));
writeFileSync(join(f.workspace, "db", "schema.sql"), "create table orders(id int, user_id int);\n");
mkdirSync(join(f.root, "away"));
writeFileSync(join(f.root, "away", "orders.csv"), "id,total\n1,20\n2,35\n");

const app = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 });
  const editor = page.locator("#composer textarea").first();
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("I'll be asking about checkout this week. Keep these handy.");
  await page.keyboard.press("Enter");
  await page.getByText("I’ll check them whenever a question needs them.").first().waitFor({ timeout: 20_000 });
  const card = page.locator('#cards [data-card="sources"]');
  expect(await card.count() === 0, "no sources, no card");
  expect(!system.includes("Sources the person keeps"), "and the model isn't told about any");

  // Something dragged over the window: a dashed line of its own; a link dropped on it is kept.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/uri-list", "https://example.com/docs/checkout");
    document.querySelector("#conversation")!.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
  });
  await card.waitFor({ timeout: 5_000 });
  expect(await card.evaluate((node) => node.classList.contains("src-ghost")), "dragging shows the dashed line");
  expect((await card.innerText()).includes("Drop to keep it with this chat"), "it says what a drop does");
  await page.screenshot({ path: join(output, "ghost.png") });
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/uri-list", "https://example.com/docs/checkout");
    document.querySelector('#cards [data-card="sources"]')!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.locator("#cards .src-row").first().waitFor({ timeout: 15_000 });
  expect((await page.locator("#cards .src-row").first().innerText()).includes("example.com/docs/checkout"), "the dropped link is kept, and the card shows it landing");
  await page.screenshot({ path: join(output, "landed.png") });

  // A file in the project stays put; one from elsewhere is copied in.
  const sessionId = (await f.client.listSessions()).find((session) => session.turns.some((turn) => turn.content.includes("Keep these handy")))!.id;
  const keep = (path: string) => page.evaluate((args) => (window as unknown as { demesne: { request: (method: string, args: unknown) => Promise<unknown> } }).demesne.request("source-add", args), { path, sessionId });
  await keep(join(f.workspace, "db", "schema.sql"));
  await keep(join(f.root, "away", "orders.csv"));
  await page.locator("#cards .src-row").nth(2).waitFor({ state: "attached", timeout: 5_000 });
  await page.waitForTimeout(1800);
  const rows = await page.locator("#cards .src-row").allInnerTexts();
  expect(rows[0]!.includes("orders.csv") && rows[0]!.includes("copied into the chat"), `newest first, copied from elsewhere: ${rows[0]!.replace(/\s+/g, " ")}`);
  expect(rows[1]!.includes("schema.sql") && rows[1]!.includes("in this project · db/"), `the project file stays put: ${rows[1]!.replace(/\s+/g, " ")}`);
  const marks = await card.locator(".src-marks .src-k").allInnerTexts();
  expect(marks.join(",") === "CSV,SQL,E", `the line's marks: ${marks.join(",")}`);

  // Rows only on hover; the + only on hover.
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  expect(!(await page.locator("#cards .src-row").first().isVisible()), "at rest it's one line");
  expect(await card.locator(".src-add").evaluate((node) => getComputedStyle(node).opacity === "0"), "the + hides at rest");
  await page.screenshot({ path: join(output, "line.png") });
  await card.locator(".src-head").hover();
  await page.waitForTimeout(500);
  expect(await page.locator("#cards .src-row").first().isVisible(), "hover unfolds the rows");
  await page.screenshot({ path: join(output, "unfolded.png") });

  // The + field: words are refused, a link is kept.
  await card.locator(".src-add").click();
  const input = card.locator(".src-input");
  await input.waitFor({ timeout: 3_000 });
  await input.fill("checkout is slow on mobile");
  await input.press("Enter");
  await card.locator(".src-hint.bad").waitFor({ timeout: 3_000 });
  expect((await card.locator(".src-hint").innerText()).startsWith("That isn’t a link"), "words aren't a link, and it says so");
  expect(await card.locator(".src-input").inputValue() === "checkout is slow on mobile", "what you typed stays");
  await page.screenshot({ path: join(output, "not-a-link.png") });
  await card.locator(".src-input").fill("https://example.org/pricing");
  await card.locator(".src-input").press("Enter");
  await page.locator("#cards .src-row", { hasText: "example.org/pricing" }).waitFor({ state: "attached", timeout: 15_000 });
  expect(await card.locator(".src-field").count() === 0, "the field closes once it's kept");
  expect(await card.locator(".src-marks .src-more").count() === 0 && await card.locator(".src-marks .src-k").count() === 4, "four marks");

  // Asked: the model is told, reads one, and the step says so.
  await editor.click();
  await page.keyboard.type("Why does checkout take 2 seconds?");
  await page.keyboard.press("Enter");
  await page.getByText("Orders by user_id has no index in your schema.sql.").first().waitFor({ timeout: 20_000 });
  expect(system.includes("Sources the person keeps with this chat") && /: file schema\.sql \(in the project at db\/schema\.sql\)/.test(system), "the model gets one line per source");
  expect(readBack.includes("create table orders"), "read_source read the file");
  await page.mouse.move(10, 10);
  await page.waitForTimeout(500);
  await page.getByText("1 step", { exact: true }).last().click();
  await page.waitForTimeout(400);
  const step = page.locator(".tool-row", { hasText: "your source" });
  expect(await step.count() === 1, "the step says “your source”");
  expect((await step.innerText()).includes("schema.sql"), "and names it");
  expect(await card.locator(".src-marks .src-k.used").count() === 1, "its mark gets a ring");
  await page.screenshot({ path: join(output, "used.png") });
  await card.locator(".src-head").hover();
  await page.waitForTimeout(400);
  expect(await card.locator(".src-row.used").count() === 1 && (await card.locator(".src-row.used").innerText()).includes("schema.sql"), "its row gets the dot");
  await page.screenshot({ path: join(output, "used-rows.png") });

  // × takes one off.
  const before = await card.locator(".src-row").count();
  const first = card.locator(".src-row").first();
  await first.hover();
  await first.locator(".src-x").click();
  await page.waitForFunction((n) => document.querySelectorAll("#cards .src-row").length === n - 1, before, { timeout: 5_000 });
  expect(true, "× takes it off");
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(output, "after.png") });
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
