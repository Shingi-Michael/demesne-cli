import {
  computePromptVisualLines,
  formatDiffPreview,
  formatFooterLine,
  formatMentionMenu,
  formatApprovalAsk,
  formatSlashCommandMenu,
  formatToolRow,
  HARNESS,
  presenceForTool,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  shortenPath,
  SLASH_MENU_LIMIT,
  slashCommandMatches,
  slashMenuLineCommands,
  TerminalMarkdownStream,
  textIndexAtVisualColumn,
  truncateText,
  visibleLength,
  wrapDisplayText,
  type Painter,
  type PaletteColor,
  type PresenceState,
  type SlashCommand,
  type ToolRowState,
} from "@demesne/brand";
import { driveComposerAllowed, type DriveAction, type DriveObservation, type DriveState, type EventEnvelope, type PermissionDecision, type SessionStateResponse, type UserAnswer, type UserQuestion } from "@demesne/protocol";
import type { DriveControl } from "../agent-drive.ts";
import { drawDriveFeedback, driveTypingChunks, waitForDriveFrame, type DriveFeedback } from "./drive-feedback.ts";
import { driveActivityLabel, driveTracePreview } from "./drive-trace-view.ts";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { sliceAnsi } from "bun";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { surface } from "./surface.ts";
import { Canvas, workspaceInset } from "./canvas.ts";
import { TerminalInputDecoder, PASTE_ENABLE, PASTE_DISABLE, FOCUS_ENABLE, FOCUS_DISABLE, type TerminalInput } from "./terminal-input.ts";
import { restoreSessionEntries } from "./history.ts";
import { applyToolDraft, proposedDiff } from "./tool-preview.ts";
import { composeDraft, composerHeight } from "./composer.ts";
import { CommandMenu, groupSlashCommands, type CommandMenuFrame } from "./command-menu.ts";
import { MentionMenu } from "./mention-menu.ts";
import { SessionView } from "./session.ts";
import { toolFailed } from "./evidence.ts";
import { keycap, keyHints, sessionStatus } from "./session-chrome.ts";
import { sidebarRail, type RailAction } from "./sidebar-rail.ts";
import { ArtifactPreview, type PreviewServices } from "./preview-panel.ts";
import { graphicsProbe, TerminalGraphics, type TerminalImage } from "../terminal-graphics.ts";
import type { ImageArtifact } from "@demesne/protocol";
import { StartScreen, startScreenLayout, START_OPERATIONS, type StartAction, type StartLayout } from "./start-screen.ts";
import type { RecentSession } from "../recent-sessions.ts";
import type { WorkbenchEntry, AssistantEntry, ReasoningEntry, ToolEntry, NoticeEntry, ToolState, ResponseReceipt } from "./entries.ts";
export type { ToolState } from "./entries.ts";
import { responseCard, userCard } from "./conversation.ts";
import { inspectorPanel, INSPECTOR_TABS, type InspectorTab } from "./inspector.ts";
import { groupActivity, changeSummary, evidenceCounts } from "./activity.ts";
import { computeWorkbenchLayout, conversationInset, sessionPanelLayout, type WorkbenchLayout } from "./layout.ts";
import { ConversationViewport } from "./viewport.ts";
import { MOUSE_DISABLE, MOUSE_ENABLE, type MouseEvent } from "../mouse.ts";
import {
  createPromptEditorState,
  mentionLabel,
  draftMentions,
  mentionMatches,
  mentionTokenAt,
  reducePromptEditor,
  setPromptValue,
  type PromptEditorKey,
  type PromptEditorResult,
  type PromptEditorState,
} from "../prompt-editor.ts";
import { escapePresses, interruptArmed, reduceInterruptKey } from "../interrupt-key.ts";
import { reducedMotionEnabled } from "../motion.ts";
import { approvalOptions, reduceApprovalSelection } from "../approval-selection.ts";
import { createQuestionPrompt, ownRow, reduceQuestionPrompt, type QuestionPromptState } from "./question-prompt.ts";
import { filterDialogIndices, reduceDialogPicker } from "../session-picker.ts";
import { planTranscript, type PlannedTool } from "./transcript.ts";
import { classifyTurnPhase } from "../turn-activity.ts";
import { composeInEditor } from "../external-editor.ts";
import { narrateWaiting } from "../voice.ts";
import type { CliContextRail } from "../context-rail.ts";

/// Terminal lifecycle and input orchestration. SessionView owns run selection,
/// navigation and inspection; activity/transcript remain alternate views.

export type WorkbenchMode = "input" | "streaming" | "approval" | "dialog";

export interface ApprovalRequest {
  summary: string;
  toolName?: string;
  previewRows?: string[];
  allowPersist: boolean;
  /// Where a command would run, shown under it; the workspace when omitted.
  cwd?: string;
}

export interface PromptContext {
  history: readonly string[];
  mentions: readonly string[];
  commands: readonly SlashCommand[];
  /// Text to start the editor with, such as a queue returned after a stop.
  draft?: string;
}

export interface WorkbenchOptions {
  files?: () => Promise<string[]>;
  fileInfo?: () => Promise<import("@demesne/protocol").WorkspaceFileInfo[]>;
  /// One workspace file's current text, for the file viewer's whole-file view.
  readFile?: (path: string) => Promise<import("@demesne/protocol").WorkspaceFileText>;
  preview?: PreviewServices;
  paint: Painter;
  contextRail: CliContextRail;
  sessionTitle: string;
  version: string;
  /// Shown in the header instead of the model, which the footer already owns.
  workspaceRoot?: string;
  onExit: () => void;
  onInterrupt: () => void;
  drive?: { control(control: DriveControl): void; intervene(): void; waitForFrame?(milliseconds: number, signal: AbortSignal): Promise<void> };
  queue: {
    get(): string;
    set(value: string): void;
  };
}

/// Verbs for the aligned tool column. Short and lowercase so the column reads
/// as a label, not as prose.
const TOOL_VERBS: Record<string, string> = {
  list_files: "list",
  read_file: "read",
  read_files: "read",
  search_files: "search",
  edit_file: "edit",
  write_file: "write",
  git_status: "git",
  git_diff: "diff",
  move_path: "move",
  delete_path: "delete",
  run_command: "run",
  command_logs: "logs",
  command_stop: "stop",
};

/// A click target within the composer area, addressed by content row (zero is
/// the first line under the composing rule).
/// Frames that draw their own title row report zones one row up, since the
/// caller offsets input zones by the wrapper's title row.
function withOwnTitle<T extends { zones: InputZone[] }>(frame: T): T {
  return { ...frame, zones: frame.zones.map((zone) => ({ ...zone, row: zone.row - 1 })) };
}

/// Optional details for `choose()`: Figma 31:356's grouped, annotated list.
export interface ChooseOptions {
  subtitle?: string;
  /// A group name per item, e.g. its provider; items are shown under headers.
  groups?: readonly string[];
  /// A detail column per item, e.g. `100k ctx · 8k out`.
  details?: readonly string[];
  /// The item marked `● current`.
  currentIndex?: number;
  /// What Enter does, for the footer: `switch`, `open`…
  action?: string;
  /// What the items are called in the count: `models`, `themes`…
  noun?: string;
  /// Right-hand text per item, e.g. the command that also changes it.
  hints?: readonly string[];
  /// Footer text on the right, in place of `Tab next group`.
  note?: string;
}

export interface InputZone {
  driveAllowed?: boolean;
  driveControl?: boolean;
  identity?: string;
  row: number;
  column?: number;
  width?: number;
  run: (column?: number) => void;
}

/// Terminals at least this tall give the approval card Figma's spacing.
const AIRY_APPROVAL_ROWS = 30;

export class Workbench {
  private driveState: DriveState | null = null;
  private driveDispatch = false;
  private inputRevision = 0;
  private scrollRevision = 0;
  private driveReadingHeld = false;
  private driveTargets = new Map<string, InputZone>();
  private driveSnapshot: { id: string; revision: number; scrollRevision: number } | null = null;
  private readonly driveDocumentId = crypto.randomUUID();
  private driveDocumentRevision = 0;
  private drivePanelBounds: { column: number; width: number; height: number } | null = null;
  private drivePanes: NonNullable<DriveObservation["panes"]> = [];
  private driveCardBounds: { row: number; height: number; width: number } | null = null;
  private driveFeedback: DriveFeedback | null = null;
  private driveFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private railHovered: RailAction | null = null;
  private railZones: { row: number; height: number; column: number; width: number; action: RailAction }[] = [];
  private preview: ArtifactPreview | null = null;
  private readonly graphics = new TerminalGraphics(Math.floor(Math.random() * 0x7fffffff) + 1);
  private graphicsReady = false;
  private cellSize: { width: number; height: number } | null = null;
  private imageIntent: TerminalImage | null = null;
  private probeUntil = 0;
  private sessionLayout = true;
  private readonly sessionView = (() => {
    const view = new SessionView((text) => this.copyResponse(text));
    // History opens another session through the same path as /resume.
    view.onResume = (id) => this.runCommand(`/resume ${id}`);
    return view;
  })();
  private readonly startScreen = new StartScreen();
  private startLayout: StartLayout | null = null;
  private sessionId: string | undefined;
  private recentSessions: RecentSession[] = [];
  private recentState: "loading" | "ready" | "unavailable" = "ready";
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly viewport = new ConversationViewport();
  private readonly rendered = new Map<number, { revision: number; width: number; session: boolean; lines: string[] }>();
  private entries: WorkbenchEntry[] = [];
  private nextId = 1;
  private layout: WorkbenchLayout;
  private mode: WorkbenchMode = "input";
  private editor: PromptEditorState = createPromptEditorState();
  private queuedEditor: PromptEditorState = createPromptEditorState();
  private feedback: { text: string; tone: "info" | "success" | "error" } | null = null;
  private promptContext: PromptContext = { history: [], mentions: [], commands: [] };
  private promptResolver: ((value: string) => void) | null = null;
  private approvalResolver: ((decision: PermissionDecision) => void) | null = null;
  /// Questions from the agent (`ask_user`), shown while the mode is "approval"
  /// so every waiting-on-you rule applies: keys go to the card, Drive waits.
  private question: { state: QuestionPromptState; resolve: (answers: UserAnswer[]) => void } | null = null;
  private approval: ApprovalRequest | null = null;
  private approvalSelected = 0;
  private dialogResolver: ((index: number | null) => void) | null = null;
  private dialogItems: string[] = [];
  private dialogSelected = 0;
  private dialogTitle = "";
  /// Optional Figma 31:356 chooser details: a subtitle, per-item groups and
  /// detail columns, the current item, and the verb Enter performs.
  private dialogOptions: ChooseOptions = {};
  /// Type-to-filter state for the dialog picker. `dialogFiltered` holds the
  /// original indices still matching the query, in display order.
  private dialogQuery = "";
  private dialogFiltered: number[] = [];
  /// Click targets for the current frame, by absolute terminal row. Rebuilt on
  /// every render, so clicks land on what is actually on screen.
  private mouseZones: InputZone[] = [];
  private commandMenu = new CommandMenu();
  private commandMenuFrame: CommandMenuFrame | null = null;
  private mentionMenu = new MentionMenu();
  private mentionMenuFrame: CommandMenuFrame | null = null;
  private readonly keyboard = new PassThrough();
  private readonly decoder = new StringDecoder("utf8");
  private readonly terminalInput = new TerminalInputDecoder();
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedTheme = "";
  private planMode = false;
  private savedDraft = "";
  /// The editor holds a queue returned unsent after a stopped or failed turn.
  private restoredDraft = false;
  private savedDraftRestored = false;
  private transcriptView = false;
  private collapsedSections = new Set<string>();
  private sections: Array<{ key: string; row: number; run: () => void }> = [];
  private sectionFocus: string | null = null;
  private sheet: { kind: "index"; selected: number } | { kind: "detail"; entryId: number; offset: number } | null = null;
  private chatView = true;
  private selectedTurnId: number | null = null;
  private inspectorTab: InspectorTab = "Overview";
  private inspectorFocused = false;
  private inspectorOffset = 0;
  private inspectorRevealSelection = false;
  private expandedResponses = new Set<number>();
  private conversationZones: InputZone[] = [];
  private expandedTools = new Set<number>();
  private conversationActions = new Map<number, () => void>();
  private showAllTools = false;
  /// An incomplete mouse sequence waiting for the rest of its bytes.
  private mouseCarry = "";
  private footerLeft = "";
  private footerRight = "";
  private ambient: string[] = [];
  private state: PresenceState = "idle";
  private turnStartedAt: number | null = null;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalFocused = true;
  private clockSecond = -1;
  private started = false;
  private previousRows: string[] = [];
  private previousCursor: { row: number; column: number } | null = null;
  private lastInterruptEscapeAt = 0;
  private sessionTitle: string;
  private sessionOpenedAt = Date.now();
  private sessionCreatedAt = this.sessionOpenedAt;
  private readonly expandedReasoning = new Set<number>();

  constructor(private readonly options: WorkbenchOptions) {
    if (options.preview) this.preview = new ArtifactPreview(options.preview, () => this.requestRender());
    this.sessionTitle = options.sessionTitle;
    this.layout = computeWorkbenchLayout(process.stdout.columns ?? 80, process.stdout.rows ?? 24, { sidebar: "hidden" });
    if (options.readFile) this.sessionView.diffPanel.loader = options.readFile;
    this.sessionView.diffPanel.onLoad = () => this.requestRender();
    this.sessionView.onFilesBack = () => this.openFiles(false);
    // `@` in the Files list: the file joins the draft as a mention.
    this.sessionView.onMention = (path) => {
      const { value, cursor } = this.editor;
      const token = `${cursor > 0 && !/\s/.test(value[cursor - 1]!) ? " " : ""}@${mentionLabel(path, this.promptContext.mentions)} `;
      this.editor = { ...setPromptValue(this.editor, value.slice(0, cursor) + token + value.slice(cursor)), cursor: cursor + token.length };
      this.sessionView.focusInput(); this.requestRender();
    };
  }

  isActive(): boolean {
    return this.started;
  }

  /// Drive state is saved per workspace, but a mission belongs to the session
  /// it started in: other sessions, including new ones, start without it.
  private get drive(): DriveState | null {
    const state = this.driveState;
    return state && (!this.sessionId || state.homeSessionId === this.sessionId) ? state : null;
  }

  setDrive(state: DriveState | null): void {
    const previous = this.drive?.status;
    this.driveState = state;
    if (!this.sessionView.paused) this.driveReadingHeld = false;
    if (!state || ["paused", "stopped", "blocked", "completed", "idle"].includes(state.status)) this.clearDriveFeedback();
    const shown = this.drive;
    if (shown && previous !== shown.status && ["completed", "blocked", "idle"].includes(shown.status)) this.showDrive();
    this.requestRender();
  }
  showDrive(): void { if (!this.sessionView.driveOpen) this.openRailAction("drive"); }

  private driveView(): { surface: string; focus: NonNullable<DriveObservation["focus"]> } {
    const preview = this.preview?.open && !this.sessionView.panelOpen && this.mode === "input";
    return { surface: this.mode === "dialog" ? "sessions" : preview ? "preview" : this.sessionView.driveSurface,
      focus: this.mode === "dialog" ? "dialog" : this.sessionView.focused || preview && this.preview?.focused ? "content" : "composer" };
  }

  private driveActionResult(summary: string, before: DriveObservation): string {
    if (this.started) this.render(); else this.frame(this.layout.width, this.layout.height);
    const view = this.driveView();
    const panes = this.drivePanes.map((pane) => `${pane.surface} at row ${pane.row}, column ${pane.column} (${pane.width}×${pane.height})`).join("; ");
    const scroll = this.sessionView.driveScrollRegions.map((region) => `${region.surface} offset ${region.offset}/${region.maximum}`).join("; ");
    return `${summary} Surface: ${before.surface} → ${view.surface}. Focus: ${view.focus}.${panes ? ` Visible panes: ${panes}.` : ""}${scroll ? ` Scroll positions: ${scroll}.` : ""}`;
  }

  observeDrive(): DriveObservation {
    this.clearDriveFeedback();
    if (!this.sessionView.paused) this.driveReadingHeld = false;
    // Use the same production renderer and hit targets as the visible terminal.
    if (this.started) this.render();
    const rows = (this.started ? this.previousRows : this.frame(this.layout.width, this.layout.height).rows).map(stripVTControlCharacters);
    // Operator-only traces cannot feed back into the planner or become evidence.
    const panel = this.drivePanelBounds, card = this.driveCardBounds;
    for (let row = 0; row < rows.length; row++) {
      if (card && row >= card.row && row < card.row + card.height) rows[row] = " ".repeat(card.width) + sliceAnsi(rows[row]!, card.width);
      if (panel && row >= 3 && row < panel.height) rows[row] = sliceAnsi(rows[row]!, 0, panel.column) + " ".repeat(panel.width) + sliceAnsi(rows[row]!, panel.column + panel.width);
    }
    const id = crypto.randomUUID();
    this.driveTargets.clear();
    const controls: DriveObservation["controls"] = [];
    if (this.mode !== "approval") for (const [index, zone] of this.mouseZones.entries()) {
      const column = zone.column ?? 0, width = Math.min(zone.width ?? this.layout.width, this.layout.width - column);
      if (!zone.driveAllowed || zone.row < 0 || zone.row >= rows.length || column < 0 || width < 1) continue;
      const target = `control-${index}`;
      controls.push({ id: target, label: stripVTControlCharacters(sliceAnsi(rows[zone.row]!, column, column + width)).trim(), row: zone.row, column, width });
      this.driveTargets.set(target, zone);
      if (controls.length === 160) break;
    }
    this.driveSnapshot = { id, revision: this.inputRevision, scrollRevision: this.scrollRevision };
    const preview = this.preview?.open && !this.sessionView.panelOpen && this.mode === "input";
    const driveGeometry = sessionPanelLayout(this.layout.width, true);
    return { id, sessionId: this.sessionId ?? "", workspace: this.options.contextRail.workspacePath, title: this.sessionTitle,
      mode: this.mode, ready: this.mode === "dialog" ? /^Recent sessions$|^Sessions matching /.test(this.dialogTitle) : this.mode === "input" && !!this.promptResolver,
      draft: this.mode === "streaming" ? this.options.queue.get() : this.editor.value,
      ...this.driveView(), panes: this.drivePanes.map((pane) => ({ ...pane })),
      navigation: { ...this.sessionView.driveNavigation, document: `${this.driveDocumentId}:${this.driveDocumentRevision}`, readingHeld: this.driveReadingHeld },
      width: this.layout.width, height: this.layout.height, rows, controls,
      scrollRegions: this.sessionView.driveScrollRegions.filter((region) => region.height > 0 && region.width > 0 && this.drivePanes.some((pane) =>
        (region.surface === pane.surface || region.surface.startsWith(`${pane.surface}-`)) && region.row >= pane.row && region.row + region.height <= pane.row + pane.height
        && region.column >= pane.column && region.column + region.width <= pane.column + pane.width)),
      answerRows: this.drivePanes.some((pane) => pane.surface === "response") ? this.sessionView.answerEvidenceRows.map((row) => stripVTControlCharacters(row).trim())
        .filter((text) => text && rows.some((row) => row.includes(text))) : [],
      latestAnswerRows: this.drivePanes.some((pane) => pane.surface === "response") ? this.sessionView.latestAnswerEvidenceRows.map((row) => stripVTControlCharacters(row).trim())
        .filter((text) => text && rows.some((row) => row.includes(text))) : [],
      ...(this.sessionView.driveOpen ? { evidenceRows: driveGeometry.overlay ? [] : rows.map((row) => sliceAnsi(row, 0, driveGeometry.conversationWidth)) } : {}),
      ...(preview && this.preview?.selected ? { artifactId: this.preview.selected.id } : {}) };
  }

