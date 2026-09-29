import { formatFooterLine, formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, wrapDisplayText, type Painter, type PaletteColor } from "@demesne/brand";
import { sliceAnsi } from "bun";
import type { RecentSession } from "../recent-sessions.ts";
import type { ContextReceipt } from "./entries.ts";
import type { Rect } from "./layout.ts";
import { Canvas } from "./canvas.ts";
import { clockLabel, InteractionTransitions, tint } from "./interaction.ts";
import { contextLabel } from "./session-chrome.ts";
import { sessionHeader } from "./session-header.ts";

export const START_OPERATIONS = [
  { tag: "EXPLORE", label: "Explore", title: "Trace a call flow", description: "Follow execution from entry point through the full stack", tone: "electric",
    prompt: "Trace the call flow from the main entry point and map out how requests move through the system." },
  { tag: "DEBUG", label: "Debug", title: "Find and fix a bug", description: "Diagnose an error or unexpected behavior and patch it", tone: "signal",
    prompt: "Help me diagnose and fix a bug. Ask me about the error or unexpected behavior, then investigate and verify the fix." },
  { tag: "BUILD", label: "Build", title: "Write a new feature", description: "Implement something new end-to-end with tests", tone: "citron",
    prompt: "Help me implement a new feature end-to-end. Ask what I want to build, then inspect the project and add the appropriate verification." },
  { tag: "LEARN", label: "Learn", title: "Explain this codebase", description: "Get a map of the architecture and key entry points", tone: "thinking",
    prompt: "Explain this codebase: map the architecture, key entry points, and how its main components work together." },
] as const;

export type StartAction = { kind: "operation"; index: number } | { kind: "session"; id: string }
  | { kind: "history" | "settings" | "workspace" | "context" | "model" | "commands" | "files" | "live" | "panel" };
export interface StartZone extends Rect { key: string; action: StartAction }
export interface StartLayout {
  input: Rect; label: number; metadata: number; shortcuts: number | null;
  operations: Rect; columns: number; cardHeight: number; cardOffset: number; recent: Rect; feedback: number | null;
}

export function startScreenLayout(width: number, height: number, requestedHeight: number, feedback: boolean): StartLayout {
  const inset = width >= 65 ? 2 : 1;
  const contentWidth = Math.min(96, width - inset * 2);
  const column = Math.floor((width - contentWidth) / 2);
  const header = height >= 14 ? 2 : 1;
  const recentHeight = height >= 18 ? 3 : 1;
  const recent = { row: height - recentHeight, column: 0, width, height: recentHeight };
  const available = recent.row - header - Number(feedback);
  const inputHeight = Math.min(Math.max(height >= 18 ? 5 : 3, requestedHeight), Math.max(3, available - 3));
  // The redesign's "Start from" grid: one line per operation, two columns
  // where they fit, with a small section label when there is room for it.
  const columns = contentWidth >= 64 ? 2 : 1;
  const operationRows = START_OPERATIONS.length / columns;
  const remaining = available - inputHeight - 3;
  const cardHeight = remaining >= operationRows ? 1 : 0;
  const cardOffset = cardHeight && remaining >= operationRows + 2 ? 2 : cardHeight && remaining >= operationRows + 1 ? 1 : 0;
  const operationHeight = cardHeight ? cardOffset + operationRows : remaining >= 1 ? 1 : 0;
  const groupHeight = inputHeight + 3 + operationHeight;
  const top = header + Math.max(0, Math.floor((available - groupHeight) / 2));
  const input = { row: top + 1, column, width: contentWidth, height: inputHeight };
  return { input, label: top, metadata: input.row + input.height, shortcuts: input.row + input.height + 1,
    operations: { row: input.row + input.height + 2, column, width: contentWidth, height: operationHeight }, columns, cardHeight, cardOffset, recent,
    feedback: feedback ? recent.row - 1 : null };
}

const actionKey = (action: StartAction): string => action.kind === "operation" ? `operation:${action.index}` : action.kind === "session" ? `session:${action.id}` : action.kind;
const safe = sanitizeTerminalLine;

