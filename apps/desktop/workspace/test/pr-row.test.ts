import { expect, test } from "bun:test";
import type { SessionPullRequest } from "@demesne/protocol";
import { agoWords, prHandable, prHandText, prStanding } from "../pr-row.ts";

const pr: SessionPullRequest = {
  url: "https://github.com/a/b/pull/287", number: 287, title: "Peek", state: "open", draft: false,
  createdAt: "2026-10-25T10:00:00Z", mergedAt: null, closedAt: null,
  notes: [
    { author: "ana", state: "approved", body: "", at: "2026-10-25T11:00:00Z" },
    { author: "mike", state: "commented", body: "The peek opens too soon.", at: "2026-10-25T12:00:00Z" },
  ],
  checks: [{ name: "build", state: "passed", at: "2026-10-25T10:30:00Z" }],
  activityAt: "2026-10-25T12:00:00Z",
};

test("with nothing new, the row says where it stands", () => {
  expect(prStanding(pr)).toEqual(["ana approved", "checks passed"]);
  expect(prStanding({ ...pr, notes: [], checks: [] })).toEqual(["No reviews yet"]);
});

test("new comments are handed to the chat with the ask", () => {
  expect(prHandable(pr, "2026-10-25T11:30:00Z")).toBe(true);
  expect(prHandable(pr, pr.activityAt)).toBe(false);
  expect(prHandable({ ...pr, checks: [{ name: "build", state: "failed", at: "2026-10-25T10:30:00Z" }] }, pr.activityAt)).toBe(true);
  expect(prHandText(pr, "2026-10-25T11:30:00Z")).toBe("Pull request #287 (https://github.com/a/b/pull/287) has news:\n- mike: The peek opens too soon.\n\nAddress it on the same branch and push.");
});

test("merged times in words", () => {
  const now = Date.parse("2026-10-25T14:00:00Z");
  expect(agoWords("2026-10-25T12:00:00Z", now)).toBe("2 h ago");
  expect(agoWords("2026-10-25T13:59:30Z", now)).toBe("just now");
  expect(agoWords("2026-10-24T10:00:00Z", now)).toBe("yesterday");
});
