import { expect, test } from "bun:test";
import { chatArtifacts, type ChatArtifact } from "../foundry-inline.ts";
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
