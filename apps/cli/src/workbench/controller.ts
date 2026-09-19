import {
  computePromptVisualLines,
  formatDiffPreview,
  formatFooterLine,
  formatMentionMenu,
  formatPermissionCard,
  formatSlashCommandMenu,
  renderSpinner,
  sanitizeTerminalLine,
  slashCommandMatches,
  SPINNER_PERIOD_MS,
  TerminalMarkdownStream,
  truncateText,
  visibleLength,
  wrapDisplayText,
  type Painter,
  type PaletteColor,
  type SlashCommand,
} from "@demesne/brand";
import type { EventEnvelope, PermissionDecision } from "@demesne/protocol";
import { emitKeypressEvents } from "node:readline";
import { computeWorkbenchLayout, type SidebarMode, type WorkbenchLayout } from "./layout.ts";
import { ConversationViewport } from "./viewport.ts";
import {
  createPromptEditorState,
  mentionMatches,
  mentionTokenAt,
  reducePromptEditor,
  setPromptValue,
  type PromptEditorKey,
  type PromptEditorState,
} from "../prompt-editor.ts";
import { reduceQueuedInput } from "../input-queue.ts";
import { reduceInterruptKey } from "../interrupt-key.ts";
import { approvalOptions, formatApprovalSelection, reduceApprovalSelection } from "../approval-selection.ts";
import { reduceSessionPicker, type SessionPickerKey } from "../session-picker.ts";
import { composeInEditor } from "../external-editor.ts";
import type { CliContextRail } from "../context-rail.ts";

/// Full-screen workbench.
///
/// The controller owns the alternate screen, a single keypress listener, and
/// the conversation model. It renders a complete frame on demand (header,
/// viewport, telemetry sidebar, input, fixed footer) and writes only changed
/// rows, so beacon ticks touch just the footer.

export type WorkbenchMode = "input" | "streaming" | "approval" | "dialog";
export type ToolState = "running" | "done" | "failed" | "denied";

interface UserEntry {
  id: number;
  type: "user";
  text: string;
  at: string;
}

interface AssistantEntry {
  id: number;
  type: "assistant";
  raw: string;
  streaming: boolean;
  revision: number;
}

interface ReasoningEntry {
  id: number;
  type: "reasoning";
  raw: string;
  streaming: boolean;
  startedAt: number;
  durationMs: number | null;
}

interface ToolEntry {
  id: number;
  type: "tool";
  toolCallId: string;
  name: string;
  detail?: string;
  state: ToolState;
  durationMs?: number;
  message?: string;
  diff?: { oldText: string; newText: string };
  startedAt: number;
}

interface NoticeEntry {
  id: number;
  type: "notice";
  text: string;
  tone: "info" | "success" | "error";
}

interface BlockEntry {
  id: number;
  type: "block";
  lines: string[];
}

type WorkbenchEntry = UserEntry | AssistantEntry | ReasoningEntry | ToolEntry | NoticeEntry | BlockEntry;

export interface ApprovalRequest {
  summary: string;
  toolName?: string;
  previewRows?: string[];
  allowPersist: boolean;
}

export interface PromptContext {
  history: readonly string[];
  mentions: readonly string[];
  commands: readonly SlashCommand[];
}

export interface WorkbenchOptions {
  paint: Painter;
  contextRail: CliContextRail;
  sessionTitle: string;
  version: string;
  onExit: () => void;
  onInterrupt: () => void;
  queue: {
    get(): string;
    set(value: string): void;
  };
}

const TOOL_VERBS: Record<string, string> = {
  list_files: "list",
  read_file: "read",
  read_files: "read",
  search_files: "search",
  edit_file: "edit",
  write_file: "write",
  git_status: "status",
  git_diff: "diff",
  move_path: "move",
  delete_path: "delete",
  run_command: "run",
  command_logs: "logs",
  command_stop: "stop",
};

