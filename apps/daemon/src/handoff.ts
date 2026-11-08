/// Hand-offs (pass 165 A): the chat hands a whole fix to one of your agent
/// tools (Claude Code, Codex, Gemini), which makes it in its own git
/// worktree, so it can't trip over you or another agent. Its changes come
/// back to the turn as a change card, and nothing reaches your files until
/// you press Bring it in (Undo takes it back out). Ask for changes sends a
/// note to the same agent, which keeps its session and its worktree;
/// Discard deletes the worktree.
///
/// The worktree starts from your project as it is now: HEAD plus your
/// uncommitted changes to tracked files (`git stash create`, which touches
/// nothing), so the agent's patch applies cleanly to your working tree.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentId } from "./agent-cli.ts";

export type HandoffStatus = "working" | "ready" | "applied" | "discarded" | "failed";
export interface HandoffFile { path: string; added: number; removed: number }

export interface Handoff {
  id: string;
  sessionId: string;
  /// Your project: where Bring it in applies the change.
  root: string;
  worktree: string;
  /// The commit the worktree started from (your project as it was).
  base: string;
  agent: AgentId;
  /// The tool's own session, so Ask for changes carries on where it was.
  agentSession: string | null;
  description: string;
  status: HandoffStatus;
  files: HandoffFile[];
  /// The commands it ran ("bun test"), for the card.
  checks: string[];
  report: string;
  error?: string;
  /// How many times it has been sent back with changes.
  rounds: number;
  linked: string[];
  createdAt: string;
  updatedAt: string;
}

/// One run of an agent tool in edit mode, in `cwd`. `resume` is its own
/// session to carry on, if it has one.
export type HandoffRunner = (agent: AgentId, prompt: string, cwd: string, resume: string | null, signal: AbortSignal,
  step: (line: string) => void) => Promise<{ report: string; session: string | null }>;

type Git = (argv: string[], cwd: string, input?: string) => Promise<{ ok: boolean; out: string; err: string }>;

async function git(argv: string[], cwd: string, input?: string) {
  const child = Bun.spawn(["git", ...argv], { cwd, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (input !== undefined && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, out, err: err.trim() };
  } catch (error) { return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) }; }
  finally { clearTimeout(timer); }
}

/// A command that checks the work: tests, type checks, linters, builds.
const CHECK = /\b(test|tests|tsc|lint|eslint|typecheck|check|build|vitest|jest|pytest|mypy|ruff|clippy|vet)\b/;

const AGENT_NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
export const agentName = (agent: AgentId) => AGENT_NAMES[agent];

/// The brief an editing agent gets around the chat's own prompt.
export function handoffBrief(prompt: string, worktree: string, again: boolean): string {
  if (again) return `The person looked at your change and asks for this:\n\n${prompt}\n\nMake it in the same folder, run the checks again, and end with the same kind of report.`;
  return `You are making a change for another coding agent, in ${worktree}: a separate git worktree of the person's project, so their own checkout is untouched.
Make the change described below. Keep to what it asks: no unrelated refactors. Run the project's relevant checks (tests, type check, lint) when it has them and fix what your change broke.
Do not commit, push, create branches, or change anything outside this folder. Never ask questions: nobody can answer them; decide sensibly and say what you decided.
Your final message goes back to the other agent, which can't see your steps: say what you changed and why, the checks you ran with their results, and anything left undone.

Task:
${prompt}`;
}

export class Handoffs {
  private readonly items = new Map<string, Handoff>();
  private readonly running = new Set<string>();

  constructor(private readonly file: string, private readonly worktreeRoot: string, private readonly runner: HandoffRunner, private readonly run: Git = git) {
    try {
      for (const item of JSON.parse(readFileSync(file, "utf8")) as Handoff[]) {
        // A daemon that stopped mid-run left it half done.
        if (item.status === "working") Object.assign(item, { status: "failed", error: "Demesne stopped while the agent was working." });
        this.items.set(item.id, item);
      }
    } catch { /* none yet */ }
  }

  get(id: string): Handoff | null { return this.items.get(id) ?? null; }
  list(sessionId?: string): Handoff[] { return [...this.items.values()].filter((item) => !sessionId || item.sessionId === sessionId); }

  private patchPath(id: string) { return join(dirname(this.file), "handoffs", `${id}.patch`); }
  /// The whole change, as a git patch (empty when it changed nothing).
  patch(id: string): string { try { return readFileSync(this.patchPath(id), "utf8"); } catch { return ""; } }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const all = [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-200);
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private touch(item: Handoff, change: Partial<Handoff>) {
    Object.assign(item, change, { updatedAt: new Date().toISOString() });
    this.save();
  }

