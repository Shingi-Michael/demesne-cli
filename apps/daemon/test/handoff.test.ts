import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { Handoffs, handoffBrief, handoffDefinition, handoffResult, parseHandoffInput, type HandoffRunner } from "../src/handoff.ts";
import { agentArgs } from "../src/agent-cli.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { pickAgent } from "../src/subagent-route.ts";
import { claudeRun, fakeProcess } from "./agent-cli-fakes.ts";

const sh = (argv: string[], cwd: string) => {
  const done = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (done.exitCode !== 0) throw new Error(new TextDecoder().decode(done.stderr));
  return new TextDecoder().decode(done.stdout);
};

function project() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "demesne-handoff-")));
  const root = join(base, "app");
  mkdirSync(root);
  sh(["git", "init", "-q", "-b", "main"], root);
  writeFileSync(join(root, "retry.ts"), "export const backoff = 100;\n");
  writeFileSync(join(root, "README.md"), "# app\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "dep.js"), "1\n");
  sh(["git", "add", "-A"], root);
  sh(["git", "commit", "-qm", "start"], root);
  return { base, root, data: join(base, "data"), worktrees: join(base, ".demesne-worktrees") };
}

/// A stand-in agent: edits retry.ts in its own folder and says what it did.
const editing = (calls: { cwd: string; resume: string | null; prompt: string }[]): HandoffRunner => async (_agent, prompt, cwd, resume, _signal, step) => {
  calls.push({ cwd, resume, prompt });
  const now = readFileSync(join(cwd, "retry.ts"), "utf8");
  writeFileSync(join(cwd, "retry.ts"), calls.length === 1 ? now.replace("100", "250") : `${now}export const cap = 5000;\n`);
  writeFileSync(join(cwd, calls.length === 1 ? "retry.test.ts" : "cap.ts"), "// test\n");
  step("Edited retry.ts");
  step("Ran bun test retry.test.ts");
  return { report: `Changed the backoff (round ${calls.length}).`, session: "sess-1" };
};

