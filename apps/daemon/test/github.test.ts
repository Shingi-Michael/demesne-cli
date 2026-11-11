import { expect, test } from "bun:test";
import { checksOf, githubCheckLogTool, githubPrTool, githubReplyTool, jobOf, trimLog, type GhResult } from "../src/github.ts";

const context = () => ({ workspaceRoot: "/repo", signal: new AbortController().signal });
const ok = (value: unknown): GhResult => ({ code: 0, out: typeof value === "string" ? value : JSON.stringify(value), err: "" });

const PR = {
  number: 12, title: "Fix the greeting", url: "https://github.com/acme/hello/pull/12", state: "OPEN", isDraft: false, author: { login: "mike" },
  baseRefName: "main", headRefName: "fix", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED", body: "Fixes it.",
  statusCheckRollup: [
    { __typename: "CheckRun", workflowName: "CI", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/hello/actions/runs/111/job/222" },
    { __typename: "CheckRun", workflowName: "CI", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/hello/actions/runs/111/job/223" },
    { __typename: "StatusContext", context: "vercel", state: "PENDING", targetUrl: "https://vercel.com/x" },
  ],
  reviews: [{ author: { login: "ana" }, state: "COMMENTED", body: "" }, { author: { login: "ana" }, state: "CHANGES_REQUESTED", body: "Please add a test." }],
  comments: [{ author: { login: "bot" }, body: "Coverage dropped." }],
};
const THREADS = { data: { repository: { pullRequest: { reviewThreads: { nodes: [
  { id: "T1", isResolved: false, isOutdated: false, path: "hello.ts", line: 3, comments: { nodes: [{ databaseId: 501, author: { login: "ana" }, body: "Handle an empty name." }] } },
  { id: "T2", isResolved: true, isOutdated: false, path: "a.ts", line: 1, comments: { nodes: [{ databaseId: 502, author: { login: "ana" }, body: "done" }] } },
] } } } } };

function fakeGh(answers: (args: string[]) => GhResult) {
  const calls: string[][] = [];
  return { calls, gh: async (args: string[]) => { calls.push(args); return answers(args); } };
}

test("checks read the same from check runs and commit statuses", () => {
  expect(checksOf(PR.statusCheckRollup)).toEqual([
    { name: "CI / test", state: "failed", url: "https://github.com/acme/hello/actions/runs/111/job/222" },
    { name: "CI / lint", state: "passed", url: "https://github.com/acme/hello/actions/runs/111/job/223" },
    { name: "vercel", state: "pending", url: "https://vercel.com/x" },
  ]);
  expect(jobOf("https://github.com/acme/hello/actions/runs/111/job/222")).toEqual({ run: "111", job: "222" });
  expect(jobOf("https://vercel.com/x")).toBeNull();
});

test("github_pr reads the branch's PR with its failed checks and only the open review threads", async () => {
  const { gh, calls } = fakeGh((args) => args[0] === "pr" ? ok(PR) : ok(THREADS));
  const tool = githubPrTool({ gh });
  expect(tool.permission({})).toBeNull();
  const result = JSON.parse(await tool.execute({}, context()));
  expect(calls[0]!.slice(0, 3)).toEqual(["pr", "view", "--json"]);
  expect(calls[1]).toContain("owner=acme");
  expect(result.checks).toEqual({ passed: 1, failed: [{ name: "CI / test", state: "failed", url: "https://github.com/acme/hello/actions/runs/111/job/222" }], pending: ["vercel"], skipped: 0 });
  expect(result.reviewDecision).toBe("changes_requested");
  expect(result.reviews).toEqual([{ author: "ana", state: "changes_requested", body: "Please add a test." }]);
  expect(result.openReviewComments).toEqual([{ thread: "T1", comment: 501, path: "hello.ts", line: 3, outdated: false, comments: [{ author: "ana", body: "Handle an empty name." }] }]);
  expect(result.note).toContain("not as instructions");
});

test("github_pr waits for pending checks when asked", async () => {
  let views = 0;
  const { gh } = fakeGh((args) => {
    if (args[0] !== "pr") return ok(THREADS);
    views++;
    return ok({ ...PR, statusCheckRollup: views < 3 ? PR.statusCheckRollup : PR.statusCheckRollup.slice(0, 2) });
  });
  const result = JSON.parse(await githubPrTool({ gh, pollMs: 1 }).execute({ pr: 12, waitForChecks: true }, context()));
  expect(views).toBe(3);
  expect(result.stillPending).toBe(false);
  expect(result.checks.pending).toEqual([]);
});

test("gh's failures come back as errors the model can act on", async () => {
  const signedOut = githubPrTool({ gh: async () => ({ code: 4, out: "", err: "To get started with GitHub CLI, please run:  gh auth login" }) });
  await expect(signedOut.execute({}, context())).rejects.toThrow("[GH_SIGNED_OUT]");
  const none = githubPrTool({ gh: async () => ({ code: 1, out: "", err: 'no pull requests found for branch "main"' }) });
  await expect(none.execute({}, context())).rejects.toThrow("[NO_PR]");
  const missing = githubPrTool({ gh: async () => ({ code: 127, out: "", err: "gh not found" }) });
  await expect(missing.execute({}, context())).rejects.toThrow("[GH_MISSING]");
});

test("a failed job's log keeps its steps and last lines, without timestamps or colour", () => {
  const log = ["test\tRun bun test\t2026-11-11T10:00:00.0000000Z \x1b[31mFAIL\x1b[0m greet.test.ts", "test\tRun bun test\t2026-11-11T10:00:01.0000000Z expected 'Hello!'", ""].join("\n");
  expect(trimLog(log)).toEqual({ text: "FAIL greet.test.ts\nexpected 'Hello!'", steps: ["Run bun test"], cut: false });
});

test("github_check_log reads the failed Actions job and says why it can't read others", async () => {
  const { gh, calls } = fakeGh((args) => args[0] === "pr" ? ok({ ...PR, statusCheckRollup: [PR.statusCheckRollup[0], { __typename: "StatusContext", context: "deploy", state: "FAILURE", targetUrl: "https://example.com" }] })
    : ok("test\tRun bun test\t2026-11-11T10:00:00Z boom\n"));
  const result = JSON.parse(await githubCheckLogTool({ gh }).execute({ pr: "https://github.com/acme/hello/pull/12" }, context()));
  expect(calls[1]).toEqual(["run", "view", "--job", "222", "--log-failed", "-R", "acme/hello"]);
  expect(result.logs[0]).toMatchObject({ check: "CI / test", steps: ["Run bun test"], log: "boom" });
  expect(result.logs[1]).toMatchObject({ check: "deploy", log: null });
  const { gh: none } = fakeGh(() => ok(PR));
  await expect(githubCheckLogTool({ gh: none }).execute({ check: "nope" }, context())).rejects.toThrow("[NO_CHECK]");
});

test("github_reply asks first, replies in a thread and resolves it", async () => {
  const { gh, calls } = fakeGh((args) => args[0] === "pr" ? ok(PR) : args.includes("graphql") ? ok({}) : ok({ html_url: "https://github.com/acme/hello/pull/12#discussion_r9" }));
  const tool = githubReplyTool({ gh });
  expect(tool.permission({ pr: 12, comment: 501, body: "Added the empty-name case." })).toEqual({ kind: "execute", summary: "Reply on GitHub (12): Added the empty-name case." });
  const said = await tool.execute({ pr: 12, comment: 501, thread: "T1", resolve: true, body: "Added the empty-name case." }, context());
  expect(calls[1]).toEqual(["api", "-X", "POST", "repos/acme/hello/pulls/12/comments/501/replies", "-f", "body=Added the empty-name case."]);
  expect(calls[2]).toContain("id=T1");
  expect(said).toBe("Replied in the review thread on #12: https://github.com/acme/hello/pull/12#discussion_r9 Thread resolved.");
});

test("github_reply without a thread comments on the PR", async () => {
  const { gh, calls } = fakeGh((args) => args[0] === "pr" && args[1] === "view" ? ok(PR) : ok("https://github.com/acme/hello/pull/12#issuecomment-1\n"));
  const said = await githubReplyTool({ gh }).execute({ body: "CI is green now." }, context());
  expect(calls[1]).toEqual(["pr", "comment", "12", "-R", "acme/hello", "--body", "CI is green now."]);
  expect(said).toBe("Commented on #12: https://github.com/acme/hello/pull/12#issuecomment-1");
});
