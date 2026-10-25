import { expect, test } from "bun:test";
import type { SessionStateResponse } from "@demesne/protocol";
import { changeCounts, firstSentence, glanceHTML, glanceOf } from "../glance.ts";

const state = (over: Partial<SessionStateResponse> = {}): SessionStateResponse => ({
  session: { id: "s", title: "Release script", createdAt: "", updatedAt: "", workspace: { id: "w", root: "/Users/mike/projects/demesne-cli", gitBranch: "release-0.2" } as never,
    turns: [{ id: "t1", sessionId: "s", content: "tag it", responseText: "Tagged **v0.2.0** and built the `tarball`. Publishing needs your yes.", status: "completed", createdAt: "", completedAt: "", permissionMode: "ask", thinkingEnabled: null },
      { id: "t2", sessionId: "s", content: "", responseText: "summary", status: "completed", createdAt: "", completedAt: "", permissionMode: "ask", thinkingEnabled: null, kind: "compaction" }] },
  lastEventId: 0, pendingPermissions: [],
  latestProviderCall: { provider: "ChatGPT", model: "gpt-6.1-sol", usage: null, metrics: null, contextPlan: { capacityTokens: 200_000, estimatedInputTokens: 82_000 } as never },
  ...over,
});

test("a chat's card: branch, folder, last turn, model, context and its last sentence", () => {
  const glance = glanceOf(state(), [{ path: "a.ts", operation: "M", reverted: false, diff: ["--- a/a.ts", "+++ b/a.ts", "@@", "-old", "+new", "+more"] }, { path: "b.ts", operation: "A", reverted: true, diff: ["+x"] }]);
  expect(glance).toEqual({ asks: null, branch: "release-0.2", folder: "/Users/mike/projects/demesne-cli", changes: { files: 1, additions: 2, deletions: 1 }, model: "gpt-6.1-sol", context: 41, last: "Tagged v0.2.0 and built the tarball." });
  const html = glanceHTML("Release script", "", "Sun 18:00", glance, () => "GPT-6.1 Sol");
  expect(html).toContain("~/projects/demesne-cli");
  expect(html).toContain("GPT-6.1 Sol · 41% context");
  expect(html).toContain("Sun 18:00");
});

test("what it waits on comes first, in words", () => {
  const glance = glanceOf(state({ pendingPermissions: [{ id: "p", summary: 'run_command: {"argv":["/usr/bin/npm","publish"]}' } as never] }), null);
  expect(glance.asks).toBe("approve run npm publish");
  expect(glance.changes).toBeNull();
  expect(glanceHTML("Release script", "needs you", "", glance)).toContain('class="gl-state warn">Waiting on you · approve run npm publish');
});

test("a sentence without its Markdown, and counts that skip reverted files", () => {
  expect(firstSentence("```ts\ncode\n```\n# Done\nIt works now! More later.")).toBe("Done It works now!");
  expect(firstSentence("   ")).toBeNull();
  expect(changeCounts([{ path: "x", operation: "D", reverted: true, diff: ["-a"] }])).toBeNull();
});
