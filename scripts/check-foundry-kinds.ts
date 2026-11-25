/** Real Electron check for Foundry's more kinds (step 2 after pass 262 C):
 * a React component with Tailwind, a lucide icon and a recharts chart runs
 * on the Foundry page from the app's own kit (no network); a Mermaid
 * diagram is drawn; a code file is highlighted with a row per line; Save a
 * copy writes a React page that stands on its own, or its .jsx; a diagram
 * that doesn't parse says so under it. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };

const APP = `import { useState } from "react";
import { Coffee, Plus } from "lucide-react";
import { BarChart, Bar, XAxis } from "recharts";

type Order = { drink: string; n: number };
const week = [{ day: "Mon", n: 12 }, { day: "Tue", n: 19 }, { day: "Wed", n: 15 }];

export default function Counter() {
  const [orders, setOrders] = useState<Order[]>([{ drink: "Flat white", n: 1 }]);
  return (
    <main className="min-h-screen bg-stone-100 p-8 text-stone-800">
      <h1 className="flex items-center gap-2 text-2xl font-semibold"><Coffee size={22} /> Counter</h1>
      <ul id="orders" className="mt-4 space-y-2">{orders.map((order, i) => <li key={i} className="rounded-lg bg-white px-4 py-2">{order.drink}</li>)}</ul>
      <button id="add" className="mt-4 inline-flex items-center gap-1 rounded-lg bg-stone-900 px-4 py-2 text-white" onClick={() => setOrders([...orders, { drink: "Oat latte", n: 1 }])}><Plus size={16} /> Add</button>
      <BarChart width={360} height={160} data={week}><XAxis dataKey="day" /><Bar dataKey="n" fill="#888" /></BarChart>
    </main>
  );
}`;
const SAVES: Record<string, { title: string; kind: string; source: string; description: string }> = {
  react: { title: "Counter app", kind: "react", source: APP, description: "The counter's orders as a small React app." },
  diagram: { title: "Order flow", kind: "mermaid", source: "flowchart LR\n  A[Order] --> B{Paid?}\n  B -->|yes| C[Make it]\n  B -->|no| D[Ask again]", description: "How an order moves." },
  code: { title: "orders.ts", kind: "code", source: "export function total(items: { price: number }[]) {\n  // Every item, once.\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n", description: "The total, in code." },
  broken: { title: "Broken flow", kind: "mermaid", source: "flowchart LR\n  A[Order] --> --> ((", description: "A diagram that doesn't parse." },
};

const f = await fixture({
  providerId: "fixture", modelId: "foundry-kinds",
  async listModels() { return [{ id: "foundry-kinds", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const request = String(messages[at]?.content ?? "");
    const done = messages.slice(at + 1).some((message) => message.role === "tool");
    if (done) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const which = Object.keys(SAVES).find((key) => request.includes(`make ${key}`))!;
    const save = SAVES[which]!;
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ ...save, note: "First take" }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-kinds")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const downloads = join(f.root, "downloads");
  mkdirSync(downloads, { recursive: true });
  await desktop.evaluate(({ app }, path) => app.setPath("downloads", path), downloads);
  // Nothing leaves the machine: the libraries come from the app's kit.
  const outside: string[] = [];
  await desktop.evaluate(({ session }) => { (globalThis as { __outside?: string[] }).__outside = []; session.defaultSession.webRequest.onBeforeRequest((details, done) => { if (/^https?:/.test(details.url) && !/127\.0\.0\.1|localhost/.test(details.url)) (globalThis as { __outside?: string[] }).__outside!.push(details.url); done({}); }); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const ready = () => page!.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await ready(); await page.waitForTimeout(200);
  const chips = page.locator("#conversation .fd-chip");
  for (const key of Object.keys(SAVES)) {
    await editor.fill(`/foundry make ${key}`); await editor.press("Enter");
    await chips.filter({ hasText: SAVES[key]!.title }).waitFor();
    await ready(); await page.waitForTimeout(300);
  }
  const list = (await f.client.foundryList()).artifacts;
  assert.deepEqual(Object.values(SAVES).map((save) => list.find((item) => item.title === save.title)?.kind), ["react", "mermaid", "code", "mermaid"]);
  const idOf = (key: string) => list.find((item) => item.title === SAVES[key]!.title)!.id;
  const frameOf = (key: string) => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${idOf(key)}?v=1`) && found.url().includes("stack=1")) as Frame | undefined;
  const openIt = async (key: string) => {
    if (await page!.locator("#page .fd-open").count()) await page!.keyboard.press("Escape");
    // Pass 277 B: an opened mockup folds the sidebar; unfold it to reach a chat.
    await page!.evaluate(() => { if (document.getElementById("desktop-shell")?.classList.contains("sidebar-collapsed")) document.getElementById("desktop-toggle-sidebar")?.click(); });
    await page!.locator("#sidebar-sessions .sidebar-session, #sidebar-chats [data-action=select-session]").first().click();
    await chips.filter({ hasText: SAVES[key]!.title }).first().click();
    const item = page!.locator(`#page [data-fd="${idOf(key)}:1"]`);
    await step(78, async () => (await item.getAttribute("class").catch(() => ""))!.includes("fd-open"));
    await step(79, async () => !!frameOf(key));
    return item;
  };

  // React: it runs, Tailwind styles it, the icons and the chart draw, a click adds an order.
  const app = await openIt("react");
  assert.match((await app.locator(".fd-ln-r").first().textContent())!, /^App · /);
  await step(85, async () => frameOf("react")!.evaluate(() => !!document.querySelector("#add")).catch(() => false), 15000);
  const looks = await frameOf("react")!.evaluate(() => ({ button: getComputedStyle(document.querySelector("#add")!).backgroundColor, icons: document.querySelectorAll("svg.lucide").length, chart: document.querySelectorAll(".recharts-bar-rectangle").length }));
  assert.match(looks.button, /^oklch\(0\.216 /, "Tailwind's bg-stone-900");
  assert.ok(looks.icons >= 2, `lucide icons drawn (${looks.icons})`);
  assert.ok(looks.chart >= 3, `recharts bars drawn (${looks.chart})`);
  await frameOf("react")!.evaluate(() => (document.querySelector("#add") as HTMLElement).click());
  await step(92, async () => frameOf("react")!.evaluate(() => document.querySelectorAll("#orders li").length === 2));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(output, "foundry-kind-react.png") });
  // Save a copy: a page that runs on its own, then its .jsx.
  await app.getByRole("button", { name: "Save a copy to Downloads" }).click();
  await step(97, async () => /Saved Counter app v1\.html to Downloads/.test((await app.locator(".fd-said").textContent()) ?? ""));
  const copy = readFileSync(join(downloads, "Counter app v1.html"), "utf8");
  assert.ok(!copy.includes('src="foundry://kit/') && copy.includes("createRoot") && copy.length > 500_000, "the copy carries its libraries");
  await app.getByRole("button", { name: "Also as the .jsx" }).click();
  await step(101, async () => existsSync(join(downloads, "Counter app v1.jsx")));
  assert.equal(readFileSync(join(downloads, "Counter app v1.jsx"), "utf8"), APP);
  console.log("PASS: a React component with Tailwind, lucide icons and a recharts chart runs from the kit; its copy stands on its own, or is its .jsx.");

  // Mermaid: the diagram is drawn.
  const flow = await openIt("diagram");
  await step(107, async () => frameOf("diagram")!.evaluate(() => document.querySelectorAll(".mermaid svg .node").length === 4).catch(() => false), 15000);
  assert.match((await flow.locator(".fd-ln-r").first().textContent())!, /^Diagram · /);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "foundry-kind-mermaid.png") });
  console.log("PASS: a Mermaid diagram is drawn on the Foundry page.");

  // Code: highlighted, a row a line.
  const code = await openIt("code");
  await step(115, async () => frameOf("code")!.evaluate(() => document.querySelectorAll(".ln").length === 4 && !!document.querySelector(".hljs-keyword")).catch(() => false));
  assert.match((await code.locator(".fd-ln-r").first().textContent())!, /^Code · /);
  await page.screenshot({ path: join(output, "foundry-kind-code.png") });
  console.log("PASS: a code file is highlighted with a row per line.");

  // A diagram that doesn't parse says so under it.
  const broken = await openIt("broken");
  await step(122, async () => /This page hit an error:.*doesn't parse/.test((await broken.locator(".fd-err").textContent().catch(() => "")) ?? ""), 15000);
  console.log("PASS: a diagram that doesn't parse says so under it.");

  const left = await desktop.evaluate(() => (globalThis as { __outside?: string[] }).__outside ?? []);
  assert.deepEqual(left.filter((url) => /cdnjs|jsdelivr|unpkg/.test(url)), [], "no library came from the network");
  assert.deepEqual(errors.filter((error) => !/doesn't parse/.test(error)), []);
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
