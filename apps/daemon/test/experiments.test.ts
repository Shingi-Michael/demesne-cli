import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Experiment, ExperimentSpec } from "@demesne/protocol";
import { parseExperimentSpec } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import { ExperimentRunner, parseMetric, verdict } from "../src/experiments.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { DemesneStore } from "../../../packages/storage/src/index.ts";

// The runner commits the winner with the ambient git identity.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "experiments-"))); roots.push(root); return root; };
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" } });

/// A repository whose metric is the number in value.ts and whose check fails on a negative value.
function repository(root: string) {
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  git(workspace, "init", "-q", "-b", "main");
  writeFileSync(join(workspace, "value.ts"), "export const value = 10;\n");
  writeFileSync(join(workspace, "metric.ts"), 'import { value } from "./value.ts";\nconsole.log("measuring");\nconsole.log(JSON.stringify({ value, unit: "points" }));\n');
  writeFileSync(join(workspace, "check.ts"), 'import { value } from "./value.ts";\nif (value < 0) { console.error("negative"); process.exit(1); }\n');
  git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  return workspace;
}

/// The coder sets value.ts to the number its idea names.
const coder: TurnProcessor = {
  providerId: "test", modelId: "coder", async listModels() { return []; },
  async *stream(messages) {
    if (messages.some((message) => message.role === "tool")) { yield { type: "text_delta" as const, delta: "Changed value.ts." }; yield { type: "finish" as const, reason: "stop" }; return; }
    const prompt = String(messages.findLast((message) => message.role === "user")?.content ?? "");
    const number = /Your idea: set value to (-?[\d.]+)/.exec(prompt)?.[1] ?? "10";
    yield { type: "tool_call_delta" as const, index: 0, idDelta: "w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "value.ts", content: `export const value = ${number};\n` }) };
    yield { type: "finish" as const, reason: "tool_calls" };
  },
};

const spec = (workspace: string): ExperimentSpec => ({
  workspace, question: "Does a smaller value score better?", hypothesis: "Halving the value halves the score.",
  metric: { name: "points", direction: "lower", argv: [process.execPath, "metric.ts"] },
  checks: [[process.execPath, "check.ts"]],
  variants: [
    { label: "A", idea: "unchanged" },
    { label: "B", idea: "set value to 5", instruction: "Set value to 5." },
    { label: "C", idea: "set value to 9.5", instruction: "Set value to 9.5." },
    { label: "D", idea: "set value to -1", instruction: "Set value to -1." },
  ],
  budgetMinutes: 10,
});

test("an experiment builds variants in worktrees, stops failing ones, and keeps the winner on a local branch", async () => {
  const root = scratch(), workspace = repository(root);
  // A real remote: the winner must never be pushed to it.
  git(root, "init", "-q", "--bare", "origin.git");
  git(workspace, "remote", "add", "origin", join(root, "origin.git"));
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor: coder, experimentWorktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => { const response = await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init }); return { status: response.status, body: await response.json() as any }; };
  try {
    expect((await call("/v1/experiments", { method: "POST", body: JSON.stringify(spec(workspace)) })).status).toBe(404);
    await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    const started = await call("/v1/experiments", { method: "POST", body: JSON.stringify(spec(workspace)) });
    expect(started.status).toBe(201);
    let experiment: Experiment = started.body;
    for (let i = 0; i < 300 && experiment.status === "running"; i++) { await Bun.sleep(100); experiment = (await call(`/v1/experiments/${experiment.id}`)).body; }
    expect(experiment.status).toBe("settled");
    const byLabel = Object.fromEntries(experiment.variants.map((variant) => [variant.label, variant]));
    expect(byLabel.A).toMatchObject({ status: "done", metric: { value: 10, detail: { unit: "points" } } });
    expect(byLabel.B).toMatchObject({ status: "done", metric: { value: 5 }, changedFiles: ["value.ts"] });
    expect(byLabel.C).toMatchObject({ status: "done", metric: { value: 9.5 } });
    expect(byLabel.D).toMatchObject({ status: "failed", error: `Check failed: ${process.execPath} check.ts` });
    expect(experiment.verdict).toMatchObject({ winner: "B", change: -0.5 });
    expect(experiment.verdict!.summary).toContain("C 9.5 (-5%)");
    // Worktrees are gone; the winner's commit is on its branch; the losers' branches are deleted.
    expect(existsSync(join(root, "worktrees", experiment.id))).toBe(false);
    const branches = Bun.spawnSync(["git", "branch", "--format=%(refname:short)"], { cwd: workspace }).stdout.toString().trim().split("\n");
    expect(branches.sort()).toEqual([byLabel.B!.branch, "main"].sort());
    expect(Bun.spawnSync(["git", "show", `${byLabel.B!.branch}:value.ts`], { cwd: workspace }).stdout.toString()).toBe("export const value = 5;\n");
    expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("export const value = 10;\n");
    expect(experiment.kept).toEqual({ branch: byLabel.B!.branch });
    expect(Bun.spawnSync(["git", "ls-remote", "origin"], { cwd: workspace }).stdout.toString()).toBe("");
    expect((await call(`/v1/experiments?workspace=${encodeURIComponent(workspace)}`)).body.experiments.map((item: Experiment) => item.id)).toEqual([experiment.id]);
  } finally { server.stop(true); await app.close(); }
});

