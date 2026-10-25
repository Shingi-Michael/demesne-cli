import { expect, test } from "bun:test";
import { checksWords, openedPullRequest, parseUpdateSessionRequest, pullRequestFromGh, pullRequestNews } from "../src/index.ts";

test("a gh pr create run or a create-pull-request tool opens a pull request", () => {
  const out = "Creating pull request for claude/x into main\n\nhttps://github.com/Shingi-Michael/demesne-cli/pull/287\n";
  expect(openedPullRequest("run_command", JSON.stringify({ argv: ["gh", "pr", "create", "--fill"] }), out)).toBe("https://github.com/Shingi-Michael/demesne-cli/pull/287");
  expect(openedPullRequest("run_command", JSON.stringify({ script: "git push -u origin HEAD && gh pr create --fill" }), out)).toBe("https://github.com/Shingi-Michael/demesne-cli/pull/287");
  expect(openedPullRequest("mcp__github__create_pull_request", "{}", '{"url":"https://github.com/a/b/pull/9"}')).toBe("https://github.com/a/b/pull/9");
  // Reading about a pull request isn't opening one.
  expect(openedPullRequest("run_command", JSON.stringify({ argv: ["gh", "pr", "view", "287"] }), out)).toBeNull();
  expect(openedPullRequest("run_command", JSON.stringify({ argv: ["gh", "pr", "create"] }), "a token is needed")).toBeNull();
});

const gh = {
  number: 287, title: "Peek", url: "https://github.com/a/b/pull/287", state: "OPEN", isDraft: false,
  createdAt: "2026-10-25T10:00:00Z", mergedAt: null, closedAt: null,
  reviews: [
    { author: { login: "mike" }, state: "CHANGES_REQUESTED", body: "The peek opens too soon.", submittedAt: "2026-10-25T12:00:00Z" },
    { author: { login: "bot" }, state: "COMMENTED", body: "", submittedAt: "2026-10-25T12:01:00Z" },
  ],
  comments: [{ author: { login: "ana" }, body: "Looks good otherwise", createdAt: "2026-10-25T11:00:00Z" }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-10-25T10:30:00Z" },
    { __typename: "StatusContext", context: "lint", state: "SUCCESS", startedAt: "2026-10-25T10:20:00Z" },
  ],
};

test("gh's pull request in our words", () => {
  const pr = pullRequestFromGh(gh)!;
  expect(pr).toMatchObject({ number: 287, state: "open", activityAt: "2026-10-25T12:00:00Z" });
  // An empty COMMENTED review is the shell of line comments: left out.
  expect(pr.notes.map((note) => `${note.author} ${note.state}`)).toEqual(["ana commented", "mike changes requested"]);
  expect(pr.checks).toEqual([{ name: "build", state: "failed", at: "2026-10-25T10:30:00Z" }, { name: "lint", state: "passed", at: "2026-10-25T10:20:00Z" }]);
  expect(checksWords(pr)).toBe("1 check failed: build");
  expect(pullRequestFromGh({ ...gh, state: "MERGED", mergedAt: "2026-10-25T13:00:00Z" })).toMatchObject({ state: "merged", mergedAt: "2026-10-25T13:00:00Z" });
});

test("what's new since you looked", () => {
  const pr = pullRequestFromGh(gh)!;
  expect(pullRequestNews(pr, "2026-10-25T10:00:00Z")).toEqual(["ana: Looks good otherwise", "mike changes requested: The peek opens too soon.", "1 check failed: build"]);
  expect(pullRequestNews(pr, "2026-10-25T11:30:00Z")).toEqual(["mike changes requested: The peek opens too soon."]);
  expect(pullRequestNews(pr, pr.activityAt)).toEqual([]);
});

test("a chat's pull request link is checked, and backAt can wait for a merge", () => {
  expect(parseUpdateSessionRequest({ prUrl: "https://github.com/a/b/pull/3" })).toEqual({ prUrl: "https://github.com/a/b/pull/3" });
  expect(parseUpdateSessionRequest({ prUrl: null })).toEqual({ prUrl: null });
  expect(() => parseUpdateSessionRequest({ prUrl: "https://example.com/pull/3" })).toThrow();
  expect(parseUpdateSessionRequest({ backAt: "merge" })).toEqual({ backAt: "merge" });
});
