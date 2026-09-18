import { describe, expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import type { DaemonStatusResponse } from "@demesne/protocol";
import { formatProcessView } from "../src/process-view.ts";

const painter = createPainter(false, "dark");
const now = Date.parse("2026-01-01T00:10:00.000Z");

const status: DaemonStatusResponse = {
  provider: "llama.cpp",
  model: "qwen3.8-q4_0-100k-b256",
  inferenceSlots: 1,
  activeInferences: 1,
  queuedInferences: 2,
  active: [
    {
      id: "abcdefgh-1234-5678",
      title: "Fix parser bug",
      workspace: "/Users/me/project",
      turnId: "turn-1",
      turnStatus: "running",
      createdAt: "2026-01-01T00:08:55.000Z",
      updatedAt: "2026-01-01T00:09:00.000Z",
    },
  ],
};

describe("formatProcessView", () => {
  test("renders daemon counts and one row per active turn", () => {
    const view = formatProcessView(status, 100, painter, now);
    expect(view).toContain("llama.cpp/qwen3.8-q4_0-100k-b256 · 1 slot · 1 active · 2 queued");
    expect(view).toContain("abcdefgh");
    expect(view).toContain("running");
    expect(view).toContain("Fix parser bug");
    expect(view).toContain("project");
    expect(view).toContain("1m 5s");
  });

  test("reports an idle daemon", () => {
    const view = formatProcessView({ ...status, active: [], activeInferences: 0, queuedInferences: 0 }, 80, painter, now);
    expect(view).toContain("No active turns.");
  });

  test("keeps every line within the width", () => {
    for (const width of [40, 80, 120]) {
      const view = formatProcessView(status, width, painter, now);
      for (const line of view.split("\n")) {
        expect(visibleLength(line)).toBeLessThanOrEqual(Math.max(40, width));
      }
    }
  });

  test("uses a placeholder for sessions without a workspace", () => {
    const view = formatProcessView({
      ...status,
      active: [{ ...status.active[0]!, workspace: null }],
    }, 80, painter, now);
    expect(view).toContain("—");
  });
});
