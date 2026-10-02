import { formatFooterLine, formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, wrapDisplayText, type Painter, type PaletteColor } from "@demesne/brand";
import type { DriveState, DriveTrace } from "@demesne/protocol";
import type { DriveControl } from "../agent-drive.ts";
import { traceActive } from "../drive-trace.ts";
import { Canvas } from "./canvas.ts";
import { driveTraceLabel, driveTraceLines } from "./drive-trace-view.ts";
import { driveSince, driveStepLine, driveTaskList } from "./drive-timeline.ts";
import { keycap } from "./session-chrome.ts";
import { surface } from "./surface.ts";

/// The panel's one fold: everything long (answer, reasoning, output, mission, budget).
export type DriveSection = "details";
export type DrivePanelAction = { kind: "drive-open" } | { kind: "drive-control"; control: DriveControl }
  | { kind: "drive-follow" } | { kind: "drive-trace-toggle"; id: string } | { kind: "drive-section-toggle"; section: DriveSection };

/// The Drive panel's state word for its header: live, waiting, paused…
export function driveStatusWord(state: DriveState | null, now = Date.now()): { text: string; tone: PaletteColor } | null {
  if (!state) return null;
  if (state.recovery && state.recovery.retryAt > now) return { text: "retrying", tone: "thinking" };
  if (state.protection?.trip) return { text: "stopped", tone: "signal" };
  return state.status === "running" ? { text: "live", tone: "citron" } : state.status === "waiting" ? { text: "waiting", tone: "thinking" }
    : state.status === "completed" ? { text: "done", tone: "citron" } : state.status === "blocked" ? { text: "blocked", tone: "signal" }
    : state.status === "stopped" ? { text: "stopped", tone: "secondary" } : { text: state.status, tone: "muted" };
}

interface Verdict { mark: string; label: string; reason: string; tone: PaletteColor; surface: PaletteColor; reasonTone?: PaletteColor }

const lastAction = (state: DriveState): { kind?: string; text?: string; task?: string } => {
  try { return JSON.parse(state.steps.at(-1)?.action ?? "{}") as { kind?: string }; } catch { return {}; }
};

/// Figma 85:697: one verdict card per status and decision. Colors carry the
/// state: green keeps going or finished, amber corrects or retries, blue moves
/// on, red needs you, neutral waits or holds.
function verdict(state: DriveState, trace: DriveTrace | undefined, now: number): Verdict {
  const note = state.steps.at(-1)?.note || state.activity;
  if (state.recovery && state.recovery.retryAt > now) {
    return { mark: "↻", label: `Retrying in ${Math.max(1, Math.ceil((state.recovery.retryAt - now) / 1000))}s`, tone: "thinking", surface: "thinkingSurface",
      reason: `${state.recovery.message} Drive will try again on its own; nothing was sent to the coder.` };
  }
  if (state.protection?.trip) return { mark: "■", label: "Stopped at a limit", tone: "signal", surface: "errorSurface", reason: state.protection.trip.reason };
  if (state.status === "paused") return { mark: "‖", label: "Paused", tone: "paper", surface: "raised", reason: "Drive sends nothing while paused. The coder's current turn keeps running; resume to review it." };
  if (state.status === "blocked") return { mark: "×", label: "Blocked · needs you", tone: "signal", surface: "errorSurface", reason: state.activity };
  if (state.status === "completed") return { mark: "✓", label: "Mission complete", tone: "citron", surface: "diffAddedSurface", reason: state.activity };
  if (state.status === "stopped") return { mark: "■", label: "Stopped", tone: "secondary", surface: "raised", reason: state.activity };
  if (state.status === "idle") return { mark: "·", label: "Idle", tone: "secondary", surface: "raised", reason: state.activity };
  if (state.status === "waiting") return { mark: "◌", label: "Coder is working", tone: "secondary", surface: "raised", reason: state.activity };
  if (trace && traceActive(trace)) {
    const doing = trace.source === "controller" ? "Reviewing" : trace.status === "drafting" ? "Choosing an action" : trace.status === "acting" ? "Acting" : trace.status === "queued" ? "Waiting for the model" : "Deciding";
    return { mark: "◇", label: `${doing}…`, tone: "thinking", surface: "thinkingSurface", reason: state.activity };
  }
  const action = lastAction(state);
  if (action.kind === "keep_working") return { mark: "✓", label: "Keep working", tone: "citron", surface: "diffAddedSurface", reason: note };
  if (action.kind === "redirect") return { mark: "↻", label: "Redirected the coder", tone: "thinking", surface: "thinkingSurface",
    reason: action.text ? `${note} Sent: “${action.text}”` : note };
  if (action.kind === "next_task") return { mark: "→", label: "Next task", tone: "electric", surface: "accentSurface", reason: action.task ?? note };
  if (action.kind === "compose") return { mark: "→", label: "Sent to the coder", tone: "electric", surface: "accentSurface", reason: note };
  return { mark: "◇", label: "Reviewing", tone: "secondary", surface: "raised", reason: note };
}

