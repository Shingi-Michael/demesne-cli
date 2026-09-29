import { formatFooterLine, formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, type Painter, type PaletteColor } from "@demesne/brand";
import { sliceAnsi } from "bun";
import type { RecentSession } from "../recent-sessions.ts";
import type { ContextReceipt } from "./entries.ts";
import type { Rect } from "./layout.ts";
import { Canvas } from "./canvas.ts";
import { InteractionTransitions, tint } from "./interaction.ts";
import { contextLabel, contextMeter } from "./session-chrome.ts";

export const START_OPERATIONS = [
  { tag: "EXPLORE", label: "Explore", title: "Trace a call flow end to end", description: "Follow execution from entry point through the full stack", tone: "electric",
    prompt: "Trace the call flow from the main entry point and map out how requests move through the system." },
  { tag: "DEBUG", label: "Debug", title: "Find and fix a failing behavior", description: "Diagnose an error or unexpected behavior and patch it", tone: "electric",
    prompt: "Help me diagnose and fix a bug. Ask me about the error or unexpected behavior, then investigate and verify the fix." },
  { tag: "BUILD", label: "Build", title: "Implement a feature with tests", description: "Implement something new end-to-end with tests", tone: "electric",
    prompt: "Help me implement a new feature end-to-end. Ask what I want to build, then inspect the project and add the appropriate verification." },
  { tag: "LEARN", label: "Learn", title: "Map the architecture", description: "Get a map of the architecture and key entry points", tone: "electric",
    prompt: "Explain this codebase: map the architecture, key entry points, and how its main components work together." },
] as const;

export type StartAction = { kind: "operation"; index: number } | { kind: "session"; id: string }
  | { kind: "history" | "settings" | "workspace" | "context" | "model" | "commands" | "files" | "live" | "panel" };
export interface StartZone extends Rect { key: string; action: StartAction }
export interface StartLayout {
  input: Rect; label: number | null; metadata: number;
  operations: Rect; columns: number; cardHeight: number; cardOffset: number; recent: Rect; feedback: number | null;
}

