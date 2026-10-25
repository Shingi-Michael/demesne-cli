import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PLAN_LIMIT_DRIVE_PAUSE, type DriveAuto, type DriveAwayRequest, type DriveProposal, type DriveSignal } from "@demesne/protocol";

/// Drive on by default. Once a project has had no turn for a while, Drive
/// runs its top Next idea in its own worktree, as an away run you never had
/// to start. It stays inside fixed limits instead of asking: one run at a
/// time, a few a day, only ideas it hasn't run lately, and only in a project
/// you were working in today. One switch per project turns it off.

export const AUTO_QUIET_MINUTES = 20;
export const AUTO_RUNS_PER_DAY = 3;
/// A project you haven't touched for this long is left alone.
const AUTO_RECENT_HOURS = 12;
/// An idea Drive already ran isn't run again for this long.
const AUTO_REPEAT_DAYS = 7;
/// Ideas older than this wait for a fresh look.
const AUTO_FRESH_HOURS = 12;

export interface DriveAutoHost {
  /// Projects the daemon knows.
  workspaces(): string[];
  trusted(workspace: string): boolean;
  /// When the project's newest turn started or ended; null when one is still
  /// working (or there has never been one).
  lastActivity(workspace: string): number | null;
  /// A worktree run, mission or away list is already going.
  busy(workspace: string): boolean;
  /// The cached Next queue, best first.
  ideas(workspace: string): { generatedAt: string; proposals: DriveProposal[]; signals: DriveSignal[] } | null;
  start(request: DriveAwayRequest & { auto: true }): void;
  /// How full the plan Drive would run on is (its fuller window), when it says.
  planUsed?(): number | null;
}

interface Run { workspace: string; at: string; idea: string }
interface Saved { off: string[]; runs: Run[] }

export class DriveAutoRuns {
  private saved: Saved;
  /// Time before the daemon started doesn't count as quiet: a restart
  /// usually means you just opened (or updated) demesne and are here.
  private readonly startedAt: number;
  constructor(private readonly file: string, private readonly host: DriveAutoHost, private readonly now = () => Date.now()) {
    this.startedAt = now();
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
      this.saved = { off: Array.isArray(value.off) ? value.off : [], runs: Array.isArray(value.runs) ? value.runs : [] };
    } catch { this.saved = { off: [], runs: [] }; }
  }

  state(workspace: string): DriveAuto {
    const paused = this.planPaused();
    return { workspace, on: !this.saved.off.includes(workspace), quietMinutes: AUTO_QUIET_MINUTES, perDay: AUTO_RUNS_PER_DAY, usedToday: this.today(workspace).length, ...(paused === null ? {} : { planPaused: paused }) };
  }

  /// Near the end of your plan's window Drive leaves the rest to you.
  private planPaused(): number | null {
    const used = this.host.planUsed?.() ?? null;
    return used !== null && used >= PLAN_LIMIT_DRIVE_PAUSE ? Math.round(used) : null;
  }

  set(workspace: string, on: boolean): DriveAuto {
    this.saved.off = this.saved.off.filter((item) => item !== workspace);
    if (!on) this.saved.off.push(workspace);
    this.save();
    return this.state(workspace);
  }

  /// Starts at most one run per quiet project. Returns the projects it started in.
  tick(): string[] {
    const started: string[] = [];
    for (const workspace of this.host.workspaces()) {
      const idea = this.due(workspace);
      if (!idea) continue;
      this.saved.runs = [...this.saved.runs.filter((run) => this.now() - Date.parse(run.at) < AUTO_REPEAT_DAYS * 86_400_000), { workspace, at: new Date(this.now()).toISOString(), idea: idea.proposal.title }];
      this.save();
      this.host.start({ workspace, items: [idea], auto: true });
      started.push(workspace);
    }
    return started;
  }

  /// The idea to run now, or null when this project should be left alone.
  private due(workspace: string): DriveAwayRequest["items"][number] | null {
    if (this.saved.off.includes(workspace) || !this.host.trusted(workspace) || this.host.busy(workspace)) return null;
    if (this.today(workspace).length >= AUTO_RUNS_PER_DAY || this.planPaused() !== null) return null;
    const last = this.host.lastActivity(workspace);
    if (last === null || this.now() - last > AUTO_RECENT_HOURS * 3_600_000) return null;
    if (this.now() - Math.max(last, this.startedAt) < AUTO_QUIET_MINUTES * 60_000) return null;
    const ideas = this.host.ideas(workspace);
    if (!ideas || this.now() - Date.parse(ideas.generatedAt) > AUTO_FRESH_HOURS * 3_600_000) return null;
    const ran = new Set(this.saved.runs.filter((run) => run.workspace === workspace).map((run) => run.idea));
    const item = ideas.proposals.find((proposal) => !ran.has(proposal.title));
    if (!item) return null;
    return {
      proposal: { id: item.id, kind: item.kind, title: item.title, why: item.why, minutes: item.minutes, confidence: item.confidence },
      signals: ideas.signals.filter((signal) => item.evidence.includes(signal.id)).slice(0, 5),
    };
  }

  private today(workspace: string) {
    const day = new Date(this.now()).toDateString();
    return this.saved.runs.filter((run) => run.workspace === workspace && new Date(run.at).toDateString() === day);
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
