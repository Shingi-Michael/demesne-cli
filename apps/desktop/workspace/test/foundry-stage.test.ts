import { expect, test } from "bun:test";
import { stageHTML } from "../foundry-page.ts";
import { demoLine, fitScale, YOURS } from "../foundry-stage.ts";

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