export class Workbench {
  private readonly viewport = new ConversationViewport();
  private readonly rendered = new Map<number, { revision: number; width: number; lines: string[] }>();
  private entries: WorkbenchEntry[] = [];
  private nextId = 1;
  private layout: WorkbenchLayout;
  private sidebarMode: SidebarMode = "auto";
  private mode: WorkbenchMode = "input";
  private editor: PromptEditorState = createPromptEditorState();
  private promptContext: PromptContext = { history: [], mentions: [], commands: [] };
  private promptResolver: ((value: string) => void) | null = null;
  private approvalResolver: ((decision: PermissionDecision) => void) | null = null;
  private approval: ApprovalRequest | null = null;
  private approvalSelected = 0;
  private dialogResolver: ((index: number | null) => void) | null = null;
  private dialogItems: string[] = [];
  private dialogSelected = 0;
  private dialogTitle = "";
  private footerLeft = "";
  private footerRight = "";
  private started = false;
  private previousRows: string[] = [];
  private lastInterruptEscapeAt = 0;
  private sessionTitle: string;

  constructor(private readonly options: WorkbenchOptions) {
    this.sessionTitle = options.sessionTitle;
    this.layout = computeWorkbenchLayout(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  }

  isActive(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started || !process.stdout.isTTY) return;
    this.started = true;
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    const input = process.stdin;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.onResize);
    this.render();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const input = process.stdin;
    input.removeListener("keypress", this.onKeypress);
    process.stdout.removeListener("resize", this.onResize);
    input.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  setSessionTitle(title: string): void {
    this.sessionTitle = title;
    this.requestRender();
  }

  setFooter(left: string, right: string): void {
    this.footerLeft = left;
    this.footerRight = right;
    this.requestRender();
  }

  tick(): void {
    this.requestRender();
  }

  notice(text: string, tone: "info" | "success" | "error" = "info"): void {
    this.entries.push({ id: this.nextId++, type: "notice", text, tone });
    this.requestRender();
  }

  showBlock(lines: readonly string[]): void {
    this.entries.push({ id: this.nextId++, type: "block", lines: [...lines] });
    this.requestRender();
  }

  beginTurn(options: { userText: string; at: string; planOnly?: boolean }): void {
    this.entries.push({ id: this.nextId++, type: "user", text: options.userText, at: options.at });
    if (options.planOnly) this.notice("plan · read-only tools · approve before changes");
    this.requestRender();
  }

  reasoningDelta(delta: string): void {
    let entry = this.entries.findLast(
      (candidate): candidate is ReasoningEntry => candidate.type === "reasoning" && candidate.streaming,
    );
    if (!entry) {
      entry = {
        id: this.nextId++,
        type: "reasoning",
        raw: "",
        streaming: true,
        startedAt: Date.now(),
        durationMs: null,
      };
      this.entries.push(entry);
    }
    entry.raw += delta;
    this.requestRender();
  }

  closeReasoning(): void {
    for (const entry of this.entries) {
      if (entry.type === "reasoning" && entry.streaming) {
        entry.streaming = false;
        entry.durationMs = Math.max(100, Date.now() - entry.startedAt);
      }
    }
    this.requestRender();
  }

  assistantDelta(delta: string): void {
    let entry = this.entries.findLast(
      (candidate): candidate is AssistantEntry => candidate.type === "assistant" && candidate.streaming,
    );
    if (!entry) {
      entry = { id: this.nextId++, type: "assistant", raw: "", streaming: true, revision: 0 };
      this.entries.push(entry);
    }
    this.closeReasoning();
    entry.raw += delta;
    entry.revision += 1;
    this.requestRender();
  }

  finishAssistant(): void {
    for (const entry of this.entries) {
      if (entry.type === "assistant" && entry.streaming) entry.streaming = false;
    }
    this.requestRender();
  }

  toolRequested(input: { toolCallId: string; name: string; arguments: unknown }): void {
    const parsed = parseArguments(input.arguments);
    this.entries.push({
      id: this.nextId++,
      type: "tool",
      toolCallId: input.toolCallId,
      name: input.name,
      detail: toolDetail(input.name, parsed),
      state: "running",
      startedAt: Date.now(),
      ...(input.name === "edit_file" && typeof parsed.oldText === "string" && typeof parsed.newText === "string"
        ? { diff: { oldText: parsed.oldText, newText: parsed.newText } }
        : {}),
    });
    this.requestRender();
  }

  toolFinished(input: { toolCallId: string; name: string; state: ToolState; durationMs?: number; message?: string }): void {
    const entry = this.entries.findLast(
      (candidate): candidate is ToolEntry => candidate.type === "tool" && candidate.toolCallId === input.toolCallId,
    );
    if (!entry) return;
    entry.state = input.state;
    entry.durationMs = input.durationMs ?? Math.max(0, Date.now() - entry.startedAt);
    if (input.message) entry.message = input.message;
    this.requestRender();
  }