export function startScreenLayout(width: number, height: number, requestedHeight: number, feedback: boolean): StartLayout {
  const inset = width >= 65 ? 2 : 1;
  // Figma 8:268: a 720px hero at 14px mono (~86 cells), centered as
  // one group. Recent belongs to this column, never to the window footer.
  const contentWidth = Math.min(86, width - inset * 2);
  const column = Math.floor((width - contentWidth) / 2);
  const header = height >= 18 ? 4 : 2;
  const available = height - header - Number(feedback);
  const inputHeight = Math.max(4, Math.min(Math.max(5, requestedHeight), available - 4));
  const columns = contentWidth >= 64 ? 2 : 1;
  const operationRows = Math.ceil(START_OPERATIONS.length / columns);
  let cardHeight = 3, cardOffset = 1, recentHeight = 7, gap = 1, intro = 3;
  const group = () => intro + inputHeight + gap * 2 + (cardHeight ? cardOffset + operationRows * cardHeight : 1) + recentHeight;
  if (group() > available) cardHeight = 1;
  if (group() > available) recentHeight = 4;
  if (group() > available) gap = 0;
  if (group() > available) intro = 2;
  if (group() > available) recentHeight = 1;
  if (group() > available) cardOffset = 0;
  if (group() > available) cardHeight = 0;
  if (group() > available) intro = 1;
  const groupHeight = group();
  const top = header + Math.max(0, Math.floor((available - groupHeight) / 2));
  const input = { row: top + intro, column, width: contentWidth, height: inputHeight };
  const operations = { row: input.row + input.height + gap, column, width: contentWidth, height: cardHeight ? cardOffset + operationRows * cardHeight : 1 };
  const recent = { row: operations.row + operations.height + gap, column, width: contentWidth, height: recentHeight };
  return { input, label: intro > 1 ? top : null, metadata: top + (intro > 1 ? 1 : 0), operations, columns, cardHeight, cardOffset, recent,
    feedback: feedback ? recent.row + recent.height : null };
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
    path: string; branch?: string | null; model: string; mode: string; context: ContextReceipt; currentId?: string; recent: readonly RecentSession[];
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
    // The start frame has its own top status strip and workspace header.
    // It deliberately has no conversation action rail or wall-clock heading.
    put(0, 0, "", width, "surface");
    const context = `ctx ${contextLabel(options.context)}`;
    const settings = width >= 90 ? "Tab settings  Ctrl+K commands" : width >= 60 ? "Tab settings" : "Tab";
    const statusRoom = inner - settings.length - 2;
    let status = paint.text("● ready", "citron");
    const modelRoom = statusRoom - visibleLength(status) - context.length - 4;
    if (modelRoom >= 8) status += "  " + paint.text(truncateText(safe(options.model), modelRoom), "muted");
    const contextColumn = inset + visibleLength(status) + 2;
    status += "  " + paint.text(context, "muted");
    const meter = contextMeter(options.context, paint, 8);
    if (meter && visibleLength(status) + visibleLength(meter) + 2 <= statusRoom) status += "  " + meter;
    put(0, inset, formatFooterLine(status, paint.text(settings, "muted"), inner), inner, "surface");
    zone({ row: 0, column: contextColumn, width: context.length, height: 1 }, { kind: "context" });
    const settingsColumn = width - inset - settings.length;
    zone({ row: 0, column: settingsColumn, width: settings.startsWith("Tab settings") ? 12 : 3, height: 1 }, { kind: "settings" });
    if (width >= 90) zone({ row: 0, column: settingsColumn + 14, width: 15, height: 1 }, { kind: "commands" });
    const headerRow = height >= 18 ? 2 : 1;
    const history = width >= 60 ? "Alt+H history" : "history";
    const branch = options.branch && width >= 70 ? `⎇ ${truncateText(safe(options.branch), 20)}  ` : "";
    const heading = paint.text("demesne", "electric") + paint.text(` · ${safe(options.path)}`, "muted");
    put(headerRow, inset, formatFooterLine(heading, paint.text(branch + history, "muted"), inner), inner);
    zone({ row: headerRow, column: inset, width: Math.max(0, inner - branch.length - history.length - 2), height: 1 }, { kind: "workspace" });
    zone({ row: headerRow, column: width - inset - history.length, width: history.length, height: 1 }, { kind: "history" });
    if (height >= 18) put(3, inset, paint.text("─".repeat(inner), "rule"), inner);
    const { input } = layout;
    if (layout.label !== null) put(layout.label, input.column, paint.text("What are we working on?", "strong"), input.width);
    const capacity = `ctx ${options.context.capacity ? formatTokenCount(options.context.capacity) : "?"}`;
    const mode = `${options.mode} mode`;
    const model = truncateText(safe(options.model), input.width - capacity.length - mode.length - 6);
    put(layout.metadata, input.column, paint.text(`${model} · ${capacity} · ${mode}`, "muted"), input.width);
    zone({ row: layout.metadata, column: input.column, width: model.length, height: 1 }, { kind: "model" });
    zone({ row: layout.metadata, column: input.column + model.length + 3, width: capacity.length, height: 1 }, { kind: "context" });
    zone({ row: layout.metadata, column: input.column + model.length + capacity.length + 6, width: mode.length, height: 1 }, { kind: "settings" });
    options.input.forEach((line, index) => put(input.row + index, input.column, line, input.width, "surface"));

    const ops = layout.operations;
    if (layout.cardHeight) {
      if (layout.cardOffset) put(ops.row + layout.cardOffset - 1, ops.column, paint.text("START FROM", "muted"), ops.width);
      const gap = 1;
      const cellWidth = Math.floor((ops.width - (layout.columns - 1) * gap) / layout.columns);
      START_OPERATIONS.forEach((operation, index) => {
        const row = ops.row + layout.cardOffset + Math.floor(index / layout.columns) * layout.cardHeight;
        const column = ops.column + (index % layout.columns) * (cellWidth + gap);
        const active = emphasis(`operation:${index}`);
        const tone = operation.tone as PaletteColor;
        const selected = options.focused && this.selected === `operation:${index}`;
        const background = active >= 0.5 ? "raised" : "surface";
        const number = tint(paint, selected ? "›" : `${index + 1}`, "muted", tone, active);
        const name = paint.text(operation.label, "strong");
        const room = cellWidth - 7 - operation.label.length;
        const title = room >= 8 ? " " + paint.text(truncateText(operation.title, room), "muted") : "";
        const textRow = row + (layout.cardHeight === 3 ? 1 : 0);
        if (layout.cardHeight === 3) canvas.panel(row, column, cellWidth, 3, "", "", background);
        put(textRow, column + 1, ` ${number} ${name}${title}`, cellWidth - 2, background);
        zone({ row, column, width: cellWidth, height: layout.cardHeight }, { kind: "operation", index });
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
    const listed = options.recent.slice(0, recent.height >= 7 ? 3 : 1);
    const empty = options.recentState === "loading" ? "Loading…" : options.recentState === "unavailable" ? "Unavailable" : "No sessions";
    const boxed = recent.height >= 7;
    const listRow = recent.row + (boxed ? 2 : recent.height > 1 ? 1 : 0);
    if (recent.height > 1) put(recent.row, recent.column, paint.text("RECENT", "muted"), recent.width);
    if (boxed) canvas.panel(recent.row + 1, recent.column, recent.width, 5, "");
    const sessionTime = (session: RecentSession) => {
      const date = new Date(session.updatedAt);
      if (!Number.isFinite(date.getTime())) return "—";
      const age = Math.max(0, now - date.getTime());
      if (age < 60_000) return "just now";
      if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
      if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };
    if (listed.length) {
      const status = (session: RecentSession): [string, PaletteColor] => session.lastStatus === "completed" ? ["✓", "citron"]
        : session.lastStatus === "failed" ? ["×", "signal"] : session.lastStatus === "cancelled" || session.lastStatus === "interrupted" ? ["■", "secondary"]
        : session.lastStatus === "running" || session.lastStatus === "queued" ? ["◎", "thinking"] : ["·", "muted"];
      listed.forEach((session, index) => {
        const row = listRow + index;
        const key = `session:${session.id}`;
        const active = emphasis(key);
        const current = session.id === options.currentId;
        const background = active >= 0.5 ? "raised" : "surface";
        const [glyph, tone] = status(session);
        const time = sessionTime(session);
        const used = session.context?.used;
        const meta = [session.turns === undefined ? "" : `${session.turns} turn${session.turns === 1 ? "" : "s"}`,
          `ctx ${session.context?.estimated ? "~" : ""}${used == null ? "—" : formatTokenCount(used)}`, current ? "current" : ""].filter(Boolean).join(" · ");
        const left = `${options.focused && this.selected === key ? paint.text("›", "electric") : " "}${paint.text(glyph, tone)} `;
        const rowWidth = recent.width - 2;
        const titleRoom = Math.max(8, Math.min(40, rowWidth - 7 - meta.length - time.length));
        const text = left + paint.text(truncateText(safe(session.title), titleRoom), current ? "paper" : "secondary") + "  " + paint.text(meta, "muted");
        put(row, recent.column + 1, "", rowWidth, background);
        put(row, recent.column + 1, text, rowWidth - time.length - 2, background);
        put(row, recent.column + 1 + rowWidth - time.length - 1, paint.text(time, "muted"), time.length, background);
        zone({ row, column: recent.column + 1, width: rowWidth, height: 1 }, { kind: "session", id: session.id });
      });
    }
    if (!listed.length) put(listRow, recent.column + 2, paint.text(empty, "muted"), recent.width - 4, "surface");
    if (recent.height > 1) {
      const label = "Alt+H all sessions · /resume <name>";
      put(recent.row + recent.height - 1, recent.column, tint(paint, label, "muted", "electric", emphasis("history")), recent.width);
      zone({ row: recent.row + recent.height - 1, column: recent.column, width: Math.min(label.length, recent.width), height: 1 }, { kind: "history" });
    }
    this.controls = this.zones.filter((zone, index, zones) => (zone.action.kind === "operation" || zone.action.kind === "session" || zone.action.kind === "history")
      && zones.findIndex(other => other.key === zone.key) === index);
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
    fade({ row: layout.label ?? layout.metadata, column: input.column, width: input.width, height: 2 }, 0);
    fade(input, 1);
    fade(ops, 3); fade(recent, 4);
    return { rows: canvas.rows, zones: this.zones };
  }
}
