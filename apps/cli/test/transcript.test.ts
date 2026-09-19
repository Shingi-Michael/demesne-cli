import { describe, expect, test } from "bun:test";
import {
  MIN_COLLAPSED_INSPECTIONS,
  planTranscript,
  type PlannedEntry,
} from "../src/workbench/transcript.ts";

/// Builds the entry shapes the controller emits, so the planner is exercised
/// with the same field names and ordering it sees in production.
const user = (): PlannedEntry => ({ type: "user" });
const prose = (): PlannedEntry => ({ type: "assistant" });
const notice = (): PlannedEntry => ({ type: "notice" });
const read = (name = "read_file"): PlannedEntry => ({ type: "tool", phase: "inspect", name });
const edit = (): PlannedEntry => ({ type: "tool", phase: "change", name: "edit_file" });
const run = (): PlannedEntry => ({ type: "tool", phase: "verify", name: "run_command" });
const waiting = (): PlannedEntry => ({ type: "tool", phase: "inspect", name: "read_file", waiting: true });

function shape(entries: readonly PlannedEntry[]): string[] {
  return planTranscript(entries).map((item) =>
    item.kind === "group" ? `group(${item.tools.length})` : `entry:${item.entry.type}`);
}

describe("planTranscript", () => {
  test("collapses a contiguous run of same-verb inspections", () => {
    expect(shape([user(), read(), read(), read(), read(), read(), read(), prose()]))
      .toEqual(["entry:user", "group(6)", "entry:assistant"]);
  });

  test("leaves a run shorter than the minimum alone", () => {
    expect(shape([read(), read()])).toEqual(["entry:tool", "entry:tool"]);
    expect(shape([read(), read(), read()])).toEqual(["group(3)"]);
    expect(MIN_COLLAPSED_INSPECTIONS).toBe(3);
  });

  test("never collapses changes or verification, however long the run", () => {
    expect(shape([edit(), edit(), edit(), edit()])).toEqual(Array(4).fill("entry:tool"));
    expect(shape([run(), run(), run()])).toEqual(Array(3).fill("entry:tool"));
  });

  test("breaks the run on a different verb so a search is not counted as a read", () => {
    expect(shape([read(), read(), read("search_files"), read("search_files"), read("search_files")]))
      .toEqual(["entry:tool", "entry:tool", "group(3)"]);
  });

  test("does not collapse across narration", () => {
    // Six reads, each announced. Collapsing these would mean either dropping
    // the agent's words or burying them in a row about tool calls.
    const interleaved = [read(), prose(), read(), prose(), read(), prose(), read()];
    expect(shape(interleaved)).toEqual([
      "entry:tool", "entry:assistant", "entry:tool", "entry:assistant",
      "entry:tool", "entry:assistant", "entry:tool",
    ]);
  });

  test("resumes collapsing after the narration ends", () => {
    expect(shape([prose(), read(), read(), read(), prose(), read(), read(), read()]))
      .toEqual(["entry:assistant", "group(3)", "entry:assistant", "group(3)"]);
  });

  test("does not hide a row that is waiting on the user", () => {
    expect(shape([read(), read(), waiting()])).toEqual(["entry:tool", "entry:tool", "entry:tool"]);
  });

  test("keeps every entry when nothing is collapsible", () => {
    const entries = [user(), prose(), notice(), edit(), run(), notice()];
    expect(shape(entries)).toEqual(entries.map(() => "entry:user").map((_, index) =>
      `entry:${entries[index]!.type}`));
  });

  test("groups preserve the order and columns of the members", () => {
    const entries: PlannedEntry[] = [
      { type: "tool", phase: "inspect", name: "read_file", state: "done", detail: "src/a.ts", durationMs: 1, id: 7 },
      { type: "tool", phase: "inspect", name: "read_file", state: "failed", detail: "src/b.ts", durationMs: 2, id: 8 },
      { type: "tool", phase: "inspect", name: "read_file", state: "done", detail: "src/c.ts", durationMs: 3, id: 9 },
    ];
    const plan = planTranscript(entries);
    expect(plan).toHaveLength(1);
    const group = plan[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.tools.map((tool) => tool.detail)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(group.tools.map((tool) => tool.id)).toEqual([7, 8, 9]);
    // A failed member survives into the group so the summary can report it.
    expect(group.tools.some((tool) => tool.state === "failed")).toBe(true);
    expect(group.tools[0]).toEqual({
      type: "tool", name: "read_file", phase: "inspect", state: "done", detail: "src/a.ts", durationMs: 1, id: 7,
    });
  });

  test("handles an empty transcript", () => {
    const none: PlannedEntry[] = [];
    expect(planTranscript(none)).toEqual([]);
  });
});
