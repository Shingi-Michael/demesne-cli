/// Auto for sub-agents: which of your agent tools (Claude Code, Codex,
/// Gemini) runs a sub-agent, picked by the kind of job and by how each tool
/// has done on that kind of job on this machine. Nothing here calls a model.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { AgentId } from "./agent-cli.ts";

/// "fix" is a hand-off (handoff.ts): the agent makes a change in its own copy.
export type JobKind = "find" | "trace" | "review" | "read" | "fix";

export const JOB_WORDS: Record<JobKind, string> = { find: "finding code", trace: "tracing a flow across files", review: "reviewing changes", read: "reading a lot at once", fix: "making a change" };
const NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };

/// Who to try first for each kind before there's any history: Claude Code
/// for finding and reviewing, Codex for tracing, Gemini's long context for
/// reading whole folders.
const FIRST: Record<JobKind, AgentId[]> = {
  find: ["claude", "codex", "gemini"],
  trace: ["codex", "claude", "gemini"],
  review: ["claude", "codex", "gemini"],
  read: ["gemini", "claude", "codex"],
  fix: ["claude", "codex", "gemini"],
};

/// The kind of job, from its label and brief.
export function jobKind(description: string, prompt: string): JobKind {
  const text = `${description}\n${prompt}`.toLowerCase();
  if (/\b(review|diff|regress|what changed|recent changes?|commits?)\b/.test(text)) return "review";
  if (/\b(trace|flow|end to end|end-to-end|call chain|calls? into|path from|how does .* reach)\b/.test(text)) return "trace";
  if (/\b(every|all (the )?files|whole|entire|survey|across the (repo|codebase|project)|summari[sz]e)\b/.test(text)) return "read";
  return "find";
}

/// Each tool's good and failed sub-agents by kind (good: the report points at
/// real files, see grounded), and when a tool that
/// ran out of room may be tried again.
export interface RouteRecord { jobs: Partial<Record<AgentId, Partial<Record<JobKind, { ok: number; failed: number }>>>>; restUntil: Partial<Record<AgentId, number>> }

/// A tool needs this many jobs of a kind before its own record counts.
export const ENOUGH = 4;
/// How long a tool that hit its plan's limit sits out.
export const REST_MS = 60 * 60_000;

export interface Pick { agent: AgentId; why: string }

/// The tool for a job: among those installed and not resting, the best
/// finish rate on this kind once each has ENOUGH jobs, else the usual order.
export function pickAgent(kind: JobKind, available: readonly AgentId[], record: RouteRecord, now = Date.now()): Pick | null {
  const ready = FIRST[kind].filter((agent) => available.includes(agent) && !((record.restUntil[agent] ?? 0) > now));
  if (!ready.length) return null;
  const tally = (agent: AgentId) => record.jobs[agent]?.[kind] ?? { ok: 0, failed: 0 };
  const rate = (agent: AgentId) => { const { ok, failed } = tally(agent); return ok + failed >= ENOUGH ? ok / (ok + failed) : null; };
  const ranked = [...ready].sort((a, b) => {
    const ra = rate(a), rb = rate(b);
    if (ra !== null && rb !== null && ra !== rb) return rb - ra;
    if (ra !== null && rb === null) return ra >= 0.8 ? -1 : 1;
    if (rb !== null && ra === null) return rb >= 0.8 ? 1 : -1;
    return FIRST[kind].indexOf(a) - FIRST[kind].indexOf(b);
  });
  const agent = ranked[0]!, { ok, failed } = tally(agent);
  const why = ok + failed >= ENOUGH
    ? `${NAMES[agent]}: ${JOB_WORDS[kind]}, ${ok} of ${ok + failed} good reports on this machine`
    : `${NAMES[agent]}: ${JOB_WORDS[kind]} suits it${ok + failed ? ` (${ok} of ${ok + failed} so far)` : ""}`;
  return { agent, why };
}

/// Words a tool says when its plan is out of room.
export const OUT_OF_ROOM = /\b(rate.?limit|usage limit|quota|too many requests|429|limit reached|out of (credits|usage))\b/i;

/// The record on disk (<data>/subagent-route.json).
export class RouteBook {
  constructor(private readonly path: string) {}
  read(): RouteRecord {
    try { if (existsSync(this.path)) { const value = JSON.parse(readFileSync(this.path, "utf8")); return { jobs: value.jobs ?? {}, restUntil: value.restUntil ?? {} }; } } catch { /* start over */ }
    return { jobs: {}, restUntil: {} };
  }
  note(agent: AgentId, kind: JobKind, finished: boolean, error = "", now = Date.now()): void {
    const record = this.read();
    const kinds = record.jobs[agent] ??= {};
    const tally = kinds[kind] ??= { ok: 0, failed: 0 };
    if (finished) tally.ok++; else tally.failed++;
    if (!finished && OUT_OF_ROOM.test(error)) record.restUntil[agent] = now + REST_MS;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(record, null, 2));
      renameSync(temporary, this.path);
    } catch { /* the pick still works without it */ }
  }
}

/// Whether a report is grounded: it names at least one file that really is
/// in the project ("apps/x.ts", "x.ts:12", an absolute path inside it). A
/// report that names none is how a sub-agent says it didn't find anything,
/// or made it up, so it counts against the tool.
export function grounded(report: string, root: string): boolean {
  const candidates = report.match(/\/?(?:[\w.@~-]+\/)*[\w.@-]+\.[A-Za-z][\w]{0,9}(?=[:#)\]`'",\s]|$)/g) ?? [];
  for (const candidate of new Set(candidates)) {
    if (!candidate.includes(".") || /^\d/.test(candidate)) continue;
    const path = isAbsolute(candidate) ? candidate : join(root, candidate);
    const inside = relative(root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) continue;
    try { if (statSync(path).isFile()) return true; } catch { /* not here */ }
    // A bare name ("live.ts") is good when it is unique enough to find.
    if (!candidate.includes("/") && findByName(root, candidate)) return true;
  }
  return false;
}

/// A file of that name anywhere in the project, a bounded walk that skips
/// dependency and build folders.
function findByName(root: string, name: string, budget = { left: 4000 }): boolean {
  const walk = (folder: string): boolean => {
    let entries: Dirent[];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (--budget.left < 0) return false;
      if (entry.isFile() && entry.name === name) return true;
      if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".") && walk(join(folder, entry.name))) return true;
    }
    return false;
  };
  return walk(root);
}
const SKIP = new Set(["node_modules", "dist", "build", "release", "target", "out", "coverage"]);
