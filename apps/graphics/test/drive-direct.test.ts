import { expect, test } from "bun:test";
import { validateDriveDecisionContext, type DriveRequest } from "@demesne/protocol";
import { DirectDriveControl, SENT } from "../drive-direct.ts";
import type { GraphicsHost } from "../host.ts";

/// A stand-in host: one completed turn that edited a file, ran a check and
/// answered. Direct control reads only recorded state, never the screen.
function host(overrides: Partial<Record<string, unknown>> = {}) {
  const submitted: { text: string; plan: boolean }[] = [];
  const runs = [{
    id: "turn-1", number: 1, content: "Fix the parser", status: "completed", createdAt: "", completedAt: "", planOnly: false,
    entries: [
      { id: 1, type: "tool", toolCallId: "t1", name: "edit_file", input: { path: "src/parser.ts" }, detail: "src/parser.ts", state: "done", startedAt: 0 },
      { id: 2, type: "tool", toolCallId: "t2", name: "run_command", input: { argv: ["bun", "test"] }, detail: "$ bun test", state: "done", exitCode: 0, message: "12 pass\n0 fail", startedAt: 0 },
      { id: 3, type: "assistant", raw: "The parser now accepts Unicode.\n\nAll 12 tests pass.", streaming: false, revision: 1 },
    ],
  }];
  const fake = {
    current: { session: { id: "s1", title: "Parser" }, approvals: new Map(), questions: new Map(), runs: () => runs },
    setup: null, active: false, busy: false, connection: "online", workspace: "/work",
    processes: [{ id: "c1", check: true, turnId: "turn-1" }],
    async submit(text: string, plan = false) { submitted.push({ text, plan }); },
    async handle(method: string) {
      if (method !== "changes") throw new Error(method);
      return { files: [{ path: "src/parser.ts", state: "applied", added: 1, removed: 1, rows: [{ kind: "removed", text: "/[A-Za-z]/" }, { kind: "added", text: "/\\p{L}/u" }] }] };
    },
    api: { async commands() { return { commands: [{ id: "c1", argv: ["bun", "test"], status: "completed", exitCode: 0, freshness: "current", stdout: "12 pass\n0 fail", stderr: "" }] }; } },
    ...overrides,
  };
  return { control: new DirectDriveControl(fake as unknown as GraphicsHost), submitted };
}

test("direct observation is a recorded transcript: requests, tool lines, answers, files and checks", () => {
  const { control } = host();
  const observation = control.observe();
  expect(observation.surface).toBe("direct");
  expect(observation.controls).toEqual([]);
  expect(observation.rows).toEqual([
    "▶ Turn 1 (completed): Fix the parser",
    "✓ edit_file src/parser.ts",
    "✓ run_command $ bun test · exit 0",
    "The parser now accepts Unicode.",
    "All 12 tests pass.",
  ]);
  expect(observation.latestAnswerRows).toEqual(["The parser now accepts Unicode.", "All 12 tests pass."]);
  expect(observation.navigation).toMatchObject({ turn: "turn-1", answer: true, files: ["src/parser.ts"], checks: ["c1"], readingHeld: false });
  expect(observation.mode).toBe("input");
  expect(observation.ready).toBe(true);
  // The same recorded state gives the same observation id.
  expect(control.observe().id).toBe(observation.id);
});

test("compose submits through the API; screen actions are refused without effect", async () => {
  const { control, submitted } = host();
  const observation = control.observe(), signal = new AbortController().signal;
  expect(await control.perform({ kind: "compose", text: "Add a test for emoji identifiers" }, observation, signal)).toStartWith(SENT);
  expect(await control.perform({ kind: "compose", text: "/plan Review the lexer" }, observation, signal)).toStartWith(SENT);
  expect(submitted).toEqual([{ text: "Add a test for emoji identifiers", plan: false }, { text: "Review the lexer", plan: true }]);
  expect(await control.perform({ kind: "key", key: "ctrl+b" }, observation, signal)).toStartWith("UI changed");
  await expect(control.perform({ kind: "compose", text: "/new" }, observation, signal)).rejects.toThrow("requests or /plan");
  expect(submitted).toHaveLength(2);
});

test("inspections read recorded answers, diffs, checks and logs, and their quotes verify a completion", async () => {
  const { control } = host();
  const observation = control.observe(), signal = new AbortController().signal;
  const checks = await control.inspect({ kind: "inspect", target: "checks" }, observation, signal, () => {});
  expect(checks.pages[0]).toMatchObject({ surface: "review", item: "c1", rows: ["$ bun test · completed · exit 0 · current", "12 pass", "0 fail"] });
  expect(checks.actions).toBe(0);
  const diff = await control.inspect({ kind: "inspect", target: "diff" }, observation, signal, () => {});
  expect(diff.pages[0]!.rows).toEqual(["src/parser.ts · applied · +1 −1", "- /[A-Za-z]/", "+ /\\p{L}/u"]);
  const log = await control.inspect({ kind: "inspect", target: "log" }, observation, signal, () => {});
  expect(log.pages.map((page) => page.rows[0])).toEqual(["✓ edit_file src/parser.ts", "✓ run_command $ bun test · exit 0"]);
  const answer = await control.inspect({ kind: "inspect", target: "answer" }, observation, signal, () => {});
  expect(answer.pages[0]).toMatchObject({ surface: "response", answer: true, latest: true });
  // A verified-work completion quoting the recorded check passes the protocol's checks.
  const request: DriveRequest = { mission: "Fix the parser", homeSessionId: "s1", observation, inspection: checks,
    memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } };
  expect(() => validateDriveDecisionContext({ action: { kind: "complete", basis: "verified-work" }, note: "Done", notes: "", completed: [], remaining: [],
    evidence: [{ observationId: observation.id, quote: "12 pass" }] }, request)).not.toThrow();
});

test("a running coder or pending approval is observed as such, not as ready input", () => {
  expect(host({ active: true }).control.observe()).toMatchObject({ mode: "streaming", ready: false });
  const pending = host();
  (pending.control as unknown as { host: { current: { approvals: Map<string, unknown> } } }).host.current.approvals.set("a", {});
  expect(pending.control.observe().mode).toBe("approval");
});

test("a mission's worktree session is observed at its own root, which the daemon requires", () => {
  const plain = host();
  expect(plain.control.observe().workspace).toBe("/work");
  const { control } = host({ current: { session: { id: "s2", title: "Mission", workspace: { root: "/worktrees/work-1a2b" } }, approvals: new Map(), questions: new Map(), runs: () => [] } });
  expect(control.observe().workspace).toBe("/worktrees/work-1a2b");
});