/// Start-screen navigation and hover use the same editor and command routing as
/// the conversation. Only its geometry and empty-session actions are different.
export class StartScreen {
  private zones: StartZone[] = [];
  private controls: StartZone[] = [];
  private selected: string | null = null;
  private hovered: string | null = null;
  private pointer: { row: number; column: number } | null = null;
  private enteredAt: number | null = null;
  private reflow = false;
  private readonly transitions = new InteractionTransitions();

  reset(): void { this.zones = []; this.controls = []; this.selected = null; this.hovered = null; this.pointer = null; this.enteredAt = null; this.transitions.clear(); this.reflow = false; }
  reveal(stage: number, now: number, animate: boolean): number {
    if (!animate) return 1;
    this.enteredAt ??= now;
    const t = Math.max(0, Math.min(1, (now - this.enteredAt - stage * 80) / 240));
    return 1 - (1 - t) ** 3;
  }
  animating(now: number, animate: boolean): boolean {
    return this.reflow || animate && (this.enteredAt !== null && now < this.enteredAt + 640 || this.transitions.active(now));
  }
  hover(row: number, column: number, now = Date.now()): boolean {
    this.pointer = row < 0 ? null : { row, column };
    const key = this.zones.find((zone) => row >= zone.row && row < zone.row + zone.height && column >= zone.column && column < zone.column + zone.width)?.key ?? null;
    if (key === this.hovered) return false;
    if (this.hovered) this.transitions.set(this.hovered, 0, 1, now);
    if (key) this.transitions.set(key, 1, 0, now);
    this.hovered = key;
    return true;
  }
  move(step: number): void {
    const current = this.controls.findIndex((control) => control.key === this.selected);
    const next = current < 0 ? 0 : (current + step + this.controls.length) % this.controls.length;
    this.selected = this.controls[next]?.key ?? null;
  }
  get action(): StartAction | undefined { return (this.controls.find((control) => control.key === this.selected) ?? this.controls[0])?.action; }