test("verdict: the best variant must beat the baseline by the required margin", () => {
  const base = { spec: { metric: { name: "rounds", direction: "lower", argv: ["x"], minImprovement: 0.2 } } as ExperimentSpec };
  const variants = (b: number) => [
    { label: "A", idea: "0 lines", status: "done", branch: "a", metric: { value: 7 } },
    { label: "B", idea: "3 lines", instruction: "x", status: "done", branch: "b", metric: { value: b } },
    { label: "C", idea: "8 lines", instruction: "x", status: "failed", branch: "c", error: "Check failed" },
  ] as Experiment["variants"];
  expect(verdict({ ...base, variants: variants(4.9) })).toMatchObject({ winner: "B", change: -0.3 });
  expect(verdict({ ...base, variants: variants(6.3) })).toMatchObject({ change: -0.1 });
  expect(verdict({ ...base, variants: variants(6.3) }).winner).toBeUndefined();
  expect(verdict({ ...base, variants: variants(6.3) }).summary).toContain("20% was required");
  expect(verdict({ ...base, variants: [{ ...variants(5)[0]!, metric: undefined, status: "failed", error: "boom" }, variants(5)[1]!] }).summary).toContain("baseline could not be measured (boom)");
});

test("metrics, spec validation, and a restart stops a running experiment", () => {
  expect(parseMetric("noise\n{\"value\": 4.5, \"correct\": 8}\n")).toEqual({ value: 4.5, detail: { correct: 8 } });
  expect(parseMetric("12\n")).toEqual({ value: 12 });
  expect(parseMetric("{\"value\": \"x\"}")).toBeNull();
  const valid = spec("/w");
  expect(() => parseExperimentSpec({ ...valid, variants: valid.variants.slice(1) })).toThrow(/exactly one baseline/);
  expect(() => parseExperimentSpec({ ...valid, variants: [valid.variants[0], { ...valid.variants[1], label: "a" }] })).toThrow(/unique label/);
  expect(parseExperimentSpec(valid).variants).toHaveLength(4);
  const root = scratch(), directory = join(root, "experiments");
  mkdirSync(directory);
  writeFileSync(join(directory, "abc.json"), JSON.stringify({ id: "abc", spec: valid, status: "running", base: "x", createdAt: "2026-10-03T00:00:00.000Z", variants: [{ label: "A", idea: "u", status: "measuring", branch: "b" }] }));
  const store = new DemesneStore(join(root, "state.sqlite"));
  const runner = new ExperimentRunner({ store, directory, worktreeRoot: join(root, "w"), startTurn: () => { throw new Error("unused"); }, cancelTurn() {}, grant() {} });
  expect(runner.get("abc")).toMatchObject({ status: "stopped", error: "The daemon restarted while this experiment was running.", variants: [{ status: "stopped" }] });
  store.close();
});

