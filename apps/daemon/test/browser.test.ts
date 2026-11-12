import { expect, test } from "bun:test";
import { toolTarget } from "@demesne/workbench/history.ts";
import { browserReport, browserTool, BROWSER_PICTURES_PER_TURN, type BrowserDriver } from "../src/browser.ts";
import { seenToolPicture } from "../src/engine.ts";

// The model's own browser, from the daemon's side: what it sends to the
// hidden browser, and how little it reads back. scripts/check-browser.ts
// runs the real one.

const context = (turnId = "t1") => ({ sessionId: "chat-1", turnId, workspaceRoot: process.cwd(), signal: new AbortController().signal }) as never;
function fake(reply: Record<string, unknown> | null = { url: "http://localhost:5173/", title: "App" }) {
  const sent: Array<{ chat: string; command: Record<string, unknown> }> = [];
  const drive: BrowserDriver = async (chat, command) => { sent.push({ chat, command }); return reply; };
  return { sent, tool: browserTool(drive) };
}
const run = async (tool: ReturnType<typeof browserTool>, input: unknown, ctx = context()) => {
  const result = await tool.executeWithArtifacts!(input, ctx) as { text: string; images: { filename: string }[] };
  return { report: JSON.parse(result.text) as Record<string, unknown>, images: result.images };
};

test("open goes to this computer only, in the chat's own tab", async () => {
  const { sent, tool } = fake({ url: "http://localhost:5173/", title: "App", outline: ["# App", '[1] button "Save"'] });
  const { report } = await run(tool, { action: "open", url: "localhost:5173", width: "phone" });
  expect(sent).toEqual([{ chat: "chat-1", command: { action: "open", url: "http://localhost:5173/", width: "phone" } }]);
  expect(report).toEqual({ url: "http://localhost:5173/", title: "App", outline: ["# App", '[1] button "Save"'] });
  await expect(run(tool, { action: "open", url: "https://example.com" })).rejects.toThrow("the browser opens only this computer's own apps");
  await expect(run(tool, { action: "open" })).rejects.toThrow("open needs a url");
  await expect(run(tool, { action: "fly" })).rejects.toThrow("action must be one of");
  expect(sent).toHaveLength(1);
  expect(tool.permission({ action: "open", url: "localhost:5173" })).toBeNull();
});

test("acting by number sends the number, and the report is only what changed", async () => {
  const { sent, tool } = fake({ url: "http://localhost:5173/", title: "App", ok: true, did: 'button "Save"', changed: "new text “Saved”", errors: ["boom"], failed: ["GET /api → 500"] });
  const { report, images } = await run(tool, { action: "click", ref: 12 });
  expect(sent[0]!.command).toEqual({ action: "click", ref: 12 });
  expect(report).toEqual({ url: "http://localhost:5173/", title: "App", did: 'button "Save"', changed: "new text “Saved”", console_errors: ["boom"], failed_requests: ["GET /api → 500"] });
  expect(images).toEqual([]);
  await run(tool, { action: "type", ref: "Name", text: "Ada", clear: true, enter: true });
  expect(sent[1]!.command).toEqual({ action: "type", text: "Ada", ref: "Name", clear: true, enter: true });
  await run(tool, { action: "key", key: "enter" });
  expect(sent[2]!.command).toEqual({ action: "key", key: "Enter" });
  await expect(run(tool, { action: "click" })).rejects.toThrow("click needs a ref");
  await expect(run(tool, { action: "type", ref: 3 })).rejects.toThrow("type needs text");
  await expect(run(tool, { action: "key", key: "F5" })).rejects.toThrow("key must be one of");
});

test("what could not be done, long text and blocked addresses are said plainly", () => {
  expect(browserReport("click", { url: "u", title: "t", ok: false, did: "12 is no longer on the page; read it again" })).toEqual({ url: "u", title: "t", failed: "12 is no longer on the page; read it again" });
  expect(browserReport("text", { url: "u", title: "t", text: "abc", from: 0, total: 10 })).toEqual({ url: "u", title: "t", text: "abc", more: "7 more characters: text with from 3" });
  expect(browserReport("click", { url: "u", title: "t", ok: true, changed: "nothing visible changed", blocked: ["https://example.com/"] }).blocked).toEqual(["https://example.com/ is outside this computer, so it was not opened"]);
  expect(browserReport("open", { url: "u", title: "t", outline: [] }).outline).toEqual(["(no headings or controls on this page; use text to read it)"]);
});

test("a picture comes only when asked, a few a turn, and a model that sees gets it", async () => {
  const { tool } = fake({ url: "u", title: "t", png: Buffer.from("png").toString("base64") });
  const { images } = await run(tool, { action: "picture" });
  expect(images.map((image) => image.filename)).toEqual(["browser-page.png"]);
  expect(seenToolPicture("browser-page.png")).toBe(true);
  for (let i = 1; i < BROWSER_PICTURES_PER_TURN; i++) await run(tool, { action: "picture" });
  await expect(run(tool, { action: "picture" })).rejects.toThrow("pictures were taken this turn");
  expect((await run(tool, { action: "picture" }, context("t2"))).images).toHaveLength(1);
});

test("no browser, or an error from it, is an error the model can act on", async () => {
  await expect(run(fake(null).tool, { action: "read" })).rejects.toThrow("the browser did not answer");
  await expect(run(fake({ error: "No page is open yet: start with action open." }).tool, { action: "read" })).rejects.toThrow("No page is open yet");
  await expect(run(fake({ error: "Could not open: ERR_CONNECTION_REFUSED" }).tool, { action: "open", url: "localhost:9" })).rejects.toThrow("is the dev server running?");
});

test("its steps read in plain words", () => {
  expect(toolTarget("browser", { action: "open", url: "http://localhost:5173/settings" })).toBe("localhost:5173/settings");
  expect(toolTarget("browser", { action: "click", ref: 12 })).toBeUndefined();
  expect(toolTarget("browser", { action: "click", ref: "Save" })).toBe("“Save”");
  expect(toolTarget("browser", { action: "type", text: "Ada", ref: "Name" })).toBe("“Ada” into “Name”");
  expect(toolTarget("browser", { action: "wait", for: "Saved" })).toBe("for “Saved”");
});
