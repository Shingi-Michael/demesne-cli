import { expect, test } from "bun:test";
import { chatArtifacts, makingTitle, type ChatArtifact } from "../foundry-inline.ts";
import type { ToolEntry } from "@demesne/workbench/entries.ts";

const save = (value: unknown, state: ToolEntry["state"] = "done") => ({ name: "foundry_save", state, message: JSON.stringify(value) });
const artifact: ChatArtifact = { id: "garden", title: "Tiny Garden", kind: "html", version: 1 };

test("inline previews use successful saved artifacts, including old chat history", () => {
  expect(chatArtifacts([save(artifact), save({ ...artifact, id: "logo", kind: "svg" })])).toEqual([
    artifact, { ...artifact, id: "logo", kind: "svg" },
  ]);
  for (const state of ["running", "failed", "denied", "stopped"] as const) expect(chatArtifacts([save(artifact, state)])).toEqual([]);
  expect(chatArtifacts([{ name: "foundry_read", state: "done", message: JSON.stringify(artifact) }])).toEqual([]);
});

test("an edit is a save too: its new version replaces the preview", () => {
  const edit = { name: "foundry_edit", state: "done" as const, message: JSON.stringify({ ...artifact, version: 2 }) };
  expect(chatArtifacts([save(artifact), edit])).toEqual([{ ...artifact, version: 2 }]);
  expect(chatArtifacts([edit])).toEqual([{ ...artifact, version: 2 }]);
  expect(chatArtifacts([{ ...edit, state: "failed" }])).toEqual([]);
});

test("multiple saves in a turn show the final version of each artifact", () => {
  expect(chatArtifacts([save(artifact), save({ ...artifact, id: "logo", kind: "svg" }), save({ ...artifact, version: 2 })])).toEqual([
    { ...artifact, version: 2 }, { ...artifact, id: "logo", kind: "svg" },
  ]);
});

test("malformed tool output cannot become a preview URL", () => {
  const invalid = [null, {}, { ...artifact, id: "https://example.com" }, { ...artifact, id: "../secret" },
    { ...artifact, kind: "script" }, { ...artifact, version: 0 }, { ...artifact, version: 1.5 }, { ...artifact, title: null }];
  expect(chatArtifacts(invalid.map(value => save(value)))).toEqual([]);
  expect(chatArtifacts([{ name: "foundry_save", state: "done", message: "Truncated JSON{" }])).toEqual([]);
});

test("a chip's words name the kind and the version", async () => {
  const { chipWords } = await import("../foundry-inline.ts");
  expect(chipWords(artifact)).toBe("Prototype · v1");
  expect(chipWords({ ...artifact, kind: "markdown", version: 4 })).toBe("Document · v4");
});

test("an artifact keeps one chip, in the turn that first showed it; later turns that changed it are Edited lines", async () => {
  const { editedIn } = await import("../foundry-inline.ts");
  const garden = { id: "garden", title: "Garden", kind: "html" as const, version: 1 }, badge = { id: "badge", title: "Badge", kind: "svg" as const, version: 1 };
  expect(editedIn([[garden], [], [{ ...garden, version: 2 }, badge], [{ ...badge, version: 2 }, { ...garden, version: 3 }]]).map((set) => [...set]))
    .toEqual([[], [], ["garden"], ["badge", "garden"]]);
});

test("the title of the page Foundry is writing comes from the arguments still arriving", () => {
  const draft = (draftArguments: string, extra: Partial<ToolEntry> = {}) => ({ name: "foundry_save", state: "running" as const, input: {}, drafting: true, draftArguments, ...extra });
  expect(makingTitle([])).toBeNull();
  expect(makingTitle([{ name: "foundry_save", state: "done", input: { title: "Done" } }])).toBeNull();
  expect(makingTitle([draft('{"title": "Idea \\"garden\\"", "kind": "html", "source": "<!doctype')])).toBe('Idea "garden"');
  expect(makingTitle([draft('{"kind": "html", "sou')])).toBe("Something new");
  expect(makingTitle([draft("", { input: { title: "From input" }, drafting: false })])).toBe("From input");
  // An edit of an open artifact is not a new page: the pane keeps what it shows.
  expect(makingTitle([{ name: "foundry_edit", state: "running", input: { id: "garden" }, drafting: true, draftArguments: '{"title": "x"' }])).toBeNull();
});
