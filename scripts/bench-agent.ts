/// Agent benchmark: runs read-only questions about this repository through
/// the daemon code in *this* checkout and measures how much work the model
/// needs, to compare agent changes before merging them. Meant for a local
/// model: on a hosted one each run costs real tokens (~650k per --repeat 2).
///
///   bun scripts/bench-agent.ts [--tasks bench/agent-tasks.json] [--model id]
///     [--repeat 1] [--concurrency N] [--only id,id] [--json out.json]
///
/// It starts a private daemon (temporary data directory, port and token) with
/// only the `[provider]` table of your user config, so nothing else from that
/// file, and none of your sessions, are used. Questions run against a detached
/// worktree of the pinned commit. The last stdout line is a JSON summary whose
/// `value` is model rounds per task (lower is better): a 10%-trimmed mean, so
/// one runaway turn can't decide an experiment, with each wrong or unfinished
/// answer scored as WRONG_ROUNDS, so fewer rounds never wins by answering badly.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { parseConfigFile, renderConfigDocument, userConfigPath } from "../packages/config/src/index.ts";
import { DemesneClient } from "../packages/client/src/index.ts";

const root = resolve(import.meta.dir, "..");
const WRONG_ROUNDS = 20;
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const suite = JSON.parse(readFileSync(resolve(option("tasks") ?? join(root, "bench/agent-tasks.json")), "utf8")) as {
  pin: string; tasks: Array<{ id: string; prompt: string; expect: string[] }>;
};
const only = option("only")?.split(",");
const tasks = suite.tasks.filter((task) => !only || only.includes(task.id));
const repeat = Math.max(1, Number(option("repeat") ?? 1));

