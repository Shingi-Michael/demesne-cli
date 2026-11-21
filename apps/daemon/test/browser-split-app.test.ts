import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";
import type { BrowserDriver, BrowserFrame } from "../src/browser.ts";

// Pass 248 D from the desktop's side: the newest picture of a chat's browser,
// your input only while the model has handed you the page, and handing it back.

const directories: string[] = [];
const apps: DaemonApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close?.();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("the split gets the chat's newest picture, and input only while the page is yours", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-split-"));
  directories.push(directory);
  const sent: Record<string, unknown>[] = [];
  const frame: BrowserFrame = { seq: 3, jpeg: "/9j/", width: 1280, height: 800, url: "https://shop.example/login", title: "Sign in", handover: false };
  const browser = Object.assign((async (_chat, command) => { sent.push(command); return command.action === "handover" && command.on === true ? { url: frame.url, title: frame.title, handover: true } : { url: frame.url, title: frame.title, ok: true }; }) as BrowserDriver,
    { frame: async (_chat: string, after: number) => after < frame.seq ? frame : null });
  const app = createDaemonApp({ databasePath: join(directory, "data", "demesne.sqlite"), browser });
  apps.push(app);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, body?: unknown) => fetch(new URL(path, server.url), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const { session } = await (await call("/v1/sessions", { title: "Shop" })).json() as { session: { id: string } };
    const base = `/v1/sessions/${session.id}/browser`;
    expect(await (await call(`${base}/frame?after=0`)).json()).toEqual({ ...frame });
    expect(await (await call(`${base}/frame?after=3`)).json()).toEqual({ seq: 0 });
    expect((await call(`/v1/sessions/nope/browser/frame`)).status).toBe(404);
    // Not yours: refused, and nothing reached the browser.
    expect((await call(`${base}/input`, { events: [{ type: "text", text: "secret" }] })).status).toBe(409);
    expect(sent).toEqual([]);
    expect(await (await call(`${base}/hand-back`, {})).json()).toEqual({ handedBack: false });
  } finally { server.stop(true); }
});
