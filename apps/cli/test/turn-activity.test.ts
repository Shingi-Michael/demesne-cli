import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type EventEnvelope, type EventType } from "@demesne/protocol";
import { TurnActivityLedger, classifyTurnPhase } from "../src/turn-activity.ts";

describe("TurnActivityLedger", () => {
  test("groups inspect, change, and verification evidence across model rounds", () => {
    const ledger = new TurnActivityLedger();
    ledger.apply(event(1, "model.request_started", {}));
    ledger.apply(event(2, "tool.call_requested", {
      toolCallId: "read",
      name: "read_files",
      arguments: JSON.stringify({ paths: ["src/a.ts", "src/b.ts"] }),
    }));
    ledger.apply(event(3, "tool.call_started", { toolCallId: "read", name: "read_files" }, 100));
    ledger.apply(event(4, "tool.call_completed", { toolCallId: "read", name: "read_files" }, 135));
    ledger.apply(event(5, "model.request_started", {}));
    ledger.apply(event(6, "tool.call_requested", {
      toolCallId: "edit",
      name: "edit_file",
      arguments: JSON.stringify({ path: "src/a.ts", oldText: "a", newText: "b" }),
    }));
    ledger.apply(event(7, "tool.call_started", { toolCallId: "edit", name: "edit_file" }, 200));
    ledger.apply(event(8, "tool.call_completed", { toolCallId: "edit", name: "edit_file", created: false }, 240));
    ledger.apply(event(9, "tool.call_requested", {
      toolCallId: "test",
      name: "run_command",
      arguments: JSON.stringify({ argv: ["bun", "test"] }),
    }));
    ledger.apply(event(10, "tool.call_started", { toolCallId: "test", name: "run_command" }, 300));
    ledger.apply(event(11, "tool.call_completed", { toolCallId: "test", name: "run_command", exitCode: 0 }, 425));

    expect(ledger.snapshot()).toMatchObject({
      rounds: 2,
      tools: 3,
      changes: [{ operation: "M", path: "src/a.ts", state: "done" }],
      validations: [{ command: "bun test", state: "done", exitCode: 0 }],
    });
    expect(ledger.activity("read")).toMatchObject({ phase: "inspect", detail: "2 files · src/a.ts", durationMs: 35 });
    expect(ledger.activity("test")).toMatchObject({ phase: "verify", durationMs: 125 });
  });

  test("retains edit replacements for an inline diff and nothing else", () => {
    const ledger = new TurnActivityLedger();
    ledger.apply(event(1, "tool.call_requested", {
      toolCallId: "edit",
      name: "edit_file",
      arguments: JSON.stringify({ path: "src/a.ts", oldText: "old", newText: "new" }),
    }));
    ledger.apply(event(2, "tool.call_requested", {
      toolCallId: "read",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/a.ts" }),
    }));
    ledger.apply(event(3, "tool.call_requested", {
      toolCallId: "edit-batch",
      name: "edit_file",
      arguments: JSON.stringify({ path: "src/b.ts", hunks: [{ oldText: "a", newText: "b" }] }),
    }));

    expect(ledger.activity("edit")?.diff).toEqual({ oldText: "old", newText: "new" });
    expect(ledger.activity("read")?.diff).toBeUndefined();
    expect(ledger.activity("edit-batch")?.diff).toBeUndefined();
  });

  test("uses failed command outcomes and ignores replayed events", () => {
    const ledger = new TurnActivityLedger();
    const requested = event(1, "tool.call_requested", {
      toolCallId: "test",
      name: "run_command",
      arguments: { argv: ["bun", "run", "typecheck"] },
    });
    ledger.apply(requested);
    ledger.apply(requested);
    ledger.apply(event(2, "tool.call_completed", { toolCallId: "test", name: "run_command", exitCode: 1 }));

    expect(ledger.snapshot().tools).toBe(1);
    expect(ledger.snapshot().validations[0]).toMatchObject({ state: "failed", exitCode: 1 });
  });

  test("classifies repository checks after a change as verification", () => {
    expect(classifyTurnPhase("git_diff", {}, true)).toBe("verify");
    expect(classifyTurnPhase("git_diff", {}, false)).toBe("inspect");
    expect(classifyTurnPhase("write_file")).toBe("change");
    expect(classifyTurnPhase("search_files")).toBe("inspect");
    expect(classifyTurnPhase("run_command", { argv: ["bun", "run", "test:unit"] })).toBe("verify");
    expect(classifyTurnPhase("run_command", { argv: ["bun", "run", "lint_fix"] })).toBe("verify");
    expect(classifyTurnPhase("run_command", { argv: ["bun", "run", "build-cli"] })).toBe("verify");
  });

  test("marks provider-reported file creation as added", () => {
    const ledger = new TurnActivityLedger();
    ledger.apply(event(1, "tool.call_requested", {
      toolCallId: "write",
      name: "write_file",
      arguments: { path: "src/new.ts", content: "export {};" },
    }));
    ledger.apply(event(2, "tool.call_completed", {
      toolCallId: "write",
      name: "write_file",
      path: "src/new.ts",
      created: true,
    }));
    expect(ledger.snapshot().changes).toEqual([{
      id: "write",
      operation: "A",
      path: "src/new.ts",
      state: "done",
    }]);
  });
});

function event(
  eventId: number,
  type: EventType,
  payload: Record<string, unknown>,
  offsetMs = eventId,
): EventEnvelope {
  return {
    schemaVersion: PROTOCOL_VERSION,
    eventId,
    type,
    occurredAt: new Date(Date.UTC(2026, 7, 30, 0, 0, 0, offsetMs)).toISOString(),
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    agentRunId: "run",
    payload,
  };
}
