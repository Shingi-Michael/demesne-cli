/** A mockup of Demesne is drawn like Demesne (pass 220 A). The real window
 * and Foundry's <d-demesne> part show the same chat at the same size; the
 * parts of the window must sit in the same places, with the same type and
 * colours, and the part may not lack (or invent) a piece of the window.
 * It fails when the app's markup or styles change and the part's copy of the
 * markup (SHELL in apps/desktop/foundry-kit/parts.js) was not brought along.
 * Usage: xvfb-run -a bun scripts/check-foundry-app.ts (after prepare-desktop). */
import { _electron as electron, chromium } from "playwright";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), ui = join(root, "apps/desktop/build/app/ui");
const prompt = "Make the greeting configurable and check it", answer = "The greeting now reads `GREETING` from the environment and falls back to `Hello`.\n\n- Updated `hello.ts`.\n- `bun run check` passed.\n";
const WIDTH = 1440, HEIGHT = 900;

// The pieces of the window, by the names the app gives them.
const PIECES: Record<string, string> = {
  sidebar: "#desktop-sidebar", "new chat": ".sidebar-new", search: ".sidebar-search", scheduled: ".sidebar-nav > button:nth-of-type(2)", "projects label": ".sidebar-label",
  project: ".sidebar-project-name", chat: ".sidebar-session", "chat name": ".sidebar-session-name", release: ".sidebar-release", foot: ".sidebar-foot", you: "#sidebar-you",
  "top bar": "#desktop-toolbar", tab: ".bar-tab.on", "tab name": ".bar-tab.on .bar-tab-name", "new tab": "#workspace-new-tab", more: ".header-more",
  panel: "#app", ask: ".request .text", "answer text": ".answer .markdown p", "answer list": ".answer .markdown li", code: ".answer .markdown code", mark: ".answer-mark", receipt: ".turn-receipt", copy: ".copy-answer",
  composer: "#composer .composer-box", typing: "#composer textarea", mode: "#composer-mode", model: "#composer-model", context: "#composer-context", cards: "#cards", "where card": "#cards .card.env", "where row": "#cards .env-row",
};
const REGIONS = ["#desktop-sidebar", "#desktop-toolbar", "#conversation", "#input-area", "#cards"];

