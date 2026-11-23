/** Real Electron check for sharing a Foundry mockup outside Demesne (step 8
 * after pass 262 C, on GitHub Pages): the head line's share icon asks before
 * a first share, Publish puts the page (standing on its own) in your
 * demesne-shares repository at a link nobody can guess, sharing again keeps
 * the link, Stop sharing takes it down. A stand-in GitHub answers here
 * (DEMESNE_GITHUB_API). Run after `bun scripts/prepare-desktop.ts`, under
 * xvfb-run -a. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"></head><body><h1>Café Rosa</h1></body></html>';
const calls: string[] = [], files = new Map<string, { sha: string; content: string }>();
let made = false, pages = false, n = 0;
const hub = Bun.serve({ port: 0, async fetch(request) {
  const url = new URL(request.url), path = url.pathname, body = request.method === "GET" ? null : await request.json().catch(() => null) as any;
  calls.push(`${request.method} ${path} ${request.headers.get("authorization")}`);
  const json = (status: number, value: unknown) => Response.json(value, { status });
  if (path === "/user") return json(200, { login: "Rosa-Cafe" });
  if (path === "/repos/Rosa-Cafe/demesne-shares") return made ? json(200, { default_branch: "main" }) : json(404, { message: "Not Found" });
  if (path === "/user/repos" && request.method === "POST") { made = true; return json(201, { default_branch: "main" }); }
  if (path === "/repos/Rosa-Cafe/demesne-shares/pages") { if (request.method === "POST") { pages = true; return json(201, {}); } return pages ? json(200, {}) : json(404, {}); }
  const file = /^\/repos\/Rosa-Cafe\/demesne-shares\/contents\/(.+)$/.exec(path)?.[1];
  if (file && request.method === "GET") { const one = files.get(file); return one ? json(200, { sha: one.sha }) : json(404, {}); }
  if (file && request.method === "PUT") { files.set(file, { sha: `s${++n}`, content: Buffer.from(body.content, "base64").toString("utf8") }); return json(n === 1 ? 201 : 200, {}); }
  if (file && request.method === "DELETE") { files.delete(file); return json(200, {}); }
  return json(500, { message: "unexpected" });
} });

const f = await fixture({
  providerId: "fixture", modelId: "foundry-share",
  async listModels() { return [{ id: "foundry-share", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Café page", kind: "html", description: "The café's page.", note: "First take", why: { direction: "Plain.", look_at: "The name.", starts_from: "new", walkthrough: [{ what: "A page for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check." }] }, source: PAGE }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-data")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath, GH_TOKEN: "token-for-check", DEMESNE_GITHUB_API: `http://127.0.0.1:${hub.port}` }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const ready = () => page!.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await ready(); await page.waitForTimeout(200);
  await editor.fill("/foundry a page for my café"); await editor.press("Enter");
  const chip = page.locator("#conversation .fd-chip").filter({ hasText: "Café page" });
  await chip.waitFor();
  await ready(); await page.waitForTimeout(300);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Café page")!.id;
  await chip.click();
  const item = page.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();
  const said = () => item.locator(".fd-said").textContent().catch(() => "");
  // A first share asks; Not now publishes nothing.
  await item.getByRole("button", { name: "Share v1 as a link" }).click();
  await step(62, async () => /Publish v1 to a link anyone can open, on your GitHub Pages\?/.test((await said()) ?? ""));
  await item.locator(".fd-said").getByRole("button", { name: "Not now" }).click();
  assert.equal(calls.length, 0, "nothing goes to GitHub before you say so");
  await item.getByRole("button", { name: "Share v1 as a link" }).click();
  await item.locator(".fd-said").getByRole("button", { name: "Publish" }).click();
  await step(68, async () => /rosa-cafe\.github\.io\/demesne-shares\/[a-z0-9]{20}\//.test((await said()) ?? ""));
  await item.screenshot({ path: resolve("test-results/desktop/foundry-share.png") });
  assert.ok(made && pages, "the repository is made and Pages turned on");
  assert.ok(calls.every((line) => line.endsWith("Bearer token-for-check")), "the computer's GitHub login is used");
  const [path, file] = [...files.entries()][0]!;
  assert.ok(file.content.includes('content="noindex, nofollow"') && file.content.includes("Café Rosa") && !file.content.includes('href="foundry://kit/base.css"'), "the page stands on its own");
  console.log(`PASS: a first share asks, then publishes the page standing on its own to ${path}.`);
  // Shared again: no asking, the same link.
  await item.getByRole("button", { name: "Share v1 as a link" }).click();
  await step(77, async () => files.get(path)?.sha === "s2");
  assert.equal(files.size, 1, "the same link");
  // Stop sharing takes it down.
  await item.locator(".fd-said").getByRole("button", { name: "Stop sharing" }).click();
  await step(81, async () => files.size === 0 && /Stopped sharing/.test((await said()) ?? ""));
  assert.deepEqual(errors, []);
  console.log("PASS: sharing again keeps the link without asking; Stop sharing takes the page down.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
  hub.stop(true);
}
process.exit(0);
