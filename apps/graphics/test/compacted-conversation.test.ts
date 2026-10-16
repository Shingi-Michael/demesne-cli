import { expect, test } from "bun:test";
import type { SessionCheckpoint } from "@demesne/protocol";
import type { GraphicsRun } from "../session-model.ts";
import { compactedConversation } from "../compacted-conversation.ts";
const run = (id: string, kind = "chat"): GraphicsRun => ({ id, kind, number: 1, content: id, status: "completed", createdAt: "", completedAt: "", planOnly: false, entries: [{ id: 1, type: "assistant", raw: `Summary for ${id}`, streaming: false, revision: 1 }] });
const checkpoint = (firstRetainedTurnId = "recent-1", turnId = "compact"): SessionCheckpoint => ({ firstRetainedTurnId, turnId, summary: "saved fallback" } as SessionCheckpoint);
test("collapses only the saved prefix, keeping recent and newly appended turns", () => {
  const runs = [run("old"), run("old-compact", "compaction"), run("recent-1"), run("recent-2"), run("compact", "compaction"), run("new")];
  const result = compactedConversation(runs, checkpoint())!;
  expect([...result.hiddenIds]).toEqual(["old", "old-compact"]);
  expect(result.summary).toBe("Summary for compact");
  expect(result.hiddenIds.has("recent-1")).toBe(false);
  expect(result.hiddenIds.has("new")).toBe(false);
});
test("a later compaction advances the boundary and uses its new summary", () => {
  const runs = [run("old"), run("recent-1"), run("recent-2"), run("compact", "compaction"), run("new"), run("newer"), run("compact-2", "compaction")];
  const result = compactedConversation(runs, checkpoint("new", "compact-2"))!;
  expect([...result.hiddenIds]).toEqual(["old", "recent-1", "recent-2", "compact"]);
  expect(result.summary).toBe("Summary for compact-2");
});
test("missing or inconsistent checkpoints never hide conversation", () => {
  const runs = [run("old"), run("recent-1"), run("compact", "compaction")];
  expect(compactedConversation(runs, null)).toBeNull();
  expect(compactedConversation(runs, { ...checkpoint(), firstRetainedTurnId: undefined })).toBeNull();
  expect(compactedConversation(runs, checkpoint("missing"))).toBeNull();
  expect(compactedConversation(runs, checkpoint("recent-1", "missing"))).toBeNull();
  expect(compactedConversation(runs, checkpoint("compact", "old"))).toBeNull();
});