interface Piece { box: number[]; type: string; colour: string; fill: string; radius: string }
interface Measure { pieces: Record<string, Piece | null>; made: string[] }
/// Runs in both pages. `within` is the window: the document, or the part's <d-app>.
const MEASURE = ([within, pieces, regions]: [string, Record<string, string>, string[]]): Measure => {
  const window_ = document.querySelector(within)!, origin = window_.getBoundingClientRect();
  const seen = (el: Element) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const out: Record<string, Piece | null> = {};
  for (const [name, selector] of Object.entries(pieces)) {
    const el = window_.querySelector(selector);
    if (!el || !seen(el)) { out[name] = null; continue; }
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    out[name] = { box: [box.left - origin.left, box.top - origin.top, box.width, box.height].map((value) => Math.round(value * 10) / 10),
      type: `${style.fontSize}/${style.lineHeight} ${style.fontWeight} ${style.fontFamily.split(",")[0]!.replace(/"/g, "")}`, colour: style.color, fill: style.backgroundColor, radius: style.borderTopLeftRadius };
  }
  // What the window is made of: every piece that shows, by tag, id and classes.
  const made = new Set<string>();
  for (const region of regions) for (const el of window_.querySelectorAll(`${region}, ${region} *`)) {
    if (el.closest("svg") && el.localName !== "svg") continue;
    if (el.closest(".dm-main") && !el.closest("article.turn")) continue;
    if (!seen(el)) continue;
    const classes = [...el.classList].filter((name) => name !== "dm-main").sort().join(".");
    // A turn and a tab carry their chat's id in the app; the part has no chats to name.
    const id = /^(turn|workspace-tab)-/.test(el.id) ? "" : el.id;
    made.add(`${el.localName}${id ? `#${id}` : ""}${classes ? `.${classes}` : ""}`);
  }
  return { pieces: out, made: [...made].sort() };
};

const f = await fixture({
  providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages) {
    yield { type: "text_delta", delta: messages.findLast((message) => message.role === "user")?.content === prompt ? answer : "Ready." };
    yield { type: "finish", reason: "stop" };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "demesne-foundry-app-"));
const app = await electron.launch({ args: [join(root, "apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
let failed: string[] = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width: WIDTH, height: HEIGHT });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 30_000 });
  await page.waitForTimeout(2000);
  await page.fill("textarea", prompt); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".answer .markdown")?.textContent?.includes("passed"), null, { timeout: 30_000 });
  await page.waitForSelector(".turn-receipt .copy-answer", { timeout: 30_000 });
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1500);
  const size = await page.evaluate(() => [innerWidth, innerHeight]);
  const real = await page.evaluate(MEASURE, ["html", PIECES, REGIONS] as [string, Record<string, string>, string[]]);
  // The same chat, said to the part in its own words.
  const said = await page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? "";
    return { project: text(".sidebar-project-name > span:last-child"), branch: text(".sidebar-project-branch span"), chat: text(".sidebar-session-name"), tab: text(".bar-tab.on .bar-tab-name"), age: text(".sidebar-session-age"),
      you: text("#sidebar-you"), plan: text("#sidebar-plan"), drive: document.querySelector<HTMLElement>("#drive-pill")?.offsetParent ? text("#drive-pill .dp-about").replace(/^·\s*/, "") : "none", time: text(".request time"), meta: text(".turn-receipt > span"), model: text("#composer-model"),
      mode: text("#composer-mode .mode-opt.on"), placeholder: document.querySelector<HTMLTextAreaElement>("#composer textarea")!.placeholder, mac: document.documentElement.classList.contains("mac-chrome"),
      theme: document.documentElement.dataset.appearance ?? "dark", answer: document.querySelector(".answer .markdown")!.innerHTML.replace(/<!--.*?-->/g, "") };
  });
  await page.screenshot({ path: join(scratch, "app.png") });

  const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const kit = (name: string) => readFileSync(join(ui, "kit", name), "utf8").replaceAll("foundry://kit/fonts/", `file://${join(ui, "vendor/fonts")}/`);
  const mock = `<!doctype html><html><head><meta charset="utf-8"><style>${kit("base.css")}</style><style data-demesne-app>${kit("app.css")}</style><style>body{margin:0}</style><script>${kit("parts.js").replace(/<\/script/g, "<\\/script")}</script></head><body>
<d-demesne width="${size[0]}" height="${size[1]}" theme="${said.theme}"${said.mac ? "" : ' os="other"'} project="${attr(said.project)}" branch="${attr(said.branch)}" chats="${attr(said.chat)}" tabs="${attr(said.tab)}" user="${attr(said.you)}" plan="${attr(said.plan)}" drive="${attr(said.drive)}" model="${attr(said.model)}">
<d-message from="you" time="${attr(said.time)}">${prompt}</d-message><d-message meta="${attr(said.meta)}">${said.answer}</d-message>
<d-composer placeholder="${attr(said.placeholder)}" mode="${attr(said.mode)}" model="${attr(said.model)}"></d-composer></d-demesne></body></html>`;
  writeFileSync(join(scratch, "mock.html"), mock);
  const browser = await chromium.launch({ executablePath: process.env.DEMESNE_CHROMIUM || undefined });
  let part: Measure;
  try {
    const view = await browser.newPage({ viewport: { width: size[0]!, height: size[1]! }, colorScheme: "dark" });
    await view.goto(`file://${join(scratch, "mock.html")}`);
    await view.evaluate(() => document.fonts.ready);
    await view.mouse.move(700, 600);
    await view.waitForTimeout(800);
    part = await view.evaluate(MEASURE, ["d-app", PIECES, REGIONS] as [string, Record<string, string>, string[]]);
    await view.screenshot({ path: join(scratch, "part.png") });
  } finally { await browser.close(); }

  // Places within 2px (two browsers set type a hair apart); type, colours and corners exactly.
  for (const name of Object.keys(PIECES)) {
    const a = real.pieces[name], b = part.pieces[name];
    if (!a) { failed.push(`${name}: the app no longer shows ${PIECES[name]}; update PIECES in this check`); continue; }
    if (!b) { failed.push(`${name}: the part does not draw ${PIECES[name]}`); continue; }
    const off = a.box.map((value, index) => Math.abs(value - b.box[index]!));
    if (off.some((value) => value > 2)) failed.push(`${name}: at ${b.box.join(", ")} in the part, ${a.box.join(", ")} in the app`);
    for (const key of ["type", "colour", "fill", "radius"] as const) if (a[key] !== b[key]) failed.push(`${name}: ${key} is ${b[key]} in the part, ${a[key]} in the app`);
  }
  const missing = real.made.filter((piece) => !part.made.includes(piece)), extra = part.made.filter((piece) => !real.made.includes(piece));
  if (missing.length) failed.push(`the part lacks: ${missing.join("  ")}`);
  if (extra.length) failed.push(`the part invents: ${extra.join("  ")}`);
  console.log(JSON.stringify({ pieces: Object.keys(PIECES).length, made: real.made.length, shots: scratch, failed }, null, 2));
} finally {
  await app.close().catch(() => {});
  await f.close();
  if (!failed.length) rmSync(scratch, { recursive: true, force: true });
}
if (failed.length) { console.error(`FAILED: Foundry's Demesne part is not drawn like the app (${failed.length}). Bring SHELL in apps/desktop/foundry-kit/parts.js along with the app.`); process.exit(1); }
console.log("PASS: a mockup of Demesne is drawn like the app.");
process.exit(0);
