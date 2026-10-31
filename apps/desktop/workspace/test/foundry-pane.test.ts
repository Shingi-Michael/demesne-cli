import { expect, test } from "bun:test";
import type { FoundryArtifactDetail } from "@demesne/protocol";
import { frameSource, motionLine, motionMessage, neighbours, paneFoot, paneHead, paneMakingHead } from "../foundry-pane.ts";

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

test("the frame's runtime is heard only in the two shapes it speaks, and nothing else", () => {
  expect(motionMessage({ demesne: "motions", motions: [{ name: "Arrive", duration: 1200 }, { name: 7, duration: 1 }, { name: "Switch", duration: -1 }], current: "Arrive" }))
    .toEqual({ motions: [{ name: "Arrive", duration: 1200 }], current: "Arrive" });
  expect(motionMessage({ demesne: "motions", motions: [], current: 3 })).toEqual({ motions: [], current: null });
  expect(motionMessage({ demesne: "motion", state: { name: "Arrive", duration: 1200, currentTime: 600, progress: 1.5, paused: "no" } }))
    .toEqual({ state: { name: "Arrive", duration: 1200, currentTime: 600, progress: 1, paused: false } });
  expect(motionMessage({ demesne: "motion", state: { name: "Arrive", duration: "1200", currentTime: 0, progress: 0 } })).toBeNull();
  expect(motionMessage({ demesne: "motion", state: { name: "x".repeat(61), duration: 1, currentTime: 0, progress: 0 } })).toBeNull();
  expect(motionMessage({ demesne: "other" })).toBeNull();
  expect(motionMessage("motions")).toBeNull();
  expect(motionMessage(null)).toBeNull();
  // At most a dozen motions make the line; more are the page's problem.
  const many = motionMessage({ demesne: "motions", motions: Array.from({ length: 20 }, (_, i) => ({ name: `m${i}`, duration: 1 })) });
  expect(many && "motions" in many ? many.motions : []).toHaveLength(12);
});

test("the motion line: play or pause, the scrubber, the time, the motions by name, half speed, Replay; nothing for a page without motions", () => {
  const motions = [{ name: "Arrive", duration: 1200 }, { name: "Switch <plan>", duration: 300 }];
  expect(motionLine([], null, null, false)).toBe("");
  const playing = motionLine(motions, { name: "Arrive", duration: 1200, currentTime: 600, progress: 0.5, paused: false }, "Arrive", false);
  expect(playing).toContain('data-pane="mo-play" class="mo-play" aria-label="Pause"');
  expect(playing).toContain('data-pane="mo-seek" min="0" max="1000" value="500" aria-label="Scrub Arrive"');
  expect(playing).toContain("0.60s / 1.20s");
  expect(playing).toContain('data-pane="mo-pick" data-name="Arrive" aria-pressed="true"');
  expect(playing).toContain('data-name="Switch &lt;plan&gt;" aria-pressed="false"');
  expect(playing).not.toContain("<plan>");
  expect(playing).toContain('data-pane="mo-speed" aria-pressed="false"');
  expect(playing).toContain('data-pane="mo-replay"');
  const paused = motionLine(motions, { name: "Switch <plan>", duration: 300, currentTime: 300, progress: 1, paused: true }, "Switch <plan>", true);
  expect(paused).toContain('aria-label="Play"');
  expect(paused).toContain('value="1000"');
  expect(paused).toContain('data-pane="mo-speed" aria-pressed="true"');
  // Before the first tick, the line shows the current motion at its start.
  const fresh = motionLine(motions, null, "Switch <plan>", false);
  expect(fresh).toContain("0.00s / 0.30s");
  expect(fresh).toContain('data-name="Switch &lt;plan&gt;" aria-pressed="true"');
  expect(motionLine(motions, null, null, false)).toContain("0.00s / 1.20s");
});