test("a hand-off works in its own copy; Bring it in, Undo and Discard act on your files only when asked", async () => {
  const { base, root, data, worktrees } = project();
  try {
    // Your uncommitted change comes along into the agent's copy.
    writeFileSync(join(root, "README.md"), "# app\n\nwork in progress\n");
    const calls: { cwd: string; resume: string | null; prompt: string }[] = [];
    const handoffs = new Handoffs(join(data, "handoffs.json"), worktrees, editing(calls));
    const steps: string[] = [];
    const item = await handoffs.start({ sessionId: "s1", root, agent: "codex", description: "Slow the retry", prompt: "Make the backoff 250ms", signal: new AbortController().signal, step: (line) => steps.push(line) });
    expect(item.status).toBe("ready");
    expect(item.worktree.startsWith(worktrees)).toBe(true);
    expect(readFileSync(join(item.worktree, "README.md"), "utf8")).toContain("work in progress");
    expect(calls[0]!.prompt).toContain("Make the backoff 250ms");
    expect(calls[0]!.prompt).toContain("Do not commit, push");
    expect(item.files.map((file) => file.path).sort()).toEqual(["retry.test.ts", "retry.ts"]);
    expect(item.files.find((file) => file.path === "retry.ts")).toMatchObject({ added: 1, removed: 1 });
    expect(item.checks).toEqual(["bun test retry.test.ts"]);
    expect(item.agentSession).toBe("sess-1");
    // node_modules is linked in for checks, and never part of the change.
    expect(existsSync(join(item.worktree, "node_modules", "dep.js"))).toBe(true);
    expect(handoffs.patch(item.id)).not.toContain("node_modules");
    // Nothing in your files yet.
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toContain("100");
    expect(handoffResult(item, handoffs.patch(item.id))).toContain(`continue "${item.id}"`);

    // Ask for changes: the same agent, its session, the same copy.
    const again = await handoffs.start({ sessionId: "s1", root, agent: "claude", description: "x", prompt: "Also cap it at 5s", signal: new AbortController().signal, step: () => {}, again: item.id });
    expect(calls[1]).toMatchObject({ cwd: item.worktree, resume: "sess-1" });
    expect(calls[1]!.prompt).toContain("Also cap it at 5s");
    expect(again.agent).toBe("codex");
    expect(again.rounds).toBe(1);
    expect(again.files.map((file) => file.path).sort()).toEqual(["cap.ts", "retry.test.ts", "retry.ts"]);
    await expect(handoffs.start({ sessionId: "other", root, agent: "codex", description: "x", prompt: "y", signal: new AbortController().signal, step: () => {}, again: item.id })).rejects.toThrow("another chat");

    // Bring it in: your working tree gets it (uncommitted), your own edit stays.
    await handoffs.apply(item.id);
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toBe("export const backoff = 250;\nexport const cap = 5000;\n");
    expect(readFileSync(join(root, "cap.ts"), "utf8")).toBe("// test\n");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("work in progress");
    expect(sh(["git", "log", "--oneline"], root).trim().split("\n")).toHaveLength(1);
    expect(existsSync(item.worktree)).toBe(false);
    await expect(handoffs.apply(item.id)).rejects.toThrow("already brought in");

    // Undo takes it back out.
    await handoffs.undo(item.id);
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toBe("export const backoff = 100;\n");
    expect(existsSync(join(root, "cap.ts"))).toBe(false);
    expect(handoffs.get(item.id)?.status).toBe("ready");

    // A sent-back one whose copy is gone gets it back, change and all.
    await handoffs.start({ sessionId: "s1", root, agent: "codex", description: "x", prompt: "Tidy up", signal: new AbortController().signal, step: () => {}, again: item.id });
    expect(calls[2]!.cwd).toBe(item.worktree);
    expect(readFileSync(join(item.worktree, "retry.ts"), "utf8")).toContain("cap = 5000");

    // Your files changed where the change goes: refused, nothing touched.
    writeFileSync(join(root, "retry.ts"), "export const backoff = 999;\n");
    await expect(handoffs.apply(item.id)).rejects.toThrow("Your files changed where this change goes");
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toBe("export const backoff = 999;\n");

    await handoffs.discard(item.id);
    expect(existsSync(item.worktree)).toBe(false);
    expect(new Handoffs(join(data, "handoffs.json"), worktrees, editing([])).get(item.id)?.status).toBe("discarded");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a hand-off that changed nothing, or ran in a worktree or outside git, fails plainly", async () => {
  const { base, root, data, worktrees } = project();
  try {
    const handoffs = new Handoffs(join(data, "handoffs.json"), worktrees, async () => ({ report: "Nothing needed.", session: null }));
    const item = await handoffs.start({ sessionId: "s1", root, agent: "claude", description: "x", prompt: "y", signal: new AbortController().signal, step: () => {} });
    expect(item.status).toBe("failed");
    expect(handoffResult(item, "")).toContain("Error:");
    expect(await handoffs.refuse(join(worktrees, "app-1"))).toContain("already works in a copy");
    const plain = join(base, "plain"); mkdirSync(plain);
    expect(await handoffs.refuse(plain)).toContain("git project");
    // A failed run that did change files still comes back for review.
    const broken = new Handoffs(join(data, "h2.json"), worktrees, async (_a, _p, cwd) => { writeFileSync(join(cwd, "half.ts"), "x\n"); throw new Error("Codex stopped (exit 1): rate limit"); });
    const half = await broken.start({ sessionId: "s1", root, agent: "codex", description: "x", prompt: "y", signal: new AbortController().signal, step: () => {} });
    expect(half.status).toBe("ready");
    expect(half.error).toContain("rate limit");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the tool, its input, the agents' edit modes and Auto's pick for a fix", () => {
  expect(handoffDefinition(["claude", "codex"]).description).toContain("Claude Code, Codex");
  expect(parseHandoffInput({ description: "Fix it", prompt: "Do it", continue: "ab12" })).toEqual({ description: "Fix it", prompt: "Do it", again: "ab12" });
  expect(() => parseHandoffInput({ description: "Fix it", prompt: "Do it", agent: "vim" })).toThrow();
  expect(() => parseHandoffInput({ prompt: "Do it" })).toThrow();
  expect(handoffBrief("Do it", "/w", true)).toContain("asks for this");
  expect(agentArgs("claude", "p", { id: "u", fresh: true })).toContain("acceptEdits");
  expect(agentArgs("codex", "p", { id: "t", fresh: false })).toEqual(expect.arrayContaining(["workspace-write", "resume", "t"]));
  expect(pickAgent("fix", ["codex", "gemini"], { jobs: {}, restUntil: {} })?.why).toContain("making a change");
});

test("in a chat, hand_off runs Claude Code in its own copy, the card comes back, and Bring it in applies it", async () => {
  const { base, root } = project();
  const spawned: { argv: string[]; cwd: string }[] = [];
  const results = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  let toolResult = "";
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(messages, tools): AsyncGenerator<ProviderStreamEvent> {
      if (!results(messages).length) {
        expect((tools ?? []).some((tool) => tool.name === "hand_off")).toBe(true);
        yield { type: "tool_call_delta", index: 0, idDelta: "h1", nameDelta: "hand_off", argumentsDelta: JSON.stringify({ description: "Slow the retry", prompt: "Make the backoff 250ms in retry.ts" }) };
        yield { type: "finish", reason: "tool_calls" }; return;
      }
      toolResult = results(messages)[0]!;
      yield { type: "text_delta", delta: "Looks right." }; yield { type: "finish", reason: "stop" };
    } };
  const app = createDaemonApp({ databasePath: join(base, "data/state.sqlite"), processor, worktreeRoot: join(base, ".demesne-worktrees"),
    agentCli: { which: (command) => command === "claude" ? "/fake/claude" : null, home: base, spawn: (argv, cwd) => {
      spawned.push({ argv, cwd });
      writeFileSync(join(cwd, "retry.ts"), "export const backoff = 250;\n");
      return fakeProcess(claudeRun("c-1", "Set the backoff to 250ms; bun test passes."));
    } } });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Hand-off", workspacePath: root, trustWorkspace: true });
    const submitted = await client.submitTurn(session.id, { content: "Have Claude Code slow the retry" });
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(8000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(spawned[0]!.argv).toContain("acceptEdits");
    expect(spawned[0]!.cwd).toContain(".demesne-worktrees");
    const progress = events.filter((event) => event.type === "tool.call_progress").map((event) => event.payload);
    expect(progress[0]).toMatchObject({ text: "agent:claude · starting" });
    const card = progress.find((payload) => payload.handoff)?.handoff as { id: string; files: { path: string }[]; checks: string[]; status: string };
    expect(card).toMatchObject({ agent: "claude", status: "ready", files: [{ path: "retry.ts", added: 1, removed: 1 }], checks: ["bun test"] });
    expect(toolResult).toContain(`Hand-off ${card.id}`);
    expect(toolResult).toContain("+export const backoff = 250;");
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toContain("100");

    const found = await client.handoff(card.id);
    expect(found.patch).toContain("backoff = 250");
    expect((await client.handoffAct(card.id, "apply")).handoff.status).toBe("applied");
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toContain("250");
    await expect(client.handoffAct(card.id, "apply")).rejects.toThrow("already brought in");
    expect((await client.handoffAct(card.id, "undo")).handoff.status).toBe("ready");
    expect(readFileSync(join(root, "retry.ts"), "utf8")).toContain("100");
  } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
});

test("a Claude Code call it wasn't allowed says so, and Claude Code may run checks in its copy", async () => {
  const { parseAgentLine, HANDOFF_CHECKS } = await import("../src/agent-cli.ts");
  const state = { words: {} };
  expect(parseAgentLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf x" } }] } }), "/w", state)).toEqual([{ step: "Ran rm -rf x" }]);
  expect(parseAgentLine("claude", JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "This command requires approval" }] } }), "/w", state)).toEqual([{ step: "Ran rm -rf x (not allowed)" }]);
  const args = agentArgs("claude", "p", { id: "u", fresh: true }, {}, [...HANDOFF_CHECKS]);
  expect(args[1]).toBe("--allowedTools");
  expect(args[2]).toContain("Bash(bun test:*)");
  expect(args.at(-1)).toBe("p");
  expect(HANDOFF_CHECKS.some((rule) => /push|install|rm /.test(rule))).toBe(false);
});
