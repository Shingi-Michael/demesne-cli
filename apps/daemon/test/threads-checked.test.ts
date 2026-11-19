import { afterEach, expect, test } from "bun:test";
import { withoutNotes } from "../src/chat-notes.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThreadReport, type DriveFix } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import { parseChanges, threadIssues } from "../src/drive-fixes.ts";
import { overlappingClaims } from "../src/threads.ts";
import type { TurnProcessor } from "../src/processor.ts";

// Pass 211: threads are checked when they land, can wait for another, and
// fix their own merge when your branch moved on.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env });

test("a thread's check names files outside its claim and failed checks", () => {
  const fix = { thread: { brief: "", files: ["src/a.ts", "docs/"] }, checks: [{ command: "bun test", passed: false }] };
  const issues = threadIssues(fix, ["src/a.ts", "docs/x.md", "src/b.ts"]);
  expect(issues[0]).toContain("outside its claim (src/b.ts)");
  expect(issues[1]).toContain("a check failed (bun test)");
  expect(threadIssues({ thread: { brief: "", files: ["src/a.ts"] }, checks: [{ command: "bun test", passed: true }] }, ["src/a.ts"])).toEqual([]);
});

test("a thread built on another may share its files", () => {
  expect(overlappingClaims([{ title: "Endpoint", files: ["src/a.ts"] }, { title: "Wire it", files: ["src/a.ts"], after: "Endpoint" }])).toBeNull();
  expect(overlappingClaims([{ title: "Endpoint", files: ["src/a.ts"] }, { title: "Other", files: ["src/a.ts"] }])).toContain("both claim");
});

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "threads-checked-"))); roots.push(root);
  const workspace = join(root, "repo");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(workspace, "src", "b.ts"), "export const b = 1;\n");
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  return { root, workspace };
}

async function serve(root: string, stream: TurnProcessor["stream"]) {
  const processor: TurnProcessor = { providerId: "test", modelId: "coder", async listModels() { return []; }, stream };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor, worktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init });
    return { status: response.status, body: await response.json() as any };
  };
  const close = async () => { server.stop(true); await app.close(); };
  return { call, close };
}

const write = (id: string, path: string, content: string) => [
  { type: "tool_call_delta" as const, index: 0, idDelta: id, nameDelta: "write_file", argumentsDelta: JSON.stringify({ path, content }) },
  { type: "finish" as const, reason: "tool_calls" as const },
];
const say = (text: string) => [{ type: "text_delta" as const, delta: text }, { type: "finish" as const, reason: "stop" as const }];

async function until(read: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await read()) return; await Bun.sleep(25); }
  throw new Error("never got there");
}

test("a thread that strays outside its files is sent back once, then reports what's left", async () => {
  const { root, workspace } = repo();
  const reports: string[] = [], sentBack: string[] = [];
  const { call, close } = await serve(root, async function* (messages) {
    const last = messages.at(-1)!, said = withoutNotes(String(last.content));
    if (last.role === "user" && said.startsWith("Thread report: ")) { reports.push(said); yield* say("Noted."); return; }
    if (last.role === "user" && said.includes("You're one of the threads")) {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "w1", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "src/a.ts", content: "export const a = 2;\n" }) };
      yield { type: "tool_call_delta" as const, index: 1, idDelta: "w2", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "src/b.ts", content: "export const b = 9;\n" }) };
      yield { type: "finish" as const, reason: "tool_calls" }; return;
    }
    if (last.role === "user" && said.startsWith("Your work came back")) { sentBack.push(said); yield* write("w3", "src/b.ts", "export const b = 1;\n"); return; }
    if (last.role === "user" && said === "split it") {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "t", nameDelta: "start_threads", argumentsDelta: JSON.stringify({ threads: [{ title: "Bump a", brief: "Set a to 2.", files: ["src/a.ts"] }] }) };
      yield { type: "finish" as const, reason: "tool_calls" }; return;
    }
    yield* say("Done.");
  });
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    await until(async () => reports.length === 1);
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0]).toContain("outside its claim (src/b.ts)");
    const [fix] = (await call(`/v1/threads?from=${session.id}`)).body.fixes as DriveFix[];
    expect(fix!.status).toBe("ready");
    // It put b back, so nothing is off, but it ran no checks: not "checked".
    expect(fix!.review).toEqual({ sentBack: 1, note: "no checks ran" });
    expect(fix!.diff?.paths).toEqual(["src/a.ts"]);
    const report = parseThreadReport(reports[0]!)!;
    expect(report.review).toEqual({ checked: false, sentBack: 1, note: "no checks ran" });
    expect(reports[0]).toContain("send it back once with message_thread");
  } finally { await close(); }
}, 30_000);

