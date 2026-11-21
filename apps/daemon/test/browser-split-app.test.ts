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
    expect(await (await call(`${base}/frame?after=0`)).json()).toEqual({ ...frame, visits: [] });
    expect(await (await call(`${base}/frame?after=3`)).json()).toEqual({ seq: 0, visits: [] });
    expect((await call(`/v1/sessions/nope/browser/frame`)).status).toBe(404);
    // Not yours: refused, and nothing reached the browser.
    expect((await call(`${base}/input`, { events: [{ type: "text", text: "secret" }] })).status).toBe(409);
    expect(sent).toEqual([]);
    expect(await (await call(`${base}/hand-back`, {})).json()).toEqual({ handedBack: false });
  } finally { server.stop(true); }
});

test("you take the page, go where you like on it, step back through pages, and hand it back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-split-"));
  directories.push(directory);
  const sent: Record<string, unknown>[] = [];
  const frame: BrowserFrame = { seq: 2, jpeg: "/9j/", width: 1280, height: 800, url: "https://shop.example/", title: "Shop", handover: false };
  const visits = [{ seq: 1, url: "https://shop.example/", title: "Shop", tab: 1, jpeg: "/9j/a" }];
  const browser = Object.assign((async (_chat, command) => { sent.push(command); return { url: String(command.url ?? frame.url), title: "Shop", ok: true }; }) as BrowserDriver,
    { frame: async (_chat: string, after: number) => after < frame.seq ? frame : null, visits: () => visits });
  const resolveHost = async (host: string) => host === "inside.example" ? ["192.168.1.4"] : ["93.184.215.14"];
  const app = createDaemonApp({ databasePath: join(directory, "data", "demesne.sqlite"), browser, resolveHost });
  apps.push(app);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, body?: unknown) => fetch(new URL(path, server.url), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const { session } = await (await call("/v1/sessions", { title: "Shop" })).json() as { session: { id: string } };
    const base = `/v1/sessions/${session.id}/browser`;
    expect((await (await call(`${base}/frame?after=0`)).json()).visits).toEqual([{ seq: 1, url: "https://shop.example/", title: "Shop", tab: 1 }]);
    expect(await (await call(`${base}/visit?seq=1`)).json()).toEqual(visits[0]!);
    expect((await call(`${base}/visit?seq=9`)).status).toBe(404);
    // Not yours yet: going anywhere is refused.
    expect((await call(`${base}/go`, { to: "back" })).status).toBe(409);
    expect(await (await call(`${base}/take`, {})).json()).toEqual({ taken: true });
    expect(sent).toEqual([{ action: "handover", on: true }]);
    expect((await (await call(`${base}/frame?after=2`)).json()).held).toBe("person");
    expect((await call(`${base}/go`, { to: "back" })).status).toBe(200);
    expect((await call(`${base}/go`, { to: "tab:2" })).status).toBe(200);
    expect((await call(`${base}/go`, { to: "example.com/help" })).status).toBe(200);
    expect((await call(`${base}/go`, { to: "" })).status).toBe(400);
    expect((await call(`${base}/go`, { to: "https://inside.example/" })).status).toBe(400);
    expect((await call(`${base}/input`, { events: [{ type: "text", text: "hi" }] })).status).toBe(200);
    expect(sent.slice(1)).toEqual([{ action: "go", to: "back" }, { action: "switch", tab: 2 }, { action: "go", url: "https://example.com/help", site: "example.com" }, { action: "input", events: [{ type: "text", text: "hi" }] }]);
    expect(await (await call(`${base}/hand-back`, {})).json()).toEqual({ handedBack: true });
    expect(sent.at(-1)).toEqual({ action: "handover", on: false });
    expect((await (await call(`${base}/frame?after=2`)).json()).held).toBeUndefined();
  } finally { server.stop(true); }
});