  /// Whether `root` can take a hand-off: a git project that isn't itself one
  /// of Demesne's worktrees. The reason it can't, or null.
  async refuse(root: string): Promise<string | null> {
    if (root === this.worktreeRoot || root.startsWith(`${this.worktreeRoot}/`) || root.split(/[\\/]/).includes(".demesne-worktrees"))
      return "This chat already works in a copy of the project; make the change yourself.";
    const top = await this.run(["rev-parse", "--show-toplevel"], root);
    if (!top.ok) return "Hand-offs need a git project (the agent works in a git worktree).";
    const head = await this.run(["rev-parse", "--verify", "HEAD"], root);
    if (!head.ok) return "Hand-offs need a project with at least one commit.";
    return null;
  }

  /// Hands a fix to `agent`, or (with `again`) sends a ready one back with
  /// your note. Resolves once the agent is done and its diff is collected.
  async start(input: { sessionId: string; root: string; agent: AgentId; description: string; prompt: string; signal: AbortSignal; step: (line: string) => void; again?: string }): Promise<Handoff> {
    const item = input.again ? this.items.get(input.again) : await this.create(input);
    if (!item) throw new Error(`No hand-off ${input.again}. Start a new one without continue.`);
    if (input.again) {
      if (item.sessionId !== input.sessionId) throw new Error("That hand-off belongs to another chat.");
      if (this.running.has(item.id)) throw new Error("That hand-off is still working.");
      if (item.status === "applied") throw new Error("That change is already in the person's files. Undo it on its card first, or start a new hand-off.");
      if (item.status === "discarded") throw new Error("That hand-off was discarded. Start a new one.");
      if (!existsSync(item.worktree)) await this.restore(item);
    }
    this.running.add(item.id);
    this.touch(item, { status: "working", error: undefined, ...(input.again ? { rounds: item.rounds + 1 } : {}) });
    const checks = new Set(input.again ? item.checks : []);
    let report = "", failure: string | null = null;
    try {
      const done = await this.runner(item.agent, handoffBrief(input.prompt, item.worktree, Boolean(input.again)), item.worktree, item.agentSession, input.signal, (line) => {
        // Only commands that check something count, and not ones it was refused.
        const refused = / \((not allowed|failed)\)$/.exec(line);
        const command = line.startsWith("Ran ") ? line.slice(4).replace(/ \((not allowed|failed)\)$/, "") : "";
        if (command && refused) checks.delete(command);
        else if (command && CHECK.test(command)) checks.add(command);
        input.step(line);
      });
      report = done.report;
      if (done.session) item.agentSession = done.session;
    } catch (error) {
      if (input.signal.aborted) {
        this.running.delete(item.id);
        await this.collect(item).catch(() => {});
        this.touch(item, { status: item.files.length ? "ready" : "failed", error: "Stopped before it finished.", checks: [...checks].slice(-8) });
        throw error;
      }
      failure = error instanceof Error ? error.message : String(error);
    }
    try {
      await this.collect(item);
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    } finally {
      this.running.delete(item.id);
    }
    // A run that failed after changing files still comes back for review.
    this.touch(item, { status: item.files.length ? "ready" : "failed", report: report.slice(0, 16_000), checks: [...checks].slice(-8),
      ...(failure ? { error: failure.slice(0, 600) } : !item.files.length ? { error: "It changed no files." } : {}) });
    return item;
  }

  private async create(input: { sessionId: string; root: string; agent: AgentId; description: string }): Promise<Handoff> {
    const refused = await this.refuse(input.root);
    if (refused) throw new Error(refused);
    const top = (await this.run(["rev-parse", "--show-toplevel"], input.root)).out.trim();
    // Your uncommitted changes come along; nothing in your checkout changes.
    const stash = (await this.run(["stash", "create"], top)).out.trim();
    const base = stash || (await this.run(["rev-parse", "HEAD"], top)).out.trim();
    const id = randomUUID().slice(0, 8);
    const worktree = join(this.worktreeRoot, `${basename(top)}-handoff-${id}`);
    mkdirSync(this.worktreeRoot, { recursive: true });
    const added = await this.run(["worktree", "add", "--detach", worktree, base], top);
    if (!added.ok) throw new Error(`Couldn't make the agent's copy: ${added.err.split("\n")[0]}`);
    const now = new Date().toISOString();
    const item: Handoff = { id, sessionId: input.sessionId, root: top, worktree, base, agent: input.agent, agentSession: null, description: input.description,
      status: "working", files: [], checks: [], report: "", rounds: 0, linked: await this.link(top, worktree), createdAt: now, updatedAt: now };
    this.items.set(id, item);
    this.save();
    return item;
  }

