import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Experiment, ExperimentCommandResult, ExperimentSpec, ExperimentVariant, ExperimentVerdict, Turn } from "@demesne/protocol";
import type { DemesneStore } from "@demesne/storage";
import type { SessionRule } from "./permissions.ts";

/// Drive experiments: each variant of an idea is built by a coder in its own
/// git worktree, checked, and measured with a named metric; the best variant
/// that beats the baseline by the required margin wins and is committed on a
/// local branch for review (experiments never push). Records persist as JSON, so results outlive the window and
/// a daemon restart (which stops a running experiment rather than resuming it).

export interface CommandOutput { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface ExperimentDependencies {
  store: DemesneStore;
  /// Directory for experiment records.
  directory: string;
  /// Where variant worktrees are created; must not overlap the data directory.
  worktreeRoot: string;
  /// Creates and queues a coder turn in a session with the given model.
  startTurn(sessionId: string, content: string, model: string | undefined): Turn;
  cancelTurn(turnId: string): void;
  grant(sessionId: string, rule: SessionRule): void;
  run?(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandOutput>;
  now?(): number;
}

/// Tools a coder may use anywhere in its own worktree without asking.
const EDIT_TOOLS = ["edit_file", "write_file", "move_path", "delete_path"];
const TAIL = 2000;
const CODER_ATTEMPTS = 2;

export class ExperimentRunner {
  private readonly experiments = new Map<string, Experiment>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: ExperimentDependencies) {
    mkdirSync(deps.directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(deps.directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const experiment = JSON.parse(readFileSync(join(deps.directory, name), "utf8")) as Experiment;
        if (experiment.status === "running") {
          experiment.status = "stopped";
          experiment.error = "The daemon restarted while this experiment was running.";
          for (const variant of experiment.variants) if (!["done", "failed"].includes(variant.status)) variant.status = "stopped";
          experiment.settledAt = new Date(this.now()).toISOString();
          this.save(experiment);
        }
        this.experiments.set(experiment.id, experiment);
      } catch { /* an unreadable record is skipped */ }
    }
  }

  list(workspace?: string): Experiment[] {
    return [...this.experiments.values()].filter((item) => !workspace || item.spec.workspace === workspace)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): Experiment | undefined { return this.experiments.get(id); }

  async start(spec: ExperimentSpec): Promise<Experiment> {
    const head = await this.run(["git", "rev-parse", "HEAD"], spec.workspace, 10_000);
    if (head.exitCode !== 0) throw new Error("The workspace is not a git repository with a commit.");
    const id = randomUUID().slice(0, 8);
    const experiment: Experiment = {
      id, spec, status: "running", base: head.stdout.trim(), createdAt: new Date(this.now()).toISOString(),
      variants: spec.variants.map((variant) => ({ ...variant, status: "pending", branch: `demesne/experiment-${id}-${variant.label.toLowerCase()}` })),
    };
    this.experiments.set(id, experiment);
    this.save(experiment);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const budget = setTimeout(() => controller.abort(new Error(`The ${spec.budgetMinutes}-minute budget ran out.`)), spec.budgetMinutes * 60_000);
    const task = this.execute(experiment, controller.signal)
      .catch((error) => { experiment.status = "failed"; experiment.error = error instanceof Error ? error.message : String(error); })
      .finally(() => {
        clearTimeout(budget);
        this.controllers.delete(id);
        experiment.settledAt ??= new Date(this.now()).toISOString();
        this.save(experiment);
        this.running.delete(task);
      });
    this.running.add(task);
    return experiment;
  }

  stop(id: string): Experiment | undefined {
    this.controllers.get(id)?.abort(new Error("Stopped by request."));
    return this.experiments.get(id);
  }