  async performDrive(action: DriveAction, observation: DriveObservation, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const revision = this.inputRevision, scrollRevision = this.scrollRevision;
    const unchanged = () => this.inputRevision === revision && this.sessionId === observation.sessionId && this.mode === observation.mode
      // Reading elsewhere does not change text already being typed into the
      // composer. Other actions must re-observe after the viewport moves.
      && (action.kind === "compose" || this.scrollRevision === scrollRevision)
      && (!this.started || process.stdout.columns === observation.width && process.stdout.rows === observation.height);
    // Typing into an empty composer of the same session does not depend on the
    // rest of the screen, so a long decision does not cancel its own message
    // because something unrelated (a key, a title, a render) changed meanwhile.
    const composeReady = action.kind === "compose" && this.sessionId === observation.sessionId && this.mode === "input" && observation.mode === "input";
    if (!composeReady && (this.driveSnapshot?.id !== observation.id || this.driveSnapshot.revision !== revision || this.driveSnapshot.scrollRevision !== scrollRevision || !unchanged())
      || this.mode === "approval" || this.mode === "streaming" || this.editor.value.trim())
      return "UI changed since observation; inspect again before acting.";
    if (this.mode === "dialog" && !/^Recent sessions$|^Sessions matching /.test(this.dialogTitle)) throw new Error("Drive can navigate the sessions picker only.");
    const wait = async (milliseconds: number): Promise<void> => {
      await (this.options.drive?.waitForFrame ?? waitForDriveFrame)(milliseconds, signal);
      signal.throwIfAborted();
    };
    const route = (run: () => void): void => {
      this.driveDispatch = true;
      try { run(); } finally { this.driveDispatch = false; }
    };
    let performed = false;
    try {
      if (action.kind === "inspect") {
        if (this.driveReadingHeld) return "UI changed: inspection deferred while you hold scrollback. Live resumes controller inspection.";
        this.showDriveFeedback(`Controller · inspect ${action.target}`);
        await wait(250);
        if (!unchanged()) return "UI changed before inspection; observe again before navigating.";
        route(() => {
          if (this.preview) { this.preview.open = false; this.preview.focused = false; }
          this.sessionView.inspectDrive(action);
        }); performed = true;
        return this.driveActionResult(`Opened ${action.target} for controller inspection.`, observation);
      }
      if (action.kind === "compose") {
        if (this.mode !== "input" || !this.promptResolver || !driveComposerAllowed(action.text)) throw new Error("Composer is not ready for this Drive instruction.");
        const safe = sanitizeTerminalText(action.text);
        if (safe !== action.text) throw new Error("Drive instructions cannot contain terminal control characters.");
        // A whitespace-only draft (a stray newline) holds nothing to preserve.
        if (this.editor.value) this.editor = setPromptValue(this.editor, "");
        this.sessionView.focusInput();
        this.showDriveFeedback("Typing in composer");
        let inserted = "";
        // If Drive stops partway, its own half-typed text is removed; text a
        // person added is theirs and stays.
        const abandon = (): string => {
          if (inserted && this.editor.value === inserted && this.mode === "input") { this.editor = setPromptValue(this.editor, ""); this.requestRender(); return "Input changed; Drive's partial text was cleared without sending."; }
          return "Input changed; composed draft preserved without sending.";
        };
        for (const chunk of reducedMotionEnabled() ? [safe] : driveTypingChunks(safe)) {
          if (!unchanged() || this.editor.value !== inserted || !this.promptResolver) return abandon();
          this.applyEditorResult(reducePromptEditor(this.editor, { text: chunk, key: {}, commands: [], history: [] }));
          this.editor = { ...this.editor, menuDismissed: true };
          inserted += chunk; this.render();
          await wait(60);
        }
        this.showDriveFeedback("Sending · Enter");
        await wait(650);
        if (!unchanged() || this.editor.value !== safe || !this.promptResolver) return abandon();
        // Inspection performed by Drive must not pin the working agent behind
        // an old turn or a utility pane. Human scrollback remains a reading hold.
        const startsWork = !safe.trimStart().startsWith("/") || /^\/plan\s+\S/.test(safe.trimStart());
        if (startsWork && !this.driveReadingHeld && this.scrollRevision === scrollRevision) {
          this.sessionView.act({ kind: "follow" });
          if (this.preview) { this.preview.open = false; this.preview.focused = false; }
        }
        route(() => this.dispatchEditorKey({ name: "return" })); performed = true;
        this.showDriveFeedback("Sent through composer");
        return `Sent through the visible composer: ${safe.slice(0, 500)}`;
      }
      if (action.kind === "click") {
        const zone = this.driveTargets.get(action.target);
        if (!zone) throw new Error("Drive selected a control absent from the observation.");
        const target = observation.controls.find((control) => control.id === action.target)!;
        this.showDriveFeedback(`Click · ${target.label || action.target}`, target);
        await wait(450);
        if (!unchanged()) return "UI changed before the click; inspect again before acting.";
        // Re-render to catch asynchronous changes, then match the exact action.
        if (this.started) this.render(); else this.frame(this.layout.width, this.layout.height);
        const current = this.mouseZones.find((item) => item.driveAllowed && item.row === zone.row && item.column === zone.column && item.width === zone.width && item.identity === zone.identity);
        if (!current) return "Control moved since observation; inspect again before clicking.";
        route(() => current.run(current.column)); performed = true;
        this.showDriveFeedback(`Clicked · ${target.label || action.target}`);
        return this.driveActionResult(`Clicked ${target.label || action.target}.`, observation);
      }
      if (action.kind === "key") {
        const parts = action.key.split("+");
        this.showDriveFeedback(`Key · ${action.key}`);
        await wait(350);
        if (!unchanged()) return "UI changed before the keypress; inspect again before acting.";
        const draft = this.editor.value;
        route(() => this.onKeypress("", { name: parts.at(-1)!, ctrl: parts.includes("ctrl"), meta: parts.includes("alt"), shift: parts.includes("shift") })); performed = true;
        // Keys navigate; a key that only typed into the composer (a newline)
        // is undone, so Drive never leaves itself a draft it then refuses.
        if (this.mode === "input" && !draft && this.editor.value) {
          this.editor = setPromptValue(this.editor, ""); this.requestRender();
          return this.driveActionResult(`Pressed ${action.key}: it only typed into the composer, so that was undone. It has no other effect here.`, observation);
        }
        this.showDriveFeedback(`Pressed · ${action.key}`);
        return this.driveActionResult(`Pressed ${action.key}.`, observation);
      }
      if (action.kind === "scroll") {
        if (action.row >= observation.height || action.column >= observation.width) throw new Error("Scroll target is outside the visible terminal.");
        this.showDriveFeedback(`Scroll ${action.amount > 0 ? "down" : "up"} · ${Math.abs(action.amount)} rows`, { row: action.row, column: action.column, width: 1 });
        await wait(350);
        if (!unchanged()) return "UI changed before scrolling; inspect again before acting.";
        let scrolled = false;
        route(() => {
          if (this.mode === "dialog") {
            const previous = this.dialogSelected;
            this.onKeypress("", { name: action.amount > 0 ? "down" : "up" });
            scrolled = previous !== this.dialogSelected;
          } else scrolled = this.sessionView.wheel(action.row, action.column, action.amount);
        }); performed = true;
        this.showDriveFeedback(`Scrolled ${action.amount > 0 ? "down" : "up"} · ${Math.abs(action.amount)} rows`);
        return this.driveActionResult(scrolled ? `Scrolled ${action.amount} rows.` : "Scroll did not move the target; it is at a boundary or outside a scrollable pane.", observation);
      }
      return "No UI action.";
    } finally {
      if (performed && !signal.aborted) {
        this.driveFeedbackTimer = setTimeout(() => this.clearDriveFeedback(), 1400); this.driveFeedbackTimer.unref();
      } else this.clearDriveFeedback();
    }
  }

  private showDriveFeedback(label: string, target?: DriveFeedback["target"]): void {
    if (this.driveFeedbackTimer) clearTimeout(this.driveFeedbackTimer);
    this.driveFeedbackTimer = null;
    this.driveFeedback = { label, target }; this.render();
  }

  private clearDriveFeedback(): void {
    if (this.driveFeedbackTimer) clearTimeout(this.driveFeedbackTimer);
    this.driveFeedbackTimer = null;
    if (this.driveFeedback) { this.driveFeedback = null; this.requestRender(); }
  }

  private withDriveFeedback(frame: { rows: string[]; cursor: { row: number; column: number } | null }) {
    return this.driveFeedback ? { ...frame, rows: drawDriveFeedback(frame.rows, this.layout.width, this.layout.input.width, this.options.paint, this.driveFeedback) } : frame;
  }

  start(): void {
    if (this.started || !process.stdout.isTTY) return;
    this.started = true;
    this.terminalFocused = true;
    this.clockSecond = Math.floor(Date.now() / 1000);
    this.previousRows = []; this.previousCursor = null;
    process.stdout.write(`\x1b[22;0t\x1b]2;demesne\x07\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J${MOUSE_ENABLE}${PASTE_ENABLE}${FOCUS_ENABLE}`);
    const input = process.stdin;
    // Only non-mouse bytes reach our isolated keypress stream.
    input.on("data", this.onData);
    emitKeypressEvents(this.keyboard);
    input.setRawMode(true);
    input.resume();
    this.keyboard.on("keypress", this.onKeypress);
    if (this.preview && this.options.paint.enabled) {
      this.graphicsReady = false; this.cellSize = null; this.probeUntil = Date.now() + 1500;
      process.stdout.write(graphicsProbe(this.graphics.imageId));
    }
    process.stdout.on("resize", this.onResize);
    this.animationTimer = setInterval(() => {
      const second = Math.floor(Date.now() / 1000);
      if (second !== this.clockSecond || this.mode === "streaming" && !reducedMotionEnabled()) this.requestRender();
      this.clockSecond = second;
    }, 120);
    this.animationTimer.unref();
    this.render();
  }

  stop(): void {
    this.clearDriveFeedback();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = null;
    if (!this.started) return;
    this.started = false;
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = null;
    const input = process.stdin;
    this.keyboard.removeListener("keypress", this.onKeypress);
    this.mouseCarry = "";
    this.terminalInput.reset();
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    input.removeListener("data", this.onData);
    process.stdout.removeListener("resize", this.onResize);
    input.setRawMode(false);
    this.sessionView.hover(-1, -1);
    this.startScreen.hover(-1, -1);
    this.preview?.cancel();
    const background = this.terminalBackground ? "\x1b]111\x07" : "";
    this.terminalBackground = null;
    process.stdout.write(this.graphics.clear() + `\x1b[?2026l\x1b[?7h\x1b[?25h${MOUSE_DISABLE}${PASTE_DISABLE}${FOCUS_DISABLE}\x1b[?1049l\x1b[23;0t${background}`);
  }

  setSessionTitle(title: string): void {
    this.sessionTitle = title;
    this.recentSessions = this.recentSessions.map((session) => session.id === this.sessionId ? { ...session, title } : session);
    this.requestRender();
  }

  addArtifact(artifact: ImageArtifact): void {
    this.preview?.add(artifact, !this.sessionView.panelOpen && (process.stdout.columns ?? 80) >= 100);
  }

  setArtifactSession(sessionId: string): void { this.preview?.reset(sessionId); }

  setRecentSessions(sessions: readonly RecentSession[], state: "loading" | "ready" | "unavailable" = "ready"): void {
    this.recentSessions = [...sessions]; this.recentState = state;
    this.sessionView.recentSessions = this.recentSessions.filter((session) => session.id !== this.sessionId);
    this.requestRender();
  }

  setMentionFiles(files: readonly string[]): void {
    this.promptContext = { ...this.promptContext, mentions: files };
    this.requestRender();
  }

  private get showingStart(): boolean {
    return this.sessionLayout && this.mode === "input" && !this.sessionView.panelOpen && !this.preview?.open
      && !this.entries.some((entry) => entry.type === "user" || entry.type === "assistant" || entry.type === "reasoning" || entry.type === "tool");
  }