  finishTurn(status: "completed" | "stopped" | "failed", summary: string): void {
    this.closeReasoning();
    this.finishAssistant();
    this.notice(summary, status === "completed" ? "success" : status === "failed" ? "error" : "info");
    this.requestRender();
  }

  contextEvent(event: EventEnvelope): void {
    this.options.contextRail.apply(event);
    this.requestRender();
  }

  readPrompt(context: PromptContext): Promise<string> {
    this.promptContext = context;
    this.mode = "input";
    this.editor = createPromptEditorState();
    this.requestRender();
    return new Promise((resolve) => {
      this.promptResolver = resolve;
    });
  }

  askApproval(request: ApprovalRequest): Promise<PermissionDecision> {
    this.approval = request;
    this.approvalSelected = approvalOptions(request.toolName !== "run_command", request.allowPersist).selectedIndex;
    this.mode = "approval";
    this.requestRender();
    return new Promise((resolve) => {
      this.approvalResolver = resolve;
    });
  }

  /// Temporarily restores the normal screen for an external picker or editor.
  async suspend<T>(run: () => Promise<T>): Promise<T> {
    const wasStarted = this.started;
    if (wasStarted) this.stop();
    try {
      return await run();
    } finally {
      if (wasStarted) {
        this.previousRows = [];
        this.start();
      }
    }
  }

  /// Runs a simple list dialog and resolves the chosen index, or null.
  choose(title: string, items: readonly string[], selectedIndex = 0): Promise<number | null> {
    this.dialogTitle = title;
    this.dialogItems = [...items];
    this.dialogSelected = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
    this.mode = "dialog";
    this.requestRender();
    return new Promise((resolve) => {
      this.dialogResolver = resolve;
    });
  }

  private readonly onResize = (): void => {
    this.previousRows = [];
    this.requestRender();
  };

  private readonly onKeypress = (
    text: string,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
  ): void => {
    if (this.mode === "streaming") {
      const nextQueue = reduceQueuedInput(this.options.queue.get(), key, text ?? "");
      if (nextQueue !== this.options.queue.get()) this.options.queue.set(nextQueue);
      const interrupt = reduceInterruptKey(this.lastInterruptEscapeAt, key, Date.now());
      this.lastInterruptEscapeAt = interrupt.lastEscapeAt;
      if (interrupt.interrupt) this.options.onInterrupt();
      this.requestRender();
      return;
    }

    if (this.mode === "approval") {
      const allowSession = this.approval?.toolName !== "run_command";
      const next = reduceApprovalSelection(this.approvalSelected, allowSession, key, this.approval?.allowPersist ?? false);
      this.approvalSelected = next.selectedIndex;
      if (next.decision) {
        const resolve = this.approvalResolver;
        this.approvalResolver = null;
        this.approval = null;
        this.mode = "streaming";
        resolve?.(next.decision);
      }
      this.requestRender();
      return;
    }

    if (this.mode === "dialog") {
      const next = reduceSessionPicker(this.dialogSelected, this.dialogItems.length, text ?? "", key as SessionPickerKey);
      this.dialogSelected = next.index;
      if (next.decision === "select") this.finishDialog(this.dialogSelected);
      else if (next.decision === "cancel") this.finishDialog(null);
      else this.requestRender();
      return;
    }

    if (key.ctrl && key.name === "t") {
      this.sidebarMode = this.sidebarMode === "hidden" ? "auto" : this.sidebarMode === "auto" ? "wide" : "hidden";
      this.previousRows = [];
      this.requestRender();
      return;
    }
    if (key.name === "pageup") {
      this.viewport.scrollUp(10);
      this.requestRender();
      return;
    }
    if (key.name === "pagedown") {
      this.viewport.scrollDown(10);
      this.requestRender();
      return;
    }
    if (key.ctrl && key.name === "g") {
      this.viewport.toBottom();
      this.requestRender();
      return;
    }

    const result = reducePromptEditor(this.editor, {
      key: key as PromptEditorKey,
      text: text ?? "",
      commands: this.matchingCommands(),
      history: this.promptContext.history,
      mentions: this.promptContext.mentions,
    });
    this.editor = result.state;
    if (result.action.type === "cancel") {
      this.options.onExit();
      return;
    }
    if (result.action.type === "submit") {
      const resolve = this.promptResolver;
      this.promptResolver = null;
      this.mode = "streaming";
      resolve?.(result.action.value);
      return;
    }
    if (result.action.type === "compose") {
      void this.composeExternally();
      return;
    }
    this.requestRender();
  };

