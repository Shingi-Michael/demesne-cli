// A measured hand-off, for real (piece 7 of pass 274): the desktop app draws a
// mockup off screen, and foundry_read {spec: true} gives back what it
// measures, with the project's own tokens and components named. Run after
// `bun scripts/prepare-desktop.ts` (Linux needs a display:
// xvfb-run -a bun scripts/check-foundry-spec.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DemesneStore } from "../packages/storage/src/index.ts";
import { electronLook } from "../apps/daemon/src/foundry-look.ts";
import { foundryReadTool } from "../apps/daemon/src/foundry.ts";

const root = resolve(import.meta.dir, "..");
const electron = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const command = [electron, ...(process.env.DEMESNE_ELECTRON ? [] : [join(root, "apps/desktop/build/app")]), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

// The project the mockup is for: a clinic's booking app with its own tokens and parts.
const project = mkdtempSync(join(tmpdir(), "demesne-spec-check-"));
mkdirSync(join(project, "src/components"), { recursive: true });
writeFileSync(join(project, "src/tokens.css"), ":root{--brand:#0b6e4f;--ink:#1a1f1c;--paper:#f6f4ee;--radius:10px;font-family:Georgia,serif}");
for (const name of ["Button", "SlotPicker", "ClinicCard"]) writeFileSync(join(project, `src/components/${name}.tsx`), `export const ${name} = () => null;`);

const option = (name: string, lead: string) => `<section data-option="${name}"><main class="booking"><h1>${lead}</h1><p class="lede">Pick a time that suits you at Harbor Clinic.</p>
<div class="slots"><button class="slot">9:00</button><button class="slot">9:30</button><button class="slot">10:00</button></div><button class="book" data-go="${name} booked">Book the visit</button><div class="over"><div data-view="${name} closed"></div><div class="sheet" data-view="${name} booked" data-move="rise">Booked for Tuesday, 10:30</div></div></main></section>`;
const PAGE = `<link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script>
<style>:root{--accent:#0b6e4f;--ink:#1a1f1c;--paper:#f6f4ee;--move:320ms}.booking{padding:48px 96px;display:flex;flex-direction:column;gap:24px;background:#f6f4ee;color:#1a1f1c;font:16px/24px Georgia,serif}
.booking h1{margin:0;font:700 40px/44px Georgia,serif}.booking p{margin:0}.slots{display:grid;grid-template-columns:repeat(3,120px);gap:8px}
.slot{padding:8px 16px;border:1px solid rgba(26,31,28,.2);border-radius:10px;background:#fff;color:#1a1f1c;font:inherit}
.book{align-self:start;padding:10px 20px;border:0;border-radius:10px;background:#0b6e4f;color:#fff;font:600 16px/24px Georgia,serif;transition:background-color 160ms ease-out}</style>
<d-compare recommended="Day first">${option("Day first", "Book a visit")}${option("Clinic first", "Choose your clinic")}</d-compare>`;

const store = new DemesneStore(":memory:");
try {
  const { session } = store.createSession("Harbor Clinic", project);
  const { turn } = store.createTurn(session.id, "build Clinic first");
  const part = (name: string, at: string) => ({ name, says: `${name} does its job.`, at });
  const walk = ["Day first", "Clinic first"].map((name) => ({ option: name, what: `${name}, for patients.`, parts: [part("Book button", ".book"), part("Time slots", ".slots"), part("Headline", "h1")], why: "They book in one go.", differs: `${name} leads.` }));
  const mockup = store.saveFoundryArtifact({ kind: "html", title: "Booking", source: PAGE, sessionId: session.id, turnId: turn.id, description: "Two ways to book.", why: { direction: "Calm.", look: "The slots.", dropped: "", walk } });
  const context = { workspaceRoot: project, signal: new AbortController().signal, sessionId: session.id, turnId: turn.id };
  const started = Date.now();
  const read = JSON.parse(await foundryReadTool(store, electronLook(command)).execute({ id: mockup.id, spec: true, option: "Clinic first" }, context as never) as string);
  console.log(JSON.stringify(read, null, 1));
  assert.equal(read.option, "Clinic first");
  const { spec } = read;
  assert.match(spec.page, /^1280×\d+, /);
  const parts = Object.fromEntries((spec.parts as Record<string, string>[]).map((one) => [one.name, one]));
  // The option drawn is the second one: its headline, not the first option's.
  assert.equal(parts.Headline!.words, "Choose your clinic");
  assert.match(parts.Headline!.type!, /^700 40px\/44px Georgia$/);
  assert.match(parts["Book button"]!.is!, /^<button> \d+×44 at \d+,\d+$/);
  assert.equal(parts["Book button"]!.ground, "#0b6e4f (= brand)");
  assert.equal(parts["Book button"]!.padding, "10px 20px");
  assert.equal(parts["Book button"]!.corners, "10px");
  assert.equal(parts["Time slots"]!.layout, "grid 3 columns");
  assert.equal(parts["Time slots"]!.gap, "8px");
  assert((spec.colours as string[]).some((line) => /^#0b6e4f \(= brand\): .*button/.test(line)), "the button's colour is named by the project's token");
  assert((spec.colours as string[]).some((line) => line.startsWith("#f6f4ee (= paper)")), "the ground is the project's paper");
  assert((spec.type as string[]).some((line) => /Georgia 40px, weight 700, line 44px: “Choose your clinic”/.test(line)));
  assert((spec.words as string[]).includes("Book the visit") && !(spec.words as string[]).includes("Book a visit"), "the words are the drawn option's only");
  assert((spec.motion as string[]).some((line) => /^\.book: background-color, 160ms, ease-out/.test(line)), "how the button moves is in the hand-off");
  // Piece 8: a kit move on a part not shown yet is in the hand-off, with the page's own timing.
  assert((spec.motion as string[]).includes('div.sheet "Booked for Tuesday, 10:30": animation rise (from transform: translateY(100%) → at rest), 320ms, cubic-bezier(.2,.8,.2,1), each time it appears'), "the sheet's rise is in the hand-off");
  assert.equal((spec.motion as string[]).filter((line) => line.includes("rise")).length, 1, "only the drawn option's sheet");
  assert.deepEqual(spec.other_places, [{ name: "Clinic first booked", words: ["Booked for Tuesday, 10:30"] }]);
  assert.deepEqual(read.project.components.sort(), ["Button", "ClinicCard", "SlotPicker"]);
  assert.match(read.how, /foundry_built/);
  console.log(`PASS a measured hand-off: ${spec.parts.length} parts, ${spec.colours.length} colours, ${spec.type.length} type styles in ${Date.now() - started}ms`);
} finally { store.close(); rmSync(project, { recursive: true, force: true }); }
