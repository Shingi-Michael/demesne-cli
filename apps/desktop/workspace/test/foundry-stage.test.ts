import { expect, test } from "bun:test";
import { stageHTML } from "../foundry-page.ts";
import { demoLine, fitScale, glanceRow, optionHead, YOURS } from "../foundry-stage.ts";

const page = { id: "a1", title: "Pin a chat", kind: "html" as const };
const at = "2026-11-13T10:00:00Z";

test("a version with a surface sits on it: Foundry draws the frame and the backdrop around the page (pass 221 A)", () => {
  const html = stageHTML(page, { version: 2, createdAt: at, stage: { surface: { frame: "window", width: 900, height: 560, title: "Settings" } } });
  expect(html).toContain('class="fd-stage fd-s s-window b-desk"');
  expect(html).toContain('data-ow="900" data-oh="590"');
  expect(html).toContain('<div class="fd-chrome" aria-hidden="true"><i></i><i></i><i></i><span>Settings</span></div>');
  expect(html).toContain("foundry://artifact/a1?v=2&amp;stack=1");
  expect(html).not.toContain("fd-demo");
  // A part grows with its content; a page with no width fills the stage.
  expect(stageHTML(page, { version: 1, createdAt: at, stage: { surface: { frame: "part" } } })).toContain('data-ow="360" data-oh="480" data-bar="0" data-grow');
  expect(stageHTML(page, { version: 1, createdAt: at, stage: { surface: { frame: "page" } } })).toContain("fd-fluid");
});

test("a demo rides on the stage, and its words get a quiet line under it; a deck gets one too", () => {
  const demo = [{ click: "Pin", say: "Click the pin" }];
  const html = stageHTML(page, { version: 1, createdAt: at, stage: { demo } });
  expect(html).toContain(`data-demo="${JSON.stringify(demo).replace(/"/g, "&quot;")}"`);
  expect(html).toMatch(/<\/div><p class="fd-demo" aria-live="polite"><\/p>$/);
  expect(stageHTML({ ...page, kind: "deck" }, { version: 1, createdAt: at })).toContain(" data-deck");
  // Without a surface or a demo it is the plain stage it always was.
  expect(stageHTML(page, { version: 1, createdAt: at })).toBe(`<div class="fd-stage k-html"><iframe class="fd-frame" src="foundry://artifact/a1?v=1&amp;stack=1&amp;at=${Date.parse(at)}" loading="lazy" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="Pin a chat v1"></iframe></div>`);
});

test("a surface only ever shrinks to fit, and the demo's line counts its beats", () => {
  expect(fitScale(800, 400)).toBe(1);
  expect(fitScale(640, 1280)).toBe(0.5);
  expect(fitScale(0, 1280)).toBe(1);
  expect(demoLine(1, 3, "Click <the> pin")).toBe('<span class="fd-ticks" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i></span><span>Click &lt;the&gt; pin</span>');
  expect(demoLine(0, 2, "")).toContain("Step 1 of 2");
  expect(YOURS).toMatch(/^Yours now/);
});

test("a style's line shows its colours as dots, then what it is made of (pass 246 A)", () => {
  expect(optionHead({ name: "B · Pin always showing", note: "louder" }, false)).toBe('<div class="fd-opt"><b>B · Pin always showing</b><span>louder</span></div>');
  expect(optionHead({ name: "Roastery <label>", note: "Mono capitals · square corners", colors: ["#1d1613", "#f3e9da", "#e0a93b"] }, true)).toBe(
    '<div class="fd-opt"><b>Roastery &lt;label&gt;</b><span class="fd-rec-pill">recommended</span>'
    + '<span class="fd-sw" aria-hidden="true"><i style="background:#1d1613"></i><i style="background:#f3e9da"></i><i style="background:#e0a93b"></i></span><span>Mono capitals · square corners</span></div>');
  expect(optionHead({ name: "Plain", note: "", colors: [] }, false)).toBe('<div class="fd-opt"><b>Plain</b></div>');
});

test("styles get one row of small ones: the same page in each, at its own width, a tall page cut at three quarters (pass 246 A)", () => {
  const options = [{ name: "Clean counter", note: "" }, { name: "Roastery label", note: "" }, { name: "Warm paper", note: "" }];
  const row = glanceRow("foundry://artifact/a1?v=1&stack=1&at=5", "Checkout v1", options, 0, 760, 380);
  expect(row).toStartWith('<div class="fd-glance" data-ow="760" data-oh="380" role="group" aria-label="The styles side by side">');
  expect(row.match(/<figure>/g)).toHaveLength(3);
  expect(row).toContain('<div class="fd-mini" style="--ow:760px;--oh:380px"><iframe class="fd-mini-frame" src="foundry://artifact/a1?v=1&amp;stack=1&amp;at=5&amp;option=1" loading="lazy" tabindex="-1" aria-hidden="true" sandbox="allow-scripts"');
  expect(row).toContain('<figcaption><b>Clean counter</b><span class="fd-rec-pill">recommended</span></figcaption>');
  expect(row).toContain("<figcaption><b>Warm paper</b></figcaption>");
  // Nothing in it is a control.
  expect(row).not.toMatch(/<button|<a |data-action/);
  expect(glanceRow("x", "t", options, -1, 1000, 2400)).toContain('data-ow="1000" data-oh="750"');
});