const minutes = (ms: number): string => ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.round(ms % 3_600_000 / 60_000)}m`;

/// Figma 85:697, simplified: a status line and one short sentence, a
/// timeline of what Drive did, a plain task checklist and one stats line.
/// Everything long (the full note or answer, reasoning, raw output, the
/// mission, budget) stays folded under Details.
export function renderDrivePanel(width: number, height: number, paint: Painter, state: DriveState | null, offset: number,
  options: { follow?: boolean; followStep?: number; snapshot?: { state: DriveState; now: number }; collapsed?: ReadonlySet<string>; sections?: ReadonlySet<DriveSection>; now?: number } = {}) {
  const canvas = new Canvas(width, height, paint);
  const zones: { row: number; column: number; width: number; action: DrivePanelAction }[] = [];
  const content: string[] = [];
  const controls: { row: number; column: number; width: number; action: DrivePanelAction }[] = [];
  const inner = Math.max(1, width - 2);
  const now = options.now ?? Date.now();
  const add = (text: string, tone: PaletteColor = "secondary") => {
    for (const line of text.split("\n")) content.push(...wrapDisplayText(sanitizeTerminalLine(line), inner).map((row) => paint.text(row, tone)));
  };
  // At most `lines` rows; a longer text ends in an ellipsis (the whole of it is under Details).
  const clip = (text: string, tone: PaletteColor, lines = 2, indent = "") => {
    const rows = wrapDisplayText(sanitizeTerminalLine(text.replace(/\s+/g, " ").trim()), Math.max(1, inner - indent.length));
    const kept = rows.slice(0, lines);
    if (rows.length > lines) kept[lines - 1] = truncateText(`${kept[lines - 1]!} ${rows[lines]!}`, Math.max(1, inner - indent.length));
    content.push(...kept.map((row, index) => (index ? indent : "") + paint.text(row, tone)));
    return rows.length > lines;
  };
  const heading = (label: string) => content.push(paint.text(label, "muted"));
  const control = (text: string, action: DrivePanelAction, column = 0) => { controls.push({ row: content.length, column, width: visibleLength(text), action }); content.push(text); };
  const footer = height >= 4 ? 1 : 0;
  const footerHints: { key: string; label: string; action?: DrivePanelAction }[] = [];
  let streamLabel = -1;
  if (state) {
    const live = state;
    // The body can be held for reading; controls and the footer stay current.
    state = options.snapshot?.state ?? state;
    const at = options.snapshot?.now ?? now;
    const trace = state.traces?.at(-1);
    const card = verdict(state, trace, at);
    content.push(paint.bold(`${card.mark} ${card.label}`, card.tone));
    const clipped = card.reason ? clip(card.reason, "paper") : false;
    // Resume and Stop buttons where Drive is holding for you.
    const resumable = !live.protection?.trip && (["paused", "blocked", "stopped", "idle"].includes(live.status));
    const active = live.status === "running" || live.status === "waiting";
    if (resumable) {
      const resume = paint.wash(" p  Resume ", "diffAddedSurface", "citron"), stop = paint.wash(" s  Stop ", "raised", "paper");
      controls.push({ row: content.length, column: 0, width: visibleLength(resume), action: { kind: "drive-control", control: "resume" } });
      if (!["stopped", "completed"].includes(live.status)) controls.push({ row: content.length, column: visibleLength(resume) + 2, width: visibleLength(stop), action: { kind: "drive-control", control: "stop" } });
      content.push(resume + (["stopped", "completed"].includes(live.status) ? "" : "  " + stop));
    }
    // A limit stop shows the resource that ran out.
    if (state.protection?.trip) {
      const { used, limits } = state.protection;
      const gauges: [string, number, number, (value: number) => string][] = [
        ["tokens", used.planningTokens + used.workerTokens, limits.maxTokens, formatTokenCount],
        ["active time", used.activeMs, limits.maxActiveMinutes * 60_000, minutes],
        ["cycles", used.cycles, limits.maxCycles, String], ["tasks", used.tasks, limits.maxTasks, String],
        ["coder requests", used.workerRequests, limits.maxWorkerRequests, String]];
      const [name, value, limit, format] = gauges.reduce((best, gauge) => gauge[1] / Math.max(1, gauge[2]) > best[1] / Math.max(1, best[2]) ? gauge : best);
      const ratio = Math.min(1, value / Math.max(1, limit)), bar = Math.min(inner, 30), filled = Math.round(ratio * bar);
      content.push(paint.text(name, "muted") + " " + paint.text(`${format(value)} / ${format(limit)} · ${Math.round(ratio * 100)}%`, "signal"));
      content.push(paint.text("━".repeat(filled), "signal") + paint.text("━".repeat(bar - filled), "rule"));
      add("Start /drive <revised mission> to continue; Resume cannot clear a limit stop.", "muted");
    }
    content.push("");
    // What Drive did, newest last, then what it is doing now.
    const steps = state.steps.slice(-5);
    const working = trace && traceActive(trace) ? "Deciding the next step" : live.status === "waiting" ? "Waiting for the coder" : "";
    if (steps.length || working) {
      heading("TIMELINE");
      const entry = (mark: string, text: string, tone: PaletteColor, when: string) => {
        const right = when ? paint.text(when, "muted") : "";
        const room = Math.max(4, inner - visibleLength(when) - 3);
        const rows = wrapDisplayText(`${mark} ${text}`, room);
        content.push(formatFooterLine(paint.text(rows[0] ?? "", tone), right, inner));
        if (rows.length > 1) content.push("  " + paint.text(truncateText(rows.slice(1).join(" ").replace(/^\s+/, ""), Math.max(1, inner - 2)), tone));
      };
      for (const step of steps) { const line = driveStepLine(step); entry(line.mark, line.text, line.tone, driveSince(step.at, at)); }
      if (working) entry(trace && traceActive(trace) ? "◇" : "◌", working, "thinking", "now");
      content.push("");
    }
    // Tasks as a plain checklist, without record IDs or criteria.
    const ledger = Array.isArray(state.ledger?.tasks) ? state.ledger!.tasks.filter((item) => item && typeof item.title === "string") : [];
    const tasks = driveTaskList(state);
    if (tasks.length) {
      heading("TASKS");
      for (const item of tasks) content.push(paint.text(truncateText(`${item.mark} ${item.text}`, inner), item.tone));
      content.push("");
    }
    // One line of numbers: step, time, tokens, and who planned the last step.
    const used = state.protection?.used;
    const planner = trace?.source === "controller" ? "Local controller" : (state.model ?? "").split("/").at(-1)?.trim() || "";
    add([`step ${state.step}`, used ? minutes(used.activeMs) : "", used ? `${formatTokenCount(used.planningTokens + used.workerTokens)} tokens` : "", planner,
      state.recovery ? `attempt ${state.recovery.attempt} of ${state.recovery.limit}` : "",
      state.protection && lastAction(state).kind === "redirect" ? `redirect ${state.protection.used.redirects} of ${state.protection.limits.maxRedirects}` : ""]
      .filter(Boolean).join(" · "), "muted");
    // Everything long stays folded until asked for.
    const open = options.sections?.has("details") ?? false;
    control(paint.text(`${open ? "▾" : "▸"} Details`, "secondary"), { kind: "drive-section-toggle", section: "details" });
    if (open) {
      content.push("");
      if (state.answer) { heading("ANSWER"); add(state.answer, "paper"); content.push(""); }
      else if (clipped) { heading("NOTE"); add(card.reason, "paper"); content.push(""); }
      heading("REASONING");
      const settled = (state.traces ?? []).filter((item) => !traceActive(item));
      if (!settled.length && !(trace && traceActive(trace))) add("No finished steps yet.", "muted");
      for (const item of settled.slice(-6)) {
        const rendered = driveTraceLines(item, inner, paint, !options.collapsed?.has(item.id), at);
        if (item.source !== "controller") controls.push({ row: content.length + rendered.thinkingRow, column: 0, width: inner, action: { kind: "drive-trace-toggle", id: item.id } });
        content.push(...rendered.rows, "");
      }
      // While Drive plans, its live stream follows the finished steps.
      if (trace && traceActive(trace)) {
        const rendered = driveTraceLines(trace, inner, paint, !options.collapsed?.has(trace.id), at);
        if (trace.source !== "controller") controls.push({ row: content.length + rendered.thinkingRow, column: 0, width: inner, action: { kind: "drive-trace-toggle", id: trace.id } });
        streamLabel = content.length;
        content.push(paint.text(`${driveTraceLabel(trace)} · step ${trace.step}`, "thinking"));
        content.push(...rendered.rows.slice(2));
        if (!options.follow) controls.push({ row: content.length, column: 0, width: 13, action: { kind: "drive-follow" } }), content.push(paint.text("↓ Follow live", "electric"));
        content.push("");
      }
      if (trace && (trace.text || trace.action || trace.result)) {
        heading("OUTPUT");
        if (trace.text) add(trace.text, "paper");
        if (trace.action) add(trace.action, "secondary");
        if (trace.result) add(trace.result, trace.status === "failed" ? "signal" : "muted");
        content.push("");
      }
      heading("MISSION"); add(state.mission, "paper");
      add(state.mode === "continuous" ? "Continuous: finishes each task, chooses worthwhile next work, then goes idle." : "Bounded: finishes after one verified task.", "muted");
      if (state.notes) { content.push(""); heading("NOTES"); add(state.notes); }
      if (state.evidence.length) { content.push(""); heading("EVIDENCE"); for (const item of state.evidence.slice(-5)) add(`“${item.quote}”`); }
      if (state.protection) {
        const { used: spent, limits, migrated } = state.protection;
        content.push(""); heading("BUDGET");
        add(`${Math.floor(spent.activeMs / 60_000)}/${limits.maxActiveMinutes} active min · ${spent.cycles}/${limits.maxCycles} cycles`);
        add(`${spent.tasks}/${limits.maxTasks} tasks · ${spent.workerRequests}/${limits.maxWorkerRequests} coder requests`);
        add(`${spent.checkIns}/${limits.maxCheckIns} check-ins · ${spent.redirects}/${limits.maxRedirects} redirects`, "muted");
        add(`${(spent.planningTokens + spent.workerTokens).toLocaleString()}/${limits.maxTokens.toLocaleString()} tokens`, "muted");
        if (migrated) add("Earlier mission usage is only partially available.", "muted");
      }
      if (ledger.some((item) => item.status === "completed")) { content.push(""); add("Reopen a finished task: /drive reopen <task-id> <reason>", "muted"); for (const item of ledger.filter((entry) => entry.status === "completed").slice(-4)) add(`${item.id.slice(0, 8)} · ${item.title}`, "muted"); }
    }
    if (active) footerHints.push({ key: "P", label: "pause", action: { kind: "drive-control", control: "pause" } });
    else if (resumable) footerHints.push({ key: "P", label: "resume", action: { kind: "drive-control", control: "resume" } });
    if (!["stopped", "completed"].includes(live.status) && !live.protection?.trip) footerHints.push({ key: "S", label: "stop", action: { kind: "drive-control", control: "stop" } });
  } else {
    add("Give Drive a mission", "paper"); add(""); add("/drive <what you want finished>", "electric"); add("");
    add("Drive directs the coding agent through your workbench, reviews what it did, and keeps choosing worthwhile next work until nothing is left.");
    add(""); add("Typing in the composer pauses Drive. Tool approvals stay yours.", "muted");
  }
  footerHints.push({ key: "Alt+J", label: "hide", action: { kind: "drive-open" } });
  const top = 2, room = Math.max(0, height - top - footer);
  const maximum = Math.max(0, content.length - room);
  const streaming = !!state?.traces?.length && traceActive(state.traces.at(-1)!) && (options.sections?.has("details") ?? false);
  offset = options.follow && streaming ? Math.min(maximum, options.followStep === undefined ? maximum : offset + options.followStep) : Math.max(0, Math.min(offset, maximum));
  for (let row = 0; row < room; row++) canvas.put(top + row, 1, content[offset + row] ?? "", inner, "surface");
  // A long live stream keeps its label pinned at the top as it scrolls.
  if (streamLabel >= 0 && streamLabel < offset && room > 1) canvas.put(top, 1, content[streamLabel]!, inner, "surface");
  for (const item of controls) if (item.row >= offset && item.row < offset + room)
    zones.push({ row: top + item.row - offset, column: 1 + item.column, width: Math.min(item.width, inner - item.column), action: item.action });
  if (footer) {
    // The keycap footer: P pause or resume, S stop, Alt+J hide; each is clickable.
    let column = 1, text = "";
    for (const hint of footerHints) {
      const part = `${keycap(paint, hint.key)} ${paint.text(hint.label, "muted")}`;
      if (column + visibleLength(part) > width - 1) break;
      if (hint.action) zones.push({ row: height - 1, column, width: visibleLength(part), action: hint.action });
      text += (text ? "  " : "") + part; column += visibleLength(part) + 2;
    }
    canvas.put(height - 1, 1, formatFooterLine(text, "", inner), inner, "surface");
  }
  return { rows: canvas.rows, zones, offset, maximum };
}