  restoreSession(state: SessionStateResponse, events: readonly EventEnvelope[] = []): void {
    this.driveDocumentRevision++;
    this.inputRevision++;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = null;
    this.turnStartedAt = null;
    const latest = [...state.session.turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (latest?.status === "running" || latest?.status === "queued") {
      const start = Date.parse(latest.createdAt);
      if (Number.isFinite(start)) this.turnStartedAt = start;
    }
    this.state = "idle";
    this.entries = restoreSessionEntries(state, events);
    this.nextId = (this.entries.at(-1)?.id ?? 0) + 1;
    this.sessionTitle = state.session.title;
    if (this.sessionId !== state.session.id) this.sessionOpenedAt = Date.now();
    this.sessionCreatedAt = Date.parse(state.session.createdAt) || this.sessionOpenedAt;
    this.sessionId = state.session.id;
    this.preview?.reset(state.session.id);
    this.startScreen.reset(); this.startLayout = null;
    this.options.workspaceRoot = state.session.workspace?.root;
    this.sessionView.reset();
    this.driveReadingHeld = false;
    this.sheet = null; this.inspectorFocused = false; this.selectedTurnId = null;
    this.inspectorOffset = 0; this.sectionFocus = null;
    this.rendered.clear(); this.collapsedSections.clear(); this.expandedTools.clear(); this.expandedResponses.clear(); this.expandedReasoning.clear();
    this.viewport.setLines([]); this.viewport.toBottom();
    this.options.queue.set(""); this.queuedEditor = createPromptEditorState();
    this.feedback = null;
    this.requestRender();
  }

  setFooter(left: string, right: string): void {
    this.footerLeft = left;
    this.footerRight = right;
    this.requestRender();
  }

  /// Drives the animated marks. Motion is confined to the active turn so
  /// settled scrollback stays still.
  setPresence(state: PresenceState): void {
    if (this.state === state) return;
    this.state = state;
    this.requestRender();
  }

  setAmbient(lines: readonly string[]): void {
    this.ambient = [...lines];
    this.requestRender();
  }

  tick(): void {
    this.requestRender();
  }

  refresh(): void {
    this.previousRows = [];
    this.requestRender();
  }

  notice(text: string, tone: "info" | "success" | "error" = "info"): void {
    this.driveDocumentRevision++;
    this.entries.push({ id: this.nextId++, type: "notice", text, tone });
    this.feedback = { text, tone };
    this.requestRender();
  }

  /// Command output that already draws its own opener and grid. Rendered
  /// verbatim: adding the turn rail here double-indented the panel and forced
  /// its opener to truncate.
  showPanel(lines: readonly string[], options: { open?: boolean; title?: string; files?: import("@demesne/protocol").WorkspaceFileInfo[] } = {}): void {
    this.driveDocumentRevision++;
    if (lines.length === 0) return;
    const id = this.nextId++;
    this.entries.push({ id, type: "panel", lines: [...lines], title: options.title, files: options.files });
    if (this.sessionLayout && options.open !== false) this.sessionView.presentOutput(id);
    this.requestRender();
  }

  showBlock(lines: readonly string[]): void {
    this.driveDocumentRevision++;
    if (lines.length === 0) return;
    const id = this.nextId++;
    this.entries.push({ id, type: "block", lines: [...lines] });
    if (this.sessionLayout) this.sessionView.presentOutput(id);
    this.requestRender();
  }

  bindTurnId(turnId: string): void {
    const request=this.entries.findLast(entry=>entry.type === "user");
    if (request?.type === "user") { request.turnId=turnId; this.requestRender(); }
  }
  beginTurn(options: { userText: string; at: string; planOnly?: boolean; compaction?: boolean }): void {
    this.driveDocumentRevision++;
    this.mode = "streaming";
    this.state = "thinking";
    this.turnStartedAt = Date.now();
    this.feedback = null;
    this.sessionView.dismissOutput();
    this.entries.push({ id: this.nextId++, type: "user", text: options.userText, at: options.at, startedAt: this.turnStartedAt, model: this.options.contextRail.modelId, planOnly: options.planOnly ?? false, compaction: options.compaction });
    if (options.planOnly) this.notice("plan · read-only tools · proposals before changes");
    if (options.compaction) this.feedback = { text: "Compacting older context · keeping the latest two turns · Esc Esc / Ctrl+C stops", tone: "info" };
    this.requestRender();
  }

  reasoningDelta(delta: string): void {
    this.driveDocumentRevision++;
    this.state = "reasoning";
    let entry = this.entries.findLast(
      (candidate): candidate is ReasoningEntry => candidate.type === "reasoning" && candidate.streaming,
    );
    if (!entry) {
      entry = { id: this.nextId++, type: "reasoning", raw: "", streaming: true, startedAt: Date.now(), durationMs: null };
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

  assistantDelta(delta: string, at?: string): void {
    this.driveDocumentRevision++;
    if (!delta) return;
    this.state = "writing";
    // The entry belongs to the current model round; only `beginRound` and
    // `finishTurn` close it. Closing on tool events split a single sentence
    // whenever the pacer flushed after the tool call arrived.
    let entry = this.entries.findLast(
      (candidate): candidate is AssistantEntry => candidate.type === "assistant" && candidate.streaming,
    );
    if (!entry) {
      entry = { id: this.nextId++, type: "assistant", raw: "", streaming: true, revision: 0, at: at ?? new Date(Date.now()).toISOString() };
      this.entries.push(entry);
    }
    this.closeReasoning();
    entry.raw += delta;
    entry.revision += 1;
    this.requestRender();
  }

  /// Closes the previous round's prose so the next round starts a new
  /// paragraph. Called on `model.request_started`.
  beginRound(): void {
    this.state = "thinking";
    this.closeReasoning();
    this.finishAssistant();
  }

  finishAssistant(): void {
    this.driveDocumentRevision++;
    for (const entry of this.entries) {
      if (entry.type === "assistant" && entry.streaming) entry.streaming = false;
    }
    this.requestRender();
  }

  toolDraft(event: EventEnvelope): void {
    this.closeReasoning(); this.finishAssistant();
    applyToolDraft(this.entries, event.payload, () => this.nextId++, Date.parse(event.occurredAt));
    this.state = "working";
    this.requestRender();
  }

  toolRequested(input: { toolCallId: string; name: string; arguments: unknown; draftId?: string }): void {
    // The caller drains the pacer before this, so the round's prose is
    // complete: stop its caret and animation. The entry stays open as the same
    // paragraph, and `beginRound` separates it from the next round's prose.
    this.closeReasoning();
    this.finishAssistant();
    const parsed = parseArguments(input.arguments);
    this.state = presenceForTool(input.name, classifyTurnPhase(input.name, parsed, this.hasChanges()) === "verify");
    const draft = input.draftId ? this.entries.findLast((entry): entry is ToolEntry => entry.type === "tool" && entry.draftId === input.draftId) : undefined;
    const record: ToolEntry = {
      id: draft?.id ?? this.nextId++,
      type: "tool",
      toolCallId: input.toolCallId,
      name: input.name,
      input: parsed,
      detail: toolDetail(input.name, parsed),
      state: "running",
      startedAt: draft?.startedAt ?? Date.now(),
      phase: classifyTurnPhase(input.name, parsed, this.hasChanges()),
      diff: proposedDiff(input.name, parsed),
      ...(input.draftId ? { draftId: input.draftId, drafting: false, draftArguments: undefined } : {}),
    };
    if (draft) Object.assign(draft, record); else this.entries.push(record);
    this.requestRender();
  }

  private hasChanges(): boolean {
    return this.currentEntries().some((entry) => entry.type === "tool" && entry.phase === "change");
  }

  toolFinished(input: {
    toolCallId: string;
    name: string;
    state: ToolState;
    durationMs?: number;
    message?: string;
    exitCode?: number;
    created?: boolean;
    changes?: import("@demesne/protocol").ToolFileChange[];
  }): void {
    this.driveDocumentRevision++;
    const entry = this.entries.findLast(
      (candidate): candidate is ToolEntry => candidate.type === "tool" && candidate.toolCallId === input.toolCallId,
    );
    if (!entry) return;
    entry.state = input.state;
    entry.waiting = false;
    entry.durationMs = input.durationMs ?? Math.max(0, Date.now() - entry.startedAt);
    if (input.message) entry.message = input.message;
    if (input.exitCode !== undefined) entry.exitCode = input.exitCode;
    if (input.created !== undefined) entry.created = input.created;
    if (input.changes) entry.changes = input.changes;
    this.requestRender();
  }

  /// Marks a tool call as blocked on approval so it renders as an anticipatory
  /// row instead of a running one.
  toolWaiting(toolCallId: string, waiting: boolean): void {
    this.driveDocumentRevision++;
    const entry = this.entries.findLast(
      (candidate): candidate is ToolEntry => candidate.type === "tool" && candidate.toolCallId === toolCallId,
    );
    if (!entry) return;
    entry.waiting = waiting;
    this.requestRender();
  }

  finishTurn(status: "completed" | "stopped" | "failed", summary: string, measured: Partial<Pick<ResponseReceipt, "durationMs" | "tokensPerSecond">> = {}): void {
    const durationMs = this.turnStartedAt === null ? null : Math.max(0, Date.now() - this.turnStartedAt);
    this.turnStartedAt = null;
    this.state = status === "completed" ? "done" : status === "stopped" ? "stopped" : "error";
    this.closeReasoning();
    this.finishAssistant();
    const entries = this.currentEntries();
    const request = entries.find((entry) => entry.type === "user");
    if (request?.compaction) this.feedback = null;
    const answer = entries.findLast((entry) => entry.type === "assistant");
    const lastTool = entries.findLast((entry) => entry.type === "tool");
    const receipt: ResponseReceipt = {
      mode: request?.compaction ? "Compact" : request?.planOnly ? "Plan" : "Build", model: this.options.contextRail.modelId,
      durationMs: measured.durationMs === undefined ? durationMs : measured.durationMs,
      tokensPerSecond: measured.tokensPerSecond === undefined ? this.options.contextRail.tokensPerSecond : measured.tokensPerSecond,
      context: this.options.contextRail.contextSnapshot,
    };
    if (answer && !answer.receipt && answer.id > (lastTool?.id ?? -1)) answer.receipt = receipt;
    for (const entry of entries) {
      if (entry.type === "tool" && entry.state === "running") {
        entry.state = status === "stopped" ? "stopped" : "failed";
        entry.waiting = false;
        entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
        entry.message = status === "stopped" ? "Stopped before a result was recorded." : "The run ended before a result was recorded.";
      }
    }
    if (this.mode === "streaming") this.mode = "input";
    this.entries.push({
      id: this.nextId++,
      type: "notice",
      text: summary,
      tone: status === "completed" ? "success" : status === "failed" ? "error" : "info",
      closesTurn: true,
      receipt,
    });
    this.requestRender();
  }

  contextEvent(event: EventEnvelope): void {
    this.options.contextRail.apply(event);
    this.requestRender();
  }

  readPrompt(context: PromptContext): Promise<string> {
    this.promptContext = context;
    this.mode = "input";
    if (this.showingStart) this.sessionView.focusInput();
    this.editor = createPromptEditorState();
    const draft = context.draft || this.savedDraft;
    this.restoredDraft = Boolean(context.draft) || Boolean(this.savedDraft) && this.savedDraftRestored;
    this.savedDraftRestored = false;
    if (draft) {
      this.editor = setPromptValue(this.editor, draft);
      this.savedDraft = "";
    }
    this.requestRender();
    return new Promise((resolve) => {
      this.promptResolver = resolve;
    });
  }

  /// Shows the agent's questions one at a time and resolves with every answer
  /// once the last is answered, or with the rest skipped on Esc.
  askQuestions(questions: readonly UserQuestion[]): Promise<UserAnswer[]> {
    this.mode = "approval";
    this.requestRender();
    return new Promise((resolve) => { this.question = { state: createQuestionPrompt(questions), resolve }; this.requestRender(); });
  }

  private answerQuestions(answers: UserAnswer[]): void {
    const pending = this.question;
    this.question = null;
    this.mode = "streaming";
    this.requestRender();
    pending?.resolve(answers);
  }

  askApproval(request: ApprovalRequest): Promise<PermissionDecision> {
    this.approval = request;
    this.approvalSelected = approvalOptions(true, request.allowPersist, request.toolName === "run_command").selectedIndex;
    this.mode = "approval";
    this.requestRender();
    return new Promise((resolve) => {
      this.approvalResolver = resolve;
    });
  }

  /// Temporarily restores the normal screen for an external editor.
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

  choose(title: string, items: readonly string[], selectedIndex = 0, options: ChooseOptions = {}): Promise<number | null> {
    this.dialogTitle = title;
    this.dialogOptions = options;
    this.dialogItems = items.map(stripVTControlCharacters);
    this.dialogQuery = "";
    this.dialogFiltered = filterDialogIndices(this.dialogItems, "");
    this.dialogSelected = Math.max(0, Math.min(selectedIndex, Math.max(0, this.dialogFiltered.length - 1)));
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
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string },
    fromScroll = false,
  ): void => {
    if (!this.driveDispatch && !fromScroll) {
      this.inputRevision++;
      // Opening or reading Drive's own progress panel is observation, not a
      // takeover of the conversation. Still invalidate stale UI targets.
      const driveShortcut = this.driveShortcut(text, key);
      const drivePanelKey = this.options.drive && (driveShortcut !== null || key.meta && key.name === "j" && this.mode !== "dialog"
        || this.sessionView.driveOpen && !key.ctrl && !key.meta
          && (key.name === "escape" || this.sessionView.focused && ["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name ?? ""))
        || this.sessionView.driveOpen && key.ctrl && key.name === "g");
      const resumeReading = this.driveReadingHeld && key.ctrl && key.name === "g" && !this.sessionView.panelOpen && !this.preview?.open
        && (this.mode === "input" || this.mode === "streaming");
      if (this.mode !== "approval" && !drivePanelKey && !resumeReading) this.options.drive?.intervene();
    }
    // Readline emits the terminal's Ctrl+_ / Ctrl+/ byte without a key name.
    if (text === "\x1f") key = { ...key, name: "_", ctrl: true };
    if (this.handleModalKey(text, key)) return;
    if (key.meta && key.name === "j" && this.options.drive) { this.openRailAction("drive"); return; }
    if (key.meta && key.name === "v" && this.preview) {
      if (this.sessionView.panelOpen) this.preview.open = false;
      this.sessionView.act({ kind: "panel-close" }); this.preview.toggle(); this.requestRender(); return;
    }
    if (this.preview?.key(key.name ?? "", key.shift)) return;
    if (text && !key.ctrl && !key.meta && this.preview) this.preview.focused = false;
    if (this.mode === "input" && this.editor.search) {
      this.sessionView.focusInput();
      this.applyEditorResult(reducePromptEditor(this.editor, { key, text, commands: [], history: this.promptContext.history }));
      return;
    }
    if (this.sessionLayout && this.mode === "input" && !key.ctrl && !key.meta && (this.matchingCommands().length || this.matchingMentions().length)
      && ["up", "down", "pageup", "pagedown", "tab", "return", "enter", "escape"].includes(key.name ?? "")) {
      this.sessionView.focusInput();
      this.dispatchEditorKey(key);
      return;
    }
    // Figma 85:697 footer keys: P pauses or resumes and S stops, but only while
    // the Drive panel has focus and the draft is empty, so typing still types.
    const driveKey = this.driveShortcut(text, key);
    if (driveKey) {
      try { this.options.drive?.control(driveKey); } catch (error) { this.notice(error instanceof Error ? error.message : "Drive could not change state.", "error"); }
      this.requestRender(); return;
    }
    // The file viewer's own keys (v n p /) and its search, like Drive's P/S.
    if (this.sessionLayout && (this.mode === "input" || this.mode === "streaming") && this.sessionView.viewerKey(text ?? "", key, !(this.mode === "streaming" ? this.queuedEditor : this.editor).value)) { this.requestRender(); return; }
    // Inspection never consumes ordinary typing. Editing resumes in the draft
    // at its existing cursor, while the selected evidence stays open.
    if (this.sessionLayout && !key.ctrl && !key.meta && text && /^[^\x00-\x1f\x7f]+$/u.test(text)) this.sessionView.focusInput();
    if (this.sessionLayout && (key.ctrl && ["a", "e", "r", "u", "k", "w", "o", "j", "_", "underscore", "/"].includes(key.name ?? "") || key.shift && (key.name === "return" || key.name === "enter"))) this.sessionView.focusInput();
    if (this.sessionLayout && (this.mode === "input" || this.mode === "streaming")) {
      this.sessionView.sync(this.entries);
      if (this.mode === "streaming") {
        // An Escape that steps back or closes an open panel is navigation, so
        // it must not arm Esc Esc: backing out twice would stop the turn.
        if (key.name === "escape" && !key.ctrl && escapePresses(key) === 1 && this.sessionView.panelOpen) {
          this.lastInterruptEscapeAt = 0; this.sessionView.key(key); this.requestRender(); return;
        }
        const interrupt = reduceInterruptKey(this.lastInterruptEscapeAt, key, Date.now());
        this.lastInterruptEscapeAt = interrupt.lastEscapeAt;
        if (interrupt.interrupt) { this.options.onInterrupt(); return; }
        if (key.name === "escape") { this.sessionView.key(key); this.requestRender(); return; }
      }
      if (key.meta && key.name === "c") { this.showContext(); return; }
      if (key.meta && key.name === "d") { this.openRailAction("diff"); return; }
      // Alt+O: the Files list (Alt+F moves by word in the composer).
      if (key.meta && key.name === "o") { this.openRailAction("files"); return; }
      if (key.meta && key.name === "p") { this.showWorkspace(); return; }
      if (key.ctrl && key.name === "l") {
        this.sessionLayout = false; this.chatView = false; this.transcriptView = false;
        this.requestRender(); return;
      }
      if (key.ctrl && key.name === "y" && !this.editor.value) {
        this.sessionView.act({ kind: "copy" });
        return;
      }
      if (key.ctrl && key.name === "b") { this.sessionView.act({ kind: "log" }); this.requestRender(); return; }
      if (this.showingStart && this.handleStartKey(key)) return;
      if (this.sessionView.key(key)) { this.requestRender(); return; }
    }
    if ((this.mode === "input" || this.mode === "streaming") && this.sheet && (this.inspectorFocused || !this.layout.sidebar)) {
      if (key.name === "escape" || (key.ctrl && key.name === "t")) { if (!this.layout.sidebar) this.sheet = null; this.inspectorFocused = false; this.requestRender(); return; }
      if (key.name === "tab" || key.name === "left" || key.name === "right") {
        const step = key.name === "left" || key.shift ? 2 : 1;
        this.inspectorTab = INSPECTOR_TABS[(INSPECTOR_TABS.indexOf(this.inspectorTab) + step) % 3]!;
        this.sheet = { kind: "index", selected: 0 }; this.inspectorOffset = 0; this.requestRender(); return;
      }
      if (this.sheet.kind === "index") {
        const items = this.indexEntries();
        if (key.name === "up") this.sheet.selected = Math.max(0, this.sheet.selected - 1);
        if (key.name === "down") this.sheet.selected = Math.min(Math.max(0, items.length - 1), this.sheet.selected + 1);
        if (key.name === "down" || key.name === "up") this.inspectorRevealSelection = true;
        if (key.name === "return" && items[this.sheet.selected]) this.inspectEntry(items[this.sheet.selected]!.id);
      } else {
        if (key.name === "up" || key.name === "pageup") this.sheet.offset = Math.max(0, this.sheet.offset - (key.name === "pageup" ? 10 : 1));
        if (key.name === "down" || key.name === "pagedown") this.sheet.offset += key.name === "pagedown" ? 10 : 1;
        if (key.name === "backspace") this.sheet = { kind: "index", selected: 0 };
      }
      if (key.ctrl && key.name === "c") { if (this.mode === "streaming") this.options.onInterrupt(); else this.options.onExit(); }
      this.requestRender();
      return;
    }
    if ((this.mode === "input" || this.mode === "streaming") && key.ctrl && key.name === "l") {
      if (this.chatView) { this.chatView = false; this.transcriptView = false; }
      else if (!this.transcriptView) this.transcriptView = true;
      else { this.sessionLayout = true; this.chatView = true; this.transcriptView = false; }
      this.sheet = null;
      this.inspectorFocused = false;
      this.sectionFocus = null;
      this.viewport.toBottom();
      this.requestRender();
      return;
    }
    if ((this.mode === "input" || this.mode === "streaming") && key.meta && (key.name === "up" || key.name === "down")) {
      const current = this.sections.findIndex((section) => section.key === this.sectionFocus);
      const index = Math.max(0, Math.min(this.sections.length - 1, current + (key.name === "up" ? -1 : 1)));
      const section = this.sections[index];
      if (section) {
        this.sectionFocus = section.key;
        this.viewport.revealLine(section.row, this.layout.conversation.height - 1);
      }
      this.requestRender();
      return;
    }
    if ((this.mode === "input" || this.mode === "streaming") && this.sectionFocus) {
      if (key.name === "return") { this.sections.find((section) => section.key === this.sectionFocus)?.run(); return; }
      this.sectionFocus = null;
      if (key.name === "escape") { this.requestRender(); return; }
    }
    if (this.mode === "input" && !this.editor.value && key.ctrl && key.name === "k") {
      this.openSettings();
      return;
    }
    if (this.mode === "input" && key.name === "tab" && !this.matchingCommands().length && !mentionTokenAt(this.editor.value, this.editor.cursor)) {
      this.openSettings();
      return;
    }
    if (key.ctrl && key.name === "y" && !this.editor.value) {
      const response = this.entries.findLast((entry): entry is AssistantEntry => entry.type === "assistant");
      if (response) process.stdout.write(`\x1b]52;c;${Buffer.from(response.raw).toString("base64")}\x07`);
      return;
    }
    if (key.ctrl && key.name === "b") {
      this.showAllTools = !this.showAllTools;
      this.requestRender();
      return;
    }
    if (key.ctrl && key.name === "t") {
      this.sheet = this.sheet && !this.layout.sidebar ? null : this.sheet ?? { kind: "index", selected: 0 };
      this.inspectorFocused = Boolean(this.sheet);
      this.requestRender();
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      if (key.name === "pageup") this.viewport.scrollUp(10);
      else this.viewport.scrollDown(10);
      this.requestRender();
      return;
    }
    if (this.mode === "streaming") {
      if (key.name !== "return" && key.name !== "enter" || key.shift) {
        this.syncQueuedEditor();
        const next = reducePromptEditor(this.queuedEditor, { key, text: text ?? "", commands: [], history: [], mentions: [] });
        this.queuedEditor = next.state;
        if (next.action.type === "compose") void this.composeQueuedExternally();
        this.options.queue.set(this.queuedEditor.value);
      }
      const interrupt = reduceInterruptKey(this.lastInterruptEscapeAt, key, Date.now());
      this.lastInterruptEscapeAt = interrupt.lastEscapeAt;
      if (interrupt.interrupt) this.options.onInterrupt();
      this.requestRender();
      return;
    }

    if (key.ctrl && key.name === "x") {
      const last = this.entries.findLast((candidate): candidate is ReasoningEntry => candidate.type === "reasoning");
      if (last) {
        if (this.expandedReasoning.has(last.id)) this.expandedReasoning.delete(last.id);
        else this.expandedReasoning.add(last.id);
        this.requestRender();
      }
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
    this.applyEditorResult(result);
  };

  private handleModalKey(text: string, key: PromptEditorKey): boolean {
    if (this.mode === "approval" && this.question) {
      const result = reduceQuestionPrompt(this.question.state, key, text);
      this.question.state = result.state;
      if ("answers" in result) this.answerQuestions(result.answers);
      else this.requestRender();
      return true;
    }
    if (this.mode === "approval") {
      const next = reduceApprovalSelection(this.approvalSelected, true, key, this.approval?.allowPersist ?? false);
      this.approvalSelected = next.selectedIndex;
      if (next.decision) this.resolveApproval(next.decision);
      else this.requestRender();
      return true;
    }
    if (this.mode === "dialog" && key.name === "tab" && !key.ctrl && !key.meta && this.dialogOptions.groups) {
      // Tab jumps to the first match in the next group, wrapping around.
      const groups = this.dialogOptions.groups;
      const current = groups[this.dialogFiltered[this.dialogSelected] ?? -1];
      const order = this.dialogFiltered.map((index, position) => ({ position, group: groups[index] }));
      const next = order.find((item) => item.position > this.dialogSelected && item.group !== current) ?? order.find((item) => item.group !== current);
      if (next) { this.dialogSelected = next.position; this.requestRender(); }
      return true;
    }
    if (this.mode === "dialog") {
      const next = reduceDialogPicker({ index: this.dialogSelected, query: this.dialogQuery }, this.dialogFiltered.length, key, text);
      this.dialogQuery = next.state.query;
      this.dialogFiltered = filterDialogIndices(this.dialogItems, this.dialogQuery);
      this.dialogSelected = Math.min(next.state.index, Math.max(0, this.dialogFiltered.length - 1));
      if (next.decision === "select") this.finishDialog(this.dialogFiltered[this.dialogSelected] ?? null);
      else if (next.decision === "cancel") this.finishDialog(null);
      else this.requestRender();
      return true;
    }
    return false;
  }

  private syncQueuedEditor(): void {
    if (this.queuedEditor.value !== this.options.queue.get()) this.queuedEditor = setPromptValue(this.queuedEditor, this.options.queue.get());
  }

  private async composeQueuedExternally(): Promise<void> {
    try {
      const edited = await this.suspend(() => composeInEditor(this.options.queue.get(), { env: process.env }));
      this.queuedEditor = setPromptValue(this.queuedEditor, edited);
      this.options.queue.set(edited);
      this.requestRender();
    } catch (error) { this.notice(error instanceof Error ? error.message : "Could not open the editor.", "error"); }
  }

  /// Shared disposition for editor results, whether the key came from the
  /// keyboard or from a synthetic dispatch (a menu click).
  private applyEditorResult(result: PromptEditorResult): void {
    this.editor = result.state;
    // Emptying a restored draft ends it; anything typed afterwards is new.
    if (!this.editor.value.trim()) this.restoredDraft = false;
    if (result.action.type === "cancel") {
      this.options.onExit();
      return;
    }
    if (result.action.type === "submit") {
      if (!result.action.value.trim()) { this.requestRender(); return; }
      this.feedback = null;
      this.restoredDraft = false;
      const resolve = this.promptResolver;
      this.promptResolver = null;
      this.mode = "streaming";
      // Clear the composer: the prompt was sent, and leaving it on screen read
      // as though it had not been. What the user types next is queued for the
      // following turn and is drawn in its place.
      this.editor = createPromptEditorState();
      this.requestRender();
      resolve?.(this.planMode && !result.action.value.startsWith("/") ? `/plan ${result.action.value}` : result.action.value);
      return;
    }
    if (result.action.type === "compose") {
      void this.composeExternally();
      return;
    }
    this.requestRender();
  }

  /// Runs a synthetic key through the prompt editor, for mouse clicks that
  /// accept the menu selection they just activated.
  private dispatchEditorKey(key: PromptEditorKey): void {
    this.applyEditorResult(reducePromptEditor(this.editor, {
      key,
      text: "",
      commands: this.matchingCommands(),
      history: this.promptContext.history,
      mentions: this.promptContext.mentions,
    }));
  }

  private resolveApproval(decision: PermissionDecision): void {
    const resolve = this.approvalResolver;
    this.approvalResolver = null;
    this.approval = null;
    this.mode = "streaming";
    this.requestRender();
    resolve?.(decision);
  }

  private async composeExternally(): Promise<void> {
    try {
      const edited = await this.suspend(() => composeInEditor(this.editor.value, { env: process.env }));
      this.editor = setPromptValue(this.editor, edited);
      this.requestRender();
    } catch (error) { this.notice(error instanceof Error ? error.message : "Could not open the editor.", "error"); }
  }

  private finishDialog(index: number | null): void {
    const resolve = this.dialogResolver;
    this.dialogResolver = null;
    this.dialogItems = [];
    this.dialogFiltered = [];
    this.dialogQuery = "";
    this.mode = "input";
    this.requestRender();
    resolve?.(index);
  }

  /// Split SGR mouse sequences from ordinary input, preserving mixed chunks.
  private readonly onData = (chunk: Buffer | string): void => {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.dispatchTerminalInput(this.terminalInput.push(typeof chunk === "string" ? chunk : this.decoder.write(chunk)));
    if (this.terminalInput.waitingForEscape) this.escapeTimer = setTimeout(() => this.dispatchTerminalInput(this.terminalInput.flushEscape()), 40);
  };

  private dispatchTerminalInput(events: TerminalInput[]): void {
    for (const event of events) {
      if (event.kind === "mouse") this.handleMouse(event.event);
      else if (event.kind === "graphics-reply") {
        if (Date.now() <= this.probeUntil && event.header.split(",").includes(`i=${this.graphics.imageId}`)) {
          this.graphicsReady = event.message === "OK"; this.requestRender();
        }
      } else if (event.kind === "cell-size") {
        if (Date.now() <= this.probeUntil && event.width > 0 && event.height > 0 && event.width < 1000 && event.height < 1000) {
          this.cellSize = { width: event.width, height: event.height }; this.requestRender();
        }
      }
      else if (event.kind === "focus") {
        this.terminalFocused = event.focused;
        if (!event.focused) { this.sessionView.hover(-1, -1); this.startScreen.hover(-1, -1); }
        this.requestRender();
      }
      else if (event.kind === "escape") this.onKeypress(event.sequence, { name: "escape", sequence: event.sequence });
      else if (event.kind === "text") this.keyboard.write(event.text);
      else if (event.kind === "paste" && this.mode !== "approval") {
        this.inputRevision++; this.options.drive?.intervene();
        this.lastInterruptEscapeAt = 0;
        const text = sanitizeTerminalText(event.text.replace(/\r\n|\r/g, "\n"));
        if (this.mode === "dialog") {
          this.dialogQuery += text.replace(/\s+/g, " ");
          this.dialogFiltered = filterDialogIndices(this.dialogItems, this.dialogQuery);
          this.dialogSelected = 0;
        } else {
          this.sessionView.focusInput();
          if (this.mode === "streaming") {
            this.syncQueuedEditor();
            this.queuedEditor = reducePromptEditor(this.queuedEditor, { key: {}, text, commands: [], history: [] }).state;
            this.options.queue.set(this.queuedEditor.value);
          } else this.applyEditorResult(reducePromptEditor(this.editor, { key: {}, text, commands: [], history: [] }));
        }
        this.requestRender();
      }
    }
  }

  private handleMouse(event: MouseEvent): void {
    // Horizontal trackpad noise has no action in these vertical panes.
    if (event.kind === "wheel" && event.direction !== "up" && event.direction !== "down") return;
    // Scrolling is passive inspection, not a takeover. Invalidate screen-based
    // actions without cancelling planning or an in-progress composer entry.
    const drivePanel = this.drivePanelBounds;
    const readingDrive = drivePanel && event.row >= 3 && event.row < drivePanel.height && event.col >= drivePanel.column && event.col < drivePanel.column + drivePanel.width;
    // Drive notes are excluded from observations, and their scrolling leaves
    // actionable panes and fixed controls in place.
    if (!this.driveDispatch && event.kind === "wheel" && !readingDrive) this.scrollRevision++;
    if (!this.driveDispatch && event.kind === "press") {
      this.inputRevision++;
      const control = this.mouseZones.find((zone) => zone.row === event.row && event.col >= (zone.column ?? 0) && event.col < (zone.column ?? 0) + (zone.width ?? this.layout.width));
      const panel = this.drivePanelBounds;
      const overDrive = panel && event.row >= 0 && event.row < panel.height && event.col >= panel.column && event.col < panel.column + panel.width;
      if (this.mode !== "approval" && !control?.driveControl && !overDrive) this.options.drive?.intervene();
    }
    if (event.kind === "move" || event.kind === "drag") {
      const hovered = this.railZones.find((zone) => event.row >= zone.row && event.row < zone.row + zone.height && event.col >= zone.column && event.col < zone.column + zone.width)?.action ?? null;
      if (hovered !== this.railHovered) { this.railHovered = hovered; this.requestRender(); }
    }
    if (event.kind === "press" && this.preview && event.row >= this.layout.input.row) this.preview.focused = false;
    const isMention = Boolean(this.mentionMenuFrame);
    const menu = this.mentionMenuFrame ?? this.commandMenuFrame;
    const matches = isMention ? this.matchingMentions() : this.matchingCommands();
    if (menu && this.mode === "input" && matches.length && event.row >= menu.rect.row && event.row < menu.rect.row + menu.rect.height
      && event.col >= menu.rect.column && event.col < menu.rect.column + menu.rect.width) {
      const item = menu.zones.find((zone) => zone.row === event.row);
      if (event.kind === "wheel") {
        const selected = isMention ? this.editor.mentionSelected : this.editor.menuSelected;
        const index = Math.max(0, Math.min(matches.length - 1, selected + (event.direction === "down" ? 3 : -3)));
        this.editor = { ...this.editor, ...(isMention ? { mentionSelected: index } : { menuSelected: index }) };
      } else if (item && (event.kind === "move" || event.kind === "press" && event.button === 0)) {
        this.editor = { ...this.editor, ...(isMention ? { mentionSelected: item.index } : { menuSelected: item.index }) };
        if (event.kind === "press") { this.sessionView.focusInput(); this.dispatchEditorKey({ name: "return" }); }
      }
      this.requestRender();
      return;
    }
    if (event.kind === "move" || event.kind === "drag") {
      if (this.sessionLayout && this.mode !== "dialog" && this.mode !== "approval" && this.terminalFocused
        && (this.showingStart ? this.startScreen.hover(event.row, event.col) : this.sessionView.hover(event.row, event.col))) this.requestRender();
      return;
    }
    // Double Escape means consecutive input. Inspecting another control with
    // the mouse between Escapes must not turn closing a sheet into Stop.
    this.lastInterruptEscapeAt = 0;
    if ((this.mode === "dialog" || this.mode === "approval") && event.kind === "wheel") {
      this.onKeypress("", { name: event.direction === "down" ? "down" : "up" }, true);
      return;
    }
    if (this.sessionLayout && event.kind === "wheel") {
      if (this.showingStart) return;
      if (this.preview?.open && !this.sessionView.panelOpen) {
        const geometry = sessionPanelLayout(this.layout.width, !this.preview.expanded);
        if (this.preview.expanded || geometry.overlay || event.col >= geometry.conversationWidth) return;
      }
      if (this.sessionView.wheel(event.row, event.col, event.direction === "down" ? 3 : -3)) {
        const panel = this.drivePanelBounds;
        const overDrive = panel && event.row < panel.height && event.col >= panel.column && event.col < panel.column + panel.width;
        if (!this.driveDispatch && !overDrive) this.driveReadingHeld = this.sessionView.paused;
        this.requestRender();
      }
      return;
    }
    if (event.kind === "wheel") {
      const overInspector = this.layout.sidebar ? event.col >= this.layout.sidebar.column : Boolean(this.sheet);
      if (overInspector) {
        const amount = event.direction === "down" ? 3 : -3;
        if (this.sheet?.kind === "detail") this.sheet.offset = Math.max(0, this.sheet.offset + amount);
        else this.inspectorOffset = Math.max(0, this.inspectorOffset + amount);
        this.requestRender();
        return;
      }
      if (event.direction === "down") this.viewport.scrollDown(3);
      else this.viewport.scrollUp(3);
      this.requestRender();
      return;
    }
    if (event.kind !== "press" || event.button !== 0) return;
    const input = this.layout.input;
    if (event.row >= input.row && event.row < input.row + input.height && event.col >= input.column && event.col < input.column + input.width) { this.inspectorFocused = false; this.sessionView.focusInput(); }
    const zone = this.mouseZones.find((zone) => zone.row === event.row && event.col >= (zone.column ?? 0) && event.col < (zone.column ?? 0) + (zone.width ?? this.layout.width));
    if (!zone) { this.requestRender(); return; }
    zone.run(event.col);
  }

  private matchingCommands(): readonly SlashCommand[] {
    if (this.editor.menuDismissed) return [];
    const commands = slashCommandMatches(this.editor.value, this.promptContext.commands);
    return this.sessionLayout ? groupSlashCommands(commands) : commands.slice(0, SLASH_MENU_LIMIT);
  }

  private matchingMentions(): readonly string[] {
    if (this.editor.mentionDismissed || this.editor.search) return [];
    const token = mentionTokenAt(this.editor.value, this.editor.cursor);
    return token ? mentionMatches(this.promptContext.mentions, token.query) : [];
  }

  private requestRender(): void {
    if (!this.started || this.renderTimer) return;
    // Mouse momentum and one provider update can each cause several state
    // changes. Paint the final frame once, rather than its intermediate states.
    this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 16);
    this.renderTimer.unref();
  }

  /// The terminal's own background (OSC 11) follows the theme while demesne
  /// runs, so window padding and cells outside the grid match the page
  /// instead of the terminal theme's color. `stop` restores it (OSC 111).
  private terminalBackground: string | null = null;
  /// The OSC 11 sequence when the page color changed, else "". It goes out
  /// inside the frame's single write, so frames stay atomic.
  private terminalBackgroundSequence(): string {
    const color = this.options.paint.enabled ? this.options.paint.colors.ink : null;
    if (!color || color === this.terminalBackground) return "";
    this.terminalBackground = color;
    return `\x1b]11;${color}\x07`;
  }

  private render(): void {
    if (!this.started) return;
    this.imageIntent = null;
    const frame = this.frame(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    if (this.startLayout ? this.startScreen.animating(Date.now(), this.options.paint.enabled && !reducedMotionEnabled()) : this.sessionView.animating()) this.requestRender();
    const output: string[] = [];
    for (let row = 0; row < frame.rows.length; row += 1) {
      if (this.previousRows[row] === frame.rows[row]) continue;
      // Every row is cell-padded. Clearing it first exposes a blank line on
      // terminals that paint a large write incrementally.
      output.push(`\x1b[${row + 1};1H${frame.rows[row]}`);
    }
    this.previousRows = frame.rows;
    const graphics = this.graphics.update(this.imageIntent);
    if (!output.length && !graphics && frame.cursor?.row === this.previousCursor?.row && frame.cursor?.column === this.previousCursor?.column) return;
    // Synchronized output makes a scroll one visible frame on supporting
    // terminals; the single write and padded rows also work without it.
    output.unshift("\x1b[?2026h\x1b[?25l" + this.terminalBackgroundSequence());
    if (graphics) output.push(graphics);
    if (frame.cursor) {
      output.push(`\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H\x1b[?25h`);
    }
    output.push("\x1b[?2026l");
    this.previousCursor = frame.cursor;
    process.stdout.write(output.join(""));
  }

  /// Production frame composition, also used by deterministic terminal previews.
  frame(width: number, height: number): { rows: string[]; cursor: { row: number; column: number } | null } {
    this.drivePanelBounds = null;
    this.driveCardBounds = null;
    this.drivePanes = [];
    if (this.cachedTheme !== this.options.paint.themeName) {
      this.cachedTheme = this.options.paint.themeName;
      this.rendered.clear();
    }
    if (this.sessionLayout) this.sessionView.sync(this.entries);
    const panel = sessionPanelLayout(Math.max(40, width), (this.sessionView.panelOpen && !this.sessionView.panelExpanded || Boolean(this.preview?.open && !this.preview.expanded)) && (this.mode === "input" || this.mode === "streaming"));
    this.layout = computeWorkbenchLayout(width, height, {
      sidebar: !this.sessionLayout && (this.chatView || this.transcriptView) ? "auto" : "hidden",
      inputLines: this.inputLineCount(this.sessionLayout ? panel.conversationWidth : width, height),
    });
    this.startLayout = this.showingStart ? startScreenLayout(this.layout.width, this.layout.height,
      this.inputLineCount(Math.min(86, this.layout.width - (this.layout.width >= 65 ? 4 : 2))), Boolean(this.feedback)) : null;
    if (this.startLayout) {
      this.layout.input = this.startLayout.input;
    } else if (this.sessionLayout && this.mode === "dialog") {
      // The chooser box fits its list (borders, title, filter, rows, footer),
      // sitting above the status bar so the conversation stays in view.
      const groups = this.dialogOptions.groups ? new Set(this.dialogFiltered.map((index) => this.dialogOptions.groups![index])).size : 0;
      const needed = Math.max(1, this.dialogFiltered.length) + groups + 7;
      const height = Math.max(8, Math.min(this.layout.height - 4, needed));
      this.layout.input = { row: this.layout.height - 1 - height, column: 0, width: panel.conversationWidth, height };
    } else if (this.sessionLayout && (this.mode === "input" || this.mode === "streaming")) {
      const editor = this.mode === "streaming" ? this.queuedEditor : this.editor;
      const selecting = Boolean(editor.search);
      const queued = this.mode === "streaming" && Boolean(editor.value.trim());
      const labelled = queued || this.mode === "input" && this.restoredDraft && Boolean(editor.value.trim());
      const inputHeight = Math.min(this.layout.input.height, Math.max(selecting || labelled ? 4 : 3, Math.floor(this.layout.height / 3)));
      this.layout.input = { row: this.layout.height - 1 - inputHeight, column: 0, width: panel.conversationWidth, height: inputHeight };
    } else if (this.sessionLayout) this.layout.input.width = panel.conversationWidth;
    this.rebuildConversation();
    const frame = this.composeFrame();
    const menuInset = this.startLayout ? 0 : this.layout.input.width >= 65 ? 2 : 1;
    const menuInput = { ...this.layout.input, column: this.layout.input.column + menuInset, width: this.layout.input.width - menuInset * 2 };
    // On the start screen the composer sits under the title, so menus drop
    // down over Start from instead of covering the header (Figma 1:2).
    // Tiny terminals may have no room there, so fall back to opening above.
    const roomBelow = this.layout.height - 1 - (menuInput.row + menuInput.height), roomAbove = menuInput.row - 1;
    const bottom = this.startLayout && (roomBelow >= 5 || roomBelow >= roomAbove) ? this.layout.height - 1 : undefined;
    this.commandMenuFrame = this.sessionLayout && this.mode === "input" && !this.editor.search
      ? this.commandMenu.render({ commands: this.matchingCommands(), selected: this.editor.menuSelected, query: this.editor.value,
        input: menuInput, paint: this.options.paint, top: this.startLayout ? 1 : 2, bottom }) : null;
    const mentionToken = mentionTokenAt(this.editor.value, this.editor.cursor);
    this.mentionMenuFrame = this.sessionLayout && this.mode === "input" && !this.commandMenuFrame
      ? this.mentionMenu.render({ files: this.matchingMentions(), selected: this.editor.mentionSelected, query: mentionToken?.query ?? "",
        searching: Boolean(mentionToken) && !this.editor.mentionDismissed && !this.editor.search && this.promptContext.mentions.length > 0,
        input: menuInput, paint: this.options.paint, top: this.startLayout ? 1 : 2, bottom }) : null;
    if (!this.commandMenuFrame) this.commandMenu.reset();
    if (!this.mentionMenuFrame) this.mentionMenu.reset();
    const menu = this.mentionMenuFrame ?? this.commandMenuFrame;
    if (!menu) return this.withDriveFeedback(frame);
    const canvas = new Canvas(this.layout.width, this.layout.height, this.options.paint);
    frame.rows.forEach((text, row) => canvas.put(row, 0, text, this.layout.width));
    menu.lines.forEach((text, row) => canvas.put(menu.rect.row + row, menu.rect.column, text, menu.rect.width));
    // Occluded transcript controls cannot receive clicks through the popup.
    this.mouseZones = this.mouseZones.filter((zone) => zone.row < menu.rect.row || zone.row >= menu.rect.row + menu.rect.height
      || (zone.column ?? 0) >= menu.rect.column + menu.rect.width || (zone.column ?? 0) + (zone.width ?? this.layout.width) <= menu.rect.column);
    for (const zone of menu.zones) this.mouseZones.push({ row: zone.row, column: menu.rect.column + 1, width: menu.rect.width - 2,
      run: () => {
        if (this.mentionMenuFrame) {
          if (!this.matchingMentions()[zone.index]) return;
          this.editor = { ...this.editor, mentionSelected: zone.index };
        } else this.editor = { ...this.editor, menuSelected: zone.index };
        this.sessionView.focusInput(); this.dispatchEditorKey({ name: "return" });
      } });
    return this.withDriveFeedback({ ...frame, rows: canvas.rows });
  }

  private inputLineCount(columns = process.stdout.columns ?? 80, rows = this.layout.height): number {
    if (this.mode === "approval" && this.question) return this.questionCardRows(columns - (columns >= 65 ? 4 : 2) - 4, this.options.paint, rows >= AIRY_APPROVAL_ROWS).length + 2;
    if (this.mode === "approval") {
      // Title, summary, previews, the sandbox note and one row of choices.
      // Card: borders, title, summary, the inset block and the buttons, plus
      // Figma's blank lines between them when the terminal has room.
      if (this.sessionLayout) return 5 + (this.approval?.toolName === "run_command" ? 2 : Math.min(6, this.approval?.previewRows?.length ?? 0)) + (rows >= AIRY_APPROVAL_ROWS ? 3 : 0);
      // Voice line + permission card + preview rows + selection row.
      return Math.max(7, 6 + (this.approval?.previewRows?.length ?? 0) + 2);
    }
    if (this.mode === "dialog") {
      return 4 + Math.min(this.dialogFiltered.length, 10) + (this.dialogQuery ? 1 : 0);
    }
    if (this.sessionLayout) {
      this.syncQueuedEditor();
      return composerHeight({ width: columns, editor: this.mode === "streaming" ? this.queuedEditor : this.editor,
        hero: this.showingStart, restored: this.restoredDraft,
        streaming: this.mode === "streaming", mentions: this.promptContext.mentions, history: this.promptContext.history });
    }
    const width = Math.max(10, computeWorkbenchLayout(columns, process.stdout.rows ?? 24, { sidebar: this.sessionLayout ? "hidden" : "auto" }).input.width - HARNESS.content - 1);
    const streaming = this.mode === "streaming";
    const value = streaming ? this.options.queue.get() : this.editor.value;
    this.syncQueuedEditor();
    const cursor = streaming ? this.queuedEditor.cursor : this.editor.cursor;
    const valueLines = computePromptVisualLines(value, cursor, width).lines.length;
    const commands = streaming ? 0 : this.matchingCommands().length;
    // The shared menu layout adds a quiet label and a blank line before each
    // of the three sections once the list is long enough to need them.
    const menuLines = commands > 0 ? Math.min(commands, SLASH_MENU_LIMIT) + (commands >= 6 ? 5 : 0) : 0;
    // One rule above the prompt, then the prompt and any menu.
    const mention = mentionTokenAt(value, cursor);
    const mentions = !streaming && mention ? mentionMatches(this.promptContext.mentions, mention.query).length : 0;
    return 4 + Math.max(1, valueLines) + (mentions || menuLines) + (draftMentions(value, this.promptContext.mentions).length ? 1 : 0);
  }

  private rebuildConversation(): void {
    if (this.sessionLayout) { this.sessionView.sync(this.entries); return; }
    const width = this.layout.conversation.width;
    const lines: string[] = [];
    this.conversationActions.clear();
    this.conversationZones = [];
    this.sections = [];
    if (this.chatView) {
      this.rebuildChat(lines, width);
      this.viewport.setLines(lines);
      return;
    }
    if (this.transcriptView) this.appendTranscript(this.entries, lines, width);
    else for (const page of groupActivity(this.entries)) {
      if (page.request) {
        lines.push("", `  ${this.options.paint.bold(String(page.number).padStart(2, "0"), "electric")}   ${this.options.paint.bold("REQUEST", "secondary")}`, "");
        lines.push(...this.renderEntry(page.request, width));
      }
      for (const section of page.sections) {
        const key = `${page.id}:${section.name}`;
        const collapsed = this.collapsedSections.has(key);
        const tools = section.entries.filter((entry): entry is ToolEntry => entry.type === "tool");
        const failed = tools.filter((entry) => toolFailed(entry) || entry.state === "denied").length;
        const checks = evidenceCounts(tools);
        const count = section.name === "Verification"
          ? `${checks.passed} passed${checks.failed ? ` · ${checks.failed} failed` : ""}${checks.pending ? ` · ${checks.pending} running` : ""}${checks.waiting ? ` · ${checks.waiting} awaiting approval` : ""}${checks.blocked ? ` · ${checks.blocked} denied` : ""}${checks.stopped ? ` · ${checks.stopped} stopped` : ""}${checks.unknown ? ` · ${checks.unknown} unknown` : ""}`
          : tools.length ? `${tools.length} ${section.name === "Changes" ? (tools.length === 1 ? "action" : "actions") : (tools.length === 1 ? "record" : "records")}${failed ? ` · ${failed} unsuccessful` : ""}` : "";
        lines.push("");
        const row = lines.length;
        const run = () => {
          if (this.collapsedSections.has(key)) this.collapsedSections.delete(key);
          else this.collapsedSections.add(key);
          this.rebuildConversation();
          const anchor = this.sections.find((section) => section.key === key);
          if (anchor) this.viewport.revealLine(anchor.row, this.layout.conversation.height - 1);
          this.requestRender();
        };
        this.sections.push({ key, row, run });
        this.conversationActions.set(row, run);
        const heading = `${collapsed ? "▸" : "▾"} ${section.name.toUpperCase()}`;
        const paint = this.options.paint;
        lines.push(`      ${this.sectionFocus === key ? paint.wash(heading, "electric") : paint.bold(heading, "electric")} ${paint.text(count, failed ? "signal" : "secondary")}`);
        if (!collapsed) {
          lines.push("");
          this.appendTranscript(section.entries, lines, width);
        }
      }
    }
    this.viewport.setLines(lines);
  }

  private rebuildChat(lines: string[], width: number): void {
    const paint = this.options.paint;
    for (const page of groupActivity(this.entries)) {
      const entries = page.sections.flatMap((section) => section.entries).sort((a, b) => a.id - b.id);
      if (page.request?.type === "user") {
        const body = page.request.text.split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), width - 10));
        lines.push(...userCard(body, width, paint, page.request.at));
      }
      const prose = entries.filter((entry): entry is AssistantEntry => entry.type === "assistant");
      const tools = entries.filter((entry): entry is ToolEntry => entry.type === "tool");
      const close = entries.findLast((entry): entry is NoticeEntry => entry.type === "notice" && Boolean(entry.closesTurn));
      if (prose.length || tools.length || close) {
        const expanded = this.expandedResponses.has(page.id) || this.showAllTools;
        const final = prose.at(-1);
        const answer = final && (!close || final.id > (tools.at(-1)?.id ?? -1)) ? final : undefined;
        const body: string[] = [];
        if (expanded) {
          for (const entry of entries) {
            if (entry.type === "assistant" && entry !== answer) body.push(...this.renderedMarkdown(entry, width - 10), "");
            if (entry.type === "tool") body.push(paint.text(`${entry.waiting ? "!" : entry.state === "stopped" ? "■" : entry.state === "done" && !entry.exitCode ? "✓" : entry.state === "running" ? "·" : "×"} ${sanitizeTerminalLine(entry.detail ?? entry.name)}`, toolFailed(entry) || entry.state === "denied" ? "signal" : "secondary"));
          }
          body.push("");
        }
        if (answer) body.push(...this.renderedMarkdown(answer, width - 10));
        else if (close) body.push(paint.dim("No final answer was recorded."));
        const status = close ? close.tone === "success" ? "Complete" : close.tone === "error" ? "Failed" : "Interrupted" : tools.some((entry) => entry.waiting) ? "Needs your decision" : final?.streaming ? "Writing" : "Working";
        const model = page.request?.type === "user" ? page.request.model ?? "Model not recorded" : this.options.contextRail.modelId;
        const selected = this.selectedTurnId === page.id;
        const card = responseCard({ width, paint, model, status, body, selected, expanded, canCopy: Boolean(answer),
          activity: tools.length || prose.length > 1 ? `${tools.length} tool${tools.length === 1 ? "" : "s"}${prose.length > 1 ? ` · ${prose.length - 1} progress updates` : ""}` : "",
          summary: changeSummary(tools) + (close ? ` · ${sanitizeTerminalLine(close.text)}` : ""),
        });
        const origin = lines.length;
        const select = () => {
          if (this.selectedTurnId !== page.id) { this.sheet = { kind: "index", selected: 0 }; this.inspectorOffset = 0; }
          this.selectedTurnId = page.id;
        };
        for (const action of card.actions) this.conversationZones.push({ row: origin + action.row, column: action.column, width: action.width, run: () => {
          if (action.action === "copy") { if (answer) process.stdout.write(`\x1b]52;c;${Buffer.from(answer.raw).toString("base64")}\x07`); }
          else if (action.action === "activity") {
            if (this.expandedResponses.has(page.id)) this.expandedResponses.delete(page.id); else this.expandedResponses.add(page.id);
            select(); this.inspectorTab = "Activity";
          } else { select(); this.inspectorFocused = true; this.sheet ??= { kind: "index", selected: 0 }; }
          this.requestRender();
        } });
        body.forEach((line, index) => {
          const tool = tools.find((entry) => entry.detail && stripVTControlCharacters(line).includes(entry.detail));
          if (tool) this.conversationZones.push({ row: origin + card.bodyStart + index, column: 4, width: width - 8, run: () => { select(); this.inspectEntry(tool.id); } });
        });
        lines.push(...card.lines);
      }
      for (const entry of entries) if (entry.type === "panel" || entry.type === "block" || (entry.type === "notice" && !entry.closesTurn)) lines.push(...this.renderEntry(entry, width));
    }
  }

  private appendTranscript(entries: WorkbenchEntry[], lines: string[], width: number): void {
    for (const item of planTranscript(entries)) {
      if (item.kind === "group") {
        const first = item.tools[0] as ToolEntry;
        this.conversationActions.set(lines.length, () => {
          if (this.expandedTools.has(first.id)) this.expandedTools.delete(first.id);
          else this.expandedTools.add(first.id);
          this.requestRender();
        });
        lines.push(this.renderToolGroup(item.tools, width));
        if (this.showAllTools || this.expandedTools.has(first.id)) {
          for (const tool of item.tools) lines.push(...this.renderEntry(tool as ToolEntry, width));
        }
        continue;
      }
      if (item.entry.type === "tool") {
        const entry = item.entry as ToolEntry;
        this.conversationActions.set(lines.length, () => {
          if (!this.transcriptView && entry.phase !== "inspect") { this.inspectEntry(entry.id); return; }
          if (this.expandedTools.has(entry.id)) this.expandedTools.delete(entry.id);
          else this.expandedTools.add(entry.id);
          this.requestRender();
        });
      }
      lines.push(...this.renderEntry(item.entry, width));
    }
  }

  /// One row for a run of inspection calls: the first target names what was
  /// looked at, `+n` says how much more, and the meta column carries the total
  /// time. The row is failed if any member failed, so a bad read is never
  /// hidden inside a summary that reads as success.
  private renderToolGroup(entries: PlannedTool[], width: number): string {
    const paint = this.options.paint;
    const first = entries[0]!;
    const running = entries.some((entry) => entry.state === "running" && !entry.waiting);
    const failed = entries.some((entry) => entry.state === "failed");
    const state: ToolRowState = running ? "running" : failed ? "failed" : "done";
    // No animated mark: the footer is the only place the turn's state animates.
    const expanded = this.showAllTools || this.expandedTools.has((first as ToolEntry).id);
    const mark = paint.text(expanded ? "▾" : "▸", "electricBright");
    const total = entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
    const target = first.detail === undefined
      ? `${entries.length} files`
      : `${first.detail} +${entries.length - 1}`;
    const meta = running ? undefined : failed ? "failed" : formatDuration(total, undefined);
    return formatToolRow(state, toolVerb(first.name), target, meta, width, paint, {
      rail: false,
      phase: first.phase,
      ...(mark ? { mark } : {}),
    });
  }

  private renderEntry(entry: WorkbenchEntry, width: number): string[] {
    const paint = this.options.paint;
    const rail = "    ";
    const bar = " ";
    const proseWidth = Math.max(16, width - HARNESS.content);
    switch (entry.type) {
      case "user": {
        const body = entry.text.split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), proseWidth - 2));
        return [...(this.transcriptView ? [`      ${paint.dim(`Request · ${entry.at}`)}`] : []), ...body.map((line) => `      ${line}`), ""];
      }
      case "assistant": {
        const body = entry.raw ? this.renderedMarkdown(entry, proseWidth) : [];
        if (body.length === 0) return [];
        // The model's reply carries no mark. The footer is the only place the
        // turn's state is shown, and a mark here put the same glyph on screen
        // twice at once. Prose is plain text, and every line starts on the
        // content column so a wrapped reply stays flush with its first line.
        const prefix = `${rail}  `;
        return [
          ...(this.transcriptView ? [`      ${paint.dim("Response")}`] : []),
          ...body.map((line) => `${prefix}${line}`),
          "",
        ];
      }
      case "reasoning": {
        const body = wrapDisplayText(sanitizeTerminalLine(entry.raw.trim()), Math.max(8, proseWidth));
        if (entry.streaming) {
          // `⋯` for both the live and settled trace, so reasoning has one glyph
          // in the transcript. It used to animate the footer's reasoning glyph
          // here as well, putting the same mark on screen twice.
          return [
            `${" ".repeat(HARNESS.rail)}${bar} ${paint.text("⋯", "electricBright")} ${paint.dim("thinking")}`,
            ...body.slice(-2).map((line) => `${rail}${paint.dim(line)}`),
          ];
        }
        const duration = ((entry.durationMs ?? 0) / 1_000).toFixed(1);
        const expanded = this.expandedReasoning.has(entry.id);
        const trace = `${rail}${paint.text("⋯", "rule")} `
          + paint.dim(`thought ${duration}s${expanded ? "" : " · ctrl+x"}`);
        return expanded
          ? [trace, ...body.map((line) => `${rail}  ${paint.dim(line)}`)]
          : [trace];
      }
      case "tool": {
        const row = this.renderToolRow(entry, width);
        const expanded = this.showAllTools || this.expandedTools.has(entry.id);
        const diffLines = entry.state === "done" && entry.diff
          ? formatDiffPreview(entry.diff.oldText, entry.diff.newText, 12, paint)
            .map((line) => `${" ".repeat(HARNESS.toolTarget)}${line}`)
          : [];
        const message = entry.state === "failed" && entry.message
          ? [`${" ".repeat(HARNESS.toolTarget)}${paint.text(truncateText(sanitizeTerminalLine(entry.message), Math.max(8, width - HARNESS.toolTarget - HARNESS.gutter)), "signal")}`]
          : [];
        const detail = expanded ? JSON.stringify(entry.input, null, 2).split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), width - 10)).map((line) => `      ${paint.dim(line)}`) : [];
        return [row, ...(expanded ? diffLines : []), ...message, ...detail];
      }
      case "notice": {
        const glyph = entry.tone === "success" ? "✓" : entry.tone === "error" ? "×" : "·";
        if (entry.closesTurn) {
          return [`    ${paint.text(glyph, entry.tone === "error" ? "signal" : "citron")} ${paint.dim(entry.text)}`, ""];
        }
        const color: PaletteColor = entry.tone === "success" ? "citron" : entry.tone === "error" ? "signal" : "secondary";
        return [
          `${rail}${paint.text(glyph, color)} `
            + paint.dim(truncateText(sanitizeTerminalLine(entry.text), Math.max(8, proseWidth - 2))),
        ];
      }
      case "panel":
        return [...entry.lines, ""];
      case "block":
        return [
          ...entry.lines.map((line) => `${rail}${line}`),
          "",
        ];
    }
  }

  /// A tool row is a status mark, a verb, a target, and right-aligned meta.
  ///
  /// The row is structural rather than a sentence: the grid exists for
  /// scanning, and the agent's voice lives in its prose and in the turn
  /// notices. Narration inside this column collided with the verb column and
  /// read as noise.
  private renderToolRow(entry: ToolEntry, width: number): string {
    const paint = this.options.paint;
    const verb = toolVerb(entry.name);
    const running = entry.state === "running" && !entry.waiting;
    const state: ToolRowState = entry.waiting ? "waiting" : entry.state;
    // Settled, running, and waiting rows all use the transcript's own static
    // glyphs; the footer is the only place the turn's state animates.
    const mark = entry.state === "running" ? undefined : paint.text(this.showAllTools || this.expandedTools.has(entry.id) ? "▾" : "▸", "electricBright");
    const meta = entry.waiting
      ? "needs you"
      : running
        ? undefined
        : entry.state === "failed"
          ? "failed"
          : entry.state === "denied"
            ? "denied"
            : entry.state === "stopped" ? "stopped" : formatDuration(entry.durationMs, entry.exitCode);
    if (!this.transcriptView) {
      const failed = toolFailed(entry) || entry.state === "denied";
      const glyph = entry.waiting ? "!" : entry.state === "stopped" ? "■" : failed ? "×" : entry.state === "done" ? "✓" : "·";
      const color = failed ? "signal" : entry.state === "stopped" ? "secondary" : entry.state === "done" ? "citron" : "electric";
      const target = truncateText(sanitizeTerminalLine(entry.detail ?? toolVerb(entry.name)), Math.max(8, width - 30));
      return `      ${paint.text(glyph, color)} ${target}  ${paint.dim(meta ?? "working")}${paint.text("  ↗", "electric")}`;
    }
    return formatToolRow(state, verb, entry.detail, meta, width, paint, {
      rail: false,
      phase: entry.phase,
      ...(mark ? { mark } : {}),
    });
  }

  private renderedMarkdown(entry: AssistantEntry, width: number): string[] {
    const cached = this.rendered.get(entry.id);
    if (cached && cached.revision === entry.revision && cached.width === width && cached.session === this.sessionLayout) return cached.lines;
    const stream = new TerminalMarkdownStream(this.options.paint, Math.max(16, width), 0, true, this.sessionLayout ? "gutter" : "framed");
    // A fresh stream per revision keeps the trailing partial line visible
    // while the model streams; flush() alone would only run at turn end.
    const rendered = `${stream.write(entry.raw)}${stream.flush()}`;
    // Markdown's own block separation and the formatter's block spacing must
    // not accumulate into empty rows. Blank code lines retain their border.
    const result = rendered.split("\n").filter((line, index, lines) => line.trim() || index > 0 && lines[index - 1]!.trim());
    if (!result.at(-1)?.trim()) result.pop();
    this.rendered.set(entry.id, { revision: entry.revision, width, session: this.sessionLayout, lines: result });
    return result;
  }

  private composeFrame(): { rows: string[]; cursor: { row: number; column: number } | null } {
    if (this.sessionLayout) return this.composeSessionFrame();
    const paint = this.options.paint;
    const { layout } = this;
    const rows: string[] = Array.from({ length: layout.height }, () => "");
    this.mouseZones = [];

    const chrome = this.composeHeader(layout.width);
    rows[layout.header.row] = surface(chrome.mark, layout.width, paint, "ink");
    const pages = groupActivity(this.entries);
    const currentPage = pages.at(-1);
    const title = sanitizeTerminalLine(this.sessionTitle);
    rows[layout.header.row + 1] = surface(`  ${paint.bold(String(currentPage?.number || 1).padStart(2, "0"), "electric")}   ${paint.bold(title, "paper")}`, layout.width, paint, "ink");
    rows[layout.header.row + 2] = surface(`       ${paint.text(changeSummary(this.currentEntries()), "secondary")}  ${paint.text("↗ inspect", "electric")}`, layout.width, paint, "ink");
    this.mouseZones.push({ row: layout.header.row + 2, column: 7, width: layout.width - 7, run: () => { this.sheet = { kind: "index", selected: 0 }; this.requestRender(); } });
    // A static rule below the header frames the transcript. The previous
    // animated pulse read as an endless moving line during inference and
    // carried no information, so structure replaces motion here.
    const conversation = this.viewport.visible(Math.max(1, layout.conversation.height - 1));
    if (!this.transcriptView && this.viewport.lineCount < conversation.length) {
      const blanks = conversation.length - this.viewport.lineCount;
      conversation.splice(0, blanks);
      conversation.push(...Array<string>(blanks).fill(""));
    }
    if (this.entries.length === 0) {
      const welcome = ["", `      ${paint.bold("New session", "electricBright")}`, "",
        "      Begin with a question, a problem, or an idea.", "",
        "      Updates, changes, verification, and responses appear here."];
      conversation.splice(0, Math.min(welcome.length, conversation.length), ...welcome.slice(0, conversation.length));
    }
    const viewHeight = Math.max(1, layout.conversation.height - 1);
    const end = this.viewport.lineCount - Math.min(this.viewport.scrollOffset, Math.max(0, this.viewport.lineCount - viewHeight));
    const start = Math.max(0, end - viewHeight);
    const padding = this.transcriptView ? Math.max(0, viewHeight - (end - start)) : 0;
    for (const [line, run] of this.conversationActions) {
      if (line >= start && line < end) this.mouseZones.push({ row: layout.conversation.row + 1 + padding + line - start, column: 0, width: layout.conversation.width, run });
    }
    for (const zone of this.conversationZones) {
      if (zone.row >= start && zone.row < end) this.mouseZones.push({ ...zone, row: layout.conversation.row + 1 + padding + zone.row - start });
    }
    const rule = "";
    for (let index = 0; index < layout.conversation.height; index += 1) {
      const row = layout.conversation.row + index;
      const conversationLine = index === 0
        ? rule
        : truncateText(conversation[index - 1] ?? "", layout.conversation.width);
      rows[row] = surface(conversationLine, layout.width, paint, "ink");
    }

    const input = this.composeInput(layout.input.width);
    for (let index = 0; index < layout.input.height; index += 1) {
      rows[layout.input.row + index] = input.lines[index] ?? "";
    }
    // Input content starts one row down from the composing rule.
    for (const zone of input.zones ?? []) {
      if (zone.row + 1 < layout.input.height) this.mouseZones.push({ ...zone, row: layout.input.row + 1 + zone.row });
    }
    if (!this.chatView && !this.transcriptView && this.sheet) this.composeSheet(rows);
    else if (layout.sidebar || this.sheet) this.composeInspector(rows);
    const navigation = this.inspectorFocused ? "Inspector · Esc return to chat" : this.transcriptView ? "Transcript · Ctrl+L session" : this.chatView ? "Chat · Ctrl+T inspect · Tab settings" : "Activity · Ctrl+L transcript";
    rows[layout.footer.row] = surface(formatFooterLine(this.footerLeft, paint.dim(navigation), layout.width), layout.width, paint, "ink");
    return {
      rows: rows.map((row) => visibleLength(row) === layout.width ? row : surface(row, layout.width, paint, "ink")),
      cursor: (!this.sheet || Boolean(layout.sidebar)) && !this.inspectorFocused && !this.sectionFocus && input.cursor && input.cursor.row < layout.input.height ? { row: layout.input.row + input.cursor.row, column: input.cursor.column } : null,
    };
  }

  private handleStartKey(key: PromptEditorKey): boolean {
    if (key.meta && key.name === "h") { this.runCommand("/sessions"); return true; }
    if (key.ctrl && key.name === "t") {
      this.sessionView.focused = !this.sessionView.focused;
      if (this.sessionView.focused) this.startScreen.move(0);
      this.requestRender(); return true;
    }
    if ((key.ctrl && key.name === "g") || (key.name === "escape" && !key.ctrl && !key.meta && this.sessionView.focused)) {
      this.sessionView.focusInput(); this.requestRender(); return true;
    }
    if (this.sessionView.focused && !key.ctrl && !key.meta) {
      if (["tab", "left", "right", "up", "down"].includes(key.name ?? "")) {
        this.startScreen.move(key.shift || key.name === "left" || key.name === "up" ? -1 : 1);
        this.requestRender(); return true;
      }
      if (key.name === "return" || key.name === "enter") {
        const action = this.startScreen.action;
        if (action) this.actStart(action);
        return true;
      }
    }
    return key.name === "pageup" || key.name === "pagedown";
  }

  private actStart(action: StartAction): void {
    if (this.mode !== "input") return;
    if (action.kind === "operation") {
      const operation = START_OPERATIONS[action.index];
      if (operation) this.editor = setPromptValue({ ...this.editor, search: null, searchDraft: "" }, operation.prompt);
      this.sessionView.focusInput();
    } else if (action.kind === "session") {
      if (action.id !== this.sessionId) this.runCommand(`/resume ${action.id}`);
      else this.sessionView.focusInput();
    } else if (action.kind === "history") this.runCommand("/sessions");
    else if (action.kind === "settings") this.openSettings();
    else if (action.kind === "workspace") this.showWorkspace();
    else if (action.kind === "context") this.showContext();
    else if (action.kind === "model") this.runCommand("/model");
    else if (action.kind === "panel") this.sessionView.act({ kind: "log" });
    else {
      if (action.kind === "commands") this.editor = setPromptValue({ ...this.editor, search: null, searchDraft: "" }, "/");
      if (action.kind === "files") {
        const { value, cursor } = this.editor;
        const token = `${cursor > 0 && !/\s/.test(value[cursor - 1]!) ? " " : ""}@`;
        this.editor = { ...setPromptValue({ ...this.editor, search: null, searchDraft: "" }, value.slice(0, cursor) + token + value.slice(cursor)), cursor: cursor + token.length };
      }
      this.sessionView.focusInput();
    }
    this.requestRender();
  }

  private composeStartFrame(): { rows: string[]; cursor: { row: number; column: number } | null } {
    const layout = this.startLayout!;
    const { paint, contextRail: rail } = this.options;
    const input = this.composeInput(layout.input.width);
    const result = this.startScreen.render({ width: this.layout.width, height: this.layout.height, layout, paint,
      now: Date.now(), openedAt: this.sessionOpenedAt, createdAt: this.sessionCreatedAt, animate: this.started && paint.enabled && !reducedMotionEnabled(), focused: this.sessionView.focused,
      path: shortenPath(this.options.workspaceRoot ?? rail.workspacePath), branch: rail.workspaceBranch, model: rail.modelId, mode: this.planMode ? "Plan" : "Build", context: rail.contextSnapshot,
      currentId: this.sessionId, recent: this.recentSessions, recentState: this.recentState, feedback: this.feedback, input: input.lines });
    const canvas = new Canvas(this.layout.width, this.layout.height, paint);
    result.rows.forEach((text, row) => canvas.put(row, 0, text, this.layout.width));
    this.mouseZones = result.zones.flatMap((zone) => Array.from({ length: zone.height }, (_, index) => ({ row: zone.row + index,
      column: zone.column, width: zone.width, run: () => this.actStart(zone.action) })));
    for (const zone of input.zones) this.mouseZones.push({ row: layout.input.row + 1 + zone.row,
      column: layout.input.column + (zone.column ?? 0), width: zone.width,
      run: (column) => zone.run(column === undefined ? undefined : column - layout.input.column) });
    this.railZones = [];
    return { rows: canvas.rows, cursor: this.terminalFocused && !this.sessionView.focused && input.cursor
      ? { row: layout.input.row + input.cursor.row, column: layout.input.column + input.cursor.column } : null };
  }

  private composeSessionFrame(): { rows: string[]; cursor: { row: number; column: number } | null } {
    if (this.startLayout) return this.composeStartFrame();
    const { layout } = this;
    const paint = this.options.paint;
    this.sessionView.sync(this.entries);
    const rail = this.options.contextRail;
    const feedback = this.feedback && this.mode !== "dialog" && this.mode !== "approval"
      ? paint.text(sanitizeTerminalLine(this.feedback.text), this.feedback.tone === "error" ? "signal" : "secondary") : null;
    const modal = this.mode === "approval" || this.mode === "dialog";
    if (modal) this.sessionView.hover(-1, -1);
    const previewOpen = Boolean(this.preview?.open && !this.sessionView.panelOpen && !modal);
    const panelOpen = (this.sessionView.panelOpen || previewOpen && !this.preview?.expanded) && !modal;
    const geometry = sessionPanelLayout(layout.width, panelOpen && !this.sessionView.panelExpanded);
    if (panelOpen && this.sessionView.panelExpanded) geometry.overlay = true;
    const width = geometry.conversationWidth;
    const gap = feedback ? 1 : 0;
    const trace = this.drive?.traces?.at(-1);
    const cardHeight = trace && !this.sessionView.driveOpen && !modal ? layout.height >= 18 ? 4 : 1 : 0;
    const sessionHeight = layout.input.row - gap - cardHeight;
    const root = this.options.workspaceRoot ?? rail.workspacePath;
    const renderOptions = { paint, drive: this.drive,
      animateScroll: this.started,
      title: this.sessionTitle, path: shortenPath(root), branch: rail.workspaceBranch, now: Date.now(), openedAt: this.sessionOpenedAt, createdAt: this.sessionCreatedAt,
      presence: this.mode === "approval" ? "waiting" as const : this.state, asking: Boolean(this.question),
      markdown: (entry: AssistantEntry, width: number) => this.renderedMarkdown(entry, width),
    };
    const frame = this.sessionView.render({ ...renderOptions, width, height: sessionHeight });
    if (!modal && sessionHeight > 0) this.drivePanes.push({ surface: "response", row: 0, column: 0, width, height: sessionHeight });
    const canvas = new Canvas(layout.width, layout.height, paint);
    for (const [row, text] of frame.rows.entries()) canvas.put(row, 0, text, width);
    const zones = panelOpen && geometry.overlay ? [] : frame.zones;
    if (panelOpen && !previewOpen) {
      const panelWidth = geometry.overlay ? width : geometry.panelWidth - 1;
      const column = geometry.overlay ? 0 : width + 1;
      const panel = this.sessionView.render({ ...renderOptions, width: panelWidth, height: geometry.overlay ? sessionHeight : layout.height,
        panel: true, column, replace: geometry.overlay, model: rail.modelId, contextLines: rail.lines(Math.max(16, panelWidth - 5), 1000, paint) });
      if (geometry.overlay) this.drivePanes = [];
      this.drivePanes.push({ surface: this.sessionView.driveSurface, row: 0, column, width: panelWidth, height: geometry.overlay ? sessionHeight : layout.height });
      if (this.sessionView.driveOpen) this.drivePanelBounds = { column, width: panelWidth, height: geometry.overlay ? sessionHeight : layout.height };
      panel.rows.forEach((text, row) => canvas.put(row, column, text, panelWidth, "surface"));
      zones.push(...panel.zones);
    }
    for (let row = 0; row < layout.height; row++) {
      if (!panelOpen || geometry.overlay) canvas.put(row, width, "", geometry.panelWidth, "surface");
      // An open panel's edge is the bright border, so it reads as its own sheet.
      canvas.put(row, width, paint.text("│", panelOpen && !geometry.overlay ? "borderBright" : "rule"), 1, "surface");
    }
    if (!panelOpen || geometry.overlay) {
      const column = width + Math.floor((geometry.panelWidth + 1) / 2);
      canvas.put(1, column, paint.text("│", "borderBright"), 1, "surface");
      canvas.put(3, column, paint.text(panelOpen ? "×" : "⊞", "muted"), 1, "surface");
      zones.push({ row: 3, column: width + 1, width: geometry.panelWidth - 1, action: { kind: "panel-toggle" } });
    }
    this.mouseZones = (modal ? [] : zones).map((zone) => ({ ...zone,
      driveAllowed: !["settings", "workspace", "drive-control", "drive-open", "drive-follow", "drive-trace-toggle"].includes(zone.action.kind),
      driveControl: zone.action.kind.startsWith("drive-") || this.driveReadingHeld && zone.action.kind === "follow", identity: JSON.stringify(zone.action), run: () => {
      if (zone.action.kind === "drive-control") { this.options.drive?.control(zone.action.control); return; }
      if (zone.action.kind === "workspace") { this.showWorkspace(); this.requestRender(); return; }
      if (zone.action.kind === "context") { this.showContext(); this.requestRender(); return; }
      if (zone.action.kind === "settings") { this.openSettings(); return; }
      this.sessionView.act(zone.action);
      this.requestRender();
    } }));
    if (previewOpen && this.preview) {
      const overlay = geometry.overlay || this.preview.expanded;
      const column = overlay ? 0 : width + 1;
      const panelWidth = overlay ? width : geometry.panelWidth - 1;
      const preview = this.preview.render(panelWidth, sessionHeight, column, paint, this.graphicsReady ? this.cellSize : null);
      if (overlay) this.drivePanes = [];
      this.drivePanes.push({ surface: "preview", row: 0, column, width: panelWidth, height: sessionHeight });
      preview.rows.forEach((text, row) => canvas.put(row, column, text, panelWidth, "surface"));
      if (overlay) this.mouseZones = [];
      this.mouseZones.push(...preview.zones.map((zone, index) => ({ ...zone, driveAllowed: true, identity: `preview:${this.preview?.selectedId}:${index}` })));
      this.imageIntent = preview.image;
    }
    this.railZones = [];
    if (!panelOpen && !previewOpen && !modal) this.drawSidebarRail(canvas, width, geometry.panelWidth);
    const input = this.composeInput(width);
    const inset = width >= 65 ? 2 : 1;
    const workspaceWidth = width - inset * 2;
    if (gap) canvas.put(sessionHeight, inset + 2, feedback ?? "", width - inset - 2);
    if (cardHeight && trace) {
      const top = layout.input.row - cardHeight;
      this.driveCardBounds = { row: top, height: cardHeight, width };
      const elapsed = Math.max(0, ((trace.completedAt ?? Date.now()) - trace.startedAt) / 1000).toFixed(1);
      canvas.put(top, inset, paint.text(`▷ DRIVE · ${driveActivityLabel(this.drive!, trace)} · ${elapsed}s · Alt+J details`, "thinking"), workspaceWidth, "thinkingSurface");
      if (cardHeight > 1) {
        const preview = this.drive!.status === "waiting" ? this.drive!.activity : driveTracePreview(trace);
        const lines = wrapDisplayText(sanitizeTerminalLine(preview.slice(-4000).replace(/\s+/g, " ")), Math.max(1, workspaceWidth - 2)).slice(-(cardHeight - 1));
        for (let row = 1; row < cardHeight; row++) canvas.put(top + row, inset, paint.text(`▎ ${lines[row - 1] ?? ""}`, "secondary"), workspaceWidth, "thinkingSurface");
      }
      for (let row = top; row < layout.input.row; row++) this.mouseZones.push({ row, column: inset, width: workspaceWidth, driveControl: true, run: () => this.showDrive() });
    }
    for (let row = 0; row < layout.input.height; row++) canvas.put(layout.input.row + row, 0, input.lines[row] ?? "", width, "surface");
    for (const zone of input.zones) this.mouseZones.push({ ...zone, row: layout.input.row + 1 + zone.row });
    const status = sessionStatus({ width: workspaceWidth, paint, state: this.mode === "approval" ? this.question ? "QUESTION" : "APPROVAL" : this.sessionView.latest?.status ?? "READY",
      context: this.sessionView.latest?.settled ? this.sessionView.latest.receipt?.context ?? rail.contextSnapshot : rail.contextSnapshot,
      now: Date.now(), reducedMotion: reducedMotionEnabled(),
      presence: this.state, elapsed: this.turnStartedAt === null ? undefined : Math.max(0, Date.now() - this.turnStartedAt),
      tokensPerSecond: rail.tokensPerSecond, paused: this.sessionView.paused, model: rail.modelId,
      hasResponse: Boolean(this.sessionView.current?.settled && this.sessionView.current.answer) });
    canvas.put(layout.height - 1, 0, "", width, "surface");
    canvas.put(layout.height - 1, inset, status.text, workspaceWidth, "surface");
    if (!modal) for (const zone of status.zones) this.mouseZones.push({ row: layout.height - 1,
      column: inset + zone.column, width: zone.width, run: () => { this.sessionView.act({ kind: zone.action }); this.requestRender(); } });
    return { rows: canvas.rows, cursor: this.terminalFocused && (!this.sessionView.focused || this.mode === "dialog") && input.cursor && input.cursor.row < layout.input.height
      ? { row: layout.input.row + input.cursor.row, column: input.cursor.column } : null };
  }

  private showContext(): void {
    if (this.sessionLayout) { this.sessionView.act({ kind: "context" }); this.requestRender(); return; }
    this.showPanel([this.options.paint.bold("CONTEXT WINDOW · Alt+C", "electricBright"), "",
      ...this.options.contextRail.lines(this.layout.width - 4, 200, this.options.paint)]);
  }

  private drawSidebarRail(canvas: Canvas, column: number, width: number): void {
    const rail = sidebarRail(width, this.layout.height, this.options.paint, this.mode === "streaming", this.railHovered,
      this.options.drive ? this.drive?.status === "running" || this.drive?.status === "waiting" ? "active" : "idle" : undefined);
    rail.rows.forEach((text, row) => canvas.put(row, column, text, width, "surface"));
    this.railZones = rail.zones.map((zone) => ({ ...zone, column: column + zone.column }));
    const hovered = this.railZones.find((zone) => zone.action === this.railHovered);
    if (hovered) {
      const label = ` ${hovered.action === "files" ? "Files" : hovered.action === "diff" ? "Diff" : hovered.action === "drive" ? "Drive" : "Preview"} `;
      canvas.put(hovered.row + 1, Math.max(0, column - label.length - 1), this.options.paint.text(label, "electric"), label.length, "raised");
    }
    // Replace the former single-toggle hit target with the three real actions.
    this.mouseZones = this.mouseZones.filter((zone) => (zone.column ?? 0) < column);
    for (const zone of this.railZones) for (let row = zone.row; row < zone.row + zone.height; row++) {
      this.mouseZones.push({ row, column: zone.column, width: zone.width, driveAllowed: zone.action !== "drive", driveControl: zone.action === "drive", identity: `rail:${zone.action}`, run: () => this.openRailAction(zone.action) });
    }
  }

  private openRailAction(action: RailAction): void {
    this.railHovered = null;
    if (action === "drive") {
      if (this.preview) { this.preview.open = false; this.preview.focused = false; }
      this.sessionView.act({ kind: "drive-open" }); this.requestRender(); return;
    }
    if (action === "preview") {
      this.sessionView.act({ kind: "panel-close" });
      if (this.preview) { if (!this.preview.open) this.preview.toggle(); }
      else this.showPanel(["PREVIEW", "No image artifacts are available in this session."]);
    } else {
      if (this.preview) { this.preview.open = false; this.preview.focused = false; }
      if (action === "diff") {
        const run = this.sessionView.current;
        if (this.sessionView.diffOpen) this.sessionView.act({ kind: "panel-close" });
        else this.sessionView.act({ kind: "diff-open", runId: run?.id ?? 0 });
      } else this.openFiles(true);
    }
    this.requestRender();
  }

  /// The Files list (Figma 119:1190). A fresh open clears its filter; coming
  /// back from a file (‹ Files) keeps it.
  private openFiles(fresh: boolean): void {
    if (this.preview) { this.preview.open = false; this.preview.focused = false; }
    if (fresh) this.sessionView.resetFilesList();
    const sessionId = this.sessionId;
    this.showPanel(["Loading workspace files…"], { title: "FILES" });
    const outputId = this.entries.at(-1)!.id;
    void (this.options.fileInfo?.() ?? (this.options.files?.() ?? Promise.resolve([...this.promptContext.mentions])).then((files) => files.map((path) => ({ path, byteLength: null, status: null })))).then((files) => {
      if (sessionId !== this.sessionId || !this.sessionView.showingOutput(outputId)) return;
      this.showPanel(files.length ? [""] : ["No workspace files available."], { title: "FILES", files });
    }).catch(() => { if (sessionId === this.sessionId && this.sessionView.showingOutput(outputId)) this.showPanel(["Workspace files could not be loaded."], { title: "FILES" }); });
    this.requestRender();
  }

  private copyResponse(text: string): void {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => { this.copyTimer = null; this.requestRender(); }, 1600);
    this.copyTimer.unref();
    this.requestRender();
  }

  private showWorkspace(): void {
    this.showPanel([this.options.paint.bold("PROJECT FOLDER · Alt+P", "electricBright"), "",
      sanitizeTerminalLine(this.options.workspaceRoot ?? this.options.contextRail.workspacePath),
      ...(this.options.contextRail.workspaceBranch ? ["", `Branch: ${sanitizeTerminalLine(this.options.contextRail.workspaceBranch)}`] : [])]);
  }

  /// A quiet imprint and workspace attribution above the task title.
  private composeHeader(width: number): { mark: string } {
    const paint = this.options.paint;
    const rail = this.options.contextRail;
    const left = `  ${paint.text("D E M E S N E", "secondary")}`;
    const root = this.options.workspaceRoot;
    const workspace = root ? paint.dim(truncateText(sanitizeTerminalLine(shortenPath(root)), 34)) : "";
    const branch = rail.workspaceBranch ? paint.dim(sanitizeTerminalLine(rail.workspaceBranch)) : "";
    return { mark: formatFooterLine(left, [workspace, branch].filter(Boolean).join(" / "), width) };
  }

  /// A writing margin on the same canvas; selectors and decisions use a sheet.
  private composeInput(width: number): {
    lines: string[];
    cursor: { row: number; column: number } | null;
    zones: InputZone[];
  } {
    const paint = this.options.paint;
    if (this.sessionLayout && (this.mode === "input" || this.mode === "streaming")) {
      this.syncQueuedEditor();
      const streaming = this.mode === "streaming";
      const result = composeDraft({ width, height: this.layout.input.height, paint, focused: this.terminalFocused && !this.sessionView.focused, context: this.options.contextRail.contextSnapshot,
        now: Date.now(), reducedMotion: reducedMotionEnabled(), stopArmed: streaming && interruptArmed(this.lastInterruptEscapeAt, Date.now()),
        hero: Boolean(this.startLayout), reveal: this.startLayout ? this.startScreen.reveal(1, Date.now(), this.started && paint.enabled && !reducedMotionEnabled()) : 1,
        editor: streaming ? this.queuedEditor : this.editor, streaming, restored: this.restoredDraft, mentions: this.promptContext.mentions, history: this.promptContext.history });
      return { lines: result.lines, cursor: result.cursor, zones: result.zones.map((zone) => ({ ...zone, row: zone.row - 1, run: (column?: number) => {
        const action = zone.action;
        if (action.kind === "submit") this.dispatchEditorKey({ name: "return" });
        else if (action.kind === "newline") this.dispatchEditorKey({ name: "return", shift: true });
        else if (action.kind === "commands" || action.kind === "files") this.actStart({ kind: action.kind });
        else if (action.kind === "stop") this.options.onInterrupt();
        else if (action.kind === "clear") {
          if (streaming) { this.options.queue.set(""); this.queuedEditor = createPromptEditorState(); }
          else { this.editor = createPromptEditorState(); this.restoredDraft = false; }
        }
        else if (action.kind === "remove") {
          const editor = streaming ? this.queuedEditor : this.editor;
          const updated = setPromptValue(editor, editor.value.slice(0, action.start) + editor.value.slice(action.start + action.length));
          if (streaming) { this.queuedEditor = updated; this.options.queue.set(updated.value); } else this.editor = updated;
        } else if (action.kind === "caret") {
          const cursor = action.start + textIndexAtVisualColumn(action.text, (column ?? zone.column) - zone.column);
          if (streaming) this.queuedEditor = { ...this.queuedEditor, cursor };
          else this.editor = { ...this.editor, cursor };
        }
        this.requestRender();
      } })) };
    }
    const rule = this.sessionLayout ? this.mode === "approval" ? `    ${paint.bold("Approval required", "signal")}` : this.mode === "streaming" ? `    ${paint.dim("Follow-up · queued after this run")}` : ""
      : paint.text(`╭${"─".repeat(Math.max(0, width - 2))}╮`, this.mode === "approval" ? "signal" : "electric");
    const inset = this.sessionLayout ? workspaceInset(width) : 0;
    const panelWidth = width - inset * 2;
    const contentInset = this.sessionLayout ? conversationInset(panelWidth) - 3 : 0;
    const content = this.composeInputContent(panelWidth - contentInset);
    const compactDecision = this.sessionLayout && this.mode === "approval" && this.layout.input.height < 5;
    const available = Math.max(1, this.layout.input.height - (compactDecision ? 1 : 2));
    let offset = 0;
    if (content.lines.length > available && content.cursor) {
      offset = Math.max(0, content.cursor.row - available + 2);
    }
    if (this.mode === "approval" && content.lines.length > available && this.approval) {
      // Keep the choice row in view; it is the last line.
      offset = Math.max(0, content.lines.length - available);
    }
    if (this.sessionLayout && this.mode === "dialog") return withOwnTitle(this.composeChooser(width, inset, paint));
    // These draw their own titles, so their zones cancel the frame's +1 row
    // offset that assumes the wrapper's title row above the content.
    if (this.mode === "approval" && this.question) return withOwnTitle(this.composeQuestionCard(width, inset, paint));
    if (this.sessionLayout && this.mode === "approval" && this.approval) return withOwnTitle(this.composeApprovalCard(width, inset, paint));
    if (this.sessionLayout) {
      const canvas = new Canvas(width, this.layout.input.height, paint);
      for (let row = 0; row < this.layout.input.height; row++) {
        canvas.put(row, inset, "", panelWidth, "surface");
        canvas.put(row, inset, paint.text("▎", this.mode === "approval" ? "thinking" : "electric"), 1, "surface");
      }
      const approvalTitle = paint.text("! ", "thinking") + paint.bold(this.approval?.toolName === "run_command" ? "Allow this command?" : "Allow this action?", "paper");
      canvas.put(0, inset + contentInset + 3, this.mode === "approval" ? approvalTitle : paint.bold("Select", "electricBright"), panelWidth - contentInset - 6, "surface");
      for (let y = 0; y < available; y++) canvas.put(y + 1, inset + contentInset + 1, content.lines[offset + y]?.replace(/^ {2}/, "") ?? "", panelWidth - contentInset - 2, "surface");
      return {
        lines: canvas.rows,
        cursor: content.cursor ? { row: content.cursor.row - offset + 1, column: inset + contentInset + content.cursor.column - 1 } : null,
        zones: content.zones.filter((zone) => zone.row >= offset && zone.row < offset + available)
          .map((zone) => ({ ...zone, row: zone.row - offset, column: inset + contentInset + Math.max(1, (zone.column ?? 2) - 1), width: Math.min(zone.width ?? panelWidth - contentInset - 2, panelWidth - contentInset - 2) })),
      };
    }
    return {
      lines: [surface(rule, width, paint, "raised"), ...content.lines.slice(offset, offset + available).map((line) => surface(line, width, paint, "raised")), ...(compactDecision ? [] : [this.sessionLayout ? surface("", width, paint, "raised") : paint.text(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "rule")])],
      cursor: content.cursor ? { row: content.cursor.row - offset + 1, column: content.cursor.column } : null,
      zones: content.zones.filter((zone) => zone.row >= offset && zone.row < offset + available).map((zone) => ({ ...zone, row: zone.row - offset })),
    };
  }

  private composeInputContent(width: number): {
    lines: string[];
    cursor: { row: number; column: number } | null;
    zones: InputZone[];
  } {
    const paint = this.options.paint;
    const lines: string[] = [];
    const zones: InputZone[] = [];

    if (this.mode === "approval" && this.approval) {
      // Commands too: the daemon grants exactly this argv in this directory.
      const choices = approvalOptions(true, this.approval.allowPersist).options;
      // Rail-aligned and box-free so the request reads as part of the turn
      // rather than as a modal from a different interface.
      const askLines = formatApprovalAsk({
        ask: narrateWaiting(this.approval.summary),
        toolName: this.approval.toolName,
        previewRows: this.approval.previewRows?.slice(0, Math.max(0, this.layout.input.height - choices.length - 2)),
        width,
        painter: paint,
        // The composer's own mark, in the signal color because it wants a
        // decision: the footer already shows the waiting glyph.
        waitingMark: paint.text("❯", "signal"),
      });
      const labels = { allow_once: "Allow once", allow_session: "Allow for session", allow_always: "Always allow", deny: "Deny" };
      if (this.sessionLayout) {
        // Two visible choices, as the redesign asks; the session and always
        // options stay one key away as quiet hints. Every option remains
        // selectable with the arrows, and Deny keeps its fail-safe default.
        lines.push(`    ${paint.text(truncateText(sanitizeTerminalLine(this.approval.summary), width - 8), "secondary")}`);
        const unsandboxed = this.approval.toolName === "run_command";
        for (const line of (this.approval.previewRows ?? []).slice(0, Math.max(0, this.layout.input.height - (unsandboxed ? 5 : 4)))) lines.push(`    ${sanitizeTerminalLine(line)}`);
        if (unsandboxed) lines.push(`    ${paint.text("runs on your machine · not sandboxed", "thinking")}`);
        const keys: Record<PermissionDecision, string> = { allow_once: "y", allow_session: "a", allow_always: "s", deny: "n" };
        let row = "    ";
        const buttonRow = lines.length;
        for (const decision of choices.filter((choice) => choice === "allow_once" || choice === "deny")) {
          const selected = choices[this.approvalSelected] === decision;
          const label = ` ${keys[decision]}  ${labels[decision]} `;
          zones.push({ row: buttonRow, column: visibleLength(row), width: label.length, run: () => this.resolveApproval(decision) });
          row += (selected ? paint.wash(label, decision === "deny" ? "errorSurface" : "diffAddedSurface", decision === "deny" ? "signal" : "citron") : paint.wash(label, "raised", "paper")) + "  ";
        }
        const quiet = choices.filter((choice) => choice === "allow_session" || choice === "allow_always");
        const hints = quiet.map((decision) => {
          const text = `${keys[decision]} ${decision === "allow_session" ? "this session" : "always"}`;
          return choices[this.approvalSelected] === decision ? paint.wash(` ${text} `, "menuSelection", "electric") : paint.text(keys[decision], "secondary") + paint.text(text.slice(1), "muted");
        }).join(paint.text(" · ", "borderBright"));
        lines.push(hints && visibleLength(row + hints) <= width - 2 ? row + " " + hints : row);
        if (hints && visibleLength(row + hints) > width - 2) lines.push(`    ${hints}`);
        return { lines, cursor: null, zones };
      }
      lines.push(...askLines);
      choices.forEach((decision, index) => {
        const label = ` ${index === this.approvalSelected ? "›" : " "} ${labels[decision]} `;
        zones.push({ row: lines.length, column: 4, width: visibleLength(label), run: () => this.resolveApproval(decision) });
        lines.push(`    ${index === this.approvalSelected ? paint.wash(label, decision === "deny" ? "signal" : "electric") : label}`);
      });
      return { lines, cursor: null, zones };
    }

    if (this.mode === "dialog") {
      const count = Math.max(1, Math.min(10, this.layout.input.height - 5));
      const start = Math.max(0, this.dialogSelected - count + 1);
      const shown = this.dialogFiltered
        .map((index) => ({ index, label: this.dialogItems[index] ?? "" }))
        .slice(start, start + count);
      const filtered = this.dialogQuery ? ` of ${this.dialogItems.length}` : "";
      const at = shown.length === 0 ? 0 : this.dialogSelected + 1;
      // The redesign's chooser: a quiet selection wash with an accent edge
      // instead of a solid block, a labelled filter, and a short footer.
      lines.push(
        `${" ".repeat(HARNESS.margin)}${paint.bold(this.dialogTitle, "paper")}  `
          + paint.text(`${at}/${this.dialogFiltered.length}${filtered}`, "muted"),
      );
      lines.push(`    ${paint.text("filter", "muted")}  ${this.dialogQuery ? paint.text(sanitizeTerminalLine(this.dialogQuery), "paper") : paint.text("type to filter", "muted")}`);
      if (!shown.length) lines.push(`    ${paint.text("No matches — backspace to edit", "secondary")}`);
      shown.forEach((item, position) => {
        position += start;
        const selected = position === this.dialogSelected;
        const label = truncateText(sanitizeTerminalLine(item.label), Math.max(8, width - HARNESS.content - 2));
        lines.push(`   ${selected ? paint.text("▎", "electric") + paint.wash(` ${label}`.padEnd(width - 7), "menuSelection", "electric") : paint.text(`  ${label}`, "secondary")}`);
        zones.push({
          row: lines.length - 1,
          run: () => this.clickDialogItem(position),
        });
      });
      lines.push(`${" ".repeat(HARNESS.margin)}  ${paint.text("↑↓ select · ↵ choose · Esc cancel", "muted")}`);
      return { lines, cursor: null, zones };
    }

    // While a turn runs, the composer shows what is being queued rather than
    // the prompt that was already submitted. The queue is what the next turn
    // will receive, so it belongs where the user is typing.
    const streaming = this.mode === "streaming";
    const label = `    ${paint.text("▎", "electric")} ${paint.italic(streaming ? "Queued follow-up" : "Prompt", "electricBright")}${this.planMode ? paint.dim(" · plan") : ""}`;
    lines.push(formatFooterLine(label, streaming ? "" : paint.text("Settings ↗  ", "secondary"), width));
    if (!streaming) {
      zones.push({ row: 0, column: Math.max(0, width - 12), width: 12, run: () => this.openSettings() });
    }
    const value = streaming ? this.options.queue.get() : this.editor.value;
    this.syncQueuedEditor();
    const valueCursor = streaming ? this.queuedEditor.cursor : this.editor.cursor;
    const promptWidth = Math.max(10, width - HARNESS.content - 1);
    const layout = computePromptVisualLines(value, valueCursor, promptWidth);
    const commands = streaming ? [] : this.matchingCommands();
    const queued = streaming && value.length > 0;
    const placeholder = value.length === 0 && commands.length === 0
      ? paint.dim(truncateText(
        streaming ? "Queue a follow-up…" : "Ask a question or describe a change…",
        promptWidth,
      ))
      : "";
    // The prompt mark is static and belongs to the composer alone. It used to be
    // the turn's state glyph, which put the same animated diamond in the footer
    // on the line directly below it.
    for (let index = 0; index < layout.lines.length; index += 1) {
      const prefix = " ".repeat(HARNESS.content);
      const body = layout.lines[index] || (index === 0 ? placeholder : "");
      // Queued text reads as a waiting draft: a raised surface, not a prompt.
      lines.push(`${prefix}${queued && body ? paint.italic(body, "secondary") : body}`);
    }
    const cursor = { row: layout.cursorLine + 1, column: HARNESS.content + layout.cursorCol };
    const attachments = draftMentions(value, this.promptContext.mentions);
    if (attachments.length) {
      let chips = "    ";
      for (const mention of attachments) {
        const label = ` ${mention.path} × `;
        const column = visibleLength(chips);
        if (column + visibleLength(label) >= width - 2) break;
        if (!streaming) zones.push({ row: lines.length, column, width: visibleLength(label), run: () => {
          this.editor = setPromptValue(this.editor, value.slice(0, mention.start) + value.slice(mention.start + mention.length));
          this.requestRender();
        } });
        chips += paint.text(label, "electric") + " ";
      }
      lines.push(chips);
    }
    const menuStart = lines.length;

    const mention = mentionTokenAt(this.editor.value, this.editor.cursor);
    const mentionCandidates = !this.editor.mentionDismissed && mention && this.promptContext.mentions.length > 0
      ? mentionMatches(this.promptContext.mentions, mention.query)
      : [];
    if (mentionCandidates.length > 0) {
      const menuLines = formatMentionMenu(mentionCandidates, this.editor.mentionSelected, width, paint).split("\n");
      menuLines.forEach((line, index) => lines.push(line));
      for (let index = 0; index < mentionCandidates.length; index += 1) {
        zones.push({ row: menuStart + index, run: () => this.clickMention(index) });
      }
    } else if (commands.length > 0) {
      const menuLines = formatSlashCommandMenu(commands, this.editor.menuSelected, width, paint).split("\n");
      menuLines.forEach((line, index) => lines.push(line));
      // The zone map and the renderer share `slashMenuLineCommands`, so a click
      // target can never drift from the row that draws it.
      slashMenuLineCommands(commands).forEach((commandIndex, lineIndex) => {
        if (commandIndex === null) return;
        zones.push({ row: menuStart + lineIndex, run: () => this.clickCommand(commandIndex) });
      });
    }
    const actionRow = lines.length;
    if (streaming) {
      lines.push(`    ${paint.text("Stop ■", "signal")}   ${value ? paint.text("Clear queue", "secondary") : ""}`);
      zones.push({ row: actionRow, column: 4, width: 6, run: () => this.options.onInterrupt() });
      if (value) zones.push({ row: actionRow, column: 13, width: 11, run: () => { this.options.queue.set(""); this.requestRender(); } });
    } else {
      const mode = this.planMode ? "Plan" : "Build";
      lines.push(`    ${value.trim() ? paint.wash(" Send ↵ ", "electric") : paint.dim(" Send ↵ ")}   ${paint.text(`${mode} ▾`, "secondary")}   ${paint.text("Model ▾", "secondary")}`);
      if (value.trim()) zones.push({ row: actionRow, column: 4, width: 8, run: () => this.dispatchEditorKey({ name: "return" }) });
      zones.push(
        { row: actionRow, column: 15, width: mode.length + 2, run: () => { this.planMode = !this.planMode; this.requestRender(); } },
        { row: actionRow, column: 20 + mode.length, width: 7, run: () => this.runCommand("/model") });
    }
    return { lines, cursor, zones };
  }

  private runCommand(command: string): void {
    if (this.mode !== "input") return;
    this.savedDraft = this.editor.value;
    this.savedDraftRestored = this.restoredDraft;
    this.applyEditorResult({ state: this.editor, action: { type: "submit", value: command } });
  }

  private currentEntries(): WorkbenchEntry[] {
    const start = this.entries.findLastIndex((entry) => entry.type === "user");
    return this.entries.slice(Math.max(0, start));
  }

  private indexEntries(): ToolEntry[] {
    return this.inspectionEntries().filter((entry): entry is ToolEntry => entry.type === "tool" && (this.inspectorTab === "Activity" || (this.inspectorTab === "Changes" ? entry.phase === "change" : entry.phase !== "inspect")));
  }

  private inspectionEntries(): WorkbenchEntry[] {
    if (this.selectedTurnId === null) return this.currentEntries();
    const start = this.entries.findIndex((entry) => entry.id === this.selectedTurnId);
    if (start < 0) return this.currentEntries();
    const end = this.entries.findIndex((entry, index) => index > start && entry.type === "user");
    return this.entries.slice(start, end < 0 ? undefined : end);
  }

  private inspectEntry(entryId: number): void {
    const index = this.entries.findIndex((entry) => entry.id === entryId);
    this.selectedTurnId = this.entries.slice(0, index + 1).findLast((entry) => entry.type === "user")?.id ?? null;
    this.inspectorFocused = true;
    this.sheet = { kind: "detail", entryId, offset: 0 };
    this.requestRender();
  }

  private composeInspector(rows: string[]): void {
    const paint = this.options.paint;
    const rect = this.layout.sidebar ?? { ...this.layout.conversation, height: this.layout.footer.row - this.layout.conversation.row };
    if (!this.layout.sidebar) this.mouseZones = this.mouseZones.filter((zone) => zone.row < rect.row);
    const records = this.inspectionEntries().filter((entry): entry is ToolEntry => entry.type === "tool");
    const panel = inspectorPanel({ width: rect.width, height: rect.height, paint, records, tab: this.inspectorTab,
      selected: this.sheet?.kind === "index" ? this.sheet.selected : 0,
      detailId: this.sheet?.kind === "detail" ? this.sheet.entryId : undefined,
      offset: this.sheet?.kind === "detail" ? this.sheet.offset : this.inspectorOffset,
      title: this.selectedTurnId === null ? "Live turn" : `Turn ${this.entries.filter((entry) => entry.type === "user").findIndex((entry) => entry.id === this.selectedTurnId) + 1} · pinned`,
      context: this.options.contextRail.statusLine(rect.width * 2, paint),
      revealSelected: this.inspectorRevealSelection,
    });
    this.inspectorRevealSelection = false;
    if (this.sheet?.kind === "detail") this.sheet.offset = Math.min(this.sheet.offset, panel.maxOffset);
    else this.inspectorOffset = panel.offset;
    for (let row = 0; row < rect.height; row++) {
      const prefix = this.layout.sidebar ? `${surface(sliceAnsi(rows[rect.row + row] ?? "", 0, rect.column - 1), rect.column - 1, paint, "ink")}${paint.text("│", "rule")}` : "";
      rows[rect.row + row] = prefix + surface(panel.lines[row] ?? "", rect.width, paint);
    }
    for (const target of panel.targets) this.mouseZones.push({ row: rect.row + target.row, column: rect.column + target.column, width: target.width, run: () => {
      this.inspectorFocused = true;
      if (target.tab) { this.inspectorTab = target.tab; this.sheet = { kind: "index", selected: 0 }; this.inspectorOffset = 0; }
      else if (target.entryId !== undefined) this.inspectEntry(target.entryId);
      else if (target.back) { this.sheet = { kind: "index", selected: 0 }; this.inspectorOffset = 0; }
      else if (target.follow) { this.selectedTurnId = null; this.sheet = { kind: "index", selected: 0 }; this.inspectorOffset = 0; }
      this.requestRender();
    } });
  }

  private composeSheet(rows: string[]): void {
    if (!this.sheet) return;
    const paint = this.options.paint;
    const rect = this.layout.conversation;
    const width = this.layout.width;
    const height = rect.height;
    this.mouseZones = this.mouseZones.filter((zone) => zone.row < rect.row);
    const content: string[] = [];
    const addZone = (row: number, run: () => void) => {
      if (row < height) this.mouseZones.push({ row: rect.row + row, column: 4, width: width - 8, run });
    };
    if (this.sheet.kind === "index") {
      content.push(`    ${paint.bold("REVISION INDEX", "electric")}`);
      if (height > 4) content.push("");
      const entries = this.indexEntries();
      const count = Math.max(1, height - content.length - 1);
      this.sheet.selected = Math.min(this.sheet.selected, Math.max(0, entries.length - 1));
      const start = Math.max(0, this.sheet.selected - count + 1);
      if (!entries.length) content.push("    No changes or checks recorded yet.");
      entries.slice(start, start + count).forEach((entry, offset) => {
        const label = `${entry.phase === "change" ? "revision" : "check"}  ${entry.detail ?? entry.name} · ${entry.waiting ? "awaiting approval" : toolFailed(entry) ? "failed" : entry.state}${entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ""}`;
        const selected = this.sheet?.kind === "index" && this.sheet.selected === start + offset;
        addZone(content.length, () => this.inspectEntry(entry.id));
        const failed = toolFailed(entry) || entry.state === "denied";
        content.push(`    ${selected ? paint.bold("› ", "electric") : "  "}${paint.text(truncateText(sanitizeTerminalLine(label), width - 8), failed ? "signal" : selected ? "paper" : "secondary")}`);
      });
      content.push("", paint.dim("    Enter inspect · Esc close"));
    } else {
      const entryId = this.sheet.entryId;
      const entry = this.entries.find((entry): entry is ToolEntry => entry.type === "tool" && entry.id === entryId);
      const detail: string[] = [];
      if (entry) {
        detail.push(paint.bold(entry.phase === "verify" ? "EVIDENCE RECORD" : "REVISION RECORD", "electric"));
        detail.push(sanitizeTerminalLine(entry.detail ?? entry.name));
        detail.push(paint.text(`${entry.waiting ? "awaiting approval" : entry.state}${entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ""}`, toolFailed(entry) || entry.state === "denied" ? "signal" : entry.state === "done" ? "citron" : "secondary"), "");
        if (entry.diff) {
          detail.push(paint.bold(entry.state === "done" ? "RECORDED EDIT" : "PROPOSED EDIT", "secondary"));
          detail.push(...formatDiffPreview(entry.diff.oldText, entry.diff.newText, 10_000, paint), "");
        }
        if (entry.message) detail.push(...entry.message.split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), width - 8)), "");
        detail.push(paint.bold("ARGUMENTS", "secondary"), ...JSON.stringify(entry.input, null, 2).split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), width - 8)));
      } else detail.push("Record unavailable.");
      const headingRows = height > 4 ? 2 : 1;
      const available = Math.max(1, height - headingRows);
      this.sheet.offset = Math.min(this.sheet.offset, Math.max(0, detail.length - available));
      content.push(paint.dim("    ← Index · Backspace     Esc close"));
      if (headingRows > 1) content.push("");
      addZone(0, () => { this.sheet = { kind: "index", selected: 0 }; this.requestRender(); });
      content.push(...detail.slice(this.sheet.offset, this.sheet.offset + available).map((line) => `    ${line}`));
    }
    for (let row = 0; row < height; row++) rows[rect.row + row] = surface(content[row] ?? "", width, paint, "ink");
  }

  /// Figma 49:560: what this session uses, each with its current value and
  /// the command that also changes it, grouped as Session, Appearance and
  /// Navigate. Enter changes the selected one.
  private openSettings(): void {
    if (this.mode !== "input") return;
    const commands = this.promptContext.commands;
    const paint = this.options.paint;
    const sessions = this.recentSessions.filter((session) => session.id !== this.sessionId).length;
    const items = ["Mode", "Model", "Theme", "Sessions", "All commands"];
    void this.choose("Settings", items, 0, {
      subtitle: "this session",
      groups: ["Session", "Session", "Appearance", "Navigate", "Navigate"],
      details: [this.planMode ? "Plan · read-only" : "Build · edits allowed", this.options.contextRail.modelId,
        `${paint.themeName} · ${paint.theme}`, sessions ? `${sessions} recent` : "recent and saved sessions", `${commands.length} commands`],
      hints: [this.planMode ? "to Build" : "to Plan", "/model", "/theme", "/sessions", "/"],
      action: "change", noun: "settings", note: "Tab or Ctrl+K opens this",
    }).then((index) => {
      if (index === null) return;
      if (index === 0) { this.planMode = !this.planMode; this.requestRender(); }
      else if (index <= 3) this.runCommand(["", "/model", "/theme", "/sessions"][index]!);
      else { this.editor = setPromptValue(this.editor, "/"); this.requestRender(); }
    });
  }

  /// Figma 23:164: an amber-bordered card. The title names the decision and
  /// the tool and turn; the command sits in an inset block with where it runs
  /// and that it is not sandboxed; Allow once and Deny lead, with the saved
  /// options as quiet key hints. Keys and selection are unchanged.
  /// Figma 101:736: the card's rows between its borders. Row text is painted;
  /// `select` marks the rows a click chooses, `wash` the selected one.
  private questionCardRows(inner: number, paint: Painter, airy: boolean): { text: string; right?: string; wash?: boolean; select?: number }[] {
    const { state } = this.question!;
    const question = state.questions[state.index]!;
    const rows: { text: string; right?: string; wash?: boolean; select?: number }[] = [];
    const turn = this.sessionView.latest?.number;
    const count = state.questions.length;
    rows.push({ text: paint.text("? ", "thinking") + paint.text(count > 1 ? `Question ${state.index + 1} of ${count}` : "Question", "paper"),
      right: paint.text(["ask_user", turn ? `Turn ${turn}` : ""].filter(Boolean).join(" · "), "muted") });
    // Answered questions collapse to one line each; the latest two stay visible.
    for (let index = Math.max(0, state.index - 2); index < state.index; index++) {
      const answer = state.answers[index];
      const said = answer?.source === "skipped" || !answer?.answer ? "agent decides" : answer.answer;
      rows.push({ text: paint.text("✓ ", "citron") + paint.text(`${sanitizeTerminalLine(state.questions[index]!.question)}  ·  ${sanitizeTerminalLine(said)}`, "muted") });
    }
    for (const line of wrapDisplayText(sanitizeTerminalLine(question.question), inner).slice(0, 3)) rows.push({ text: paint.text(line, "strong") });
    if (question.reason) rows.push({ text: paint.text(sanitizeTerminalLine(question.reason), "secondary") });
    if (airy) rows.push({ text: "" });
    const own = ownRow(question);
    question.suggestions.forEach((suggestion, index) => {
      const selected = state.selected === index;
      rows.push({ text: `${paint.text(`${index + 1}  `, selected ? "electric" : "muted")}${paint.text(sanitizeTerminalLine(suggestion), selected ? "electric" : "paper")}`,
        right: index === 0 ? paint.text("suggested", "muted") + (selected ? " " + keycap(paint, "Enter") : "") : selected ? keycap(paint, "Enter") : "", wash: selected, select: index });
    });
    const typed = state.typed[state.index] ?? "";
    const editing = state.selected === own;
    rows.push({ text: `${paint.text(`${own + 1}  `, editing ? "electric" : "muted")}${typed ? paint.text(sanitizeTerminalLine(typed), "paper") : paint.text("Type your own answer…", "muted")}${editing ? paint.text("▏", "electric") : ""}`,
      right: editing && typed.trim() ? keycap(paint, "Enter") : "", wash: editing, select: own });
    if (airy) rows.push({ text: "" });
    const hints: [string, string][] = [["Enter", state.index + 1 < count ? "accept · next" : "accept"], ["↑↓", "choose"], ["type", "your own answer"]];
    if (state.index > 0) hints.push(["←", "previous"]);
    hints.push(["Esc", "let the agent decide"]);
    rows.push({ text: keyHints(paint, hints) });
    return rows;
  }

  private composeQuestionCard(width: number, inset: number, paint: Painter): { lines: string[]; cursor: { row: number; column: number } | null; zones: InputZone[] } {
    const height = this.layout.input.height, boxWidth = width - inset * 2, inner = boxWidth - 4, left = inset + 2;
    const canvas = new Canvas(width, height, paint), zones: InputZone[] = [];
    const rows = this.questionCardRows(inner, paint, this.layout.height >= AIRY_APPROVAL_ROWS);
    for (let row = 0; row < height; row++) canvas.put(row, inset, "", boxWidth, "surface");
    canvas.put(0, inset, paint.text(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`, "thinking"), boxWidth, "surface");
    canvas.put(height - 1, inset, paint.text(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, "thinking"), boxWidth, "surface");
    // When the card is short, keep the title, the choices and the keys; drop the middle first.
    const room = Math.max(0, height - 2);
    const shown = rows.length <= room ? rows : [rows[0]!, ...rows.slice(rows.length - (room - 1))].slice(0, room);
    shown.forEach((entry, index) => {
      const row = index + 1;
      const background = entry.wash ? "menuSelection" : "surface";
      canvas.put(row, inset, paint.text("│", "thinking"), 1, "surface");
      canvas.put(row, inset + boxWidth - 1, paint.text("│", "thinking"), 1, "surface");
      canvas.put(row, inset + 1, entry.wash ? paint.text("▎", "electric") : "", boxWidth - 2, background);
      canvas.put(row, left, formatFooterLine(truncateText(entry.text, Math.max(1, inner - visibleLength(entry.right ?? "") - 2)), entry.right ?? "", inner), inner, background);
      if (entry.select !== undefined) {
        const choice = entry.select;
        zones.push({ row, column: inset + 1, width: boxWidth - 2, run: () => {
          if (!this.question) return;
          this.question.state = { ...this.question.state, selected: choice };
          const result = reduceQuestionPrompt(this.question.state, { name: "return" });
          this.question.state = result.state;
          if ("answers" in result) this.answerQuestions(result.answers); else this.requestRender();
        } });
      }
    });
    return { lines: canvas.rows, cursor: null, zones };
  }

  private composeApprovalCard(width: number, inset: number, paint: Painter): { lines: string[]; cursor: { row: number; column: number } | null; zones: InputZone[] } {
    const approval = this.approval!, height = this.layout.input.height, boxWidth = width - inset * 2;
    const canvas = new Canvas(width, height, paint), zones: InputZone[] = [];
    const inner = boxWidth - 4, left = inset + 2;
    const command = approval.toolName === "run_command";
    const choices = approvalOptions(true, approval.allowPersist).options;
    for (let row = 0; row < height; row++) canvas.put(row, inset, "", boxWidth, "surface");
    // Short terminals drop the border so the question, summary and buttons fit.
    const bordered = height >= 6, first = bordered ? 1 : 0, buttonRow = bordered ? height - 2 : height - 1;
    // Figma 23:164 spacing: a blank line after the title, after the summary
    // and before the buttons, when the card was given the room for it.
    const blockLength = command ? 2 : Math.min(6, (approval.previewRows ?? []).filter((row) => !/^Working directory:/.test(stripVTControlCharacters(row))).length);
    const airy = bordered && height >= 8 + blockLength;
    const summaryRow = first + (airy ? 2 : 1), blockStart = summaryRow + (airy ? 2 : 1);
    if (bordered) {
      canvas.put(0, inset, paint.text(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`, "thinking"), boxWidth);
      canvas.put(height - 1, inset, paint.text(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, "thinking"), boxWidth);
      for (let row = 1; row < height - 1; row++) { canvas.put(row, inset, paint.text("│", "thinking"), 1); canvas.put(row, inset + boxWidth - 1, paint.text("│", "thinking"), 1); }
    } else for (let row = 0; row < height; row++) canvas.put(row, inset, paint.text("▎", "thinking"), 1);
    const turn = this.sessionView.latest?.number;
    const tool = [approval.toolName, turn ? `Turn ${turn}` : ""].filter(Boolean).join(" · ");
    const title = paint.text("! ", "thinking") + paint.text(command ? "Allow this command?" : "Allow this action?", "paper");
    // The question always reads whole; the tool and turn drop on narrow cards.
    canvas.put(first, left, formatFooterLine(title, visibleLength(title) + tool.length + 2 <= inner ? paint.text(tool, "muted") : "", inner), inner, "surface");
    if (summaryRow < buttonRow) canvas.put(summaryRow, left, paint.text(truncateText(sanitizeTerminalLine(approval.summary), inner), "secondary"), inner, "surface");
    // The inset block: the command and where it runs, or the change preview.
    const preview = (approval.previewRows ?? []).map((row) => sanitizeTerminalLine(stripVTControlCharacters(row)));
    const where = approval.cwd ?? preview.find((row) => row.startsWith("Working directory: "))?.slice(19) ?? this.options.workspaceRoot ?? "the workspace";
    const commandText = preview.find((row) => row && !row.startsWith("Working directory: "))?.replace(/^\$ /, "") ?? approval.summary;
    const block: string[] = command
      ? [paint.text("$ ", "muted") + paint.text(commandText, "paper"),
        paint.text(`in ${where} · `, "muted") + paint.text("runs on your machine, not sandboxed", "thinking")]
      : (approval.previewRows ?? []).filter((row) => !/^Working directory:/.test(stripVTControlCharacters(row)));
    const blockRows = Math.max(0, Math.min(block.length, buttonRow - blockStart - (airy ? 1 : 0)));
    for (let index = 0; index < blockRows; index++) canvas.put(blockStart + index, left, paint.onBackground(" " + truncateText(block[index]!, inner - 2) + " ".repeat(Math.max(0, inner - 2 - visibleLength(truncateText(block[index]!, inner - 2)))) + " ", "raised"), inner, "raised");
    // Buttons, then the saved-rule options as quiet hints on the right.
    const keys: Record<PermissionDecision, string> = { allow_once: "y", allow_session: "a", allow_always: "s", deny: "n" };
    const labels: Record<PermissionDecision, string> = { allow_once: "Allow once", allow_session: "allow this session", allow_always: "always allow", deny: "Deny" };
    let column = left;
    for (const decision of choices.filter((choice) => choice === "allow_once" || choice === "deny")) {
      const selected = choices[this.approvalSelected] === decision;
      const label = ` ${keys[decision]}  ${labels[decision]} `;
      const text = selected ? paint.wash(label, decision === "deny" ? "errorSurface" : "diffAddedSurface", decision === "deny" ? "signal" : "citron") : paint.wash(label, "raised", "paper");
      canvas.put(buttonRow, column, text, label.length, "surface");
      zones.push({ row: buttonRow, column, width: label.length, run: () => this.resolveApproval(decision) });
      column += label.length + 2;
    }
    const quiet = choices.filter((choice) => choice === "allow_session" || choice === "allow_always");
    let hints = "";
    for (const decision of quiet) {
      const text = choices[this.approvalSelected] === decision ? paint.wash(` ${keys[decision]} ${labels[decision]} `, "menuSelection", "electric")
        : paint.text(keys[decision], "secondary") + " " + paint.text(labels[decision], "muted");
      hints += (hints ? "   " : "") + text;
    }
    if (hints && column + visibleLength(hints) + 2 <= left + inner) {
      const start = left + inner - visibleLength(hints);
      canvas.put(buttonRow, start, hints, visibleLength(hints), "surface");
      let at = start;
      for (const decision of quiet) {
        const width = visibleLength(choices[this.approvalSelected] === decision ? ` ${keys[decision]} ${labels[decision]} ` : `${keys[decision]} ${labels[decision]}`);
        zones.push({ row: buttonRow, column: at, width, run: () => this.resolveApproval(decision) });
        at += width + 3;
      }
    }
    return { lines: canvas.rows, cursor: null, zones };
  }

  /// Figma 31:356: a titled box with a filter field, items grouped under
  /// quiet headers with counts, a detail column, the current item marked, and
  /// a keycap footer. Plain lists (themes, sessions) use the same frame.
  private composeChooser(width: number, inset: number, paint: Painter): { lines: string[]; cursor: { row: number; column: number } | null; zones: InputZone[] } {
    const height = this.layout.input.height, boxWidth = width - inset * 2;
    const canvas = new Canvas(width, height, paint), zones: InputZone[] = [];
    const inner = boxWidth - 4, left = inset + 2;
    const { subtitle, groups, details, currentIndex, action = "choose", hints: rowHints, note } = this.dialogOptions;
    for (let row = 0; row < height; row++) canvas.put(row, inset, "", boxWidth, "surface");
    canvas.put(0, inset, paint.text(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`, "borderBright"), boxWidth);
    canvas.put(height - 1, inset, paint.text(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, "borderBright"), boxWidth);
    for (let row = 1; row < height - 1; row++) { canvas.put(row, inset, paint.text("│", "borderBright"), 1); canvas.put(row, inset + boxWidth - 1, paint.text("│", "borderBright"), 1); }
    const noun = this.dialogOptions.noun ?? "items";
    const count = `${this.dialogQuery ? `${this.dialogFiltered.length} of ` : ""}${this.dialogItems.length} ${this.dialogItems.length === 1 ? noun.replace(/s$/, "") : noun}`;
    canvas.put(1, left, formatFooterLine(paint.text(this.dialogTitle, "paper") + (subtitle ? "  " + paint.text(sanitizeTerminalLine(subtitle), "muted") : ""), paint.text(count, "muted"), inner), inner, "surface");
    // The filter field: a raised line with its label and the query.
    const query = this.dialogQuery ? paint.text(sanitizeTerminalLine(this.dialogQuery), "paper") + paint.text("▏", "electric") : paint.text("type to filter", "muted");
    canvas.put(2, left, paint.onBackground(" " + paint.text("filter", "muted") + "  " + query + " ".repeat(Math.max(0, inner - 10 - visibleLength(query))), "raised"), inner, "raised");
    const footerRow = height - 2;
    const rows: { text: string; position?: number }[] = [];
    const detailColumn = Math.min(Math.floor(inner * 0.45), Math.max(12, ...this.dialogItems.map((item) => visibleLength(item) + 2)));
    let lastGroup: string | undefined;
    this.dialogFiltered.forEach((index, position) => {
      const group = groups?.[index];
      if (group !== undefined && group !== lastGroup) {
        const size = this.dialogFiltered.filter((other) => groups![other] === group).length;
        rows.push({ text: formatFooterLine(paint.text(group.toUpperCase(), "muted"), paint.text(String(size), "muted"), inner) });
        lastGroup = group;
      }
      const selected = position === this.dialogSelected;
      const label = truncateText(sanitizeTerminalLine(this.dialogItems[index] ?? ""), detailColumn - 1);
      const detail = details?.[index] ? paint.text(truncateText(sanitizeTerminalLine(details[index]!), Math.max(4, inner - detailColumn - 12)), "muted") : "";
      const hint = rowHints?.[index] ? paint.text(rowHints[index]!, "muted") : "";
      const right = selected ? (hint ? `${hint} ` : "") + keycap(paint, "↵") : index === currentIndex ? paint.text("● current", "muted") : hint;
      const text = `${paint.text(label, selected ? "electric" : "paper")}${" ".repeat(Math.max(1, detailColumn - visibleLength(label)))}${detail}`;
      rows.push({ text: formatFooterLine(text, right, inner), position });
    });
    if (!rows.length) rows.push({ text: paint.text("No matches — backspace to edit", "secondary") });
    const room = Math.max(1, footerRow - 4);
    const selectedRow = Math.max(0, rows.findIndex((row) => row.position === this.dialogSelected));
    const start = Math.max(0, Math.min(selectedRow - room + 1, rows.length - room));
    rows.slice(start, start + room).forEach((row, offset) => {
      const y = 4 + offset, selected = row.position === this.dialogSelected && row.position !== undefined;
      canvas.put(y, inset + 1, selected ? paint.text("▎", "electric") : "", boxWidth - 2, selected ? "menuSelection" : "surface");
      canvas.put(y, left, row.text, inner, selected ? "menuSelection" : "surface");
      if (row.position !== undefined) { const position = row.position; zones.push({ row: y, column: left, width: inner, run: () => this.clickDialogItem(position) }); }
    });
    const hints = keyHints(paint, [["↑↓", "select"], ["↵", action], ["Esc", "cancel"]]);
    canvas.put(footerRow, left, formatFooterLine(hints, note ? paint.text(note, "muted") : groups ? keyHints(paint, [["Tab", "next group"]]) : "", inner), inner, "surface");
    return { lines: canvas.rows, cursor: null, zones };
  }

  private driveShortcut(text: string, key: { ctrl?: boolean; meta?: boolean }): "pause" | "resume" | "stop" | null {
    if (!this.options.drive || !this.drive || key.ctrl || key.meta || !this.sessionView.driveOpen || !this.sessionView.focused || this.editor.value) return null;
    const status = this.drive.status;
    if (text === "s" && !["stopped", "completed"].includes(status) && !this.drive.protection?.trip) return "stop";
    if (text !== "p") return null;
    if (status === "running" || status === "waiting") return "pause";
    const resumable = ["paused", "blocked", "stopped", "idle"].includes(status) || status === "completed" && !!this.drive.autonomy;
    return this.drive.protection?.trip || !resumable ? null : "resume";
  }

  /// A dialog row click selects it; clicking the selected row confirms.
  private clickDialogItem(position: number): void {
    if (this.mode !== "dialog") return;
    if (position === this.dialogSelected) {
      this.finishDialog(this.dialogFiltered[position] ?? null);
      return;
    }
    this.dialogSelected = position;
    this.requestRender();
  }

  private clickMention(index: number): void {
    if (this.mode !== "input") return;
    if (this.editor.mentionSelected === index) {
      this.dispatchEditorKey({ name: "return" });
      return;
    }
    this.editor = { ...this.editor, mentionSelected: index };
    this.requestRender();
  }

  private clickCommand(index: number): void {
    if (this.mode !== "input") return;
    if (this.editor.menuSelected === index) {
      this.dispatchEditorKey({ name: "return" });
      return;
    }
    this.editor = { ...this.editor, menuSelected: index };
    this.requestRender();
  }
}

function formatDuration(durationMs: number | undefined, exitCode: number | undefined): string | undefined {
  if (durationMs === undefined) return exitCode === undefined ? undefined : `exit ${exitCode}`;
  const time = durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`;
  return exitCode === undefined || exitCode === 0 ? time : `${time} · exit ${exitCode}`;
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
  if (name === "ask_user") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = questions[0] && typeof questions[0] === "object" && typeof (questions[0] as { question?: unknown }).question === "string" ? (questions[0] as { question: string }).question : "";
    return first ? `${first}${questions.length > 1 ? ` (+${questions.length - 1} more)` : ""}` : undefined;
  }
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