  /// Stops every running experiment and waits for its cleanup.
  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new Error("The daemon is shutting down."));
    await Promise.allSettled([...this.running]);
  }

  private async execute(experiment: Experiment, signal: AbortSignal): Promise<void> {
    const { spec } = experiment;
    try {
      // Worktrees, one per variant, all from the same commit.
      for (const variant of experiment.variants) {
        variant.worktree = join(this.deps.worktreeRoot, experiment.id, variant.label.toLowerCase());
        mkdirSync(join(this.deps.worktreeRoot, experiment.id), { recursive: true });
        const added = await this.run(["git", "worktree", "add", "-q", "-b", variant.branch, variant.worktree, experiment.base], spec.workspace, 60_000, signal);
        if (added.exitCode !== 0) throw new Error(`Could not create a worktree for ${variant.label}: ${tail(added.stderr)}`);
      }
      this.save(experiment);
      // Build: setup, then the coder (in parallel), then the checks.
      await Promise.all(experiment.variants.map((variant) => this.build(experiment, variant, signal)));
      // Measure one at a time, so variants don't compete for the same model.
      for (const variant of [...experiment.variants].sort((a, b) => Number(Boolean(a.instruction)) - Number(Boolean(b.instruction)))) {
        if (variant.status !== "measuring") continue;
        signal.throwIfAborted();
        this.save(experiment);
        const output = await this.run(spec.metric.argv, variant.worktree!, (spec.metric.timeoutMinutes ?? 60) * 60_000, signal);
        // Stopped mid-measurement: not a metric failure.
        if (signal.aborted) break;
        const metric = output.exitCode === 0 ? parseMetric(output.stdout) : null;
        if (metric) { variant.metric = metric; variant.status = "done"; }
        else { variant.status = "failed"; variant.error = output.timedOut ? "The metric timed out." : `The metric did not report a value: ${tail(output.stderr || output.stdout, 400)}`; }
        this.save(experiment);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      for (const variant of experiment.variants) {
        if (["done", "failed"].includes(variant.status)) continue;
        variant.status = "stopped";
        if (variant.turnId) this.deps.cancelTurn(variant.turnId);
      }
    }
    experiment.verdict = verdict(experiment);
    if (signal.aborted) experiment.error = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
    const winner = experiment.variants.find((variant) => variant.label === experiment.verdict!.winner);
    if (winner) await this.keepWinner(experiment, winner);
    await this.cleanup(experiment, winner);
    // Settled only once the worktrees are gone and the winner is kept.
    experiment.settledAt = new Date(this.now()).toISOString();
    experiment.status = signal.aborted && !winner ? "stopped" : "settled";
  }

  private async build(experiment: Experiment, variant: ExperimentVariant, signal: AbortSignal): Promise<void> {
    const { spec } = experiment, cwd = variant.worktree!;
    try {
      variant.status = "setup"; this.save(experiment);
      for (const argv of spec.setup ?? []) {
        const output = await this.run(argv, cwd, 15 * 60_000, signal);
        if (output.exitCode !== 0) return this.fail(experiment, variant, `Setup failed: ${argv.join(" ")}: ${tail(output.stderr || output.stdout, 400)}`);
      }
      if (variant.instruction) {
        variant.status = "building";
        // A coder turn that fails (often its context filled while reading)
        // gets one more attempt in a fresh session, which starts with an
        // empty context but keeps the partial edits already in the worktree.
        let settled: Turn | undefined;
        for (let attempt = 1; attempt <= CODER_ATTEMPTS; attempt++) {
          const { session } = this.deps.store.createSession(`Experiment ${experiment.id} · ${variant.label}: ${variant.idea}${attempt > 1 ? ` (attempt ${attempt})` : ""}`, cwd);
          variant.sessionId = session.id;
          variant.attempts = attempt;
          for (const tool of EDIT_TOOLS) this.deps.grant(session.id, { tool, pathPrefix: "" });
          for (const argv of spec.checks) this.deps.grant(session.id, { tool: "run_command", pathPrefix: "", argv, cwd: "." });
          const turn = this.deps.startTurn(session.id, coderPrompt(spec, variant, attempt > 1), spec.coderModel);
          variant.turnId = turn.id;
          this.save(experiment);
          settled = await this.waitForTurn(turn.id, signal);
          if (settled.status !== "failed") break;
        }
        if (settled!.status !== "completed") return this.fail(experiment, variant, `The coder's turn ${settled!.status}${variant.attempts! > 1 ? ` after ${variant.attempts} attempts` : ""}.`);
        const status = await this.run(["git", "status", "--porcelain"], cwd, 30_000, signal);
        variant.changedFiles = status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).slice(0, 200);
        if (!variant.changedFiles.length) return this.fail(experiment, variant, "The coder made no change.");
      }
      variant.status = "checking"; this.save(experiment);
      variant.checks = [];
      for (const argv of spec.checks) {
        const started = this.now();
        const output = await this.run(argv, cwd, 30 * 60_000, signal);
        const result: ExperimentCommandResult = { argv, exitCode: output.exitCode, passed: output.exitCode === 0, seconds: Math.round((this.now() - started) / 100) / 10, tail: tail(`${output.stdout}\n${output.stderr}`) };
        variant.checks.push(result);
        // A variant that fails a check is stopped early: its metric won't count.
        if (!result.passed) return this.fail(experiment, variant, `Check failed: ${argv.join(" ")}`);
      }
      variant.status = "measuring";
      this.save(experiment);
    } catch (error) {
      if (signal.aborted) return;
      this.fail(experiment, variant, error instanceof Error ? error.message : String(error));
    }
  }

  private fail(experiment: Experiment, variant: ExperimentVariant, error: string) {
    variant.status = "failed"; variant.error = error; this.save(experiment);
  }

  private async waitForTurn(turnId: string, signal: AbortSignal): Promise<Turn> {
    for (;;) {
      const turn = this.deps.store.getTurn(turnId);
      if (!turn) throw new Error("The coder's turn disappeared.");
      if (!["queued", "running"].includes(turn.status)) return turn;
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /// Commits the winner on its local branch, so removing the worktree
  /// loses nothing. Experiments never push: you review the branch locally.
  private async keepWinner(experiment: Experiment, winner: ExperimentVariant) {
    const cwd = winner.worktree!, { spec } = experiment;
    experiment.kept = { branch: winner.branch };
    for (const argv of [["git", "add", "-A"], ["git", "commit", "-q", "-m", `${winner.idea}\n\nExperiment ${experiment.id}: ${spec.question}\n${experiment.verdict!.summary}`]]) {
      const output = await this.run(argv, cwd, 120_000);
      if (output.exitCode !== 0) {
        // Uncommitted, the change exists only in the worktree: keep it there.
        experiment.kept.keptWorktree = cwd;
        experiment.kept.error = `git ${argv[1]} failed: ${tail(output.stderr || output.stdout, 300)} The winner's change is kept in ${cwd}.`;
        return;
      }
    }
  }

  private async cleanup(experiment: Experiment, winner: ExperimentVariant | undefined) {
    for (const variant of experiment.variants) {
      if (variant.worktree === experiment.kept?.keptWorktree) continue;
      if (variant.worktree && existsSync(variant.worktree)) await this.run(["git", "worktree", "remove", "--force", variant.worktree], experiment.spec.workspace, 60_000);
      // The winner's branch is kept for you to review; the others go.
      if (variant !== winner) await this.run(["git", "branch", "-D", variant.branch], experiment.spec.workspace, 30_000);
    }
    if (!experiment.kept?.keptWorktree) rmSync(join(this.deps.worktreeRoot, experiment.id), { recursive: true, force: true });
  }

  private save(experiment: Experiment) {
    const path = join(this.deps.directory, `${experiment.id}.json`), temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(experiment, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  private run(argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandOutput> {
    return (this.deps.run ?? runCommand)(argv, cwd, timeoutMs, signal ?? new AbortController().signal);
  }
}

export function coderPrompt(spec: ExperimentSpec, variant: ExperimentVariant, retry = false): string {
  return [
    `You are building variant ${variant.label} of a Drive experiment, in an isolated git worktree of this repository.`,
    ...(retry ? ["A previous attempt at this variant failed before finishing, usually because its context filled while reading. Any edits it made are already in this worktree: check git_status and git_diff first, then finish the change. Search before reading, and read only the line ranges you need."] : []),
    `Question: ${spec.question}`,
    `Hypothesis: ${spec.hypothesis}`,
    `Your idea: ${variant.idea}`,
    `Change to make: ${variant.instruction}`,
    "",
    "Rules:",
    "- Make only this change, minimal and consistent with the surrounding code. Update or add the tests it needs.",
    "- Do not commit, and do not change unrelated files.",
    spec.checks.length ? `- The only commands you can run are these checks: ${spec.checks.map((argv) => `\`${argv.join(" ")}\``).join(", ")}.` : "- You cannot run commands.",
    `- After you finish, the experiment runs the checks and measures ${spec.metric.name} (${spec.metric.direction} is better).`,
    "Finish with two or three sentences on what you changed.",
  ].join("\n");
}

/// The metric's last stdout line: a JSON object with a numeric `value`, or a bare number.
export function parseMetric(stdout: string): { value: number; detail?: Record<string, unknown> } | null {
  const line = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (/^-?\d+(\.\d+)?$/.test(line)) return { value: Number(line) };
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.value !== "number" || !Number.isFinite(parsed.value)) return null;
    const { value, ...detail } = parsed;
    return { value, ...(Object.keys(detail).length ? { detail } : {}) };
  } catch { return null; }
}

export function verdict(experiment: Pick<Experiment, "spec" | "variants">): ExperimentVerdict {
  const { metric } = experiment.spec;
  const baseline = experiment.variants.find((variant) => !variant.instruction);
  const name = metric.name;
  if (!baseline?.metric) return { summary: `No verdict: the baseline could not be measured${baseline?.error ? ` (${baseline.error})` : ""}.` };
  const base = baseline.metric.value;
  const measured = experiment.variants.filter((variant) => variant.instruction && variant.metric)
    .map((variant) => {
      const change = base === 0 ? 0 : Math.round(((variant.metric!.value - base) / Math.abs(base)) * 10_000) / 10_000;
      return { variant, change, gain: metric.direction === "lower" ? -change : change };
    })
    .sort((a, b) => b.gain - a.gain);
  const failed = experiment.variants.filter((variant) => variant.instruction && !variant.metric).map((variant) => variant.label);
  const required = metric.minImprovement ?? 0.1;
  const best = measured[0];
  const percent = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;
  const others = [...measured.map(({ variant, change }) => `${variant.label} ${format(variant.metric!.value)} (${percent(change)})`), ...failed.map((label) => `${label} failed`)].join(", ");
  if (!best) return { summary: `No variant could be measured against the baseline's ${name} of ${format(base)}${failed.length ? `; ${others}` : ""}.` };
  if (best.gain < required) return { change: best.change, summary: `No winner: the best variant, ${best.variant.label} (${best.variant.idea}), changed ${name} by ${percent(best.change)} against a baseline of ${format(base)}; ${Math.round(required * 100)}% was required. ${others}.` };
  return { winner: best.variant.label, change: best.change, summary: `${best.variant.label} wins: ${best.variant.idea} changed ${name} from ${format(base)} to ${format(best.variant.metric!.value)} (${percent(best.change)}). ${others}.` };
}

const format = (value: number) => String(Math.round(value * 100) / 100);
const tail = (text: string, size = TAIL) => (text.length > size ? `…${text.slice(-size)}` : text).trim();

/// Runs a command without a shell. The daemon's own DEMESNE_* settings are
/// not passed on, so a benchmark or test starts from a clean configuration.
export async function runCommand(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandOutput> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEMESNE_")));
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const kill = () => child.kill();
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode: timedOut || signal.aborted ? null : exitCode, stdout: stdout.slice(-200_000), stderr: stderr.slice(-50_000), timedOut };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", kill); }
}