  render(options: {
    width: number; height: number; layout: StartLayout; paint: Painter; now: number; animate: boolean; focused: boolean;
    path: string; model: string; context: ContextReceipt; currentId?: string; recent: readonly RecentSession[];
    recentState: "loading" | "ready" | "unavailable"; feedback?: { text: string; tone: string } | null; input: string[];
    openedAt?: number; createdAt?: number;
  }): { rows: string[]; zones: StartZone[] } {
    const { width, height, paint, layout, now, animate } = options;
    const canvas = new Canvas(width, height, paint);
    this.zones = []; this.reflow = false;
    const zone = (rect: Rect, action: StartAction) => {
      if (rect.width > 0 && rect.height > 0) this.zones.push({ ...rect, key: actionKey(action), action });
    };
    const emphasis = (key: string) => options.focused && (this.selected ?? this.controls[0]?.key) === key ? 1
      : this.transitions.value(key, this.hovered === key ? 1 : 0, now, !animate);
    const put = canvas.put.bind(canvas);
    const inset = width >= 65 ? 2 : 1;
    const inner = width - inset * 2;
    const compact = width < 55;
    const header = sessionHeader({ width, paint, path: options.path, now, openedAt: options.openedAt ?? now,
      createdAt: options.createdAt, accent: height >= 14, historyActive: emphasis("history") > 0 });
    header.rows.forEach((text, row) => put(row, 0, text, width, "surface"));
    zone({ row: header.row, column: header.path.column, width: header.path.width, height: 1 }, { kind: "workspace" });
    zone({ row: header.row, column: header.history.column, width: header.history.width, height: 1 }, { kind: "history" });

    const { input } = layout;
    const navigation = options.focused ? "←/→ select · Enter fill · Esc draft" : "Ctrl+T operations · Alt+H history";
    put(layout.label, input.column, formatFooterLine(paint.bold("What are we working on?", "paper"),
      input.width >= 68 ? paint.text(navigation, "muted") : "", input.width), input.width);
    options.input.forEach((line, index) => put(input.row + index, input.column, line, input.width, "surface"));
    const context = `ctx ${contextLabel(options.context)}`;
    const hint = input.width >= 80 ? "↵ send · ⇧↵ newline" : "";
    const modelWidth = Math.max(1, input.width - context.length - (hint ? hint.length + 5 : 3));
    const model = truncateText(`model ${safe(options.model)}`, modelWidth);
    const metadata = `${paint.text(model, "secondary")} · ${paint.text(context, "thinking")}`;
    const modelColumn = input.column + input.width - visibleLength(metadata);
    put(layout.metadata, input.column, formatFooterLine(hint ? paint.text(hint, "muted") : "", metadata, input.width), input.width);
    zone({ row: layout.metadata, column: modelColumn, width: visibleLength(model), height: 1 }, { kind: "model" });
    zone({ row: layout.metadata, column: input.column + input.width - context.length, width: context.length, height: 1 }, { kind: "context" });
    if (layout.shortcuts !== null) {
      let column = input.column;
      const shortcuts: { label: string; action: StartAction }[] = [
        { label: input.width < 60 ? "/ cmds" : "/ commands", action: { kind: "commands" } },
        { label: "@ files", action: { kind: "files" } }, { label: input.width < 40 ? "Tab menu" : "Tab settings", action: { kind: "settings" } },
        { label: input.width < 60 ? "^G live" : "Ctrl+G live", action: { kind: "live" } },
      ];
      for (const item of shortcuts) {
        if (column + item.label.length > input.column + input.width) break;
        put(layout.shortcuts, column, paint.text(item.label, "secondary"), item.label.length);
        zone({ row: layout.shortcuts, column, width: item.label.length, height: 1 }, item.action);
        column += item.label.length + 2;
      }
    }

    const ops = layout.operations;
    if (layout.cardHeight) {
      if (layout.cardOffset) put(ops.row + layout.cardOffset - 1, ops.column, paint.text("START FROM", "muted"), ops.width);
      const gap = 2;
      const cellWidth = Math.floor((ops.width - (layout.columns - 1) * gap) / layout.columns);
      START_OPERATIONS.forEach((operation, index) => {
        const row = ops.row + layout.cardOffset + Math.floor(index / layout.columns);
        const column = ops.column + (index % layout.columns) * (cellWidth + gap);
        const active = emphasis(`operation:${index}`);
        const tone = operation.tone as PaletteColor;
        const selected = options.focused && this.selected === `operation:${index}`;
        const background = active >= 0.5 ? "raised" : "surface";
        const number = tint(paint, `${selected ? "›" : " "}${index + 1}`, "muted", tone, active);
        const name = active >= 0.5 ? paint.bold(operation.label, "paper") : paint.text(operation.label, "paper");
        // Hover says what a click does: it fills the prompt, never sends.
        const hint = active >= 0.5 && cellWidth >= 30 ? "fill ↑" : "";
        const room = cellWidth - 4 - operation.label.length - 3 - (hint ? hint.length + 2 : 0);
        const title = room >= 8 ? "  " + paint.text(truncateText(operation.title, room), "muted") : "";
        put(row, column, "", cellWidth, background);
        put(row, column + 1, `${number}  ${name}${title}`, cellWidth - 1, background);
        if (hint) put(row, column + cellWidth - hint.length - 1, tint(paint, hint, "muted", tone, active), hint.length, background);
        zone({ row, column, width: cellWidth, height: 1 }, { kind: "operation", index });
      });
    } else if (ops.height) {
      let column = ops.column;
      for (const [index, operation] of START_OPERATIONS.entries()) {
        const selected = options.focused && this.selected === `operation:${index}`;
        const label = `${selected ? "›" : ""}${operation.label}`;
        const width = operation.label.length + 2;
        put(ops.row, column, tint(paint, label, "secondary", operation.tone, 0.4 + emphasis(`operation:${index}`) * 0.6), width);
        zone({ row: ops.row, column, width, height: 1 }, { kind: "operation", index });
        column += width;
      }
    }
    if (layout.feedback !== null && options.feedback) put(layout.feedback, input.column, paint.text(safe(options.feedback.text), options.feedback.tone === "error" ? "signal" : "secondary"), input.width);

    const recent = layout.recent;
    const history = recent.height > 1 ? "HISTORY ↓" : "History ↓";
    const titleRow = recent.row + (recent.height > 1 ? 1 : 0);
    for (let row = recent.row; row < height; row++) put(row, 0, "", width, "surface");
    if (recent.height > 1) put(recent.row, 0, paint.text("─".repeat(width), "rule"), width, "surface");
    put(titleRow, inset, paint.text("RECENT", "muted"), 6, "surface");
    put(titleRow, width - inset - history.length, tint(paint, `${options.focused && this.selected === "history" ? "›" : ""}${history}`, "secondary", "electric", emphasis("history")), history.length + 1, "surface");
    zone({ row: titleRow, column: width - inset - history.length, width: history.length, height: 1 }, { kind: "history" });
    const room = width - inset * 2 - 8 - history.length - 1;
    const count = recent.height > 1 ? Math.min(options.recent.length, Math.max(1, Math.floor(room / 18))) : Math.min(1, options.recent.length);
    if (count) {
      const size = Math.floor(room / count);
      options.recent.slice(0, count).forEach((session, index) => {
        const column = inset + 8 + index * size;
        const current = session.id === options.currentId;
        const key = `session:${session.id}`;
        const text = `${options.focused && this.selected === key ? "›" : current ? "▪" : " "} ${safe(session.title)}`;
        put(titleRow, column, tint(paint, truncateText(text, size - 1), "secondary", current ? "citron" : "electric", current ? Math.max(0.25, emphasis(key)) : emphasis(key)), size - 1, "surface");
        if (recent.height > 1) {
          const date = new Date(session.updatedAt);
          const sameDay = Number.isFinite(date.getTime()) && date.toDateString() === new Date(now).toDateString();
          const time = !Number.isFinite(date.getTime()) ? "—" : sameDay ? clockLabel(session.updatedAt).slice(0, 5) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          const used = session.context?.used;
          put(titleRow + 1, column + 2, paint.text(`${time} · ctx ${session.context?.estimated ? "~" : ""}${used == null ? "—" : formatTokenCount(used)}`, "muted"), size - 3, "surface");
        }
        for (let row = titleRow; row < height; row++) put(row, column - 1, paint.text("│", "rule"), 1, "surface");
        zone({ row: titleRow, column, width: size - 1, height: height - titleRow }, { kind: "session", id: session.id });
      });
    } else put(titleRow, inset + 8, paint.text(options.recentState === "loading" ? "Loading…" : options.recentState === "unavailable" ? "Unavailable" : "No sessions", "muted"), Math.max(0, room), "surface");
    this.controls = this.zones.filter((zone) => zone.action.kind === "operation" || zone.action.kind === "session" || zone.action.kind === "history");
    this.controls.sort((a, b) => (a.action.kind === "operation" ? 0 : a.action.kind === "session" ? 1 : 2) - (b.action.kind === "operation" ? 0 : b.action.kind === "session" ? 1 : 2));
    if (this.selected && !this.controls.some((zone) => zone.key === this.selected)) { this.selected = this.controls[0]?.key ?? null; this.reflow = true; }
    if (this.pointer) this.reflow = this.hover(this.pointer.row, this.pointer.column, now) || this.reflow;

    const fade = (rect: Rect, stage: number) => {
      const amount = this.reveal(stage, now, animate);
      if (!paint.enabled || amount >= 1) return;
      const base = [1, 3, 5].map((offset) => parseInt(paint.colors.ink.slice(offset, offset + 2), 16));
      for (let row = rect.row; row < rect.row + rect.height; row++) {
        const text = sliceAnsi(canvas.rows[row] ?? "", rect.column, rect.column + rect.width).replace(/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g, (_, type, r, g, b) =>
          `\x1b[${type};2;${[r, g, b].map((value, index) => Math.round(base[index]! + (Number(value) - base[index]!) * amount)).join(";")}m`);
        put(row, rect.column, text, rect.width);
      }
    };
    fade({ row: layout.label, column: input.column, width: input.width, height: 1 }, 0);
    fade(input, 1);
    fade({ row: layout.metadata, column: input.column, width: input.width, height: 2 }, 2);
    fade(ops, 3); fade(recent, 4);
    return { rows: canvas.rows, zones: this.zones };
  }
}