test("a thread can wait for another: it starts on that branch, and merges after it", async () => {
  const { root, workspace } = repo();
  const reports: string[] = [];
  let release: () => void = () => {};
  const firstMayFinish = new Promise<void>((resolve) => { release = resolve; });
  const { call, close } = await serve(root, async function* (messages) {
    const last = messages.at(-1)!, said = withoutNotes(String(last.content));
    if (last.role === "user" && said.startsWith("Thread report: ")) { reports.push(said); yield* say("Noted."); return; }
    if (last.role === "user" && said.includes("Your job: Add the endpoint")) { await firstMayFinish; yield* write("w1", "src/a.ts", "export const a = 2;\n"); return; }
    if (last.role === "user" && said.includes("Your job: Wire it")) {
      // It sees the endpoint's work: it started on that branch.
      yield* write("w2", "src/a.ts", `export const a = 2;\nexport const wired = true;\n`); return;
    }
    if (last.role === "user" && said === "split it") {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "t", nameDelta: "start_threads", argumentsDelta: JSON.stringify({ threads: [
        { title: "Add the endpoint", brief: "Set a to 2.", files: ["src/a.ts"] },
        { title: "Wire it", brief: "Mark it wired.", files: ["src/a.ts"], after: "Add the endpoint" },
      ] }) };
      yield { type: "finish" as const, reason: "tool_calls" }; return;
    }
    yield* say("Done.");
  });
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    let threads: DriveFix[] = [];
    await until(async () => (threads = (await call(`/v1/threads?from=${session.id}`)).body.fixes).length === 2);
    // The second waits: no chat, no worktree yet.
    expect(threads[1]!.status).toBe("starting");
    expect(threads[1]!.sessionId).toBeNull();
    expect(threads[1]!.thread?.after).toBe(threads[0]!.id);
    release();
    await until(async () => (threads = (await call(`/v1/threads?from=${session.id}`)).body.fixes).every((fix: DriveFix) => fix.status === "ready") && reports.length === 2);
    const wired = readFileSync(join(threads[1]!.path, "src", "a.ts"), "utf8");
    expect(wired).toContain("wired");
    expect(parseThreadReport(reports[1]!)!.after).toBe("Add the endpoint");
    // It merges after the one it was built on, and carries only its own work.
    const early = await call(`/v1/drive/fixes/${threads[1]!.id}/apply`, { method: "POST" });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(early.body)).toContain("Merge \\\"Add the endpoint\\\" first");
    expect((await call(`/v1/drive/fixes/${threads[0]!.id}/apply`, { method: "POST" })).body.fix.status).toBe("applied");
    expect((await call(`/v1/drive/fixes/${threads[1]!.id}/apply`, { method: "POST" })).body.fix.status).toBe("applied");
    expect(readFileSync(join(workspace, "src", "a.ts"), "utf8")).toBe("export const a = 2;\nexport const wired = true;\n");
  } finally { await close(); }
}, 30_000);

test("a thread that no longer merges settles the conflict itself, then merges", async () => {
  const { root, workspace } = repo();
  const fixing: string[] = [];
  const { call, close } = await serve(root, async function* (messages) {
    const last = messages.at(-1)!, said = withoutNotes(String(last.content));
    if (last.role === "user" && said.startsWith("Thread report: ")) { yield* say("Noted."); return; }
    if (last.role === "user" && said.includes("You're one of the threads")) { yield* write("w1", "src/a.ts", "export const a = 2;\n"); return; }
    if (last.role === "user" && said.startsWith("Your work didn't merge")) { fixing.push(said); yield* write("w2", "src/a.ts", "export const a = 2;\nexport const yours = true;\n"); return; }
    if (last.role === "user" && said === "split it") {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "t", nameDelta: "start_threads", argumentsDelta: JSON.stringify({ threads: [{ title: "Bump a", brief: "Set a to 2.", files: ["src/a.ts"] }] }) };
      yield { type: "finish" as const, reason: "tool_calls" }; return;
    }
    yield* say("Done.");
  });
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    let fix: DriveFix | undefined;
    await until(async () => (fix = (await call(`/v1/threads?from=${session.id}`)).body.fixes[0])?.status === "ready");
    // What it changed, for the open line in the threads ribbon (pass 232).
    const changes = (await call(`/v1/drive/fixes/${fix!.id}/changes`)).body;
    expect(changes.more).toBe(0);
    expect(changes.files.map((file: { path: string; additions: number; deletions: number }) => [file.path, file.additions, file.deletions])).toEqual([["src/a.ts", 1, 1]]);
    expect(changes.files[0].patch).toContain("-export const a = 1;\n+export const a = 2;");
    expect((await call("/v1/drive/fixes/nope/changes")).status).toBe(404);
    // Meanwhile your branch changed the same line.
    writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\nexport const yours = true;\n");
    git(workspace, "commit", "-qam", "yours");
    const merging = await call(`/v1/drive/fixes/${fix!.id}/apply`, { method: "POST" });
    expect(merging.body.fix.status).toBe("running");
    await until(async () => (fix = (await call(`/v1/threads?from=${session.id}`)).body.fixes[0])?.status === "ready");
    expect(fixing[0]).toContain("conflict markers");
    expect(fixing[0]).toContain("src/a.ts");
    expect((await call(`/v1/drive/fixes/${fix!.id}/apply`, { method: "POST" })).body.fix.status).toBe("applied");
    expect(readFileSync(join(workspace, "src", "a.ts"), "utf8")).toBe("export const a = 2;\nexport const yours = true;\n");
  } finally { await close(); }
}, 30_000);

