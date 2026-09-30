import { sanitizeTerminalLine, truncateText, visibleLength, type Painter, type PaletteColor, type PresenceState } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import { clockLabel, tint } from "./interaction.ts";

/// The redesign header: `demesne · title · workspace` on the left and
/// `⎇ branch · status · clock +elapsed · history` on the right. Idle and finished
/// sessions show no status pill. Narrow terminals drop the branch first, then
/// the clock and the title; the workspace path is a click target (project
/// folder) and stays longest, with brand, status and history.
const STATUS: Partial<Record<PresenceState, { label: string; tone: PaletteColor; surface: PaletteColor }>> = {
  listening: { label: "running", tone: "citron", surface: "diffAddedSurface" },
  thinking: { label: "running", tone: "citron", surface: "diffAddedSurface" },
  reasoning: { label: "running", tone: "citron", surface: "diffAddedSurface" },
  working: { label: "running", tone: "citron", surface: "diffAddedSurface" },
  writing: { label: "running", tone: "citron", surface: "diffAddedSurface" },
  verifying: { label: "running", tone: "citron", surface: "diffAddedSurface" },
  waiting: { label: "approval", tone: "thinking", surface: "thinkingSurface" },
  stopped: { label: "stopped", tone: "secondary", surface: "raised" },
  error: { label: "failed", tone: "signal", surface: "errorSurface" },
};

interface Part { key: string; text: string; width: number }

export function sessionHeader(options: { width: number; paint: Painter; path: string; now: number; openedAt: number;
  createdAt?: number; accent: boolean; pointer?: { row: number; column: number } | null; historyActive?: boolean;
  title?: string; branch?: string | null; presence?: PresenceState;
  /// What the waiting pill says: "approval" by default, "question" for `ask_user`.
  waitingLabel?: string }) {
  const { width, paint, now } = options;
  const row = options.accent ? 1 : 0;
  const canvas = new Canvas(width, row + 1, paint);
  const inset = width >= 65 ? 2 : 1;
  for (let y = 0; y <= row; y++) canvas.put(y, 0, "", width, "surface");
  if (options.accent) canvas.put(0, 0, tint(paint, "─".repeat(width), "surface", "rule", 1), width, "surface");

  const part = (key: string, text: string): Part => ({ key, text, width: visibleLength(text) });
  const title = sanitizeTerminalLine(options.title ?? "").trim();
  const safePath = sanitizeTerminalLine(options.path);
  const basename = safePath.split(/[\\/]/).filter(Boolean).at(-1) ?? safePath;
  const pathLabel = (room: number) => visibleLength(safePath) <= room ? safePath : visibleLength(basename) + 2 <= room ? `…/${basename}` : "";
  const known = options.presence ? STATUS[options.presence] : undefined;
  const status = known && options.presence === "waiting" && options.waitingLabel ? { ...known, label: options.waitingLabel } : known;
  const hoveredHistory = (column: number) => options.pointer?.row === row && options.pointer.column >= column;
  const branch = options.branch ? sanitizeTerminalLine(options.branch) : "";

  // Try the fullest header first, then drop optional fields in order.
  const plans: Array<{ title: boolean; path: boolean; branch: boolean; clock: boolean }> = [
    { title: true, path: true, branch: true, clock: true },
    { title: true, path: true, branch: false, clock: true },
    { title: true, path: true, branch: false, clock: false },
    { title: false, path: true, branch: false, clock: false },
    { title: false, path: false, branch: false, clock: false },
  ];
  const seconds = Math.max(0, Math.floor((now - options.openedAt) / 1000));
  const elapsed = `+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const history = width >= 40 ? "history" : "H";
  const gap = 3;
  for (const plan of plans) {
    const right: Part[] = [];
    if (plan.branch && branch) right.push(part("branch", paint.text(`⎇ ${branch}`, "secondary")));
    if (status) right.push(part("status", paint.wash(` ${status.label} `, status.surface, status.tone)));
    if (plan.clock) right.push(part("clock", paint.text(clockLabel(now), "secondary") + " " + paint.text(elapsed, "muted")));
    right.push(part("history", history));
    const rightWidth = right.reduce((sum, item) => sum + item.width, 0) + (right.length - 1) * 2;
    const leftRoom = width - inset * 2 - rightWidth - gap;
    const brand = part("brand", paint.bold("demesne", "electric"));
    const left: Part[] = [brand];
    let used = brand.width;
    if (plan.title && title) {
      const room = Math.min(40, leftRoom - used - 2);
      if (room >= 6) { const text = truncateText(title, room); left.push(part("title", paint.text(text, "paper"))); used += visibleLength(text) + 2; }
      else if (plan.title) continue;
    }
    let pathSpan = { column: 0, width: 0 };
    if (plan.path) {
      const label = pathLabel(Math.min(32, leftRoom - used - 2));
      if (!label) continue;
      const slash = Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\")) + 1;
      pathSpan = { column: inset + used + 2, width: visibleLength(label) };
      left.push(part("path", paint.text(label.slice(0, slash), "muted") + paint.text(label.slice(slash), "secondary")));
      used += visibleLength(label) + 2;
    }
    if (used > leftRoom) continue;

    canvas.put(row, inset, left.map((item) => item.text).join("  "), used, "surface");
    let column = width - inset - rightWidth;
    let historySpan = { column: 0, width: 0 };
    for (const item of right) {
      if (item.key === "history") {
        historySpan = { column, width: item.width };
        const active = hoveredHistory(column) && (options.pointer?.column ?? -1) < column + item.width || options.historyActive;
        canvas.put(row, column, paint.text(item.text, active ? "electric" : "secondary"), item.width, "surface");
      } else canvas.put(row, column, item.text, item.width, "surface");
      column += item.width + 2;
    }
    return { rows: canvas.rows, row, history: historySpan, path: pathSpan };
  }
  canvas.put(row, inset, paint.bold("demesne", "electric"), width - inset, "surface");
  return { rows: canvas.rows, row, history: { column: 0, width: 0 }, path: { column: 0, width: 0 } };
}