const provider = (parseConfigFile(process.env.DEMESNE_BENCH_CONFIG ?? userConfigPath()).provider ?? {}) as Record<string, unknown>;
if (!provider.url || !provider.model) throw new Error("The benchmark needs a [provider] with url and model in your user config");
const model = option("model");
if (model) { provider.model = model; provider.allowed_models = [model]; }
const concurrency = Math.max(1, Number(option("concurrency") ?? provider.inference_slots ?? 1));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "demesne-bench-")));
const target = join(scratch, "target"), data = join(scratch, "data"), config = join(scratch, "config.toml");
const git = (...argv: string[]) => {
  const result = Bun.spawnSync(["git", ...argv], { cwd: root, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${argv[0]} failed: ${result.stderr.toString().trim()}`);
};
let daemon: ReturnType<typeof Bun.spawn> | undefined;
const cleanup = () => {
  daemon?.kill();
  Bun.spawnSync(["git", "worktree", "remove", "--force", target], { cwd: root, stderr: "ignore" });
  rmSync(scratch, { recursive: true, force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

try {
  git("worktree", "add", "--detach", "--quiet", target, suite.pin);
  writeFileSync(config, renderConfigDocument({ provider }), { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 20000), token = randomBytes(24).toString("hex");
  daemon = Bun.spawn([process.execPath, join(root, "apps/daemon/src/main.ts")], {
    cwd: scratch, stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMESNE_CONFIG_FILE: config, DEMESNE_DATA_DIR: data, DEMESNE_PORT: String(port), DEMESNE_HOST: "127.0.0.1", DEMESNE_DAEMON_TOKEN: token, DEMESNE_INFERENCE_SLOTS: String(concurrency) },
  });
  const client = new DemesneClient({ server: `http://127.0.0.1:${port}/`, token });
  for (let i = 0; ; i++) {
    try { await client.health(); break; } catch { if (i > 150 || daemon.exitCode !== null) throw new Error(`Benchmark daemon did not start: ${await new Response(daemon.stderr as ReadableStream).text()}`); await Bun.sleep(100); }
  }

  const jobs = tasks.flatMap((task) => Array.from({ length: repeat }, (_, attempt) => ({ task, attempt })));
  const finished: Array<{ id: string; attempt: number; turnId: string; status: string; answer: string; seconds: number }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { task, attempt } = jobs[next++]!;
      const started = performance.now();
      const { session } = await client.createSession({ title: `bench ${task.id}`, workspacePath: target, trustWorkspace: true });
      const { turn } = await client.submitTurn(session.id, { content: task.prompt, permissionMode: "deny" });
      let state = await client.getSessionState(session.id);
      const deadline = Date.now() + 15 * 60_000;
      while (["queued", "running"].includes(state.session.turns.find((t) => t.id === turn.id)!.status)) {
        if (Date.now() > deadline) { await client.cancelTurn(turn.id).catch(() => {}); break; }
        await Bun.sleep(500);
        state = await client.getSessionState(session.id);
      }
      const settled = state.session.turns.find((t) => t.id === turn.id)!;
      finished.push({ id: task.id, attempt, turnId: turn.id, status: settled.status, answer: settled.responseText, seconds: (performance.now() - started) / 1000 });
      console.error(`  ${task.id}#${attempt + 1} ${settled.status} in ${Math.round((performance.now() - started) / 1000)}s`);
    }
  }));

  const db = new Database(join(data, "demesne.sqlite"), { readonly: true });
  const rows = finished.map((run) => {
    const task = tasks.find((t) => t.id === run.id)!;
    const calls = db.query("select input_tokens, output_tokens, cached_input_tokens from provider_calls where turn_id = ?").all(run.turnId) as Array<Record<string, number | null>>;
    const tools = db.query("select name, arguments_json from tool_calls where turn_id = ? order by created_at").all(run.turnId) as Array<{ name: string; arguments_json: string }>;
    const seen = new Set<string>();
    let rereads = 0;
    for (const tool of tools) {
      if (tool.name !== "read_file" && tool.name !== "read_files") continue;
      const input = JSON.parse(tool.arguments_json) as { path?: string; paths?: unknown[] };
      const paths = tool.name === "read_file" ? [input.path] : (input.paths ?? []).map((p) => typeof p === "string" ? p : (p as { path?: string }).path);
      for (const path of paths) { if (!path) continue; if (seen.has(path)) rereads++; seen.add(path); }
    }
    const correct = run.status === "completed" && task.expect.every((pattern) => new RegExp(pattern, "i").test(run.answer));
    return {
      id: run.id, attempt: run.attempt, status: run.status, correct, rounds: calls.length, toolCalls: tools.length,
      searches: tools.filter((t) => t.name === "search_files").length, reads: tools.filter((t) => t.name.startsWith("read_file")).length, rereads,
      // Which tools the model chose, so a run shows whether new tools get used.
      toolsUsed: Object.fromEntries([...tools.reduce((counts, t) => counts.set(t.name, (counts.get(t.name) ?? 0) + 1), new Map<string, number>())]),
      inputTokens: calls.reduce((sum, c) => sum + (c.input_tokens ?? 0), 0), outputTokens: calls.reduce((sum, c) => sum + (c.output_tokens ?? 0), 0),
      seconds: Math.round(run.seconds * 10) / 10,
    };
  });
  db.close();

  const mean = (values: number[]) => values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0;
  const scored = rows.map((r) => (r.correct ? r.rounds : WRONG_ROUNDS)).sort((a, b) => a - b);
  const trim = Math.floor(scored.length / 10);
  const summary = {
    metric: "rounds per task", direction: "lower", value: mean(scored.slice(trim, scored.length - trim)), meanRounds: mean(rows.map((r) => r.rounds)),
    correct: rows.filter((r) => r.correct).length, total: rows.length,
    toolCalls: mean(rows.map((r) => r.toolCalls)), rereads: mean(rows.map((r) => r.rereads)),
    toolsUsed: rows.reduce((totals, r) => { for (const [name, count] of Object.entries(r.toolsUsed)) totals[name] = (totals[name] ?? 0) + count; return totals; }, {} as Record<string, number>),
    inputTokens: mean(rows.map((r) => r.inputTokens)), seconds: mean(rows.map((r) => r.seconds)),
    model: String(provider.model), pin: suite.pin, tasks: rows,
  };
  console.error("\n  task               rounds  tools  rereads  input tok  correct");
  for (const r of rows) console.error(`  ${`${r.id}#${r.attempt + 1}`.padEnd(18)} ${String(r.rounds).padStart(6)} ${String(r.toolCalls).padStart(6)} ${String(r.rereads).padStart(8)} ${String(r.inputTokens).padStart(10)}  ${r.correct ? "yes" : "no"}`);
  console.error(`\n  rounds per task ${summary.value} (trimmed; mean ${summary.meanRounds}) · correct ${summary.correct}/${summary.total} · ${summary.model}`);
  console.error(`  tools: ${Object.entries(summary.toolsUsed).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ")}`);
  const out = option("json");
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, tasks: undefined }));
} finally {
  cleanup();
}