test("pass 232: what a thread changed is split into files, each with its counts and hunks", () => {
  const diff = [
    "diff --git a/src/csv.ts b/src/csv.ts", "index 1111111..2222222 100644", "--- a/src/csv.ts", "+++ b/src/csv.ts", "@@ -1,3 +1,4 @@", " export function toCsv(rows) {", "-  return \"\";", "+  const head = columns.join(\",\");", "+  return [head, ...rows].join(\"\\n\");", " }",
    "diff --git a/test/csv.test.ts b/test/csv.test.ts", "new file mode 100644", "index 0000000..3333333", "--- /dev/null", "+++ b/test/csv.test.ts", "@@ -0,0 +1,2 @@", "+import { toCsv } from \"../src/csv\";", "+test(\"quotes\", () => {});",
    "diff --git a/old.md b/old.md", "deleted file mode 100644", "index 4444444..0000000", "--- a/old.md", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone",
    "diff --git a/logo.png b/logo.png", "index 5555555..6666666 100644", "Binary files a/logo.png and b/logo.png differ", "",
  ].join("\n");
  const files = parseChanges(diff);
  expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([["src/csv.ts", 2, 1], ["test/csv.test.ts", 2, 0], ["old.md", 0, 1], ["logo.png", 0, 0]]);
  expect(files[0]!.patch.split("\n")[0]).toBe("@@ -1,3 +1,4 @@");
  expect(files[0]!.patch).not.toContain("index 1111111");
  expect(files[3]!.patch).toBe("");
  const long = parseChanges(["diff --git a/big.txt b/big.txt", "--- a/big.txt", "+++ b/big.txt", "@@ -0,0 +1,900 @@", ...Array.from({ length: 900 }, (_, at) => `+line ${at}`)].join("\n"))[0]!;
  expect(long.additions).toBe(900);
  expect(long.cut).toBe(true);
  expect(long.patch.split("\n")).toHaveLength(400);
  expect(parseChanges("")).toEqual([]);
});

test("pass 232: a thread may ask the person; it waits, and goes on with the answer", async () => {
  const { root, workspace } = repo();
  let offered = false, answer = "";
  const { call, close } = await serve(root, async function* (messages, tools) {
    const last = messages.at(-1)!, said = withoutNotes(String(last.content)), first = withoutNotes(String(messages.find((message) => message.role === "user")?.content));
    if (last.role === "user" && said.startsWith("Thread report: ")) { yield* say("Noted."); return; }
    if (first.includes("You're one of the threads")) {
      const results = messages.filter((message) => message.role === "tool");
      if (!results.length) {
        offered = tools.some((tool) => tool.name === "ask_user");
        expect(first).toContain("ask once with ask_user");
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "ask", nameDelta: "ask_user", argumentsDelta: JSON.stringify({ questions: [{ question: "Two or three?", suggestions: ["Two", "Three"] }] }) };
        yield { type: "finish" as const, reason: "tool_calls" as const }; return;
      }
      if (results.length === 1) { answer = String(results[0]!.content); yield* write("w1", "src/a.ts", "export const a = 2;\n"); return; }
      yield* say("Set a to 2."); return;
    }
    if (last.role === "user" && said === "split it") {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "t", nameDelta: "start_threads", argumentsDelta: JSON.stringify({ threads: [{ title: "Bump a", brief: "Set a to 2 or 3.", files: ["src/a.ts"] }] }) };
      yield { type: "finish" as const, reason: "tool_calls" as const }; return;
    }
    yield* say("Done.");
  });
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    let fix: DriveFix | undefined;
    // The ribbon's line turns amber: the thread waits on you.
    await until(async () => (fix = (await call(`/v1/threads?from=${session.id}`)).body.fixes[0])?.waiting === true);
    expect(offered).toBe(true);
    expect(fix!.status).toBe("running");
    const [question] = (await call(`/v1/sessions/${fix!.sessionId}`)).body.pendingQuestions;
    expect(question.questions[0].question).toBe("Two or three?");
    expect((await call(`/v1/questions/${question.id}`, { method: "POST", body: JSON.stringify({ answers: [{ answer: "Two", source: "suggestion" }] }) })).status).toBe(202);
    await until(async () => (fix = (await call(`/v1/threads?from=${session.id}`)).body.fixes[0])?.status === "ready");
    expect(answer).toContain("Two");
    expect(fix!.waiting).toBeUndefined();
  } finally { await close(); }
}, 30_000);
