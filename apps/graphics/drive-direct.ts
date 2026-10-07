import { splitNextPrompt } from "../../packages/protocol/src/next-prompt.ts";
import { createHash } from "node:crypto";
import type {
  DriveAction,
  DriveInspectAction,
  DriveInspection,
  DriveObservation,
} from "@demesne/protocol";
import type { ToolEntry, WorkbenchEntry } from "../cli/src/workbench/entries.ts";
import type { GraphicsHost } from "./host.ts";
import type { GraphicsRun } from "./session-model.ts";

/// Drive's direct control. Observations are built from the daemon's recorded
/// session (requests, tool results, answers, checks), work is submitted
/// through the API, and inspections read recorded answers, diffs, checks and
/// logs. Nothing is typed into or read back from the screen; the UI only
/// shows what Drive does.

/// Marks an observation as direct: the planner then uses its direct-control
/// instructions and offers no click, key or scroll actions.
export const DIRECT_SURFACE = "direct";
export const DIRECT_DOCUMENT = "session";
/// What perform() reports after submitting work (the agent loop keys on it).
export const SENT = "Sent to the coder:";

const MAX_ROWS = 240;
const MAX_ROW = 1900;
const PAGE_ROWS = 60;
const MAX_CHARS = 24_000;

const clip = (text: string) => (text.length > MAX_ROW ? `${text.slice(0, MAX_ROW - 1)}…` : text);
const lines = (text: string) => text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim()).map(clip);
const answers = (run: GraphicsRun) =>
  run.entries.filter((entry): entry is Extract<WorkbenchEntry, { type: "assistant" }> => entry.type === "assistant").flatMap((entry) => lines(splitNextPrompt(entry.raw).text));
const tools = (run: GraphicsRun) => run.entries.filter((entry): entry is ToolEntry => entry.type === "tool");
const FILE_TOOLS = new Set(["edit_file", "write_file", "move_path", "delete_path"]);

/// One line per tool call: `✓ run_command $ bun test · exit 0`.
function toolLine(tool: ToolEntry): string {
  const mark = tool.state === "done" ? "✓" : tool.state === "failed" ? "×" : tool.state === "denied" ? "⊘" : tool.state === "stopped" ? "■" : "◌";
  const extra = [tool.exitCode != null ? `exit ${tool.exitCode}` : "", tool.state === "running" ? "running" : ""].filter(Boolean).join(" · ");
  return clip(`${mark} ${tool.name}${tool.detail ? ` ${tool.detail}` : ""}${extra ? ` · ${extra}` : ""}`);
}

export class DirectDriveControl {
  constructor(private host: GraphicsHost) {}

  private runs(): GraphicsRun[] {
    return this.host.current?.runs() ?? [];
  }

  observe(): DriveObservation {
    const session = this.host.current;
    if (!session) throw new Error("Open a workspace session before starting Drive.");
    const runs = this.runs();
    const latest = runs.at(-1);
    const mode: DriveObservation["mode"] = session.approvals.size || session.questions.size ? "approval" : this.host.setup ? "dialog" : this.host.active ? "streaming" : "input";
    // A compact transcript of recent turns, newest last; older turns give way
    // first when it exceeds the row budget.
    const blocks = runs.map((run) => {
      const answer = answers(run);
      return {
        run,
        answer,
        rows: [clip(`▶ Turn ${run.number} (${run.status}): ${run.content.replace(/\s+/g, " ")}`), ...tools(run).map(toolLine), ...answer],
      };
    });
    const kept: typeof blocks = [];
    let total = 0;
    for (const block of [...blocks].reverse()) {
      if (total + block.rows.length > MAX_ROWS) {
        if (!kept.length) kept.push({ ...block, rows: block.rows.slice(0, MAX_ROWS), answer: block.answer.filter((row) => block.rows.slice(0, MAX_ROWS).includes(row)) });
        break;
      }
      kept.unshift(block);
      total += block.rows.length;
    }
    const rows = kept.flatMap((block) => block.rows);
    const settled = (run: GraphicsRun) => run.status === "completed";
    const answerRows = kept.filter((block) => settled(block.run)).flatMap((block) => block.answer);
    const latestBlock = kept.at(-1);
    const latestAnswerRows = latestBlock && settled(latestBlock.run) ? latestBlock.answer : [];
    // "start" (no turn yet) is the controller's convention, as in the UI's observation.
    const turnId = latest?.id ?? "start";
    const files = latest ? [...new Set(tools(latest).filter((tool) => FILE_TOOLS.has(tool.name)).flatMap((tool) => [tool.input.path, tool.input.from, tool.input.to]).filter((path): path is string => typeof path === "string"))] : [];
    const checks = this.host.processes.filter((record) => record.check && record.turnId === turnId).map((record) => record.id);
    const id = createHash("sha256").update(JSON.stringify([session.session.id, mode, latest?.status, rows])).digest("hex").slice(0, 32);
    return {
      id,
      sessionId: session.session.id,
      // The session's own root: a mission's worktree, not the project it came from.
      workspace: session.session.workspace?.root ?? this.host.workspace,
      title: session.session.title,
      mode,
      ready: mode === "input" && !this.host.busy && this.host.connection === "online",
      draft: "",
      surface: DIRECT_SURFACE,
      width: 500,
      height: 250,
      rows,
      evidenceRows: rows,
      answerRows,
      latestAnswerRows,
      controls: [],
      navigation: {
        document: DIRECT_DOCUMENT,
        turn: turnId,
        latest: true,
        answer: Boolean(latest && settled(latest) && latestAnswerRows.length),
        readingHeld: false,
        files: files.slice(0, 128),
        checks: checks.slice(0, 128),
      },
    };
  }

