import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DriveSignal } from "@demesne/protocol";

/// What Drive knows about a workspace before anyone asks: failing checks,
/// uncommitted and stale work, open PRs and red CI, asks that failed or were
/// cancelled, and what the agent's own telemetry shows. Each signal is a
/// bounded, deterministic fact with a stable id that proposals must cite.

const DAY = 86_400_000;

interface CollectOptions {
  /// Look up open PRs and CI runs with the GitHub CLI.
  gh?: boolean;
  now?: number;
  run?: (argv: string[], cwd: string) => Promise<string | null>;
}

/// Runs a command with a deadline; null when it fails or is unavailable.
async function run(argv: string[], cwd: string): Promise<string | null> {
  try {
    const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 8000);
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null; };

export async function collectDriveSignals(database: Database, workspace: string, options: CollectOptions = {}): Promise<{ signals: DriveSignal[]; fingerprint: string }> {
  const now = options.now ?? Date.now(), exec = options.run ?? run;
  const since = new Date(now - 14 * DAY).toISOString();
  const signals: DriveSignal[] = [];
  const add = (signal: DriveSignal) => { if (signals.length < 60) signals.push({ ...signal, detail: clip(signal.detail, 600) }); };
  const sessions = (database.query("SELECT s.id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE w.root = ? AND s.archived_at IS NULL").all(workspace) as { id: string }[]).map((row) => row.id);
  const inSessions = sessions.length ? `(${sessions.map(() => "?").join(",")})` : "('')";

  // Checks: the latest run of each check command; a failing latest run matters.
  const runs = database.query(`SELECT data_json FROM command_runs WHERE session_id IN ${inSessions} AND created_at >= ? ORDER BY created_at DESC LIMIT 400`).all(...sessions, since) as { data_json: string }[];
  const latest = new Map<string, { argv: string[]; status: string; exitCode: number | null; completedAt: string | null; stderr: string; stdout: string }>();
  for (const row of runs) {
    try {
      const record = JSON.parse(row.data_json);
      if (!record.check) continue;
      const key = JSON.stringify(record.argv);
      if (!latest.has(key)) latest.set(key, record);
    } catch { /* an unreadable record */ }
  }
  for (const [key, record] of latest) {
    if (record.status !== "failed") continue;
    const tail = `${record.stderr}\n${record.stdout}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    add({ id: `check:${createHash("sha1").update(key).digest("hex").slice(0, 8)}`, source: "checks", urgent: true,
      title: `Check failing: ${record.argv.map((part) => part.split("/").pop()).join(" ")}`,
      detail: `Latest run exit ${record.exitCode ?? "—"} at ${record.completedAt ?? "?"}. ${tail}` });
  }

  // Asks that failed or were cancelled and were not followed by a completed turn.
  const turns = database.query(`SELECT id, session_id, content, status, created_at FROM turns WHERE session_id IN ${inSessions} AND created_at >= ? AND kind = 'chat' ORDER BY created_at`).all(...sessions, since) as { id: string; session_id: string; content: string; status: string; created_at: string }[];
  const lastCompleted = new Map<string, string>();
  for (const turn of turns) if (turn.status === "completed") lastCompleted.set(turn.session_id, turn.created_at);
  for (const turn of turns.filter((turn) => ["failed", "interrupted"].includes(turn.status) && (lastCompleted.get(turn.session_id) ?? "") < turn.created_at).slice(-5))
    add({ id: `ask:${turn.id.slice(0, 8)}`, source: "sessions", title: `Unfinished ask (${turn.status})`, detail: `"${clip(turn.content.replace(/\s+/g, " "), 240)}" on ${turn.created_at.slice(0, 10)}` });

  // Telemetry from the event log: rounds, re-reads and prompt caching per model.
  const events = database.query(`SELECT turn_id, type, payload FROM events WHERE session_id IN ${inSessions} AND occurred_at >= ? AND agent_run_id IS NULL AND type IN ('model.request_started','model.usage','model.metrics','tool.call_requested')`).all(...sessions, new Date(now - 7 * DAY).toISOString()) as { turn_id: string; type: string; payload: string }[];
  const perModel = new Map<string, { turns: Map<string, { rounds: number; reads: string[] }>; input: number; cached: number; cachedKnown: boolean; ttft: number[] }>();
  const turnModel = new Map<string, string>();
  for (const event of events) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(event.payload); } catch { continue; }
    if (event.type === "model.request_started") turnModel.set(event.turn_id, String(payload.model ?? "?"));
    const model = turnModel.get(event.turn_id);
    if (!model) continue;
    const stats = perModel.get(model) ?? { turns: new Map(), input: 0, cached: 0, cachedKnown: false, ttft: [] as number[] };
    perModel.set(model, stats);
    const turn = stats.turns.get(event.turn_id) ?? { rounds: 0, reads: [] };
    stats.turns.set(event.turn_id, turn);
    if (event.type === "model.request_started") turn.rounds++;
    if (event.type === "model.usage" && typeof payload.inputTokens === "number") {
      stats.input += payload.inputTokens;
      if (typeof payload.cachedInputTokens === "number") { stats.cached += payload.cachedInputTokens; stats.cachedKnown = true; }
    }
    if (event.type === "model.metrics" && typeof payload.timeToFirstTokenMs === "number") stats.ttft.push(payload.timeToFirstTokenMs);
    if (event.type === "tool.call_requested" && payload.name === "read_file") {
      try { turn.reads.push(String(JSON.parse(String(payload.arguments)).path)); } catch { /* malformed arguments */ }
    }
  }
  for (const [model, stats] of perModel) {
    const working = [...stats.turns.values()].filter((turn) => turn.rounds >= 3);
    if (working.length < 3) continue;
    const reads = working.flatMap((turn) => turn.reads), repeats = working.reduce((n, turn) => n + turn.reads.length - new Set(turn.reads).size, 0);
    const cachedShare = stats.cachedKnown && stats.input ? Math.round((100 * stats.cached) / stats.input) : null;
    add({ id: `telemetry:${model}`, source: "telemetry", title: `Agent telemetry for ${model} (7 days)`,
      detail: `${working.length} tool-heavy turns; rounds per turn median ${median(working.map((turn) => turn.rounds))}; repeat reads ${repeats}/${reads.length}; first token median ${((median(stats.ttft) ?? 0) / 1000).toFixed(1)}s${cachedShare !== null ? `; cached input ${cachedShare}%` : ""}` });
  }

  // Git: uncommitted work, stale unmerged branches.
  const status = await exec(["git", "status", "--porcelain"], workspace);
  if (status !== null) {
    const changed = status.split("\n").filter(Boolean);
    if (changed.length) add({ id: "git:uncommitted", source: "git", title: `${changed.length} uncommitted change${changed.length === 1 ? "" : "s"}`, detail: changed.slice(0, 12).map((line) => line.trim()).join(", ") });
    const head = (await exec(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], workspace))?.trim().replace(/^origin\//, "") || "main";
    const branches = await exec(["git", "for-each-ref", "--format=%(refname:short)|%(committerdate:unix)", "--no-merged", head, "refs/heads"], workspace);
    const stale = (branches ?? "").split("\n").filter(Boolean).map((line) => line.split("|")).filter(([, at]) => now - Number(at) * 1000 > 7 * DAY);
    if (stale.length) add({ id: "git:stale-branches", source: "git", title: `${stale.length} unmerged branch${stale.length === 1 ? "" : "es"} older than a week`, detail: stale.slice(0, 10).map(([name]) => name).join(", ") });

    // TODO/FIXME notes in tracked code.
    // Whole words only (git's regex has no \\b).
    const todos = await exec(["git", "grep", "-n", "-I", "-w", "-e", "TODO", "-e", "FIXME", "-e", "XXX", "--", ".", ":!*.md", ":!*.lock"], workspace);
    const lines = (todos ?? "").split("\n").filter(Boolean);
    if (lines.length) add({ id: "code:todos", source: "code", title: `${lines.length} TODO/FIXME note${lines.length === 1 ? "" : "s"} in code`, detail: lines.slice(0, 6).map((line) => clip(line.trim(), 140)).join(" | ") });
  }

  // GitHub: open PRs and recent CI on the default branch.
  if (options.gh !== false) {
    const prs = await exec(["gh", "pr", "list", "--state", "open", "--limit", "10", "--json", "number,title,isDraft,updatedAt,statusCheckRollup"], workspace);
    try {
      for (const pr of JSON.parse(prs ?? "[]") as { number: number; title: string; isDraft: boolean; updatedAt: string; statusCheckRollup?: { conclusion?: string; state?: string }[] }[]) {
        const failing = (pr.statusCheckRollup ?? []).some((check) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(check.conclusion ?? check.state)));
        add({ id: `pr:${pr.number}`, source: "github", urgent: failing, title: `Open PR #${pr.number}${failing ? " with failing CI" : ""}${pr.isDraft ? " (draft)" : ""}`, detail: `${clip(pr.title, 160)} · updated ${pr.updatedAt.slice(0, 10)}` });
      }
    } catch { /* no GitHub repo or gh unavailable */ }
    const ci = await exec(["gh", "run", "list", "--limit", "8", "--json", "conclusion,displayTitle,workflowName,headBranch,createdAt"], workspace);
    try {
      const red = (JSON.parse(ci ?? "[]") as { conclusion: string; displayTitle: string; workflowName: string; headBranch: string; createdAt: string }[]).filter((item) => item.conclusion === "failure");
      if (red.length) add({ id: "ci:failures", source: "github", urgent: red.some((item) => item.headBranch === "main"), title: `${red.length} recent CI failure${red.length === 1 ? "" : "s"}`, detail: red.slice(0, 4).map((item) => `${item.workflowName} on ${item.headBranch}: ${clip(item.displayTitle, 80)} (${item.createdAt.slice(0, 10)})`).join(" | ") });
    } catch { /* no runs */ }
  }

  // The fingerprint ignores telemetry wording so it changes only with real state.
  const fingerprint = createHash("sha256").update(JSON.stringify(signals.map((signal) => [signal.id, signal.title, signal.source === "telemetry" ? "" : signal.detail]))).digest("hex").slice(0, 16);
  return { signals, fingerprint };
}
