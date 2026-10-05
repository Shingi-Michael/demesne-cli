import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { splitNextPrompt, type CommandRecord, type DriveFix, type DriveFixAction, type DriveSignal, type Turn } from "@demesne/protocol";

/// Fixes for breakages, each made in its own git worktree on its own branch:
/// the user's checkout and conversation are untouched while the agent works,
/// and nothing reaches them until they choose Apply (cherry-pick onto their
/// branch), Open PR (push the branch), or Discard.

export interface FixHost {
  /// A session rooted at the worktree.
  startSession(title: string, workspace: string): string;
  /// A coding turn with every tool allowed (publishing still asks).
  startTurn(sessionId: string, prompt: string): { turnId: string; done: Promise<void> };
  turn(turnId: string): Turn | null;
  cancel(turnId: string): void;
  commands(sessionId: string): CommandRecord[];
  activity(turnId: string): { steps: number; last: string | null };
}

type Run = (argv: string[], cwd: string, timeoutMs?: number) => Promise<{ ok: boolean; out: string; err: string }>;

async function run(argv: string[], cwd: string, timeoutMs = 60_000) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (error) { return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) }; }
  finally { clearTimeout(timer); }
}

const ACTIVE = new Set(["starting", "running", "ready", "failed"]);
const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim().slice(0, 300) ?? "";

export function fixPrompt(fix: Pick<DriveFix, "branch" | "signals">) {
  return `Something in this repository just broke. You're fixing it in a separate git worktree on branch ${fix.branch}, so the user's own checkout is untouched.

What broke:
${fix.signals.map((signal) => `- ${signal.title}: ${signal.detail}`).join("\n")}

1. Reproduce it: run the failing check (or the closest one) and read the actual error. For CI failures, \`gh run list\` and \`gh run view <id> --log-failed\` show the log.
2. Find the cause and make the smallest change that fixes it. Don't refactor or touch unrelated code. Fix the code, not the test, unless the test itself is wrong.
3. Run the check again and confirm it passes.
4. Don't install or upgrade dependencies (node_modules is shared with the user's checkout), and don't commit or push: demesne commits the result for the user to review.

End with two or three plain sentences: what was wrong and what you changed.`;
}

export class DriveFixes {
  private fixes: DriveFix[] = [];
  private done = new Map<string, Promise<void>>();
  /// Paths linked into each worktree (shared node_modules), never committed.
  private linked = new Map<string, string[]>();

  constructor(private readonly stateFile: string, private readonly worktreeRoot: string, private readonly host: FixHost, private readonly git: Run = run) {
    try { this.fixes = JSON.parse(readFileSync(stateFile, "utf8")) as DriveFix[]; } catch { this.fixes = []; }
    // A fix that was working when the daemon stopped can't resume.
    let changed = false;
    for (const fix of this.fixes) if (fix.status === "starting" || fix.status === "running") {
      Object.assign(fix, { status: "failed", finishedAt: new Date().toISOString(), error: "The daemon restarted while this fix was running." });
      changed = true;
    }
    if (changed) this.save();
  }