test("/v1/drive/experiment designs from the workspace's kit and never authors commands", async () => {
  const root = scratch(), workspace = repository(root);
  const planner: TurnProcessor = { providerId: "test", modelId: "planner", async listModels() { return []; },
    async *stream(_messages, tools) {
      const metric = (tools[0]!.inputSchema as any).properties.metric.enum[0];
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "d", nameDelta: "design_experiment", argumentsDelta: JSON.stringify({
        question: "Does a smaller value score better?", hypothesis: "Halving it halves the score.", metric, budgetMinutes: 60,
        variants: [{ idea: "set value to 5", instruction: "Change value.ts so value is 5; keep the export name." }] }) };
      yield { type: "finish" as const, reason: "tool_calls" };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor: planner, experimentWorktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const post = async (path: string, body: unknown) => { const response = await fetch(new URL(path, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
  const request = { workspace, proposal: { title: "Try a smaller value", why: "Scores look high.", evidence: [] } };
  try {
    await post("/v1/sessions", { title: "S", workspacePath: workspace, trustWorkspace: true });
    expect((await post("/v1/drive/experiment", request)).status).toBe(409);
    mkdirSync(join(workspace, ".demesne"));
    writeFileSync(join(workspace, ".demesne/experiments.json"), JSON.stringify({ setup: [], checks: [["bun", "check.ts"]], metrics: [{ name: "points", about: "The value.", direction: "lower", argv: ["bun", "metric.ts"], minImprovement: 0.2 }] }));
    const designed = await post("/v1/drive/experiment", request);
    expect(designed.status).toBe(200);
    expect(designed.body.spec).toMatchObject({
      workspace, metric: { name: "points", argv: ["bun", "metric.ts"], minImprovement: 0.2 }, checks: [["bun", "check.ts"]], budgetMinutes: 60,
      variants: [{ label: "A", idea: "unchanged (baseline)" }, { label: "B", idea: "set value to 5" }],
    });
  } finally { server.stop(true); await app.close(); }
});

test("when the winner cannot be committed, its worktree is kept so the change survives", async () => {
  const root = scratch(), workspace = repository(root);
  writeFileSync(join(workspace, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'commits are blocked here' >&2\nexit 1\n", { mode: 0o755 });
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor: coder, experimentWorktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  try {
    await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    const two = spec(workspace); two.variants = two.variants.slice(0, 2);
    let experiment: Experiment = await call("/v1/experiments", { method: "POST", body: JSON.stringify(two) });
    for (let i = 0; i < 300 && experiment.status === "running"; i++) { await Bun.sleep(100); experiment = await call(`/v1/experiments/${experiment.id}`); }
    expect(experiment.verdict?.winner).toBe("B");
    expect(experiment.kept?.error).toContain("commits are blocked here");
    const kept = experiment.kept!.keptWorktree!;
    expect(readFileSync(join(kept, "value.ts"), "utf8")).toBe("export const value = 5;\n");
    expect(existsSync(join(root, "worktrees", experiment.id, "a"))).toBe(false);
  } finally { server.stop(true); await app.close(); }
});

test("a coder turn that fails gets one more attempt in a fresh session", async () => {
  const root = scratch(), workspace = repository(root);
  const prompts: string[] = [];
  const flaky: TurnProcessor = { ...coder, async *stream(messages, tools, signal, thinking) {
    const prompt = String(messages.findLast((message) => message.role === "user")?.content ?? "");
    if (!messages.some((message) => message.role === "tool")) prompts.push(prompt);
    if (!prompt.includes("A previous attempt")) throw new Error("request (32955 tokens) exceeds the available context size (32768 tokens)");
    yield* coder.stream(messages, tools, signal, thinking);
  } };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor: flaky, experimentWorktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  try {
    await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    const two = spec(workspace); two.variants = two.variants.slice(0, 2);
    let experiment: Experiment = await call("/v1/experiments", { method: "POST", body: JSON.stringify(two) });
    for (let i = 0; i < 300 && experiment.status === "running"; i++) { await Bun.sleep(100); experiment = await call(`/v1/experiments/${experiment.id}`); }
    const b = experiment.variants.find((variant) => variant.label === "B")!;
    expect(b).toMatchObject({ status: "done", attempts: 2, metric: { value: 5 } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("check git_status and git_diff first");
    expect(experiment.verdict?.winner).toBe("B");
  } finally { server.stop(true); await app.close(); }
});

test("stopping during measurement marks the variant stopped, not failed", async () => {
  const root = scratch(), workspace = repository(root);
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor: coder, experimentWorktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  try {
    await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    const slow = spec(workspace); slow.variants = slow.variants.slice(0, 2);
    slow.metric = { ...slow.metric, argv: [process.execPath, "-e", "await Bun.sleep(30000)"] };
    let experiment: Experiment = await call("/v1/experiments", { method: "POST", body: JSON.stringify(slow) });
    for (let i = 0; i < 300 && !experiment.variants.every((variant) => variant.status === "measuring"); i++) { await Bun.sleep(100); experiment = await call(`/v1/experiments/${experiment.id}`); }
    await Bun.sleep(300);
    await call(`/v1/experiments/${experiment.id}/stop`, { method: "POST", body: "{}" });
    for (let i = 0; i < 300 && experiment.status === "running"; i++) { await Bun.sleep(100); experiment = await call(`/v1/experiments/${experiment.id}`); }
    expect(experiment.status).toBe("stopped");
    expect(experiment.variants.map((variant) => [variant.label, variant.status, variant.error])).toEqual([["A", "stopped", undefined], ["B", "stopped", undefined]]);
  } finally { server.stop(true); await app.close(); }
});
