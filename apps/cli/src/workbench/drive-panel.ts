import { formatFooterLine, formatTokenCount, sanitizeTerminalLine, visibleLength, wrapDisplayText, type Painter, type PaletteColor } from "@demesne/brand";
import type { DriveState, DriveTrace } from "@demesne/protocol";
import type { DriveControl } from "../agent-drive.ts";
import { traceActive } from "../drive-trace.ts";
import { Canvas } from "./canvas.ts";
import { driveTraceLabel, driveTraceLines } from "./drive-trace-view.ts";
import { keycap } from "./session-chrome.ts";
import { surface } from "./surface.ts";

export type DriveSection = "reasoning" | "raw" | "constraints";
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

const ago = (iso: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 90 ? `${seconds}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
};
const minutes = (ms: number): string => ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.round(ms % 3_600_000 / 60_000)}m`;

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
  const control = (text: string, action: DrivePanelAction, column = 0) => { controls.push({ row: content.length, column, width: visibleLength(text), action }); content.push(text); };
  const footer = height >= 4 ? 1 : 0;
  const footerHints: { key: string; label: string; action?: DrivePanelAction }[] = [];
  let streamLabel = -1;
  if (state) {
    const live = state;
    // The body can be held for reading; controls and the footer stay current.
    state = options.snapshot?.state ?? state;
    const trace = state.traces?.at(-1);
    const card = verdict(state, trace, options.snapshot?.now ?? now);
    const cardWidth = inner;
    content.push(paint.text(`╭${"─".repeat(Math.max(0, cardWidth - 2))}╮`, card.tone));
    const cardRow = (text: string) => content.push(paint.text("│", card.tone) + surface(` ${text}`, Math.max(0, cardWidth - 2), paint, card.surface) + paint.text("│", card.tone));
    cardRow(paint.text(`${card.mark} ${card.label}`, card.tone));
    for (const line of wrapDisplayText(sanitizeTerminalLine(card.reason || " "), Math.max(1, cardWidth - 4))) cardRow(paint.text(line, card.reasonTone ?? "paper"));
    content.push(paint.text(`╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`, card.tone));
    // Resume and Stop buttons where Drive is holding for you.
    const resumable = !live.protection?.trip && (["paused", "blocked", "stopped", "idle"].includes(live.status));
    const active = live.status === "running" || live.status === "waiting";
    if (resumable) {
      const resume = paint.wash(" p  Resume ", "diffAddedSurface", "citron"), stop = paint.wash(" s  Stop ", "raised", "paper");
      controls.push({ row: content.length, column: 0, width: visibleLength(resume), action: { kind: "drive-control", control: "resume" } });
      if (!["stopped", "completed"].includes(live.status)) controls.push({ row: content.length, column: visibleLength(resume) + 2, width: visibleLength(stop), action: { kind: "drive-control", control: "stop" } });
      content.push(resume + (["stopped", "completed"].includes(live.status) ? "" : "  " + stop));
    }
    content.push("");
    // Tasks while working through a mission; a summary once it is complete.
    const finished = state.autonomy?.history.map((item) => item.task) ?? state.completed;
    if (state.status === "completed") {
      add("SUMMARY", "muted");
      const used = state.protection?.used;
      const row = (label: string, value: string, tone: PaletteColor = "paper") => content.push(paint.text(label.padEnd(10), "muted") + paint.text(value, tone));
      if (finished.length) row("tasks", `${finished.length} done`, "citron");
      row("steps", String(state.step));
      if (used) { row("time", minutes(used.activeMs)); row("tokens", formatTokenCount(used.planningTokens + used.workerTokens)); }
      content.push("");
    } else if (!state.ledger && (finished.length || state.autonomy?.task || state.remaining.length)) {
      add("TASKS", "muted");
      for (const item of finished.slice(-4)) add(`✓ ${item}`, "secondary");
      if (state.autonomy?.task) add(`◌ ${state.autonomy.task}`, "paper");
      for (const item of state.remaining.slice(0, 4)) add(`· ${item}`, "muted");
      content.push("");
    }
    add(state.mode === "continuous" ? "Continuous · select unfinished work, then idle" : "Bounded · finish after verification", "muted");
    if (Array.isArray(state.ledger?.tasks)) {
      for (const task of state.ledger!.tasks.filter(task=>task && typeof task.id === "string" && Array.isArray(task.criteria) && Array.isArray(task.completions)).slice(-6)) {
        add(`${task.status === "completed" ? "✓" : "◌"} ${task.id.slice(0,8)} · ${task.title}`, "secondary");
        if (task.id === state.ledger!.currentTaskId) {
          for (const criterion of task.criteria) add(`  · ${criterion}`, "muted");
          if (task.reopened) add(`Reopened: ${task.reopened.reason}`, "thinking");
          const completion=task.completions.at(-1);
          if (completion) add(`Recorded ${completion.files.length} files · ${completion.checks.length} checks · ${completion.turnId?.slice(0,8) ?? "legacy record"}`, "muted");
        }
      }
      if (state.ledger!.tasks.some(task=>task.status === "completed")) add("Reopen: /drive reopen <task-id> <reason>", "muted");
      content.push("");
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
      content.push("");
    }
    // Step and time, then who planned it and what it used.
    const meta = [`Step ${state.step}`, state.protection && lastAction(state).kind === "redirect" ? `redirect ${state.protection.used.redirects} of ${state.protection.limits.maxRedirects}` : "",
      state.recovery ? `attempt ${state.recovery.attempt} of ${state.recovery.limit}` : "", ago(state.updatedAt, options.snapshot?.now ?? now)].filter(Boolean).join(" · ");
    add(meta, "muted");
    const planner = trace?.source === "controller" ? "Local controller" : state.model ?? "Selected model";
    add([planner, state.protection ? `${state.protection.used.planningTokens.toLocaleString()} tokens` : ""].filter(Boolean).join(" · "), "muted");
    content.push("");
    // Details stay folded until asked for.
    const open = options.sections ?? new Set<DriveSection>();
    const section = (name: DriveSection, label: string, body: () => void) => {
      control(paint.text(`${open.has(name) ? "▾" : "▸"} ${label}`, "secondary"), { kind: "drive-section-toggle", section: name });
      if (open.has(name)) { body(); content.push(""); }
    };
    section("reasoning", "Show reasoning", () => {
      const settled = (state!.traces ?? []).filter((item) => !traceActive(item));
      if (!settled.length) add("No finished steps yet.", "muted");
      for (const item of settled.slice(-6)) {
        const rendered = driveTraceLines(item, inner, paint, !options.collapsed?.has(item.id), options.snapshot?.now ?? now);
        if (item.source !== "controller") controls.push({ row: content.length + rendered.thinkingRow, column: 0, width: inner, action: { kind: "drive-trace-toggle", id: item.id } });
        content.push(...rendered.rows, "");
      }
    });
    section("raw", "Raw output", () => {
      if (!trace) { add("No model output yet.", "muted"); return; }
      if (trace.text) add(trace.text, "paper");
      if (trace.action) add(trace.action, "secondary");
      if (trace.result) add(trace.result, trace.status === "failed" ? "signal" : "muted");
      if (!trace.text && !trace.action && !trace.result) add("The model returned no text.", "muted");
    });
    section("constraints", "Constraints carried", () => {
      add("MISSION", "muted"); add(state!.mission, "paper");
      if (state!.notes) { add("NOTES", "muted"); add(state!.notes); }
      if (state!.evidence.length) { add("EVIDENCE", "muted"); for (const item of state!.evidence.slice(-5)) add(`“${item.quote}”`); }
      if (state!.protection) {
        const { used, limits, migrated } = state!.protection;
        add("BUDGET", "muted");
        add(`${Math.floor(used.activeMs / 60_000)}/${limits.maxActiveMinutes} active min · ${used.cycles}/${limits.maxCycles} cycles`);
        add(`${used.tasks}/${limits.maxTasks} tasks · ${used.workerRequests}/${limits.maxWorkerRequests} coder requests`);
        add(`${used.checkIns}/${limits.maxCheckIns} check-ins · ${used.redirects}/${limits.maxRedirects} redirects`, "muted");
        add(`${(used.planningTokens + used.workerTokens).toLocaleString()}/${limits.maxTokens.toLocaleString()} tokens`, "muted");
        if (migrated) add("Earlier mission usage is only partially available.", "muted");
      }
    });
    // While Drive plans, its live stream follows below the details.
    if (trace && traceActive(trace)) {
      content.push("");
      const rendered = driveTraceLines(trace, inner, paint, !options.collapsed?.has(trace.id), options.snapshot?.now ?? now);
      if (trace.source !== "controller") controls.push({ row: content.length + rendered.thinkingRow, column: 0, width: inner, action: { kind: "drive-trace-toggle", id: trace.id } });
      streamLabel = content.length;
      content.push(paint.text(`${driveTraceLabel(trace)} · step ${trace.step}`, "thinking"));
      content.push(...rendered.rows.slice(2));
      if (!options.follow) controls.push({ row: content.length, column: 0, width: 13, action: { kind: "drive-follow" } }), content.push(paint.text("↓ Follow live", "electric"));
    }
    if (active) footerHints.push({ key: "P", label: "pause", action: { kind: "drive-control", control: "pause" } });
    else if (resumable) footerHints.push({ key: "P", label: "resume", action: { kind: "drive-control", control: "resume" } });
    if (!["stopped", "completed"].includes(live.status) && !live.protection?.trip) footerHints.push({ key: "S", label: "stop", action: { kind: "drive-control", control: "stop" } });
  } else {
    add("Give Drive a mission", "paper"); add(""); add("/drive <what you want finished>", "electric"); add("");
    add("Drive reads history, directs coding work, reviews results, then asks the coding agent about useful next improvements and continues.");
    add(""); add("Your input pauses Drive. Existing tool approvals remain yours.", "muted");
  }
  footerHints.push({ key: "Alt+J", label: "hide", action: { kind: "drive-open" } });
  const top = 2, room = Math.max(0, height - top - footer);
  const maximum = Math.max(0, content.length - room);
  const streaming = !!state?.traces?.length && traceActive(state.traces.at(-1)!);
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

