/// Pass 263 A: variants as tabs, every one explained under the mockup.
import { expect, test } from "bun:test";
import type { FoundryArtifact, FoundryWalk } from "@demesne/protocol";
import { foundryPage, walkHTML } from "../foundry-page.ts";
import { variantTabs } from "../foundry-stage.ts";

const walk: FoundryWalk[] = [
  { option: "Week grid", what: "The whole week at once.", parts: [{ name: "Today's column", says: "is marked.", at: ".dh.today" }, { name: "A class", says: "shows its time." }], why: "Regulars plan the week.", differs: "The only one with the whole week.", next: "Fold to a day list on a phone." },
  { option: "Day view", what: "Today, large.", parts: [{ name: "Book", says: "on every row.", at: ".bk" }, { name: "Tomorrow", says: "in small." }], why: "Most book on the day." },
];

test("the walkthrough is each variant's own section, the first shown, its parts numbered", () => {
  const html = walkHTML(walk, "Class schedule");
  expect(html).toContain('aria-label="Class schedule, explained"');
  expect(html.match(/class="fd-walk-v"/g)?.length).toBe(2);
  expect(html).toContain('<section class="fd-walk-v" data-option="Week grid"><p class="fd-walk-what">The whole week at once.</p>');
  expect(html).toContain('<section class="fd-walk-v" data-option="Day view" hidden>');
  expect(html).toContain('<li data-n="1" data-at=".dh.today"><span class="fd-num" aria-hidden="true">1</span><span><b>Today&#39;s column</b> is marked.</span></li>');
  expect(html).toContain('<li data-n="2"><span class="fd-num"');
  expect(html).toContain("<h4>How it differs from the other</h4><p>The only one with the whole week.</p>");
  expect(html).toContain("<h4>What I’d do next</h4>");
  // What a variant leaves out has no heading.
  expect(html.split('data-option="Day view"')[1]).not.toContain("How it differs");
  expect(walkHTML(undefined, "x")).toBe("");
});

test("variants are tabs over the one stage, the pick with a dot", () => {
  const html = variantTabs([{ name: "Week grid", note: "calm" }, { name: "Day view", note: "" }, { name: "Compact", note: "" }], 0, 0);
  expect(html).toContain('role="tablist" aria-label="Variants"');
  expect(html.match(/role="tab"/g)?.length).toBe(3);
  expect(html).toContain('class="fd-tab on" data-variant="0" aria-selected="true" title="calm">Week grid<i class="fd-tab-pick" aria-label="recommended"');
  expect(html).toContain('class="fd-tab" data-variant="2" aria-selected="false">Compact</button>');
});

test("on Foundry the walkthrough sits under the mockup, and the why lines step back to what was dropped", () => {
  const artifact: FoundryArtifact = { id: "s1", title: "Class schedule", kind: "html", workspace: null, sessionId: null, createdAt: "2026-11-22T10:00:00Z", updatedAt: "2026-11-22T10:00:00Z", version: 1, description: "", basedOn: null };
  const version = { artifactId: "s1", version: 1, createdAt: new Date().toISOString(), sessionId: null, note: "", why: { direction: "Calm.", look: "The week.", dropped: "A month view.", walk } };
  const html = foundryPage({ list: [artifact], versions: [version], error: "", chatTitle: () => null });
  expect(html.indexOf('class="fd-stage')).toBeLessThan(html.indexOf('class="fd-walk"'));
  expect(html).toContain("<dt>Dropped</dt><dd>A month view.</dd>");
  expect(html).not.toContain("<dt>Direction</dt>");
  // Without a walkthrough (older versions) the three lines stay as they were.
  const old = foundryPage({ list: [artifact], versions: [{ ...version, why: { direction: "Calm.", look: "The week.", dropped: "" } }], error: "", chatTitle: () => null });
  expect(old).toContain("<dt>Direction</dt><dd>Calm.</dd>");
  expect(old).not.toContain("fd-walk");
  // Opened with its code shown, no walkthrough under the code.
  expect(foundryPage({ list: [artifact], versions: [version], error: "", chatTitle: () => null, open: { id: "s1", at: 1, shown: 1, code: "<p>" } })).not.toContain("fd-walk");
});