  /// A worktree that's gone (after Undo) comes back at the same path, with
  /// the change in it, so the agent's session still fits.
  private async restore(item: Handoff) {
    const added = await this.run(["worktree", "add", "--detach", item.worktree, item.base], item.root);
    if (!added.ok) throw new Error(`Couldn't reopen the agent's copy: ${added.err.split("\n")[0]}`);
    const patch = this.patch(item.id);
    if (patch && !(await this.run(["apply", "--binary", "-"], item.worktree, patch)).ok) throw new Error("Couldn't put the change back in the agent's copy.");
    item.linked = await this.link(item.root, item.worktree);
  }

  /// node_modules folders aren't in git: the project's are linked in, so
  /// checks run at once (as Drive's worktrees do).
  private async link(repo: string, path: string) {
    const ignored = await this.run(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], repo);
    const linked: string[] = [];
    for (const entry of ignored.ok ? ignored.out.split("\n") : []) {
      const rel = entry.trim().replace(/\/$/, "");
      if (!rel || basename(rel) !== "node_modules" || rel.split("/").length > 4 || !existsSync(join(path, dirname(rel)))) continue;
      try { symlinkSync(join(repo, rel), join(path, rel), "dir"); linked.push(rel); } catch { /* already there */ }
    }
    return linked;
  }

  /// Everything the agent changed since the base, as a patch and counts.
  /// Staged in the worktree's own index only; nothing is committed.
  private async collect(item: Handoff) {
    const exclude = item.linked.map((rel) => `:(exclude,top)${rel}`);
    const add = await this.run(["add", "-A", "--", ".", ...exclude], item.worktree);
    if (!add.ok) throw new Error(`Couldn't read the agent's changes: ${add.err.split("\n")[0]}`);
    const diff = await this.run(["diff", "--cached", "--binary", item.base], item.worktree);
    const numstat = await this.run(["diff", "--cached", "--numstat", item.base], item.worktree);
    if (!diff.ok || !numstat.ok) throw new Error("Couldn't read the agent's changes.");
    mkdirSync(dirname(this.patchPath(item.id)), { recursive: true });
    writeFileSync(this.patchPath(item.id), diff.out, { mode: 0o600 });
    item.files = numstat.out.split("\n").filter(Boolean).map((line) => {
      const [added, removed, ...path] = line.split("\t");
      return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
  }

  /// Bring it in: the change goes into your working tree (not committed).
  async apply(id: string): Promise<Handoff> {
    const item = this.ready(id, ["ready"]);
    const patch = this.patch(id);
    if (!patch.trim()) throw new Error("There's no change to bring in.");
    const check = await this.run(["apply", "--check", "--binary", "-"], item.root, patch);
    if (!check.ok) throw new Error(`Your files changed where this change goes (${check.err.split("\n")[0]?.replace(/^error: /, "")}). Ask for changes so the agent redoes it on what's there now, or discard it.`);
    const applied = await this.run(["apply", "--binary", "-"], item.root, patch);
    if (!applied.ok) throw new Error(`Couldn't bring it in: ${applied.err.split("\n")[0]}`);
    await this.remove(item);
    this.touch(item, { status: "applied" });
    return item;
  }

  /// Undo: takes a brought-in change back out of your files, as long as
  /// they still hold it as it was.
  async undo(id: string): Promise<Handoff> {
    const item = this.ready(id, ["applied"]);
    const patch = this.patch(id);
    const check = await this.run(["apply", "-R", "--check", "--binary", "-"], item.root, patch);
    if (!check.ok) throw new Error("Those files changed since it was brought in, so it can't be taken out cleanly.");
    const undone = await this.run(["apply", "-R", "--binary", "-"], item.root, patch);
    if (!undone.ok) throw new Error(`Couldn't undo it: ${undone.err.split("\n")[0]}`);
    this.touch(item, { status: "ready" });
    return item;
  }

  /// Discard: the worktree goes; the record stays so the card says so.
  async discard(id: string): Promise<Handoff> {
    const item = this.ready(id, ["ready", "failed"]);
    await this.remove(item);
    this.touch(item, { status: "discarded" });
    return item;
  }

  private ready(id: string, allowed: HandoffStatus[]): Handoff {
    const item = this.items.get(id);
    if (!item) throw new Error("No such hand-off.");
    if (this.running.has(id)) throw new Error("The agent is still working on it.");
    if (!allowed.includes(item.status)) throw new Error(`It's ${item.status === "applied" ? "already brought in" : item.status}.`);
    return item;
  }

  private async remove(item: Handoff) {
    if (!existsSync(item.worktree)) return;
    const removed = await this.run(["worktree", "remove", "--force", item.worktree], item.root);
    if (!removed.ok) rmSync(item.worktree, { recursive: true, force: true });
    await this.run(["worktree", "prune"], item.root);
  }
}

/// What the chat's model gets back: the files, the checks, the agent's own
/// report and the diff, so it can review the change for the person.
export function handoffResult(item: Handoff, patch: string, limit = 12_000): string {
  const name = agentName(item.agent);
  if (item.status === "failed") return `Error: ${name} couldn't make the change (hand-off ${item.id}): ${item.error ?? "unknown error"}${item.report ? `\n\nIts report:\n${item.report}` : ""}`;
  const added = item.files.reduce((sum, file) => sum + file.added, 0), removed = item.files.reduce((sum, file) => sum + file.removed, 0);
  const diff = patch.length > limit ? `${patch.slice(0, limit)}\n… (${patch.length - limit} more characters of diff not shown)` : patch;
  return [
    `Hand-off ${item.id}: ${name} changed ${item.files.length} file${item.files.length === 1 ? "" : "s"} (+${added} −${removed}) in its own copy of the project. None of it is in the person's files yet: they bring it in, ask for changes, or discard it on the card under this step.`,
    `Files: ${item.files.map((file) => `${file.path} (+${file.added} −${file.removed})`).join(", ")}`,
    item.checks.length ? `Commands it ran: ${item.checks.join("; ")}` : "It ran no commands.",
    ...(item.error ? [`It stopped early: ${item.error}`] : []),
    `Its report:\n${item.report || "(none)"}`,
    `Diff:\n${diff}`,
    `Now review the diff against what was asked and tell the person in two or three sentences whether it looks right and anything to watch. Don't make these edits yourself. If they ask for changes to it, call hand_off with continue "${item.id}" and their note.`,
  ].join("\n\n");
}

export const HANDOFF_TOOL = "hand_off";

/// The tool as offered to a turn, naming the agent tools on this machine.
export function handoffDefinition(available: readonly AgentId[]) {
  return {
    name: HANDOFF_TOOL,
    description: "Hand a whole, self-contained code change (a fix or a small feature) to one of the person's own coding agents "
      + `(${available.map(agentName).join(", ")}), which makes it in its own copy of the project and runs the checks there, costing this chat almost nothing. `
      + "Nothing reaches the person's files: a change card shows the files and diff, and they bring it in, ask for changes, or discard it. "
      + "Use it when the person asks for an agent to do it, or for a change that needs reading and editing many files you haven't seen. Make the edit yourself when it's small or you already have the files in view. "
      + "The agent sees nothing of this conversation: put the whole task in prompt (what to change, where, how to check it). "
      + "The result has its report and the diff: review them for the person. To revise a hand-off, call again with continue set to its id and the person's note.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["description", "prompt"],
      properties: {
        description: { type: "string", minLength: 1, maxLength: 80, description: "A 3–6 word label for the person, e.g. \"Fix the retry backoff\"." },
        prompt: { type: "string", minLength: 1, maxLength: 16_000, description: "The complete task, or with continue, what to change about the last attempt." },
        agent: { type: "string", enum: [...available], description: "Optional: the agent to use when the person names one. Omit it to let Auto pick." },
        continue: { type: "string", maxLength: 40, description: "Optional: the id of an earlier hand-off of this chat to send back with changes (the same agent, its session and copy)." },
      },
    },
  };
}

export function parseHandoffInput(input: unknown): { description: string; prompt: string; agent?: AgentId; again?: string } {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!description || description.length > 80) throw new Error("hand_off needs a description of 1–80 characters");
  if (!prompt || prompt.length > 16_000) throw new Error("hand_off needs a prompt of 1–16,000 characters");
  const agent = (["claude", "codex", "gemini"] as const).find((id) => id === value.agent);
  if (value.agent !== undefined && !agent) throw new Error("agent must be claude, codex or gemini");
  const again = typeof value.continue === "string" && value.continue.trim() ? value.continue.trim() : undefined;
  return { description, prompt, ...(agent ? { agent } : {}), ...(again ? { again } : {}) };
}
