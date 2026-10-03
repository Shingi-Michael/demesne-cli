import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDriveRequest } from "@demesne/protocol";
import { ProjectMemory } from "../src/drive-memory.ts";

const scratch = () => { const root = mkdtempSync(join(tmpdir(), "memory-")); return { root, memory: new ProjectMemory(join(root, "drive", "memory.jsonl")) }; };

test("remember, list, dedupe and forget by id prefix; the file is plain JSON lines", () => {
  const { root, memory } = scratch();
  try {
    const a = memory.add({ kind: "preference", text: "  Keep the CLI   clean ", source: "you" });
    expect(a.text).toBe("Keep the CLI clean");
    expect(memory.add({ kind: "preference", text: "keep the cli clean", source: "you" }).id).toBe(a.id);
    memory.add({ kind: "outcome", text: "Fixed the footer", source: "drive" });
    expect(memory.list().map((item) => item.text)).toEqual(["Keep the CLI clean", "Fixed the footer"]);
    memory.forget(a.id.slice(0, 4));
    expect(memory.list().map((item) => item.text)).toEqual(["Fixed the footer"]);
    expect(() => memory.forget("zzzz")).toThrow("No memory");
    const lines = readFileSync(memory.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ forget: a.id });
    // A hand-edited, broken line is skipped, not fatal.
    appendFileSync(memory.path, "{not json\n");
    expect(memory.list()).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the planner gets every standing note first, then the newest outcomes, within budget; requests validate", () => {
  const { root, memory } = scratch();
  try {
    memory.add({ kind: "decision", text: "Graphics is demesne", source: "you" });
    for (let i = 0; i < 30; i++) memory.add({ kind: "outcome", text: `Outcome ${i} ${"x".repeat(300)}`, source: "drive" });
    const planned = memory.forPlanner();
    expect(planned[0]).toMatchObject({ kind: "decision" });
    expect(planned[1]!.text).toStartWith("Outcome 29");
    expect(planned.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(6000);
    const request = parseDriveRequest({ mission: "m", homeSessionId: "s", projectMemory: planned,
      memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] },
      observation: { id: "o", sessionId: "s", workspace: "/w", title: "", mode: "input", ready: true, draft: "", surface: "direct", width: 10, height: 10, rows: [], controls: [] } });
    expect(request.projectMemory).toHaveLength(planned.length);
    expect(() => parseDriveRequest({ ...request, projectMemory: [{ id: "x", kind: "rumor", text: "t", source: "you", at: "now" }] })).toThrow("memory entry");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction keeps standing notes and the newest outcomes", () => {
  const { root, memory } = scratch();
  try {
    memory.add({ kind: "preference", text: "Ask on design choices", source: "you" });
    for (let i = 0; i < 650; i++) memory.add({ kind: "outcome", text: `Outcome ${i}`, source: "drive" });
    const lines = readFileSync(memory.path, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(600);
    const kept = memory.list();
    expect(kept[0]).toMatchObject({ kind: "preference" });
    expect(kept.at(-1)!.text).toBe("Outcome 649");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
