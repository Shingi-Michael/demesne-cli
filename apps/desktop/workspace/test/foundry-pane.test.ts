import { expect, test } from "bun:test";
import type { FoundryArtifactDetail } from "@demesne/protocol";
import { frameSource, neighbours, paneFoot, paneHead, paneMakingHead } from "../foundry-pane.ts";

const versions = [3, 2, 1].map((version) => ({ version, createdAt: "2026-10-27T22:00:00.000Z", sessionId: null, turnId: null, note: version === 3 ? "Blue" : "", byteLength: 10 }));
const detail: FoundryArtifactDetail = { id: "garden", title: "Tiny garden", kind: "html", workspace: null, sessionId: "s1", createdAt: versions[2]!.createdAt, updatedAt: versions[0]!.createdAt, version: 3, source: "<h1>Garden</h1>", versions };

test("the versions either side of the one shown", () => {
  expect(neighbours(versions, 3)).toEqual({ earlier: 2, later: null, latest: 3 });
  expect(neighbours(versions, 1)).toEqual({ earlier: null, later: 2, latest: 3 });
  expect(neighbours(versions, 2)).toEqual({ earlier: 1, later: 3, latest: 3 });
  expect(neighbours([], 1)).toEqual({ earlier: null, later: null, latest: 1 });
});

test("the head is one line: title, version arrows, Preview · Code, phone, close", () => {
  const head = paneHead(detail, { id: "garden", version: 3, view: "preview", phone: false });
  expect(head).toContain('class="pane-title" title="Tiny garden"');
  expect(head).toContain('data-pane="earlier" aria-label="Earlier version" title="v2"');
  expect(head).toContain('data-pane="later" aria-label="Later version" disabled');
  expect(head).toContain('data-pane="preview" aria-pressed="true"');
  expect(head).toContain('data-pane="code" aria-pressed="false"');
  expect(head).toContain('aria-label="Phone width" title="Phone width" aria-pressed="false"');
  expect(head).toContain('data-pane="close"');
  // Only a prototype has a phone width; a graphic or document has no such button.
  expect(paneHead({ ...detail, kind: "svg" }, { id: "garden", version: 3, view: "code", phone: false })).not.toContain("Phone width");
  expect(paneHead(null, { id: "garden", version: 1, view: "preview", phone: false })).toContain("Loading…");
  expect(paneHead({ ...detail, title: '<b>"x"</b>' }, { id: "garden", version: 3, view: "preview", phone: false })).not.toContain("<b>");
});

test("the foot names the version and offers Make this the latest only on an older one", () => {
  const latest = paneFoot(detail, { id: "garden", version: 3, view: "preview", phone: false }, "");
  expect(latest).toContain("<b>v3</b>");
  expect(latest).toContain("Blue");
  expect(latest).not.toContain("Make this the latest");
  for (const word of ["Copy", "Export", "Revise", "Open in Foundry ›"]) expect(latest).toContain(word);
  const older = paneFoot(detail, { id: "garden", version: 1, view: "preview", phone: false }, "");
  expect(older).toContain("first version");
  expect(older).toContain('data-pane="restore"');
  expect(paneFoot(detail, { id: "garden", version: 3, view: "preview", phone: false }, "No such artifact")).toContain('role="alert"');
  expect(paneFoot(null, { id: "garden", version: 3, view: "preview", phone: false }, "")).toContain("Reading");
});

test("the first show of a version asks the frame to assemble; any other show is plain", () => {
  expect(frameSource("garden", 2, true)).toBe("foundry://artifact/garden?v=2&assemble=1");
  expect(frameSource("garden", 2, false)).toBe("foundry://artifact/garden?v=2");
});

test("while Foundry writes, the line above the pane is the title alone", () => {
  const head = paneMakingHead("Tiny <garden>");
  expect(head).toContain("Tiny &lt;garden&gt;");
  expect(head).toContain("making…");
  expect(head).toContain('data-pane="close"');
  expect(head).not.toContain("Preview");
});
