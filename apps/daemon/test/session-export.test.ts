import { describe, expect, test } from "bun:test";
import type { SessionExport } from "@demesne/protocol";
import { formatSessionMarkdown } from "../src/session-export.ts";

const exported: SessionExport = {
  session: {
    id: "session-1",
    title: "Parser work",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    workspace: { id: "w1", root: "/workspace" },
    turns: [],
  },
  turns: [
    {
      id: "turn-1",
      content: "Fix the tokenizer",
      status: "completed",
      createdAt: "2026-01-01T00:01:00.000Z",
      responses: ["Fixed.", "Added a test."],
    },
    {
      id: "turn-2",
      content: "Explain it",
      status: "cancelled",
      createdAt: "2026-01-01T00:02:00.000Z",
      responses: [],
    },
  ],
};

describe("formatSessionMarkdown", () => {
  test("renders the header, requests, and every response", () => {
    const markdown = formatSessionMarkdown(exported, new Date("2026-02-01T12:00:00.000Z"));
    expect(markdown).toStartWith("# Parser work\n");
    expect(markdown).toContain("- Session: `session-1`");
    expect(markdown).toContain("- Workspace: `/workspace`");
    expect(markdown).toContain("- Exported: 2026-02-01T12:00:00.000Z");
    expect(markdown).toContain("- Turns: 2");
    expect(markdown).toContain("## Turn 1 · completed · 2026-01-01T00:01:00.000Z");
    expect(markdown).toContain("**Request**\n\nFix the tokenizer");
    expect(markdown).toContain("Fixed.");
    expect(markdown).toContain("Added a test.");
    expect(markdown).toContain("_No response recorded._");
  });

  test("handles sessions without a workspace", () => {
    const markdown = formatSessionMarkdown({
      ...exported,
      session: { ...exported.session, workspace: null },
    }, new Date("2026-02-01T12:00:00.000Z"));
    expect(markdown).toContain("- Workspace: none");
  });
});