  private async composeExternally(): Promise<void> {
    const edited = await this.suspend(() => composeInEditor(this.editor.value, { env: process.env }));
    this.editor = setPromptValue(this.editor, edited);
    this.requestRender();
  }

  private finishDialog(index: number | null): void {
    const resolve = this.dialogResolver;
    this.dialogResolver = null;
    this.dialogItems = [];
    this.mode = "input";
    this.requestRender();
    resolve?.(index);
  }

  private matchingCommands(): readonly SlashCommand[] {
    if (this.editor.menuDismissed) return [];
    return slashCommandMatches(this.editor.value, this.promptContext.commands).slice(0, 10);
  }

  private requestRender(): void {
    if (this.started) this.render();
  }

  private render(): void {
    if (!this.started) return;
    const { columns, rows } = process.stdout;
    this.layout = computeWorkbenchLayout(columns ?? 80, rows ?? 24, {
      sidebar: this.sidebarMode,
      inputLines: this.inputLineCount(),
    });
    this.rebuildConversation();
    const frame = this.composeFrame();
    const output: string[] = [];
    for (let row = 0; row < frame.rows.length; row += 1) {
      if (this.previousRows[row] === frame.rows[row]) continue;
      output.push(`\x1b[${row + 1};1H\x1b[2K${frame.rows[row]}`);
    }
    this.previousRows = frame.rows;
    if (frame.cursor) {
      output.push("\x1b[?25h");
      output.push(`\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H`);
    } else {
      output.push("\x1b[?25l");
    }
    if (output.length > 0) process.stdout.write(output.join(""));
  }

  private inputLineCount(): number {
    if (this.mode === "approval") {
      return Math.max(3, 2 + (this.approval?.previewRows?.length ?? 0) + 2);
    }
    if (this.mode === "dialog") {
      return 2 + Math.min(this.dialogItems.length, 10);
    }
    const width = Math.max(10, (process.stdout.columns ?? 80) - 4);
    const valueLines = computePromptVisualLines(this.editor.value, this.editor.cursor, width).lines.length;
    const commands = this.matchingCommands().length;
    const menuLines = commands > 0 ? Math.min(commands, 10) + (commands >= 6 ? 3 : 0) : 0;
    return Math.max(2, valueLines + menuLines + 1);
  }

  private rebuildConversation(): void {
    const width = this.layout.conversation.width;
    const lines: string[] = [];
    for (const entry of this.entries) {
      lines.push(...this.renderEntry(entry, width));
    }
    this.viewport.setLines(lines);
  }

