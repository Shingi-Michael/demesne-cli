import type { DriveStep } from "@demesne/protocol";

/// Shared by the terminal and graphics Drive panels, so both describe a step
/// the same way. Dependency-free so the graphics renderer can bundle it.
export type DriveStepTone = "electric" | "secondary" | "muted" | "citron" | "thinking" | "signal" | "paper";

const words = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const read: Record<string, string> = { answer: "answer", diff: "changes", checks: "checks", log: "log" };

/// One timeline entry for a recorded step: what Drive did, in a few words.
export function driveStepLine(step: DriveStep): { mark: string; text: string; tone: DriveStepTone } {
  let action: { kind?: string; text?: string; task?: string; target?: string; key?: string; basis?: string } = {};
  try { action = JSON.parse(step.action) as typeof action; } catch { /* a step from an older journal */ }
  const line = (mark: string, text: string, tone: DriveStepTone) => ({ mark, text, tone });
  const entry = action.kind === "compose" ? line("→", `Sent: ${words(action.text)}`, "electric")
    : action.kind === "inspect" ? line("◇", `Read the coder's ${read[action.target ?? ""] ?? "output"}`, "secondary")
    : action.kind === "key" ? line("·", `Pressed ${words(action.key)}`, "muted")
    : action.kind === "click" ? line("·", "Clicked a control", "muted")
    : action.kind === "scroll" ? line("·", "Scrolled", "muted")
    : action.kind === "wait" ? line("◌", "Waited", "muted")
    : action.kind === "keep_working" ? line("✓", "Checked in: on track", "citron")
    : action.kind === "redirect" ? line("↻", `Redirected: ${words(action.text)}`, "thinking")
    : action.kind === "next_task" ? line("→", `Next task: ${words(action.task)}`, "electric")
    : action.kind === "set_criteria" ? line("·", "Set the task's criteria", "muted")
    : action.kind === "reopen_task" ? line("↻", "Reopened a task", "thinking")
    : action.kind === "complete" ? line("✓", action.basis === "answer" ? "Answered" : "Finished the task", "citron")
    : action.kind === "blocked" ? line("×", "Stopped: needs you", "signal")
    : action.kind === "idle" ? line("·", "Nothing worthwhile left", "secondary")
    : line("·", words(step.note) || "Step", "muted");
  // A step that found the screen changed did nothing; it is tried again.
  return /^(UI changed|Control moved|Input changed|Scroll did not move)/.test(step.result)
    ? line("·", `${entry.text} (screen changed)`, "muted") : entry;
}

/// `now`, `40s`, `3m`, `2h`: how long ago a timeline step happened.
export function driveSince(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 5 ? "now" : seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
}

/// The mission's tasks as a plain checklist: finished, current, then still
/// to do. No record IDs or criteria (those stay under Details), and a task
/// named twice (ledger and planner list) appears once.
export function driveTaskList(state: Pick<import("@demesne/protocol").DriveState, "ledger" | "autonomy" | "completed" | "remaining" | "status">):
  { mark: string; text: string; tone: DriveStepTone }[] {
  const tasks: { mark: string; text: string; tone: DriveStepTone }[] = [];
  const seen = new Set<string>();
  const task = (mark: string, text: string | undefined, tone: DriveStepTone) => {
    const key = words(text).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key); tasks.push({ mark, text: words(text), tone });
  };
  const ledger = Array.isArray(state.ledger?.tasks) ? state.ledger!.tasks.filter((item) => item && typeof item.title === "string") : [];
  for (const item of ledger) task(item.status === "completed" ? "✓" : item.id === state.ledger!.currentTaskId ? "◌" : "·", item.title, item.status === "completed" ? "secondary" : "paper");
  for (const item of state.autonomy?.history.map((entry) => entry.task) ?? state.completed) task("✓", item, "secondary");
  task("◌", state.autonomy?.task, "paper");
  if (state.status !== "completed") for (const item of state.remaining) task("·", item, "muted");
  return tasks.slice(-6);
}
