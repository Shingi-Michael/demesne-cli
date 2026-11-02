// Foundry's look, for real: the desktop app renders a page with known faults
// off screen and must name each one. Run after `bun scripts/prepare-desktop.ts`
// (Linux needs a display: xvfb-run -a bun scripts/check-foundry-look.ts).
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { electronLook } from "../apps/daemon/src/foundry-look.ts";

const root = resolve(import.meta.dir, "..");
const electron = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const command = [electron, ...(process.env.DEMESNE_ELECTRON ? [] : [join(root, "apps/desktop/build/app")]), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
const page = `<link rel="stylesheet" href="foundry://kit/base.css">
<style>body{background:#fff;color:#111}.wide{width:520px}.today{width:40px;white-space:nowrap;border:1px solid}.badges{width:120px;overflow:hidden;white-space:nowrap}.faint{color:#ddd}.stack{position:relative}.stack p{position:absolute;top:0;margin:0}</style>
<main class="container"><h1>Garden plan</h1><div class="wide">Beds along the fence</div><button class="today">Today's habits</button>
<div class="badges"><span class="pill">Needs full sun all day</span></div><p class="faint">Watering schedule</p>
<div class="stack"><p>Tomatoes</p><p>Basil</p></div></main>`;
const started = Date.now();
const look = await electronLook(command)({ kind: "html", title: "Garden plan", source: page }, new AbortController().signal);
assert(look, "the app rendered the page");
const [desktop, phone] = look.pages;
assert.equal(desktop?.width, 1280); assert.equal(phone?.width, 390);
const all = (issues: string[]) => issues.join("\n");
assert.match(all(phone!.issues), /Scrolls sideways by \d+px at 390px wide; too wide: div\.wide/);
assert.doesNotMatch(all(desktop!.issues), /Scrolls sideways/);
for (const issues of [desktop!.issues, phone!.issues]) {
  assert.match(all(issues), /Text spills out of its box: button\.today/);
  assert.match(all(issues), /span\.pill "Needs full sun all day" is clipped by div\.badges/);
  assert.match(all(issues), /Hard to read \(1\.\d:1 contrast\): p\.faint/);
  assert.match(all(issues), /p "Tomatoes" overlaps p "Basil"/);
}
// Kit colours (color-mix) read right in both schemes: no false contrast alarms on pills or tints.
const pills = `<link rel="stylesheet" href="foundry://kit/base.css"><main class="container"><p class="secondary">Second line</p><span class="pill">Kit pill</span><span class="pill accent">Accent</span><p class="muted">Muted note</p><label><span style="color:transparent">✓</span><span style="color:var(--paper,#fff);background:var(--paper,#fff)">✓</span> Water</label></main>`;
for (const scheme of ["light", "dark"]) {
  const quiet = await electronLook(command)({ kind: "html", title: "Kit", source: pills.replace("<main", `<main data-scheme="${scheme}"`).replace("<link", `<html data-theme="${scheme}"><link`) }, new AbortController().signal);
  assert(quiet);
  for (const shot of quiet.pages) assert.deepEqual(shot.issues, [], `kit text in ${scheme} at ${shot.width}px`);
}
for (const shot of look.pages) assert(Buffer.from(shot.png, "base64").subarray(1, 4).toString() === "PNG", "a picture of each width");
console.log(`Foundry look passed in ${Date.now() - started} ms:`, JSON.stringify(look.pages.map(({ width, issues }) => ({ width, issues }))));
