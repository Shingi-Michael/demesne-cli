/** Real Electron check for foundry_try (pass 164 E): the app, started off
 * screen the way the daemon starts it, runs real clicks and typing on a page
 * with the bugs the tool exists to catch, and says so step by step. Then the
 * ordinary look still works. Run after `bun scripts/prepare-desktop.ts`. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { electronLook, electronTry } from "../apps/daemon/src/foundry-look.ts";

const electronBinary = (await import("electron")).default as unknown as string;
// Root (a container) needs --no-sandbox, as Electron refuses otherwise.
const command = [process.argv[2] ? resolve(process.argv[2]) : electronBinary, ...(process.argv[2] ? [] : [resolve("apps/desktop/build/app")]), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
const source = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"></head>
<body><main class="container narrow"><h1>Groceries</h1><p id="count">0 items</p>
<label>Item <input id="item" placeholder="Add an item"></label>
<button id="add" class="primary">Add</button> <button id="clear">Clear</button>
<ul id="list"></ul><div style="height:1200px"></div></main>
<button id="share" style="position:fixed;bottom:12px;left:12px;width:120px;height:40px">Share</button>
<nav style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#ddd">Tab bar</nav>
<script>
const items = [];
demesne.load("items", []).then((saved) => { items.push(...saved); draw(); });
function draw() { document.getElementById("list").innerHTML = items.map((i) => "<li>" + i + "</li>").join(""); document.getElementById("count").textContent = items.length + " items"; }
function add() { const input = document.getElementById("item"); if (!input.value.trim()) return; items.push(input.value.trim()); input.value = ""; draw(); demesne.save("items", items); }
document.getElementById("add").onclick = add;
document.getElementById("item").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
// The bug: Clear forgets to redraw.
document.getElementById("clear").onclick = () => { items.length = 0; };
</script></main></body></html>`;
const page = { kind: "html", source, title: "Groceries" };
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });

const tried = await electronTry(command)(page, { width: 390, steps: [
  { type: "Milk", into: "Item" }, { click: "Add" }, { type: "Eggs", into: "Add an item" }, { key: "Enter" },
  { click: "Clear" }, { click: "Share" }, { click: "Checkout" },
] }, new AbortController().signal);
assert(tried, "the app ran the try");
for (const step of tried.steps) console.log(`${step.ok ? "✓" : "✕"} ${step.step}: ${step.said}`);
console.log(tried.tree.join("\n"));
const [typed, added, typed2, entered, cleared, shared, missing] = tried.steps;
assert.equal(tried.width, 390);
assert(typed!.ok && /value or state changed/.test(typed!.said), "typing into the field changes its value");
assert(added!.ok && /new text .*“Milk”/.test(added!.said), "a real click on Add adds Milk");
assert(typed2!.ok, "the field is found by its placeholder");
assert(entered!.ok && /new text .*“Eggs”/.test(entered!.said), "Enter in the field adds Eggs");
assert(!cleared!.ok && /nothing visible changed/.test(cleared!.said), "Clear doing nothing is caught");
assert(!shared!.ok && /covered by nav/.test(shared!.said), "Share under the tab bar is caught");
assert(!missing!.ok && /nothing matches.*“Add”/.test(missing!.said), "a control that isn't there names the ones that are");
assert(tried.tree.some((line) => line.startsWith('heading "Groceries"')), "the tree has the heading");
assert(tried.tree.some((line) => line.startsWith('button "Share"') && line.includes("covered by nav")), "the tree marks Share covered");
assert.equal(tried.pictures.length, 2, "a picture after the first bad step and after the last");
assert.deepEqual(tried.errors, []);
tried.pictures.forEach((picture, index) => writeFileSync(join(output, `foundry-try-${index + 1}.png`), Buffer.from(picture.png, "base64")));
console.log("PASS: foundry_try runs real steps and catches a dead button, a covered button and a missing one.");

const looked = await electronLook(command)(page, new AbortController().signal);
assert(looked && looked.pages.length === 2, "the ordinary look still renders both widths");
console.log("PASS: the look still works beside it.");