  private save() {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    // Keep every unfinished fix and the 20 most recent finished ones.
    const finished = this.fixes.filter((fix) => !ACTIVE.has(fix.status)).slice(-20);
    this.fixes = this.fixes.filter((fix) => ACTIVE.has(fix.status) || finished.includes(fix));
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.fixes), { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  list(workspace: string): DriveFix[] {
    return this.fixes.filter((fix) => fix.workspace === workspace).map((fix) =>
      fix.status === "running" && fix.turnId ? { ...fix, activity: this.host.activity(fix.turnId) } : fix);
  }

  get(id: string) { return this.fixes.find((fix) => fix.id === id); }

  /// Waits for a running fix to finish (tests and shutdown).
  async settled(id: string) { await this.done.get(id); }

  async start(workspace: string, signals: DriveSignal[]): Promise<DriveFix> {
    if (this.fixes.some((fix) => fix.workspace === workspace && (fix.status === "starting" || fix.status === "running")))
      throw new Error("A fix is already running for this project.");
    const top = await this.git(["git", "rev-parse", "--show-toplevel"], workspace);
    if (!top.ok) throw new Error("Fixing in a worktree needs a git repository.");
    const base = await this.git(["git", "rev-parse", "HEAD"], workspace);
    if (!base.ok) throw new Error("This repository has no commits yet.");
    const id = randomUUID().slice(0, 8);
    const title = signals.length === 1 ? signals[0]!.title : `${signals.length} breakages: ${signals.map((signal) => signal.title).join("; ")}`.slice(0, 200);
    const slug = signals[0]!.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "") || "breakage";
    const branch = `drive/fix-${slug}-${id.slice(0, 4)}`;
    const path = join(this.worktreeRoot, `${basename(top.out)}-${id}`);
    const fix: DriveFix = { id, workspace, title, signals, branch, path, base: base.out, sessionId: null, turnId: null, status: "starting", startedAt: new Date().toISOString(), finishedAt: null };
    this.fixes.push(fix); this.save();
    try {
      mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
      const added = await this.git(["git", "worktree", "add", "-b", branch, path, fix.base], workspace, 120_000);
      if (!added.ok) throw new Error(`Couldn't create the worktree: ${firstLine(added.err)}`);
      this.linked.set(id, await this.linkDependencies(top.out, path));
      // The session opens where the user works inside the repository.
      const sub = relative(top.out, workspace);
      const sessionId = this.host.startSession(`Fix: ${title}`.slice(0, 200), sub ? join(path, sub) : path);
      const { turnId, done } = this.host.startTurn(sessionId, fixPrompt(fix));
      Object.assign(fix, { sessionId, turnId, status: "running" });
      this.save();
      this.done.set(id, done.then(() => this.finish(fix)).catch((error) => this.fail(fix, error)).finally(() => this.done.delete(id)));
    } catch (error) {
      this.fail(fix, error);
      await this.cleanup(fix, true);
    }
    return fix;
  }

