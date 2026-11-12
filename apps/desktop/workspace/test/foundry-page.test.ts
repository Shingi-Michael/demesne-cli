import { expect, test } from "bun:test";
import type { FoundryArtifact } from "@demesne/protocol";
import { foundryPage, shelfKey } from "../foundry-page.ts";

const artifact = (id: string, title: string, kind: FoundryArtifact["kind"] = "html"): FoundryArtifact =>
  ({ id, title, kind, workspace: null, sessionId: "s1", createdAt: "2026-11-07T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z", version: 2, description: "", basedOn: null });
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).toISOString();
const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9).toISOString();

test("Foundry is one long page: every version, newest first, under its day, at real size", () => {
  const html = foundryPage({
    list: [artifact("a1", "Coffee pricing"), artifact("b2", "Brief", "markdown")],
    versions: [
      { artifactId: "a1", version: 2, createdAt: today, sessionId: "s1", note: "Blue" },
      { artifactId: "b2", version: 1, createdAt: today, sessionId: null, note: "" },
      { artifactId: "a1", version: 1, createdAt: earlier, sessionId: "s1", note: "" },
      { artifactId: "gone", version: 1, createdAt: earlier, sessionId: null, note: "" },
    ],
    error: "",
    chatTitle: (id) => id === "s1" ? "Pricing page" : null,
  });
  // Two days, the newest first; the rail on the edge replaces the day strip.
  expect(html.match(/class="fd-day"/g)?.length).toBe(2);
  expect(html.indexOf(">Today<")).toBeLessThan(html.indexOf(">Yesterday<"));
  expect(html).not.toContain("fd-days");
  // Each version once, its line and its page; a deleted artifact's versions drop out.
  expect(html.match(/class="fd-item"/g)?.length).toBe(3);
  expect(html).toContain(`data-fd="${shelfKey("a1", 2)}"`);
  expect(html).toMatch(/from <button[^>]*data-action="select-session"[^>]*>“Pricing page”<\/button>/);
  expect(html).toContain("<b>v2 · Blue</b>");
  expect(html).toContain("foundry://artifact/a1?v=1&amp;stack=1");
  expect(html).toContain('loading="lazy"');
  // A document renders through the sanitizer once it scrolls near.
  expect(html).toContain(`data-md="${shelfKey("b2", 1)}"`);
  // Nothing to press on a mockup: only links to where it came from.
  expect(html).not.toMatch(/<button[^>]*data-action="foundry-(version|close|delete|export)/);
});

test("an empty Foundry says how mockups get there", () => {
  expect(foundryPage({ list: [], versions: [], error: "", chatTitle: () => null })).toContain("Nothing made yet");
  expect(foundryPage({ list: null, versions: null, error: "", chatTitle: () => null })).toContain("Reading Foundry");
});

test("a mockup shows its description, its version's name and what it was based on (pass 208 A)", () => {
  const html = foundryPage({
    list: [{ ...artifact("a1", "Roaster pricing"), description: "Three plans. Try the yearly switch." }, { ...artifact("p2", "Roaster pricing, phone"), basedOn: { id: "a1", version: 2 } }],
    versions: [{ artifactId: "p2", version: 1, createdAt: today, sessionId: null, note: "First take" }],
    error: "",
    chatTitle: () => null,
  });
  expect(html).not.toContain("Three plans");
  expect(html).toContain("<b>v1 · First take</b>");
  expect(html).toMatch(/based on <button[^>]*data-action="foundry-open"[^>]*>Roaster pricing v2<\/button>/);
  expect(html).toContain('data-args="{&quot;id&quot;:&quot;a1&quot;,&quot;version&quot;:2}"');
});

test("what one ask made sits together, the one it would use first and marked (pass 208 A)", () => {
  const list = [{ ...artifact("calm", "Calm"), description: "Quiet." }, artifact("bold", "Bold"), artifact("old", "Old")];
  const versions = [
    { artifactId: "calm", version: 1, createdAt: today, sessionId: "s1", turnId: "t1", note: "", recommended: false },
    { artifactId: "bold", version: 1, createdAt: today, sessionId: "s1", turnId: "t1", note: "", recommended: true },
    { artifactId: "old", version: 3, createdAt: today, sessionId: "s1", turnId: "t0", note: "", recommended: true },
  ];
  const html = foundryPage({ list, versions, error: "", chatTitle: () => null });
  expect(html.indexOf('data-fd="bold:1"')).toBeLessThan(html.indexOf('data-fd="calm:1"'));
  expect(html).toContain("<p class=\"fd-desc\">Quiet.</p>");
  // Only where one ask made several does the pick show.
  expect(html.match(/fd-rec-pill/g)?.length).toBe(1);
  expect(html).toMatch(/class="fd-item fd-rec" data-fd="bold:1"/);
});

test("each version says why it looks the way it does, quietly under the description (pass 218 A)", () => {
  const html = foundryPage({
    list: [{ ...artifact("a1", "Roastery pricing"), description: "Three plans." }],
    versions: [
      { artifactId: "a1", version: 2, createdAt: today, sessionId: null, note: "Middle leads", why: { direction: "Warm paper & a serif.", look: "The dark middle plan.", dropped: "" } },
      { artifactId: "a1", version: 1, createdAt: today, sessionId: null, note: "" },
    ],
    error: "",
    chatTitle: () => null,
  });
  // Direction and what to look at; a line with nothing dropped is left out, and so is a version saved before.
  expect(html.match(/class="fd-why"/g)?.length).toBe(1);
  expect(html).toContain("<dt>Direction</dt><dd>Warm paper &amp; a serif.</dd><dt>Look at</dt><dd>The dark middle plan.</dd></dl>");
  expect(html).not.toContain("<dt>Dropped</dt>");
  expect(html.indexOf("fd-desc")).toBeLessThan(html.indexOf("fd-why"));
  expect(html.indexOf("fd-why")).toBeLessThan(html.indexOf("fd-ver"));
});
