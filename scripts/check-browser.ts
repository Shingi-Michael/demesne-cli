// The model's own browser, for real: the desktop app runs hidden as the
// browser host, and the browser tool drives a small local app in it the way
// a model would: by the numbers in the page's outline. Run after
// `bun scripts/prepare-desktop.ts` (Linux needs a display:
// xvfb-run -a bun scripts/check-browser.ts).
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { browserTool, electronBrowser } from "../apps/daemon/src/browser.ts";

const root = resolve(import.meta.dir, "..");
const electron = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const command = [electron, ...(process.env.DEMESNE_ELECTRON ? [] : [join(root, "apps/desktop/build/app")]), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

const page = (title: string, body: string) => new Response(`<!doctype html><title>${title}</title><body style="font:16px sans-serif">${body}</body>`, { headers: { "Content-Type": "text/html" } });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return page("Sign in", `<h1>Sign in</h1><label>Name <input id="name" placeholder="Your name"></label><button id="go">Sign in</button><p id="said"></p>
    <a href="/list">The list</a> <a href="https://example.com/">Elsewhere</a> <button id="boom">Break</button> <button id="ask">Ask</button>
    <script>
      go.onclick = () => { document.cookie = "who=" + encodeURIComponent(document.getElementById("name").value) + "; path=/"; said.textContent = "Signed in as " + document.getElementById("name").value; };
      boom.onclick = () => { console.error("it broke on purpose"); fetch("/missing"); };
      ask.onclick = () => { if (confirm("Really?")) said.textContent = "Asked and answered"; };
    </script>`);
  if (url.pathname === "/list") return page("The list", `<h1>The list</h1><p id="who"></p><h2>Items</h2><ul>${Array.from({ length: 30 }, (_, i) => `<li>Item ${i + 1} <button>Remove ${i + 1}</button></li>`).join("")}</ul>
    <script>who.textContent = "Hello " + decodeURIComponent((document.cookie.match(/who=([^;]*)/) || [, "nobody"])[1]); document.querySelector("ul").onclick = (e) => { if (e.target.tagName === "BUTTON") e.target.parentNode.remove(); };</script>`);
  return new Response("not here", { status: 404 });
} });
const base = `http://localhost:${server.port}`;

const drive = electronBrowser(command);
const tool = browserTool(drive);
const context = (chat: string) => ({ sessionId: chat, turnId: "t1", workspaceRoot: root, signal: new AbortController().signal }) as never;
const call = async (input: Record<string, unknown>, chat = "chat-a") => {
  const result = await tool.executeWithArtifacts!(input, context(chat)) as { text: string; images: { data: Buffer; filename: string }[] };
  return { ...JSON.parse(result.text) as Record<string, any>, images: result.images, size: result.text.length };
};
const number = (outline: string[], words: string) => { const line = outline.find((item) => item.includes(words)); assert(line, `the outline has ${words}:\n${outline.join("\n")}`); return Number(/^\[(\d+)\]/.exec(line)![1]); };

try {
  const started = Date.now();
  const first = await call({ action: "open", url: `${base}/` });
  assert.equal(first.title, "Sign in");
  assert.equal(first.outline[0], "# Sign in");
  assert.match(first.outline.join("\n"), /\[\d+\] textbox "Name"/);
  assert.match(first.outline.join("\n"), /\[\d+\] link "The list"  → \/list/);
  assert.equal(first.images.length, 0, "no picture unless asked");
  console.log(`opened in ${Date.now() - started}ms, outline ${first.size} characters`);

  // Type and click by number; each says what changed, and sends no outline back.
  const name = number(first.outline, 'textbox "Name"'), signIn = number(first.outline, 'button "Sign in"');
  const typed = await call({ action: "type", ref: name, text: "Ada" });
  assert.equal(typed.did, 'textbox "Name"');
  assert.match(typed.changed, /value or state changed/);
  assert.equal(typed.outline, undefined, "the numbers still hold, so the outline is not sent again");
  const clicked = await call({ action: "click", ref: signIn });
  assert.match(clicked.changed, /new text “Signed in as Ada”/);

  // The numbers hold across a read.
  const again = await call({ action: "read" });
  assert.equal(number(again.outline, 'button "Sign in"'), signIn);
  assert.match(again.outline.join("\n"), /textbox "Name"  value "Ada"/);

  // A link to another page: the address changes, so the new outline comes with it, and the cookie came along.
  const went = await call({ action: "click", ref: number(first.outline, 'link "The list"') });
  assert.equal(went.changed, "went to /list");
  assert.equal(went.title, "The list");
  assert.equal(went.outline[0], "# The list");
  const words = await call({ action: "text" });
  assert.match(words.text, /Hello Ada/, "the tab kept its cookie");
  assert.match(words.text, /Item 30/);

  // A name works where a number isn't known.
  const removed = await call({ action: "click", ref: "Remove 2" });
  assert.match(removed.changed, /gone “Item 2 Remove 2”/);
  // A number for something that left the page says so.
  const gone = await call({ action: "click", ref: number(went.outline, 'button "Remove 2"') });
  assert.match(gone.failed, /no longer on the page/);

  // Back, and the page is where it was left only as far as the app keeps it; then forward.
  const back = await call({ action: "back" });
  assert.equal(back.changed, "went to /");
  assert.equal((await call({ action: "forward" })).title, "The list");
  await call({ action: "back" });

  // Console errors and failed requests come with the action that caused them, once.
  const home = await call({ action: "read" });
  const broke = await call({ action: "click", ref: number(home.outline, 'button "Break"') });
  assert.deepEqual(broke.console_errors?.filter((line: string) => line.includes("on purpose")), ["it broke on purpose"]);
  const quiet = await call({ action: "wait", ms: 400 });
  assert.match([...(broke.failed_requests ?? []), ...(quiet.failed_requests ?? [])].join("\n"), /GET \/missing → 404/);

  // A page that asks with a dialog is answered, and the model is told.
  const asked = await call({ action: "click", ref: number(home.outline, 'button "Ask"') });
  assert.deepEqual(asked.page_dialogs, ["confirm (answered OK): Really?"]);
  assert.match(asked.changed, /Asked and answered/);

  // It never leaves this computer.
  const out = await call({ action: "click", ref: number(home.outline, 'link "Elsewhere"') });
  assert.match(String(out.blocked), /example\.com.*outside this computer/);
  assert.equal(out.url, `${base}/`);
  await assert.rejects(call({ action: "open", url: "https://example.com/" }), /the browser opens only this computer's own apps/);

  // Wait for text; a picture only when asked.
  assert.match((await call({ action: "wait", for: "Sign in" })).did, /is on the page/);
  const shot = await call({ action: "picture" });
  assert.equal(shot.images.length, 1);
  assert.equal(shot.images[0]!.data.subarray(1, 4).toString(), "PNG");
  assert.equal(shot.images[0]!.filename, "browser-page.png");

  // Another chat has its own tab and its own cookies.
  await call({ action: "open", url: `${base}/list` }, "chat-b");
  assert.match((await call({ action: "text" }, "chat-b")).text, /Hello nobody/);
  assert.equal((await call({ action: "read" })).title, "Sign in", "the first chat's tab is where it was");

  // Closed is closed: the next call has to open again.
  await call({ action: "close" }, "chat-b");
  await assert.rejects(call({ action: "read" }, "chat-b"), /No page is open yet/);
  console.log(`check-browser passed in ${Date.now() - started}ms`);
} finally { drive.close(); server.stop(true); }
