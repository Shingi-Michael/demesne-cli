import { expect, test } from "bun:test";
import { chatArtifacts, chipPicture, type ChatArtifact } from "../foundry-inline.ts";
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


test("a chip carries the description and the version's name, and the pick leads (pass 208 A)", async () => {
  const { chipWords } = await import("../foundry-inline.ts");
  const calm = { ...artifact, id: "calm", title: "Calm", description: "Quiet plans.", note: "First take" };
  const bold = { ...artifact, id: "bold", title: "Bold", description: "Loud plans.", recommended: true };
  expect(chatArtifacts([save(calm), save(bold)])).toEqual([bold, calm]);
  expect(chipWords(calm)).toBe("Prototype · v1 · First take");
  // A lone mockup is never marked; a later fold without words keeps them.
  expect(chatArtifacts([save(bold)])).toEqual([{ ...artifact, id: "bold", title: "Bold", description: "Loud plans." }]);
  expect(chatArtifacts([save(calm), save({ ...artifact, id: "calm", title: "Calm" })])).toEqual([calm]);
});

test("a build's record is a chip that says how it came out (pass 241 A)", async () => {
  const { chipWords } = await import("../foundry-inline.ts");
  const record = { id: "plans-built", title: "Plans page, built", kind: "html", version: 1, note: "matches", built: true };
  const [chip] = chatArtifacts([{ name: "foundry_built", state: "done", message: JSON.stringify(record) }]);
  expect(chip).toEqual(record as ChatArtifact);
  expect(chipWords(chip!)).toBe("Built like the mockup · matches");
  expect(chipWords({ ...chip!, note: "2 still differ" })).toBe("Built like the mockup · 2 still differ");
  // Only foundry_built makes a record chip; a save that says built is a plain mockup.
  expect(chatArtifacts([save(record)])[0]!.built).toBeUndefined();
});

test("pass 280 B: the card's picture is the mockup itself, still and out of reach", () => {
  const html = chipPicture({ id: "garden", version: 3 });
  expect(html).toContain('src="foundry://artifact/garden?v=3"');
  for (const part of ['loading="lazy"', "inert", 'tabindex="-1"', 'sandbox="allow-scripts"', 'aria-hidden="true"']) expect(html).toContain(part);
  expect(html).not.toContain("allow-same-origin");
});
