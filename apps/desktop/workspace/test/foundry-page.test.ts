import { expect, test } from "bun:test";
import type { FoundryArtifact } from "@demesne/protocol";
import { foundryPage, shelfKey } from "../foundry-page.ts";

const artifact = (id: string, title: string, kind: FoundryArtifact["kind"] = "html"): FoundryArtifact =>
  ({ id, title, kind, workspace: null, sessionId: "s1", createdAt: "2026-11-07T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z", version: 2 });
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
  // Two days, a strip to jump between them, the newest day first.
  expect(html.match(/class="fd-day"/g)?.length).toBe(2);
  expect(html.indexOf(">Today<")).toBeLessThan(html.indexOf(">Yesterday<"));
  expect(html).toContain('data-action="foundry-day"');
  // Each version once, its line and its page; a deleted artifact's versions drop out.
  expect(html.match(/class="fd-item"/g)?.length).toBe(3);
  expect(html).toContain(`data-fd="${shelfKey("a1", 2)}"`);
  expect(html).toContain("from “Pricing page”");
  expect(html).toContain('title="Blue"');
  expect(html).toContain("foundry://artifact/a1?v=1&amp;stack=1");
  expect(html).toContain('loading="lazy"');
  // A document renders through the sanitizer once it scrolls near.
  expect(html).toContain(`data-md="${shelfKey("b2", 1)}"`);
  // Nothing to press on a mockup.
  expect(html).not.toMatch(/<button[^>]*data-action="foundry-(open|version|close|delete|export)/);
});

test("an empty Foundry says how mockups get there", () => {
  expect(foundryPage({ list: [], versions: [], error: "", chatTitle: () => null })).toContain("Nothing made yet");
  expect(foundryPage({ list: null, versions: null, error: "", chatTitle: () => null })).toContain("Reading Foundry");
});