  private renderEntry(entry: WorkbenchEntry, width: number): string[] {
    const paint = this.options.paint;
    switch (entry.type) {
      case "user": {
        const text = paint.bold(truncateText(sanitizeTerminalLine(entry.text), Math.max(8, width - 16)), "paper");
        return [`  ${paint.text("›", "electric")} ${text}  ${paint.dim(entry.at)}`, ""];
      }
      case "assistant": {
        const rail = paint.text("  │ ", "rule");
        const header = `  ${paint.text("◆", "citron")} ${paint.dim("demesne")}`;
        const body = entry.raw ? this.renderedMarkdown(entry, width) : [paint.dim("…")];
        return [header, ...body.map((line) => `${rail}${line}`), ""];
      }
      case "reasoning": {
        const body = wrapDisplayText(sanitizeTerminalLine(entry.raw.trim()), Math.max(8, width - 4));
        const shown = entry.streaming ? body.slice(-3) : body.slice(0, 5);
        const hidden = body.length - shown.length;
        const more = hidden > 0 ? [paint.dim(`  ⋯ ${hidden} more lines`)] : [];
        const tail = entry.streaming
          ? [paint.dim("  reasoning…")]
          : [paint.dim(`  thought for ${((entry.durationMs ?? 0) / 1_000).toFixed(1)}s`)];
        return [...shown.map((line) => `${paint.dim("  ⋯ ")}${paint.dim(line)}`), ...more, ...tail, ""];
      }
      case "tool": {
        const verb = toolVerb(entry.name);
        const glyph = entry.state === "running"
          ? renderSpinner((Date.now() % SPINNER_PERIOD_MS) / SPINNER_PERIOD_MS, "tool", paint, "electric")
          : entry.state === "done"
            ? paint.text("✓", "citron")
            : paint.text("×", "signal");
        const detail = entry.detail
          ? ` ${paint.text(truncateText(sanitizeTerminalLine(entry.detail), Math.max(8, width - verb.length - 16)), "secondary")}`
          : "";
        const duration = entry.state === "running" || entry.durationMs === undefined ? "" : paint.dim(` ${entry.durationMs}ms`);
        const message = entry.state === "failed" && entry.message
          ? [`    ${paint.text(truncateText(sanitizeTerminalLine(entry.message), Math.max(8, width - 6)), "signal")}`]
          : [];
        const diffLines = entry.state === "done" && entry.diff
          ? formatDiffPreview(entry.diff.oldText, entry.diff.newText, 12, paint).map((line) => `    ${line}`)
          : [];
        return [`  ${glyph} ${paint.text(verb, "paper")}${detail}${duration}`, ...message, ...diffLines];
      }
      case "notice": {
        const color: PaletteColor = entry.tone === "success" ? "citron" : entry.tone === "error" ? "signal" : "secondary";
        const glyph = entry.tone === "success" ? "✓" : entry.tone === "error" ? "×" : "·";
        return [`  ${paint.text(glyph, color)} ${paint.dim(truncateText(sanitizeTerminalLine(entry.text), Math.max(8, width - 4)))}`, ""];
      }
      case "block":
        return [...entry.lines.map((line) => `  ${line}`), ""];
    }
  }

  private renderedMarkdown(entry: AssistantEntry, width: number): string[] {
    const cached = this.rendered.get(entry.id);
    if (cached && cached.revision === entry.revision && cached.width === width) return cached.lines;
    const stream = new TerminalMarkdownStream(this.options.paint, Math.max(16, width - 4), 0);
    // A fresh stream per revision keeps the trailing partial line visible while
    // the model streams; flush() would otherwise only run at turn end.
    const rendered = `${stream.write(entry.raw)}${stream.flush()}`;
    const lines = rendered.split("\n");
    const result = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
    this.rendered.set(entry.id, { revision: entry.revision, width, lines: result });
    return result;
  }

  private composeFrame(): { rows: string[]; cursor: { row: number; column: number } | null } {
    const paint = this.options.paint;
    const { layout } = this;
    const rows: string[] = Array.from({ length: layout.height }, () => "");
    const pad = (line: string, width: number) => `${line}${" ".repeat(Math.max(0, width - visibleLength(line)))}`;

    rows[layout.header.row] = this.composeHeader(layout.width);
    const conversation = this.viewport.visible(layout.conversation.height);
    const sidebar = layout.sidebar ? this.sidebarLines() : null;
    for (let index = 0; index < layout.conversation.height; index += 1) {
      const row = layout.conversation.row + index;
      const conversationLine = truncateText(conversation[index] ?? "", layout.conversation.width);
      if (layout.sidebar && layout.dividerColumn !== null && sidebar) {
        const sidebarLine = sidebar[index] ?? "";
        rows[row] = `${pad(conversationLine, layout.conversation.width)}${paint.text("│", "rule")}${pad(sidebarLine, layout.sidebar.width)}`;
      } else {
        rows[row] = conversationLine;
      }
    }

    const input = this.composeInput(layout.input.width);
    for (let index = 0; index < layout.input.height; index += 1) {
      rows[layout.input.row + index] = input.lines[index] ?? "";
    }
    rows[layout.footer.row] = formatFooterLine(this.footerLeft, this.footerRight, layout.width);
    return {
      rows,
      cursor: input.cursor ? { row: layout.input.row + input.cursor.row, column: input.cursor.column } : null,
    };
  }

  private composeHeader(width: number): string {
    const paint = this.options.paint;
    const model = this.options.contextRail.modelId;
    const left = `  ${paint.bold("◆ DEMESNE", "paper")} ${paint.dim(this.options.version)} `
      + `${paint.text("·", "rule")} ${paint.bold(truncateText(sanitizeTerminalLine(this.sessionTitle), Math.max(8, Math.floor(width / 3))), "paper")}`;
    const right = paint.dim(`${truncateText(sanitizeTerminalLine(model), 24)} · ctrl+t sidebar · pgup/pgdn scroll`);
    const padding = Math.max(1, width - visibleLength(left) - visibleLength(right));
    return truncateText(`${left}${" ".repeat(padding)}${right}`, width);
  }

