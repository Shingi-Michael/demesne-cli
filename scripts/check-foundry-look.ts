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
// The design numbers the quality eval scores (foundry-look-measure.ts DESIGN_MEASURE).
const design = desktop!.design!;
assert(design, "design numbers come with the look");
for (const key of ["sizes", "body", "lead", "rhythm", "aligned", "colours", "surface"]) assert(typeof design[key] === "number", `design.${key}`);
assert(design.sizes >= 2 && design.lead > 1 && design.colours >= 2, JSON.stringify(design));
// The parts draw a real frame: a Demesne mock and a phone render with no faults, and paint the screen.
const parts = `<html data-theme="dark"><link rel="stylesheet" href="foundry://kit/base.css"><main class="container" style="max-width:1180px"><h1>Calmer settings</h1>
<d-demesne page="Customize" tabs="Settings"><h2>General</h2><div><d-row title="Keep this computer awake" note="While a chat or Drive runs"><d-toggle on></d-toggle></d-row>
<d-row title="Open on"><d-seg options="Home|Last chat"></d-seg></d-row></div><d-card slot="cards" title="What changed" icon="sparkles">Three pages fold into one.</d-card></d-demesne>
<d-compare recommended="A"><section data-option="A · Phone"><d-phone><div style="padding:16px"><d-stat label="This week" value="32 km" delta="+12%"></d-stat><d-chart type="bar" values="3,5,4,7" labels="M,T,W,T"></d-chart><d-avatar name="Amara Okafor"></d-avatar> <d-icon name="calendar"></d-icon></div></d-phone></section>
<section data-option="B · Window"><d-window title="Splits" width="700"><d-chart type="donut" values="40,30,30" labels="Easy,Tempo,Long"></d-chart></d-window></section></d-compare></main>
<script src="foundry://kit/parts.js"></script>`;
const partsLook = await electronLook(command)({ kind: "html", title: "Parts", source: parts }, new AbortController().signal);
assert(partsLook, "the app rendered the parts page");
for (const shot of partsLook.pages) assert.deepEqual(shot.issues, [], `parts at ${shot.width}px`);
assert.deepEqual(partsLook.errors, [], "parts log no console errors");
assert(partsLook.pages[0]!.design!.surface > 0.2, `parts paint the screen: ${JSON.stringify(partsLook.pages[0]!.design)}`);
// The ready kinds: a deck, a doc and a dashboard, drawn by the app from content alone, render with no faults or errors.
const READY = { deck: "---\ntitle: Q1 launch\nauthor: Growth team\ndate: April 2027\ntheme: forest\n---\n# Q1 launch\nWhat the free tier did to sign-ups, and what we do next.\n\n---\n\n# 3.1\u00d7\nSign-ups a week, from 1,200 to 3,700, with no change to paid conversion.\n\n---\n\n## Sign-ups tripled after the free tier\n\n```chart\ntype: bar\nlabels: W1, W2, W3, W4, W5, W6\nSign-ups: 1200, 1500, 1800, 2400, 3100, 3700\n```\n\n---\n\n## Where they came from\n\n- **Search** grew fastest, up 4\u00d7 since the launch post\n- Word of mouth doubled\n- Paid stayed flat: we spent the same\n\n```chart\ntype: donut\nlabels: Search, Word of mouth, Paid, Other\nvalues: 46, 28, 18, 8\n```\n\n---\n\n> The free tier didn't cannibalise paid. It filled the top of the funnel.\n>\n> Priya Shah, Head of Growth\n\n---\n\n## Next quarter\n\n1. Double down on search: 12 new guides\n2. Referral credit for word of mouth\n3. Keep paid flat until conversion moves\n\n---\n\n## The numbers\n\n```stats\nSign-ups | 3,700 | +210% | a week\nPaid conversion | 4.1% | +0.1 pt\nChurn | 2.3% | \u22120.4 pt | monthly\n```\n", doc: "---\ntitle: Q1 launch brief\nsubtitle: The free tier tripled sign-ups without hurting paid conversion. Here is what happened and what we propose next.\nauthor: Growth team\ndate: 3 April 2027\n---\n## Summary\n\nWe launched the free tier on 6 January. Weekly sign-ups went from **1,200 to 3,700** in six weeks, and paid conversion held at 4.1%.\n\n```stats\nSign-ups | 3,700 | +210% | a week\nPaid conversion | 4.1% | +0.1 pt\nChurn | 2.3% | \u22120.4 pt\n```\n\n## What happened\n\nSearch did most of the work. The launch post ranked for \"free invoicing app\" within two weeks.\n\n```chart\ntype: line\ntitle: Weekly sign-ups by channel\nlabels: W1, W2, W3, W4, W5, W6\nSearch: 400, 600, 900, 1300, 1700, 2000\nWord of mouth: 500, 550, 600, 700, 900, 1000\nPaid: 300, 350, 300, 400, 500, 700\n```\n\n> [!NOTE]\n> Paid spend was flat across the quarter, so the paid line is a fair control.\n\n## Risks\n\n| Risk | Likelihood | Impact |\n| --- | --- | --- |\n| Support load grows with free users | High | Medium |\n| Search ranking drops | Medium | High |\n| Free users never convert | Low | High |\n\n## Proposal\n\n1. Publish 12 search guides next quarter.\n2. Give referral credit for word of mouth.\n3. Keep paid spend flat until conversion moves.\n", dashboard: "---\ntitle: Launch numbers\nsubtitle: The free tier, six weeks in\ndate: Updated 3 Apr\ntheme: ink\n---\n```stats\nSign-ups | 3,700 | +210% | this week\nPaid conversion | 4.1% | +0.1 pt\nActive teams | 18,240 | +32%\nChurn | 2.3% | \u22120.4 pt | monthly\n```\n\n## Growth\n\n```chart\ntype: area\ntitle: Weekly sign-ups\nlabels: W1, W2, W3, W4, W5, W6\nvalues: 1200, 1500, 1800, 2400, 3100, 3700\n```\n\n```chart\ntype: donut\ntitle: Where they came from\nlabels: Search, Word of mouth, Paid, Other\nvalues: 46, 28, 18, 8\n```\n\nSearch grew fastest after the launch post ranked. Paid stayed flat.\n\n## Teams\n\n| Team | Plan | Seats | MRR |\n| --- | --- | --- | --- |\n| Halden & Co | Pro | 42 | $1,260 |\n| Northwind | Team | 18 | $540 |\n| Brightline | Pro | 31 | $930 |\n| Okafor Studio | Team | 9 | $270 |\n\n```chart\ntype: hbar\ntitle: Top countries\nlabels: UK, US, Germany, Kenya, Brazil\nvalues: 1200, 980, 640, 410, 300\n```\n" };
for (const [kind, source] of Object.entries(READY)) {
  const ready = await electronLook(command)({ kind, title: kind, source }, new AbortController().signal);
  assert(ready, `the app drew the ${kind}`);
  for (const shot of ready.pages) assert.deepEqual(shot.issues, [], `${kind} at ${shot.width}px`);
  assert.deepEqual(ready.errors, [], `${kind} logs no console errors`);
  if (process.env.FOUNDRY_LOOK_SHOTS) for (const shot of ready.pages) await Bun.write(join(process.env.FOUNDRY_LOOK_SHOTS, `${kind}-${shot.width}.png`), Buffer.from(shot.png, "base64"));
  console.log(kind, JSON.stringify(ready.pages.map(({ width, design }) => ({ width, design }))));
}
for (const shot of look.pages) assert(Buffer.from(shot.png, "base64").subarray(1, 4).toString() === "PNG", "a picture of each width");
console.log(`Foundry look passed in ${Date.now() - started} ms:`, JSON.stringify(look.pages.map(({ width, issues }) => ({ width, issues }))));
