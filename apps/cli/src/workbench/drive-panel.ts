import { sanitizeTerminalLine, wrapDisplayText, type Painter } from "@demesne/brand";
import type { DriveState } from "@demesne/protocol";
import type { DriveControl } from "../agent-drive.ts";
import { Canvas } from "./canvas.ts";
import { driveActivityLabel, driveTraceLines } from "./drive-trace-view.ts";

export type DrivePanelAction = { kind: "drive-open" } | { kind: "drive-control"; control: DriveControl }
  | { kind: "drive-follow" } | { kind: "drive-trace-toggle"; id: string };
export function renderDrivePanel(width: number, height: number, paint: Painter, state: DriveState | null, offset: number,
  options: { follow?: boolean; followStep?: number; snapshot?: { state: DriveState; now: number }; collapsed?: ReadonlySet<string>; now?: number } = {}) {
  const canvas = new Canvas(width, height, paint);
  const zones: { row: number; column: number; width: number; action: DrivePanelAction }[] = [];
  const content: string[] = [];
  const controls: { row: number; action: DrivePanelAction }[] = [];
  const add = (text: string, tone: "paper" | "muted" | "secondary" | "electric" | "citron" = "secondary") => {
    for (const line of text.split("\n")) content.push(...wrapDisplayText(sanitizeTerminalLine(line), Math.max(1, width - 2)).map((row) => paint.text(row, tone)));
  };
  if (state) {
    const active = state.status === "running" || state.status === "waiting";
    let column = 1;
    const button = (label: string, control: DriveControl) => {
      canvas.put(2, column, paint.text(label, control === "stop" ? "signal" : "electric"), label.length, "surface");
      zones.push({ row: 2, column, width: label.length, action: { kind: "drive-control", control } }); column += label.length + 3;
    };
    if (active) button("Pause", "pause");
    else if (!state.protection?.trip && (state.status === "paused" || state.status === "blocked" || state.status === "stopped" || state.status === "idle" || state.status === "completed" && state.autonomy)) button("Resume", "resume");
    if (!["stopped", "completed"].includes(state.status)) button("Stop", "stop");
    if (state.traces?.length) {
      const label = options.follow ? "LIVE" : "Live";
      canvas.put(2, Math.max(column, width - 6), paint.text(label, "electric"), 4, "surface");
      if (width >= column + 4) zones.push({ row: 2, column: Math.max(column, width - 6), width: 4, action: { kind: "drive-follow" } });
      const trace = state.traces.at(-1)!;
      canvas.put(3, 1, paint.text(`Step ${trace.step} · ${driveActivityLabel(state, trace)}`, "thinking"), width - 2, "surface");
    }
    // Pinned controls/status stay live while the scrollable body is held for reading.
    state = options.snapshot?.state ?? state;
    add(`${state.status.toUpperCase()} · step ${state.step}`, "electric");
    add(state.activity, "paper"); add("");
    if (state.protection) {
      const { used, limits, trip, migrated } = state.protection;
      add(trip ? "PROTECTION STOP" : "MISSION BUDGET", "electric");
      add(`${Math.floor(used.activeMs / 60_000)}/${limits.maxActiveMinutes} active min · ${used.cycles}/${limits.maxCycles} cycles`);
      add(`${used.tasks}/${limits.maxTasks} tasks · ${used.workerRequests}/${limits.maxWorkerRequests} worker requests`);
      add(`${used.checkIns}/${limits.maxCheckIns} check-ins · ${used.redirects}/${limits.maxRedirects} corrections`, "muted");
      add(`${(used.planningTokens + used.workerTokens).toLocaleString()}/${limits.maxTokens.toLocaleString()} accounted tokens`, "muted");
      add("Planning + tracked worker usage; estimates until usage receipts arrive.", "muted");
      if (migrated) add("Earlier mission usage is only partially available.", "muted");
      if (trip) add("Start /drive <revised mission> deliberately; Resume cannot clear this stop.", "paper");
      add("");
    }
    add("MISSION", "electric"); add(state.mission, "paper"); add("");
    if (state.autonomy) {
      add(state.autonomy.phase === "discovering" ? "FINDING NEXT WORK" : `CURRENT TASK · ${state.autonomy.cycle}`, "electric");
      add(state.autonomy.task, "paper"); add("");
      if (state.autonomy.history.length) { add("FINISHED TASKS", "citron"); for (const item of state.autonomy.history.slice(-3)) { add(`✓ ${item.task}`); add(item.summary, "muted"); } add(""); }
    }
    if (state.completed.length) { add("COMPLETED", "citron"); for (const item of state.completed) add(`✓ ${item}`); add(""); }
    if (state.remaining.length) { add("REMAINING", "electric"); for (const item of state.remaining) add(`· ${item}`); add(""); }
    if (state.notes) { add("WORKING NOTES", "electric"); add(state.notes); add(""); }
    if (state.evidence.length) { add("REVIEWED EVIDENCE", "electric"); for (const item of state.evidence.slice(-5)) add(`“${item.quote}”`); add(""); }
    if (state.steps.length) { add("RECENT ACTIONS", "electric"); for (const step of state.steps.slice(-8).reverse()) { add(`${step.step}. ${step.note}`); add(step.result, "muted"); } add(""); }
    if (state.model) add(state.model, "muted");
    add("Pause holds Drive; Stop also interrupts the current coding turn.", "muted");
    for (const trace of state.traces ?? []) {
      add("");
      const rendered = driveTraceLines(trace, Math.max(1, width - 2), paint, !options.collapsed?.has(trace.id), options.snapshot?.now ?? options.now);
      if (trace.source !== "controller") controls.push({ row: content.length + rendered.thinkingRow, action: { kind: "drive-trace-toggle", id: trace.id } });
      for (const row of rendered.rows) content.push(row);
    }
  } else {
    add("Give Drive a mission", "paper"); add(""); add("/drive <what you want finished>", "electric"); add("");
    add("Drive reads history, directs coding work, reviews results, then asks the coding agent about useful next improvements and continues.");
    add(""); add("Your input pauses Drive. Existing tool approvals remain yours.", "muted");
  }
  const top = 4, room = Math.max(0, height - top);
  const maximum = Math.max(0, content.length - room);
  offset = options.follow && state?.traces?.length ? Math.min(maximum, options.followStep === undefined ? maximum : offset + options.followStep) : Math.max(0, Math.min(offset, maximum));
  for (let row = 0; row < room; row++) canvas.put(top + row, 1, content[offset + row] ?? "", width - 2, "surface");
  for (const control of controls) if (control.row >= offset && control.row < offset + room)
    zones.push({ row: top + control.row - offset, column: 1, width: width - 2, action: control.action });
  return { rows: canvas.rows, zones, offset, maximum };
}