  /// node_modules folders aren't in git: link the user's into the worktree so
  /// checks run at once, instead of a fresh install.
  private async linkDependencies(repo: string, path: string) {
    const ignored = await this.git(["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], repo);
    const linked: string[] = [];
    for (const entry of ignored.ok ? ignored.out.split("\n") : []) {
      const rel = entry.replace(/\/$/, "");
      if (basename(rel) !== "node_modules" || rel.split("/").length > 4 || !existsSync(join(path, dirname(rel)))) continue;
      try { symlinkSync(join(repo, rel), join(path, rel), "dir"); linked.push(rel); } catch { /* already there */ }
    }
    return linked;
  }

  private fail(fix: DriveFix, error: unknown) {
    Object.assign(fix, { status: "failed", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    this.save();
  }

  private async finish(fix: DriveFix) {
    if (fix.status !== "running") return;
    const turn = fix.turnId ? this.host.turn(fix.turnId) : null;
    const summary = splitNextPrompt(turn?.responseText ?? "").text.trim().slice(-1200);
    if (summary) fix.summary = summary;
    const latest = new Map<string, CommandRecord>();
    for (const command of fix.sessionId ? this.host.commands(fix.sessionId) : []) {
      const key = command.argv.join(" ");
      if (command.check && command.status !== "running" && !latest.has(key)) latest.set(key, command);
    }
    fix.checks = [...latest.entries()].slice(0, 6).map(([command, record]) => ({ command, passed: record.status === "completed" && record.exitCode === 0 }));
    if (turn?.status !== "completed") return this.fail(fix, new Error(turn?.status === "cancelled" ? "The fix was stopped." : `The fix turn ${turn?.status ?? "was lost"}.`));
    // Commit what the agent changed, never the linked dependencies.
    const excludes = (this.linked.get(fix.id) ?? []).map((rel) => `:(exclude,top)${rel}`);
    await this.git(["git", "add", "-A", "--", ".", ...excludes], fix.path);
    const staged = await this.git(["git", "diff", "--cached", "--quiet"], fix.path);
    if (!staged.ok) {
      const committed = await this.git(["git", "commit", "-m", `Fix: ${fix.title}`.slice(0, 200), "-m", (summary || "Made by demesne in a worktree.").slice(0, 2000)], fix.path);
      if (!committed.ok) return this.fail(fix, new Error(`Couldn't commit the fix: ${firstLine(committed.err || committed.out)}`));
    }
    const numstat = await this.git(["git", "diff", "--numstat", `${fix.base}..HEAD`], fix.path);
    const rows = numstat.out.split("\n").filter(Boolean).map((line) => line.split("\t"));
    if (!rows.length) return this.fail(fix, new Error("The agent made no changes."));
    fix.diff = { files: rows.length, additions: rows.reduce((n, [a]) => n + (Number(a) || 0), 0), deletions: rows.reduce((n, [, d]) => n + (Number(d) || 0), 0), paths: rows.slice(0, 8).map((row) => row[2]!) };
    Object.assign(fix, { status: "ready", finishedAt: new Date().toISOString() });
    this.save();
  }

  async act(id: string, action: DriveFixAction): Promise<DriveFix> {
    const fix = this.get(id);
    if (!fix || !ACTIVE.has(fix.status)) throw new Error("That fix is no longer open.");
    if (action === "discard") {
      if (fix.status === "running" && fix.turnId) { this.host.cancel(fix.turnId); await this.done.get(id); }
      await this.cleanup(fix, true);
      Object.assign(fix, { status: "discarded", finishedAt: fix.finishedAt ?? new Date().toISOString() });
      this.save();
      return fix;
    }
    if (fix.status !== "ready") throw new Error("The fix isn't ready yet.");
    if (action === "apply") {
      const picked = await this.git(["git", "cherry-pick", `${fix.base}..${fix.branch}`], fix.workspace, 120_000);
      if (!picked.ok) {
        await this.git(["git", "cherry-pick", "--abort"], fix.workspace);
        throw new Error(`It didn't apply cleanly to your checkout (${firstLine(picked.err || picked.out)}). The fix is still on ${fix.branch}.`);
      }
      await this.cleanup(fix, true);
      fix.status = "applied";
    } else {
      const pushed = await this.git(["git", "push", "-u", "origin", fix.branch], fix.path, 120_000);
      if (!pushed.ok) throw new Error(`Couldn't push ${fix.branch}: ${firstLine(pushed.err)}`);
      const body = [`Fixes a breakage demesne noticed:`, ...fix.signals.map((signal) => `- **${signal.title}**: ${signal.detail}`), "", fix.summary ?? "",
        ...(fix.checks?.length ? ["", "Checks run in the worktree:", ...fix.checks.map((check) => `- ${check.passed ? "✓" : "✕"} \`${check.command}\``)] : [])].join("\n");
      const pr = await this.git(["gh", "pr", "create", "--head", fix.branch, "--title", `Fix: ${fix.title}`.slice(0, 200), "--body", body.slice(0, 60_000)], fix.path, 120_000);
      if (!pr.ok) throw new Error(`Pushed ${fix.branch}, but couldn't open the PR: ${firstLine(pr.err)}`);
      fix.prUrl = pr.out.split("\n").findLast((line) => /^https?:\/\//.test(line)) ?? pr.out;
      await this.cleanup(fix, false);
      fix.status = "pr";
    }
    this.save();
    return fix;
  }

  /// Removes the worktree, and the branch unless it was pushed.
  private async cleanup(fix: DriveFix, deleteBranch: boolean) {
    if (existsSync(fix.path)) {
      const removed = await this.git(["git", "worktree", "remove", "--force", fix.path], fix.workspace);
      if (!removed.ok) { rmSync(fix.path, { recursive: true, force: true }); await this.git(["git", "worktree", "prune"], fix.workspace); }
    }
    if (deleteBranch) await this.git(["git", "branch", "-D", fix.branch], fix.workspace);
    this.linked.delete(fix.id);
  }
}