  async perform(action: DriveAction, observation: DriveObservation, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const current = this.observe();
    if (current.id !== observation.id || current.mode !== "input" || !current.ready) return "UI changed; the session moved on. Observe again.";
    if (action.kind !== "compose") return "UI changed: direct control has no screen controls. Use compose or inspect.";
    const text = action.text.trim();
    const plan = /^\/plan\s+\S/.test(text);
    if (text.startsWith("/") && !plan) throw new Error("Drive may send requests or /plan prompts only.");
    // Drive's coder works with every tool allowed (publishing still asks).
    await this.host.submit(plan ? text.replace(/^\/plan\s+/, "") : text, plan, "allow");
    return `${SENT} ${text.slice(0, 500)}`;
  }

  async inspect(action: DriveInspectAction, observation: DriveObservation, signal: AbortSignal, activity: (text: string) => void): Promise<DriveInspection> {
    const nav = observation.navigation;
    if (!nav) throw new Error("Nothing to inspect yet.");
    const run = this.runs().find((item) => item.id === nav.turn);
    const packet: DriveInspection = { sessionId: observation.sessionId, document: nav.document, turn: nav.turn, target: action.target, pages: [], truncated: false, actions: 0, result: "" };
    if (!run) {
      packet.result = "That turn is no longer in this session.";
      return packet;
    }
    activity(`Reading the recorded ${action.target}`);
    let chars = 0;
    const page = (surface: string, rows: string[], options: { item?: string; answer?: boolean } = {}) => {
      const kept: string[] = [];
      for (const row of rows) {
        if (chars + row.length > MAX_CHARS || packet.pages.length >= 12) { packet.truncated = true; break; }
        kept.push(row); chars += row.length;
      }
      for (let start = 0; start < kept.length && packet.pages.length < 12; start += PAGE_ROWS)
        packet.pages.push({ observationId: observation.id, surface, rows: kept.slice(start, start + PAGE_ROWS), answer: Boolean(options.answer), latest: Boolean(options.answer && nav.latest), ...(options.item ? { item: options.item } : {}) });
      if (kept.length < rows.length) packet.truncated = true;
    };
    const from = <T,>(rows: T[]) => (action.position === "end" ? rows.slice(-PAGE_ROWS * 2) : rows);
    if (action.target === "answer") page("response", from(answers(run)), { answer: run.status === "completed" });
    else if (action.target === "log") {
      for (const tool of tools(run)) {
        const output = lines(tool.message ?? "");
        page("log", [toolLine(tool), ...output.slice(0, 12), ...(output.length > 24 ? [`… ${output.length - 24} lines omitted`] : []), ...output.slice(Math.max(12, output.length - 12))], { item: tool.toolCallId });
        signal.throwIfAborted();
      }
    } else if (action.target === "diff") {
      const review = (await this.host.handle("changes", { scope: "turn", turnId: run.id })) as { files: { path: string; state: string; added: number; removed: number; rows: { kind: string; text: string }[]; unavailable?: string }[] };
      signal.throwIfAborted();
      for (const file of review.files.filter((file) => !action.item || file.path === action.item)) {
        const body = file.unavailable ? [clip(file.unavailable)] : file.rows.map((row) => clip(`${row.kind === "added" ? "+" : row.kind === "removed" ? "-" : row.kind === "gap" ? "…" : " "} ${row.text}`));
        page("diff", [clip(`${file.path} · ${file.state} · +${file.added} −${file.removed}`), ...body], { item: file.path });
      }
    } else if (action.target === "checks") {
      const ids = action.item ? [action.item] : nav.checks.slice(0, 6);
      if (!action.item && nav.checks.length > 6) packet.truncated = true;
      for (const id of ids) {
        const result = await this.host.api.commands(observation.sessionId, id);
        signal.throwIfAborted();
        const check = result.commands.find((record) => record.id === id);
        if (!check) continue;
        const output = lines(`${check.stdout}\n${check.stderr}`);
        page("review", [clip(`$ ${check.argv.join(" ")} · ${check.status} · exit ${check.exitCode ?? "—"} · ${check.freshness}${check.freshnessReason ? ` (${check.freshnessReason})` : ""}`), ...output.slice(0, 30), ...(output.length > 60 ? [`… ${output.length - 60} lines omitted`] : []), ...output.slice(Math.max(30, output.length - 30))], { item: id });
      }
    }
    packet.result = `Read ${packet.pages.length} recorded ${action.target} page${packet.pages.length === 1 ? "" : "s"} directly (no UI actions).${packet.truncated ? " Bounded excerpt: inspect a specific item for more." : ""}`;
    return packet;
  }
}