  private sidebarLines(): string[] {
    if (!this.layout.sidebar) return [];
    const width = this.layout.sidebar.width;
    return this.options.contextRail.lines(
      Math.max(16, width - 2),
      this.layout.sidebar.height,
      this.options.paint,
    ).map((line) => ` ${truncateText(line, width - 2)}`);
  }

  private composeInput(width: number): { lines: string[]; cursor: { row: number; column: number } | null } {
    const paint = this.options.paint;
    const lines: string[] = [];
    let cursor: { row: number; column: number } | null = null;

    if (this.mode === "approval" && this.approval) {
      const allowSession = this.approval.toolName !== "run_command";
      lines.push(...formatPermissionCard(
        this.approval.summary,
        this.approval.toolName,
        width,
        paint,
        this.approval.previewRows,
      ).split("\n"));
      lines.push(formatApprovalSelection(this.approvalSelected, allowSession, width, paint, this.approval.allowPersist));
      return { lines, cursor: null };
    }

    if (this.mode === "dialog") {
      lines.push(`  ${paint.bold(this.dialogTitle, "paper")} ${paint.dim(`(${this.dialogSelected + 1}/${this.dialogItems.length})`)}`);
      this.dialogItems.slice(0, 10).forEach((item, index) => {
        const marker = index === this.dialogSelected ? paint.bold("›", "electric") : " ";
        const label = truncateText(sanitizeTerminalLine(item), Math.max(8, width - 6));
        lines.push(`  ${marker} ${index === this.dialogSelected ? paint.bold(label, "paper") : paint.text(label, "secondary")}`);
      });
      lines.push(`  ${paint.dim("↑/↓ · enter selects · esc cancels")}`);
      return { lines, cursor: null };
    }

    const promptWidth = Math.max(10, width - 4);
    const layout = computePromptVisualLines(this.editor.value, this.editor.cursor, promptWidth);
    const placeholder = this.editor.value.length === 0 && this.matchingCommands().length === 0
      ? paint.dim(truncateText("Ask anything or type / for commands…", promptWidth))
      : "";
    for (let index = 0; index < layout.lines.length; index += 1) {
      const prefix = index === 0 ? `  ${paint.text("◆", "electric")} ` : "    ";
      lines.push(`${prefix}${layout.lines[index] || (index === 0 ? placeholder : "")}`);
    }
    cursor = { row: layout.cursorLine, column: 4 + layout.cursorCol };

    const commands = this.matchingCommands();
    const mention = mentionTokenAt(this.editor.value, this.editor.cursor);
    const mentionCandidates = mention && this.promptContext.mentions.length > 0
      ? mentionMatches(this.promptContext.mentions, mention.query)
      : [];
    if (mentionCandidates.length > 0) {
      lines.push(...formatMentionMenu(mentionCandidates, this.editor.mentionSelected, width, paint).split("\n"));
    } else if (commands.length > 0) {
      lines.push(...formatSlashCommandMenu(commands, this.editor.menuSelected, width, paint).split("\n"));
    }
    return { lines, cursor };
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toolDetail(name: string, input: Record<string, unknown>): string | undefined {
  if (name === "move_path") {
    const from = typeof input.from === "string" ? input.from : undefined;
    const to = typeof input.to === "string" ? input.to : undefined;
    return from && to ? `${from} → ${to}` : from ?? to;
  }
  const path = typeof input.path === "string" ? input.path : undefined;
  if (path) return path;
  if (Array.isArray(input.paths) && input.paths.every((value) => typeof value === "string")) {
    const paths = input.paths as string[];
    return paths.length === 1 ? paths[0] : `${paths.length} files`;
  }
  if (Array.isArray(input.argv) && input.argv.every((value) => typeof value === "string")) {
    return `$ ${(input.argv as string[]).join(" ")}`;
  }
  if (typeof input.query === "string") return `"${input.query}"`;
  return undefined;
}

function toolVerb(name: string): string {
  if (TOOL_VERBS[name]) return TOOL_VERBS[name];
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    return `${server}/${tool}`;
  }
  return name;
}
