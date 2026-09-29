import { formatDiffPreview, formatFooterLine, sanitizeTerminalLine, toolPhaseColor, truncateText, visibleLength, type Painter, type PaletteColor, type PresenceState } from "@demesne/brand";
import { keyHints } from "./session-chrome.ts";
import type { AssistantEntry, ResponseReceipt, ToolEntry, UserEntry, WorkbenchEntry } from "./entries.ts";
import { projectRunEvidence, toolFailed, verificationOutcome, type RunEvidence } from "./evidence.ts";
import { computeSessionLayout, conversationInset } from "./layout.ts";
import { Canvas, foldCells } from "./canvas.ts";
import { artifactRecords, entryKey, renderSessionFlow, type FlowAction, type FlowExpansion, type FlowRow, type FlowArtifact } from "./session-flow.ts";
import { InteractionTransitions } from "./interaction.ts";
import { reducedMotionEnabled } from "../motion.ts";
import { diffPanelLines, filePanelLines } from "./panel-content.ts";
import { sessionHeader } from "./session-header.ts";
import { changeFiles, DiffPanel } from "./diff-panel.ts";
import { renderDrivePanel } from "./drive-panel.ts";
import type { DriveInspectAction, DriveObservation, DriveState } from "@demesne/protocol";

/// The three run surfaces. `response` is the default; `review` (recorded changes
/// plus their verification) and `log` (the execution log) open on demand.
export type Surface = "response" | "review" | "log";
export interface SessionRun {
  id: number; number: number; request?: UserEntry; entries: WorkbenchEntry[];
  tools: ToolEntry[]; answer?: AssistantEntry; receipt?: ResponseReceipt; status: string; settled: boolean;
}

/// Runs reference original records. A progress paragraph before the last tool is
/// never promoted to a final answer, including after interrupted/failed runs.
export function planRuns(entries: readonly WorkbenchEntry[]): SessionRun[] {
  const runs: SessionRun[] = [];
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "user" || !runs.length) runs.push({ id: entry.type === "user" ? entry.id : 0,
      number: entry.type === "user" ? ++count : 0,
      request: entry.type === "user" ? entry : undefined, entries: [], tools: [], status: "READY", settled: false });
    if (entry.type !== "user") runs.at(-1)!.entries.push(entry);
  }
  for (const run of runs) {
    run.tools = run.entries.filter((entry): entry is ToolEntry => entry.type === "tool");
    const close = run.entries.findLast((entry) => entry.type === "notice" && entry.closesTurn);
    run.settled = Boolean(close);
    const prose = run.entries.findLast((entry): entry is AssistantEntry => entry.type === "assistant");
    if (prose && prose.id > (run.tools.at(-1)?.id ?? -1)) run.answer = prose;
    run.receipt = close?.type === "notice" ? close.receipt ?? run.answer?.receipt : undefined;
    run.status = close?.type === "notice" ? close.tone === "success" ? "COMPLETE" : close.tone === "error" ? "FAILED" : "STOPPED"
      : run.tools.some((tool) => tool.waiting) ? "APPROVAL" : run.request ? "WORKING" : "READY";
  }
  return runs;
}

type RecordEntry = WorkbenchEntry;
interface RunMemory {
  surface: Surface;
  followFlow: boolean;
  flowOffset: number;
  anchor: { key: string; line: number } | null;
  /// Follow prose in a stable reading window, with room below incoming text.
  /// Relative to the response so folding earlier thinking cannot move it.
  responseWindow: { key: string; line: number; scrolledAt?: number } | null;
  expansion: Map<string, boolean>;
  flowFocus: string | null;
  reviewSelection: number;
  logSelection: number;
  detail: number | null;
  /// The surface a focused record was opened from; Escape returns there first.
  detailOrigin: Surface;
  detailOffsets: Map<number, number>;
}
type Action = FlowAction | { kind: "run"; id: number | null } | { kind: "surface"; surface: Surface }
  | { kind: "record"; id: number } | { kind: "back" | "history" | "log" | "thinking" | "request" | "follow" | "response-start" }
  | { kind: "workspace" | "context" | "panel-close" | "panel-toggle" | "settings" };
export interface SessionZone { row: number; column: number; width: number; action: Action }
interface ScrollRegion { row: number; column: number; width: number; height: number; target: "body" | "list" | "history" | "flow" | "output" | "context" | "diff" | "drive"; recordId?: number; maximum?: number }
const stateLabel = (tool: ToolEntry): string => tool.waiting ? "! APPROVAL" : tool.state === "denied" ? "× DENIED"
  : tool.state === "stopped" ? "■ STOPPED" : toolFailed(tool) ? "× FAILED" : tool.state === "done" ? "✓ DONE" : "● RUNNING";
const checkLabel = (tool: ToolEntry): string => tool.waiting ? "! AWAITING APPROVAL" : tool.state === "running" ? "● RUNNING" : tool.state === "denied" ? "× DENIED"
  : tool.state === "stopped" ? "■ STOPPED" : toolFailed(tool) ? `× FAILED${tool.exitCode ? ` · exit ${tool.exitCode}` : ""}`
  : verificationOutcome(tool) === "passed" ? "✓ PASSED · exit 0" : "· EXIT STATUS NOT RECORDED";
const number = (value: number) => String(value).padStart(2, "0");
const safe = sanitizeTerminalLine;

/// Interaction state lives with the run, rather than with a particular terminal
/// layout. Resizing changes geometry without discarding reading/selection state.
export class SessionView {
  selectedId: number | null = null;
  focused = false;
  private memories = new Map<number, RunMemory>();
  private runs: SessionRun[] = [];
  private regions: ScrollRegion[] = [];
  private pageSize = 10;
  private outputId: number | null = null;
  private outputOffset = 0;
  private contextOpen = false;
  private contextOffset = 0;
  private historyOpen = false;
  private historyIndex = 0;
  private argumentsOpen = new Set<number>();
  private flowRows: FlowRow[] = [];
  private answerRows: string[] = [];
  get answerEvidenceRows(): readonly string[] { return this.answerRows; }
  private latestAnswerRows: string[] = [];
  get latestAnswerEvidenceRows(): readonly string[] { return this.latestAnswerRows; }
  get driveScrollRegions(): NonNullable<DriveObservation["scrollRegions"]> {
    return this.regions.flatMap((region) => {
      if (region.target === "drive") return [];
      if (region.target === "diff") return this.diffPanel.scrollRegions.map((part) => ({ surface: part.surface, row: part.row, column: region.column,
        width: region.width, height: part.height, offset: part.offset, maximum: part.maximum }));
      const offset = region.target === "flow" ? this.memory.flowOffset : region.target === "history" ? this.historyIndex : region.target === "list" ? this.selection
        : region.target === "context" ? this.contextOffset : region.target === "output" ? this.outputOffset : this.memory.detailOffsets.get(region.recordId!) ?? 0;
      const maximum = region.target === "flow" ? this.flowMaximum : region.target === "history" ? Math.max(0, this.runs.length - 1) : region.target === "list" ? Math.max(0, this.records().length - 1) : region.maximum ?? 0;
      return [{ surface: region.target === "flow" ? "response" : region.target === "body" || region.target === "list" ? this.driveSurface : region.target,
        row: region.row, column: region.column, width: region.width, height: region.height, offset: Math.min(offset, maximum), maximum }];
    });
  }
  private flowMaximum = 0;
  private flowExpansions = new Map<string, FlowExpansion>();
  private flowControls: { key: string; row: number; action: FlowAction }[] = [];
  private reveal: { key: string; line: number; block?: boolean; start?: boolean } | null = null;
  private inspectionOrigin: { selectedId: number | null; runId: number } | null = null;
  private artifact: FlowArtifact | null = null;
  private readonly diffPanel = new DiffPanel();
  private drivePanelOpen = false;
  private driveFollowing = true;
  private driveCollapsed = new Set<string>();
  private driveOffset = 0;
  private driveRendered: DriveState | null = null;
  private driveSnapshot: { state: DriveState; now: number } | undefined;
  private driveScrollPending = false;
  private driveScrollAt = 0;
  private driveJump = true;
  private copied: { runId: number; until: number } | null = null;
  private pointer: { row: number; column: number } | null = null;
  private hovered: string | null = null;
  private hoverRegions: { row: number; column: number; width: number; key: string }[] = [];
  private readonly transitions = new InteractionTransitions();
  private hoverReflow = false;
  private scrollPending = false;
  private snapScroll = false;
  private flowGeometry: { width: number; height: number } | null = null;

  constructor(private readonly onCopy?: (text: string) => void) {}

  reset(): void {
    this.selectedId = null; this.focused = false; this.historyOpen = false; this.outputId = null;
    this.outputOffset = 0; this.historyIndex = 0; this.memories.clear(); this.runs = []; this.regions = [];
    this.contextOpen = false; this.contextOffset = 0;
    this.argumentsOpen.clear();
    this.flowRows = []; this.flowMaximum = 0; this.flowExpansions.clear(); this.flowControls = []; this.reveal = null;
    this.inspectionOrigin = null;
    this.artifact = null;
    this.diffPanel.reset();
    this.drivePanelOpen = false; this.driveOffset = 0; this.driveFollowing = true; this.driveCollapsed.clear();
    this.driveRendered = null; this.driveSnapshot = undefined; this.driveScrollPending = false; this.driveJump = true;
    this.copied = null;
    this.pointer = null; this.hovered = null; this.hoverRegions = []; this.transitions.clear(); this.hoverReflow = false;
    this.scrollPending = false; this.snapScroll = false; this.flowGeometry = null;
  }
  focusInput(): void { this.focused = false; this.historyOpen = false; }

  hover(row: number, column: number, now = Date.now()): boolean {
    this.pointer = row < 0 ? null : { row, column };
    const key = this.hoverRegions.find((region) => region.row === row && column >= region.column && column < region.column + region.width)?.key ?? null;
    if (key === this.hovered) return false;
    if (this.hovered) this.transitions.set(`hover:${this.hovered}`, 0, 1, now);
    if (key) this.transitions.set(`hover:${key}`, 1, 0, now);
    this.hovered = key;
    return true;
  }
  animating(now = Date.now()): boolean {
    return this.drivePanelOpen && this.driveFollowing && this.driveScrollPending || this.hoverReflow || !reducedMotionEnabled() && (this.transitions.active(now)
      || this.scrollPending && !this.paused && (!this.panelOpen || this.drivePanelOpen));
  }

  sync(entries: readonly WorkbenchEntry[]): void {
    const previous = this.current;
    const memory = previous ? this.memory : null;
    this.runs = planRuns(entries);
    if (this.artifact?.kind === "changes") this.diffPanel.sync(this.runs);
    // A queued follow-up can start while the reader is above the live edge.
    // Preserve the same transcript anchor across that turn boundary.
    if (this.selectedId === null && memory && !memory.followFlow && previous?.id !== this.current?.id) {
      this.memory.followFlow = false;
      this.memory.flowOffset = memory.flowOffset;
      this.memory.anchor = memory.anchor;
    }
  }
  presentOutput(id: number): void { this.pauseFlow(); this.drivePanelOpen = false; this.contextOpen = false; this.historyOpen = false; this.outputId = id; this.outputOffset = 0; this.focused = true; }
  dismissOutput(): void { this.outputId = null; }
  showingOutput(id: number): boolean { return this.outputId === id; }
  get current(): SessionRun | undefined { return this.runs.find((run) => run.id === this.selectedId) ?? this.runs.at(-1); }
  get latest(): SessionRun | undefined { return this.runs.at(-1); }
  get driveNavigation() {
    const run = this.current;
    return { turn: String(run?.id ?? 0), latest: run === this.latest, answer: run?.status === "COMPLETE" && !!run.answer,
      files: changeFiles(run?.tools.filter((tool) => tool.phase === "change") ?? []).map((file) => file.path).slice(0, 128),
      checks: run ? artifactRecords(run, "verification").map((tool) => String(tool.id)).slice(0, 128) : [],
      ...(this.diffOpen && this.diffPanel.selected ? { item: this.diffPanel.selected.path } : this.artifact ? { item: String(this.artifact.recordId) }
        : this.memory.surface === "log" && this.records()[this.selection] ? { item: String(this.records()[this.selection]!.id) } : {}) };
  }
  /// Semantic navigation uses the same handlers as the native evidence links.
  /// It never reads hidden file contents or performs a coding-agent operation.
  inspectDrive(action: DriveInspectAction): void {
    const run = this.current;
    if (!run) return;
    this.inspectionOrigin = null;
    const continuing = action.position === "continue" && (action.target === "answer" ? !this.panelOpen && this.memory.surface === "response"
      : action.target === "diff" ? this.diffOpen && (!action.item || action.item === this.diffPanel.selected?.path)
      : action.target === "checks" ? this.artifact?.kind === "verification" && (!action.item || action.item === String(this.artifact.recordId)) : this.memory.surface === "log");
    if (continuing) { this.focused = true; return; }
    if (action.target === "answer") this.act({ kind: "response-start" });
    else if (action.target === "diff") {
      this.act({ kind: "diff-open", runId: run.id });
      if (action.item) this.act({ kind: "diff-select", path: action.item });
      if (!this.diffPanel.expanded) this.act({ kind: "diff-expand" });
      this.diffPanel.key("home");
    } else if (action.target === "checks") {
      if (this.artifact?.kind === "verification") this.act({ kind: "artifact-close" });
      this.act({ kind: "artifact", target: "verification", runId: run.id });
      const records = artifactRecords(run, "verification");
      const selected = action.item ? records.find((tool) => String(tool.id) === action.item) : records[0];
      if (selected && this.artifact) this.act({ kind: "artifact-step", step: records.indexOf(selected) - records.findIndex((tool) => tool.id === this.artifact!.recordId) });
      if (selected) this.memory.detailOffsets.set(selected.id, 0);
    } else { this.act({ kind: "log" }); this.key({ name: "home" }); }
    this.focused = true;
  }
  get panelOpen(): boolean { return !this.historyOpen && (this.drivePanelOpen || this.contextOpen || this.outputId !== null || this.artifact !== null || this.memory.surface !== "response"); }
  get driveOpen(): boolean { return this.drivePanelOpen; }
  get driveSurface(): string { return this.drivePanelOpen ? "drive" : this.historyOpen ? "history" : this.diffOpen ? "diff" : this.contextOpen ? "context" : this.outputId !== null ? "output" : this.artifact ? "review" : this.memory.surface; }
  get diffOpen(): boolean { return this.artifact?.kind === "changes" && !this.contextOpen && this.outputId === null && !this.historyOpen; }
  get panelExpanded(): boolean { return this.diffOpen && this.diffPanel.expanded; }
  get paused(): boolean { return !this.memory.followFlow || this.selectedId !== null; }
  /// The shared evidence projection for the current run — the single source the
  /// response summary and the review surface both read, so they cannot disagree.
  get evidence(): RunEvidence { return projectRunEvidence(this.current?.entries ?? []); }
  get memory(): RunMemory {
    return this.memoryFor(this.current?.id ?? 0);
  }
  private memoryFor(id: number): RunMemory {
    let memory = this.memories.get(id);
    if (!memory) {
      memory = { surface: "response", followFlow: true, flowOffset: 0, anchor: null, responseWindow: null, expansion: new Map(), flowFocus: null,
        reviewSelection: 0, logSelection: 0, detail: null, detailOrigin: "response", detailOffsets: new Map() };
      this.memories.set(id, memory);
    }
    return memory;
  }

  /// Records for the active surface. The log keeps the full ordered record; the
  /// review lists recorded changes then their verification commands, so the two
  /// sections share one selection and detail model.
  private records(): RecordEntry[] {
    const run = this.current;
    const entries = run?.request ? [run.request, ...run.entries] : run?.entries ?? [];
    if (this.memory.surface === "log") return entries;
    if (this.memory.surface === "review") {
      const tools = entries.filter((entry): entry is ToolEntry => entry.type === "tool");
      return [...tools.filter((tool) => tool.phase === "change"), ...tools.filter((tool) => tool.phase === "verify" && tool.name === "run_command")];
    }
    return [];
  }
  private get selection(): number { return this.memory.surface === "log" ? this.memory.logSelection : this.memory.reviewSelection; }
  private set selection(value: number) { if (this.memory.surface === "log") this.memory.logSelection = value; else this.memory.reviewSelection = value; }

  act(action: Action): string | undefined {
    if (action.kind === "drive-control") return; // routed by the workbench
    if (action.kind === "drive-follow") { this.driveFollowing = true; this.driveJump = true; return; }
    if (action.kind === "drive-trace-toggle") {
      if (this.driveCollapsed.has(action.id)) this.driveCollapsed.delete(action.id); else this.driveCollapsed.add(action.id);
      this.holdDrive(); return;
    }
    if (action.kind === "drive-open") {
      if (this.drivePanelOpen) { this.act({ kind: "panel-close" }); return; }
      this.dismissOutput(); this.contextOpen = false; this.historyOpen = false; this.artifact = null;
      this.memory.surface = "response"; this.focused = true; this.drivePanelOpen = true; this.driveOffset = 0; this.driveFollowing = true; this.driveJump = true; return;
    }
    if (["diff-open", "artifact", "context", "review", "log", "history", "run", "surface", "thinking", "request", "follow", "panel-close", "back"].includes(action.kind)) this.drivePanelOpen = false;
    if (action.kind === "diff-open") {
      this.pauseFlow(); this.dismissOutput(); this.contextOpen = false; this.historyOpen = false;
      this.memory.surface = "response"; this.focused = true;
      this.artifact = { kind: "changes", runId: action.runId, recordId: action.recordId ?? 0 };
      this.diffPanel.open(this.runs, action.runId, action.recordId);
      return;
    }
    if (action.kind === "diff-select" || action.kind === "diff-live" || action.kind === "diff-expand") {
      this.focused = true; this.diffPanel.act(action); return;
    }
    if (action.kind === "copy") {
      const run = action.runId === undefined ? this.current : this.runs.find((run) => run.id === action.runId);
      const text = run?.answer?.raw ?? run?.entries.filter((entry): entry is AssistantEntry => entry.type === "assistant").map((entry) => entry.raw).join("\n\n");
      if (text && run) { this.copied = { runId: run.id, until: Date.now() + 1600 }; this.onCopy?.(text); }
      return text;
    }
    if (action.kind === "workspace" || action.kind === "settings") return; // routed by the controller
    if (action.kind === "panel-close") {
      this.contextOpen = false; this.dismissOutput(); this.artifact = null;
      this.memory.surface = "response"; this.memory.detail = null; this.focused = false;
      this.restoreInspectionOrigin();
      return;
    }
    if (action.kind === "panel-toggle") { this.act(this.panelOpen ? { kind: "panel-close" } : { kind: "log" }); return; }
    if (action.kind === "context") {
      this.pauseFlow(); this.dismissOutput(); this.historyOpen = false; this.contextOpen = true; this.focused = true;
      return;
    }
    if (action.kind === "response-start") {
      const answer = this.current?.settled ? this.current.answer : undefined;
      if (!answer) return;
      this.pauseFlow(); this.act({ kind: "panel-close" }); this.historyOpen = false;
      this.memory.surface = "response"; this.memory.detail = null; this.memory.flowFocus = null;
      this.focused = true;
      this.reveal = { key: entryKey(answer.id), line: 0, start: true };
      return;
    }
    this.focused = true;
    if (action.kind === "follow") { this.follow(); return; }
    if (action.kind === "artifact") {
      if (this.artifact?.runId === action.runId && this.artifact.kind === action.target) { this.closeArtifact(); return; }
      if (action.target === "changes") { this.act({ kind: "diff-open", runId: action.runId }); return; }
      const run = this.runs.find((run) => run.id === action.runId);
      if (!run) return;
      const records = artifactRecords(run, action.target);
      const record = records.find((tool) => toolFailed(tool) || tool.state === "denied") ?? records[0];
      if (!record) return;
      this.pauseFlow();
      this.dismissOutput(); this.contextOpen = false; this.historyOpen = false; this.memory.surface = "response";
      this.artifact = { runId: run.id, kind: action.target, recordId: record.id };
      return;
    }
    if (action.kind === "artifact-step") {
      if (this.diffOpen) { this.diffPanel.step(action.step); return; }
      if (!this.artifact) return;
      const run = this.runs.find((run) => run.id === this.artifact!.runId);
      if (!run) return;
      const records = artifactRecords(run, this.artifact.kind);
      const index = records.findIndex((tool) => tool.id === this.artifact!.recordId);
      const record = records[Math.max(0, Math.min(records.length - 1, index + action.step))];
      if (record) this.artifact.recordId = record.id;
      return;
    }
    if (action.kind === "artifact-close") { this.closeArtifact(); return; }
    if (action.kind === "toggle") {
      this.pauseFlow();
      const memory = this.memoryFor(action.runId);
      const run = this.runs.find((run) => run.id === action.runId);
      const reasoning = run?.entries.find((entry) => entry.type === "reasoning" && entryKey(entry.id) === action.key);
      const open = !(memory.expansion.get(action.key) ?? this.flowExpansions.get(action.key)?.open ?? Boolean(reasoning?.type === "reasoning" && reasoning.streaming && !run?.settled));
      memory.expansion.set(action.key, open);
      this.memory.flowFocus = `${action.key}:0:0`;
      this.reveal = { key: action.key, line: 0, block: open };
      return;
    }
    if (action.kind === "thinking") {
      const reasoning = this.current?.entries.findLast((entry) => entry.type === "reasoning");
      if (!reasoning) { this.focused = false; return; }
      this.contextOpen = false; this.artifact = null; this.dismissOutput();
      this.historyOpen = false;
      this.memory.surface = "response";
      this.memory.detail = null;
      this.act({ kind: "toggle", runId: this.current!.id, key: entryKey(reasoning.id) });
      return;
    }
    if (action.kind === "request") {
      if (!this.current?.request) { this.focused = false; return; }
      this.contextOpen = false; this.artifact = null; this.dismissOutput();
      this.historyOpen = false;
      this.memory.surface = "response";
      this.memory.detail = null;
      this.act({ kind: "toggle", runId: this.current.id, key: entryKey(this.current.request.id) });
      return;
    }
    if (action.kind === "arguments") {
      if (this.argumentsOpen.has(action.id)) this.argumentsOpen.delete(action.id); else this.argumentsOpen.add(action.id);
      if (action.key) {
        const open = this.argumentsOpen.has(action.id);
        this.reveal = { key: `${action.key}:${open ? "input" : "arguments"}`, line: 0, block: open };
      }
      return;
    }
    if ((action.kind === "review" || action.kind === "verification" || action.kind === "failure") && action.runId !== undefined && action.runId !== this.current?.id) {
      this.inspectionOrigin = { selectedId: this.selectedId, runId: this.current?.id ?? 0 };
      this.selectedId = action.runId;
    }
    if (action.kind === "review") { this.openReview(); return; }
    if (action.kind === "verification" || action.kind === "failure") {
      this.pauseFlow(); this.contextOpen = false; this.artifact = null; this.dismissOutput(); this.historyOpen = false;
      const memory = this.memory;
      memory.surface = action.kind === "verification" ? "review" : "log";
      const records = this.records();
      const failed = (entry: WorkbenchEntry) => entry.type === "tool" && (action.kind === "failure" || entry.phase === "verify" && entry.name === "run_command")
        && (toolFailed(entry) || entry.state === "denied");
      const selected = records.some(failed) ? records.findIndex(failed) : records.findIndex((entry) => entry.type === "tool" && entry.phase === "verify" && entry.name === "run_command");
      this.selection = Math.max(0, selected);
      memory.detailOrigin = "response";
      memory.detail = records[this.selection]?.id ?? null;
      return;
    }
    if (action.kind === "log") { this.openLog(); return; }
    if (action.kind === "history") {
      this.historyOpen = !this.historyOpen;
      this.historyIndex = Math.max(0, this.runs.findIndex((run) => run.id === this.current?.id));
      return;
    }
    this.historyOpen = false;
    if (this.outputId !== null) {
      this.outputId = null;
      if (action.kind === "back") return;
    }
    if (action.kind === "run") { this.selectedId = action.id; this.inspectionOrigin = null; }
    if (action.kind === "surface") { this.pauseFlow(); this.contextOpen = false; this.artifact = null; this.memory.surface = action.surface; this.memory.detail = null; this.restoreInspectionOrigin(); }
    if (action.kind === "record") {
      this.memory.detailOrigin = this.memory.surface;
      this.memory.detail = action.id;
      this.selection = Math.max(0, this.records().findIndex((entry) => entry.id === action.id));
    }
    if (action.kind === "back") {
      const memory = this.memory;
      if (memory.surface === "response" && this.artifact) { this.closeArtifact(); return; }
      if (memory.detail !== null) { memory.detail = null; memory.surface = memory.detailOrigin; }
      else if (memory.surface !== "response") memory.surface = "response";
      else { this.focused = false; memory.flowFocus = null; }
      this.restoreInspectionOrigin();
    }
  }

  private closeArtifact(): void {
    this.artifact = null;
    this.focused = false;
  }

  private restoreInspectionOrigin(): void {
    if (this.memory.surface !== "response" || !this.inspectionOrigin) return;
    const origin = this.inspectionOrigin;
    this.selectedId = origin.selectedId;
    const saved = this.memoryFor(origin.runId);
    this.memory.surface = "response";
    this.memory.followFlow = saved.followFlow;
    this.memory.flowOffset = saved.flowOffset;
    this.memory.anchor = saved.anchor;
    this.inspectionOrigin = null;
  }

  /// Open the change review when the run recorded changes or checks, otherwise
  /// the log — a question-only run never shows empty coding controls.
  private openReview(): void {
    this.pauseFlow(); this.contextOpen = false; this.artifact = null; this.dismissOutput(); this.historyOpen = false;
    const memory = this.memory;
    memory.detail = null;
    memory.detailOrigin = memory.surface;
    memory.surface = this.evidence.hasChanges || this.evidence.verifications.length ? "review" : "log";
    this.selection = 0;
  }
  private openLog(): void {
    this.pauseFlow(); this.contextOpen = false; this.artifact = null; this.dismissOutput(); this.historyOpen = false;
    const memory = this.memory;
    memory.detail = null;
    memory.detailOrigin = memory.surface;
    memory.surface = "log";
  }
  private moveRun(delta: number): void {
    this.inspectionOrigin = null;
    const at = this.runs.findIndex((run) => run.id === this.current?.id);
    const next = this.runs[Math.max(0, Math.min(this.runs.length - 1, at + delta))];
    if (next) this.selectedId = next.id;
  }
  /// Left/Right move between the conversation and recorded review. Tab selects
  /// inline controls in the conversation; Ctrl+B opens the execution log.
  private cycleSurface(step: number): void {
    this.pauseFlow(); this.contextOpen = false; this.artifact = null;
    const memory = this.memory;
    this.dismissOutput();
    memory.detail = null;
    const available: Surface[] = this.evidence.hasChanges || this.evidence.verifications.length ? ["response", "review"] : ["response"];
    const index = Math.max(0, available.indexOf(memory.surface));
    memory.surface = available[Math.max(0, Math.min(available.length - 1, index + step))]!;
    this.restoreInspectionOrigin();
  }
  key(key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): boolean {
    const { name } = key;
    if (this.diffOpen && key.meta && (name === "return" || name === "enter")) { this.diffPanel.act({ kind: "diff-expand" }); return true; }
    if (key.ctrl && name === "x") { this.act({ kind: "thinking" }); return true; }
    if (key.meta && name === "h") { this.act({ kind: "history" }); return true; }
    if (key.meta && name === "r") { this.act({ kind: "response-start" }); return true; }
    if (key.meta && name === "a" && this.memory.surface !== "response") {
      const record = this.records()[this.selection];
      if (record?.type === "tool") this.act({ kind: "arguments", id: record.id });
      return true;
    }
    if (this.historyOpen && this.focused && !key.ctrl && !key.meta) {
      if (name === "up" || name === "down" || name === "pageup" || name === "pagedown") this.historyIndex = Math.max(0, Math.min(this.runs.length - 1, this.historyIndex + (name === "up" || name === "pageup" ? -1 : 1) * (name.startsWith("page") ? this.pageSize : 1)));
      if (name === "home" || name === "end") this.historyIndex = name === "home" ? 0 : Math.max(0, this.runs.length - 1);
      if (name === "return") this.act({ kind: "run", id: this.runs[this.historyIndex]?.id ?? null });
      if (name === "escape" || name === "backspace") { this.historyOpen = false; this.focused = false; }
      return ["up", "down", "pageup", "pagedown", "home", "end", "return", "escape", "backspace"].includes(name ?? "");
    }
    if (this.outputId !== null && name === "escape" && !key.ctrl && !key.meta) {
      this.dismissOutput(); this.focused = this.memory.surface !== "response" || this.artifact !== null; return true;
    }
    if (this.contextOpen && name === "escape" && !key.ctrl && !key.meta) { this.contextOpen = false; this.focused = this.panelOpen; return true; }
    if (this.drivePanelOpen && name === "escape" && !key.ctrl && !key.meta) { this.act({ kind: "panel-close" }); return true; }
    if (this.artifact && this.memory.surface === "response" && name === "escape" && !key.ctrl && !key.meta) { this.closeArtifact(); return true; }
    if (key.ctrl && name === "t") { this.focused = !this.focused; return true; }
    if (key.meta && (name === "up" || name === "down")) { this.historyOpen = false; this.dismissOutput(); this.moveRun(name === "up" ? -1 : 1); return true; }
    if (this.artifact && this.focused && !key.ctrl && !key.meta && (name === "left" || name === "right")) {
      this.act({ kind: "artifact-step", step: name === "left" ? -1 : 1 }); return true;
    }
    if (this.artifact && this.focused && key.meta && name === "a") { this.act({ kind: "arguments", id: this.artifact.recordId }); return true; }
    if (this.panelOpen && this.focused && !key.ctrl && !key.meta && name === "tab") {
      if (this.memory.surface !== "response") { this.moveRecord(key.shift ? -1 : 1); return true; }
      return true;
    }
    if (this.focused && name === "tab" && !key.ctrl && !key.meta && !this.panelOpen) {
      this.moveFlowControl(key.shift ? -1 : 1); return true;
    }
    if ((key.meta || this.focused) && (name === "left" || name === "right" || (this.focused && name === "tab"))) {
      this.cycleSurface(name === "left" || key.shift ? -1 : 1);
      return true;
    }
    if (key.ctrl && name === "g") { if (this.drivePanelOpen) { this.driveFollowing = true; this.driveJump = true; } else if (this.diffOpen) this.diffPanel.act({ kind: "diff-live" }); else this.follow(); return true; }
    if (this.diffOpen && this.focused && !key.ctrl && !key.meta && this.diffPanel.key(name)) return true;
    if (name === "pageup" || name === "pagedown") { this.scroll(name === "pageup" ? -this.pageSize : this.pageSize); return true; }
    if (!this.focused || key.ctrl || key.meta || key.shift) return false;
    if (name === "home" || name === "end") { this.scroll(name === "home" ? -Infinity : Infinity); return true; }
    if (name === "escape" || name === "backspace") { this.act({ kind: "back" }); return true; }
    if (name === "up" || name === "down") {
      if (this.contextOpen || this.outputId !== null || this.artifact) this.scroll(name === "up" ? -1 : 1);
      else if (this.memory.surface !== "response" && this.memory.detail === null) this.moveRecord(name === "up" ? -1 : 1);
      else this.scroll(name === "up" ? -1 : 1);
    }
    if (name === "return") {
      if (this.contextOpen || this.outputId !== null || this.artifact) return true;
      const record = this.records()[this.selection];
      if (this.memory.surface !== "response" && record) this.act({ kind: "record", id: record.id });
      else if (this.outputId === null) {
        const control = this.flowControls.find((control) => control.key === this.memory.flowFocus)
          ?? this.flowControls.find((control) => control.row >= this.memory.flowOffset);
        if (control) this.act(control.action);
      }
    }
    return ["up", "down", "return"].includes(name ?? "");
  }
  private moveRecord(delta: number): boolean {
    const memory = this.memory;
    const records = this.records();
    const before = this.selection;
    this.selection = Math.max(0, Math.min(records.length - 1, this.selection + delta));
    if (memory.detail !== null) memory.detail = records[this.selection]?.id ?? null;
    return before !== this.selection;
  }
  private follow(): void {
    this.snapScroll = true;
    this.historyOpen = false; this.dismissOutput(); this.selectedId = null;
    this.inspectionOrigin = null;
    this.artifact = null;
    this.contextOpen = false;
    const memory = this.memory;
    memory.surface = "response"; memory.detail = null; memory.followFlow = true;
    memory.anchor = null; memory.flowFocus = null; this.reveal = null; this.focused = false;
  }
  private pauseFlow(): void {
    this.scrollPending = false;
    const memory = this.memory;
    if (memory.followFlow) {
      // Freeze automatic disclosures too: finishing a turn must not remove
      // the reasoning currently under the reader's eyes.
      for (const [key, expansion] of this.flowExpansions) this.memoryFor(expansion.runId).expansion.set(key, expansion.open);
    }
    memory.followFlow = false;
  }
  private moveFlowControl(delta: number): void {
    if (!this.flowControls.length) return;
    this.pauseFlow();
    const current = this.flowControls.findIndex((control) => control.key === this.memory.flowFocus);
    const firstVisible = this.flowControls.findIndex((control) => control.row >= this.memory.flowOffset);
    const index = current < 0 ? Math.max(0, firstVisible) : Math.max(0, Math.min(this.flowControls.length - 1, current + delta));
    const selected = this.flowControls[index]!;
    this.memory.flowFocus = selected.key;
    const row = this.flowRows[selected.row]!;
    this.reveal = { key: row.key, line: row.line };
  }
  private scroll(amount: number): boolean {
    if (this.drivePanelOpen) return this.scrollPane(amount, this.regions.find((region) => region.target === "drive"));
    if (this.diffOpen) { this.diffPanel.scroll(amount); return true; }
    if (this.contextOpen) return this.scrollPane(amount, this.regions.find((region) => region.target === "context"));
    if (this.outputId !== null) return this.scrollPane(amount, this.regions.find((region) => region.target === "output"));
    if (this.artifact) return this.scrollPane(amount, this.regions.find((region) => region.recordId === this.artifact!.recordId));
    const memory = this.memory;
    const shown = this.records()[this.selection]?.id;
    const detailId = memory.detail ?? (this.regions.some((region) => region.recordId === shown && shown !== undefined) ? shown : undefined);
    if (detailId !== null && detailId !== undefined && memory.surface !== "response") return this.scrollPane(amount, this.regions.find((region) => region.recordId === detailId));
    else if (memory.surface === "response") return this.scrollFlow(amount);
    else return this.moveRecord(amount);
  }
  private scrollFlow(amount: number): boolean {
    const memory = this.memory;
    const next = Math.max(0, Math.min(this.flowMaximum, memory.flowOffset + amount));
    // Wheel momentum at an edge must not pause following, add a footer, or
    // discard the reading anchor. Reaching live from scrollback resumes it.
    if (amount > 0 && next === this.flowMaximum && this.selectedId === null && (!this.panelOpen || this.drivePanelOpen)) {
      if (memory.followFlow && next === memory.flowOffset) return false;
      memory.followFlow = true;
    } else {
      if (next === memory.flowOffset) return false;
      this.pauseFlow();
    }
    memory.flowOffset = next;
    this.snapScroll = true;
    memory.anchor = null; memory.flowFocus = null; this.reveal = null;
    return true;
  }
  private scrollPane(amount: number, region?: ScrollRegion): boolean {
    if (!region) return false;
    const before = region.target === "drive" ? this.driveOffset : region.target === "context" ? this.contextOffset : region.target === "output" ? this.outputOffset : this.memory.detailOffsets.get(region.recordId!) ?? 0;
    const next = Math.max(0, Math.min(region.maximum ?? 0, before + amount));
    if (region.target === "drive") {
      if (amount > 0 && next === region.maximum) { this.driveFollowing = true; this.driveJump = true; }
      else if (next !== before) this.holdDrive();
    }
    if (next === before) return false;
    if (region.target === "drive") this.driveOffset = next;
    else if (region.target === "context") this.contextOffset = next;
    else if (region.target === "output") this.outputOffset = next;
    else this.memory.detailOffsets.set(region.recordId!, next);
    return true;
  }
  private holdDrive(): void {
    if (this.driveFollowing && this.driveRendered) this.driveSnapshot = { state: structuredClone(this.driveRendered), now: Date.now() };
    this.driveFollowing = false; this.driveScrollPending = false;
  }
  wheel(row: number, column: number, amount: number): boolean {
    const region = this.regions.find((region) => row >= region.row && row < region.row + region.height && column >= region.column && column < region.column + region.width);
    if (!region) return false;
    if (region.target === "diff") return this.diffPanel.wheel(row, amount);
    if (region.target === "drive" || region.target === "output" || region.target === "context" || region.recordId !== undefined) return this.scrollPane(amount, region);
    if (region.target === "history") {
      const before = this.historyIndex;
      this.historyIndex = Math.max(0, Math.min(this.runs.length - 1, this.historyIndex + amount));
      return before !== this.historyIndex;
    }
    if (region.target === "list") return this.moveRecord(amount);
    return this.scrollFlow(amount);
  }

  /// Finished turns fold, except where folding would take something away:
  /// nothing folds while an Agent Drive mission is active (Drive reads the
  /// screen) or while the reader is scrolled back (their place must not move);
  /// the turn whose evidence is open and the most recent turn with an answer
  /// stay open, so a stopped follow-up never hides the last answer.
  /// `null` keeps every turn open.
  private unfoldable(drive: DriveState | null): Set<number> | null {
    if (drive && !["completed", "stopped", "idle"].includes(drive.status)) return null;
    if (!this.memory.followFlow) return null;
    const keep = new Set<number>(this.artifact ? [this.artifact.runId] : []);
    const answered = this.runs.findLast((run) => run.settled && run.answer);
    if (answered) keep.add(answered.id);
    return keep;
  }

  render(options: { width: number; height: number; paint: Painter; title: string; path: string; branch?: string | null; now?: number; presence?: PresenceState;
    drive?: DriveState | null;
    animateScroll?: boolean;
    panel?: boolean; column?: number; replace?: boolean; contextLines?: string[]; openedAt?: number; createdAt?: number; model?: string;
    markdown: (entry: AssistantEntry, width: number) => string[] }): { rows: string[]; zones: SessionZone[] } {
    const { width, height, paint } = options;
    const run = this.current;
    const memory = this.memory;
    const zones: SessionZone[] = [];
    if (!options.panel || options.replace) { this.regions = []; this.hoverRegions = []; this.hoverReflow = false; this.scrollPending = false; this.answerRows = []; this.latestAnswerRows = []; }
    if (options.replace && this.pointer) this.hover(this.pointer.row, this.pointer.column);
    const canvas = new Canvas(width, height, paint);
    const output = this.runs.flatMap((run) => run.entries).find((entry) => entry.id === this.outputId);
    const rows = canvas.rows;
    const put = canvas.put.bind(canvas);
    const zone = (row: number, column: number, size: number, action: Action) => {
      if (row >= 0 && row < height && column >= 0 && column < width && size > 0) zones.push({ row, column: column + (options.column ?? 0), width: Math.min(size, width - column), action });
    };
    const region = (value: ScrollRegion) => this.regions.push({ ...value, column: value.column + (options.column ?? 0) });
    // The cyan accent and identity row share the existing header allocation.
    // Compact layouts drop optional timestamps before losing path and History.
    const inset = width >= 65 ? 2 : 1;
    const workspaceWidth = width - inset * 2;
    const now = options.now ?? Date.now();
    // Every docked panel except Agent Drive ends in the shared keycap footer.
    const panelFooter = Boolean(options.panel) && !this.drivePanelOpen && height >= 12;
    const finish = (hints: readonly (readonly [string, string])[] = [], note = "", escape: "close" | "back" = "close") => {
      if (!panelFooter) return { rows, zones };
      const close = keyHints(paint, [["Esc", escape]]);
      // Hints give way from the end so Esc always shows; the note goes first.
      let shown = [...hints];
      const line = () => [keyHints(paint, shown), close].filter(Boolean).join("  ");
      if (visibleLength(line()) + (note ? note.length + 2 : 0) > width - 2) note = "";
      while (shown.length && visibleLength(line()) > width - 2) shown = shown.slice(0, -1);
      const text = line();
      put(height - 1, 0, "", width, "surface");
      put(height - 1, 1, formatFooterLine(text, note ? paint.text(note, "muted") : "", width - 2), width - 2, "surface");
      zone(height - 1, 1 + visibleLength(text) - visibleLength(close), visibleLength(close), escape === "back" ? { kind: "back" } : { kind: "panel-close" });
      return { rows, zones };
    };
    let pageNote = "";
    if (!options.panel) {
      const header = sessionHeader({ width, paint, path: options.path, now, openedAt: options.openedAt ?? now,
        createdAt: options.createdAt, accent: height >= 10, pointer: this.pointer, historyActive: this.historyOpen,
        title: options.title, branch: options.branch, presence: options.presence });
      header.rows.forEach((text, row) => put(row, 0, text, width, "surface"));
      zone(header.row, header.path.column, header.path.width, { kind: "workspace" });
      zone(header.row, header.history.column, header.history.width, { kind: "history" });
      this.hoverRegions.push({ row: header.row, column: header.history.column, width: header.history.width, key: "header-history" });
    } else {
      for (let y = 0; y < height; y++) put(y, 0, "", width, "surface");
      const title = this.drivePanelOpen ? "AGENT DRIVE" : this.contextOpen ? "CONTEXT" : this.outputId !== null ? output?.type === "panel" && output.title ? output.title : "SESSION OUTPUT" : this.artifact?.kind === "changes" ? "DIFF"
        : this.artifact?.kind === "verification" ? "VERIFICATION" : this.artifact ? "FAILED / DENIED" : memory.surface === "review" ? "CHANGES" : "EXECUTION LOG";
      // Figma panel frame: a quiet uppercase label, then what it shows. The
      // keycap footer carries Esc close; × stays for narrow panels without one.
      const subjectRun = this.artifact ? this.runs.find((item) => item.id === this.artifact!.runId) ?? run : run;
      const subject = this.drivePanelOpen || this.outputId !== null ? "" : this.contextOpen ? safe(options.model ?? "")
        : subjectRun ? `Turn ${subjectRun.number}` : "";
      put(0, 1, paint.text(title, "muted") + (subject ? "  " + paint.text(subject, "secondary") : ""), width - 5, "surface");
      if (!panelFooter) {
        put(0, width - 3, paint.text("×", "muted"), 2, "surface");
        zone(0, width - 4, 4, { kind: "panel-close" });
      }
      put(1, 0, paint.text("─".repeat(width), "rule"), width, "surface");
    }
    if (height <= 2) return { rows, zones };
    if (options.panel && this.drivePanelOpen) {
      if (this.driveFollowing) this.driveSnapshot = undefined;
      this.driveRendered = options.drive ?? null;
      const panel = renderDrivePanel(width, height, paint, this.driveRendered, this.driveOffset, {
        follow: this.driveFollowing, snapshot: this.driveSnapshot, collapsed: this.driveCollapsed, now,
        ...(options.animateScroll && !this.driveJump ? { followStep: now - this.driveScrollAt >= 16 ? 1 : 0 } : {}),
      });
      if (panel.offset !== this.driveOffset) this.driveScrollAt = now;
      this.driveJump = false; this.driveScrollPending = this.driveFollowing && !!this.driveRendered?.traces?.length && panel.offset < panel.maximum;
      this.driveOffset = panel.offset;
      panel.rows.slice(2).forEach((text, index) => put(index + 2, 0, text, width, "surface"));
      for (const control of panel.zones) zone(control.row, control.column, control.width, control.action);
      region({ row: 4, column: 0, width, height: height - 4, target: "drive", maximum: panel.maximum });
      return { rows, zones };
    }

    const inspection = !options.panel && this.historyOpen;
    const paused = !memory.followFlow || this.selectedId !== null;
    // Keep the reading region the same height when follow/focus changes. The
    // quiet gap above the prompt becomes the scrollback control when needed.
    const cleanPanel = options.panel && (output?.type === "panel" && output.title || this.artifact?.kind === "changes");
    const panelTop = cleanPanel && !(this.artifact?.kind === "changes") ? 2 : 3;
    const layout = options.panel ? { actionsRow: 2, body: { row: panelTop, column: 1, width: width - 2, height: Math.max(1, height - panelTop - Number(panelFooter)) }, footerRow: height - 1 }
      : computeSessionLayout(width, height, { inspection, footer: true });
    const { actionsRow } = layout;
    const top = layout.body.row;
    const bodyHeight = layout.body.height;
    if (options.panel || !this.panelOpen) this.pageSize = Math.max(1, bodyHeight - 2);
    const x = layout.body.column;
    const stageWidth = layout.body.width;
    if (inspection) {
      const title = this.historyOpen ? "History" : this.outputId !== null ? "Session output" : memory.surface === "review" ? "Review" : "Execution log";
      const hint = this.focused && workspaceWidth >= 70 ? this.historyOpen || memory.detail === null && this.outputId === null ? " · ↑/↓ select · Enter open" : " · ↑/↓ scroll" : "";
      put(actionsRow, inset + conversationInset(workspaceWidth), paint.bold(title, "electricBright") + paint.text(hint, "secondary"), workspaceWidth - conversationInset(workspaceWidth) - 16);
      const back = "‹ Back / Esc";
      const column = inset + workspaceWidth - back.length - 3;
      put(actionsRow, column, paint.text(back, "electricBright"), back.length);
      zone(actionsRow, column, back.length, this.historyOpen ? { kind: "history" } : { kind: "back" });
    }
    const pane = (lines: string[], column: number, size: number, offset: number, target: ScrollRegion["target"], background: PaletteColor = "ink"): number => {
      const capacity = bodyHeight;
      offset = Math.min(offset, Math.max(0, lines.length - capacity));
      for (let row = 0; row < capacity; row++) put(top + row, column, lines[offset + row] ?? "", size - 1, options.panel ? "surface" : lines[offset + row] !== undefined ? background : "ink");
      region({ row: top, column, width: size, height: bodyHeight, target, maximum: Math.max(0, lines.length - capacity) });
      return offset;
    };
    if (this.historyOpen && !options.panel) {
      if (this.pointer) this.hover(this.pointer.row, this.pointer.column, now);
      const capacity = Math.max(1, Math.floor(bodyHeight / 2));
      const start = Math.max(0, this.historyIndex - capacity + 1);
      this.runs.slice(start, start + capacity).forEach((item, index) => {
        const row = top + index * 2;
        const label = ` ${number(item.number)}  ${safe(item.request?.text ?? "Session")}`;
        const selected = start + index === this.historyIndex;
        put(row, x + 1, selected ? paint.bold(label, "electricBright") : paint.text(label, "secondary"), stageWidth - 2, selected ? "surface" : "ink");
        if (selected) put(row, x + 1, paint.text("▎", "electric"), 1, "surface");
        put(row + 1, x + 6, paint.text(`${item.status.toLowerCase()} · ${item.request?.at ?? ""}${item.request?.model ? ` · ${safe(item.request.model)}` : ""}`, "secondary"), stageWidth - 8);
        zone(row, x + 1, stageWidth - 2, { kind: "run", id: item.id });
      });
      region({ row: top, column: x, width: stageWidth, height: bodyHeight, target: "history" });
      return { rows, zones };
    }
    if (options.panel && (output?.type === "panel" || output?.type === "block")) {
      // Session commands are global, even when the reader has pinned an old run.
      // Their temporary panel preserves that run's surface and reading position.
      const lines = output.type === "panel" && output.files?.length ? filePanelLines(output.files, stageWidth - 1, paint)
        : output.lines.flatMap((line) => foldCells(line, stageWidth - 1));
      this.outputOffset = pane(lines, x, stageWidth, this.outputOffset, "output");
      return finish([["↑↓", "scroll"]]);
    }
    if (options.panel && this.contextOpen) {
      this.contextOffset = pane((options.contextLines ?? []).flatMap((line) => foldCells(line, stageWidth - 1)), x, stageWidth, this.contextOffset, "context");
      return finish([["↑↓", "scroll"]], "/compact to free space");
    }
    if (options.panel && this.diffOpen) {
      const panel = this.diffPanel.render(width, height, paint);
      panel.rows.slice(2).forEach((text, index) => put(index + 2, 0, text, width, "surface"));
      for (const control of panel.zones) zone(control.row, control.column, control.width, control.action);
      region({ row: 2, column: 0, width, height: height - 2 - Number(panelFooter), target: "diff" });
      return finish([["←→", "files"], ["↑↓", "scroll"], ["Ctrl+G", "live"]]);
    }
    if (options.panel && this.artifact) {
      const source = this.runs.find((run) => run.id === this.artifact!.runId);
      const records = source ? artifactRecords(source, this.artifact.kind) : [];
      const selected = records.find((tool) => tool.id === this.artifact!.recordId);
      if (selected) {
        const index = records.indexOf(selected);
        const back = index > 0 ? "‹ " : "  ";
        const next = index + 1 < records.length ? " ›" : "  ";
        if (records.length > 1) put(2, x, paint.text(`${back}${index + 1}/${records.length}${next}`, "secondary"), stageWidth, "surface");
        if (index > 0) zone(2, x, 2, { kind: "artifact-step", step: -1 });
        if (index + 1 < records.length) zone(2, x + `${back}${index + 1}/${records.length}`.length, 2, { kind: "artifact-step", step: 1 });
        const lines = this.artifact.kind === "changes" ? diffPanelLines(selected, stageWidth - 1, paint) : this.detailLines(selected, stageWidth - 1, paint, options.markdown);
        const offset = pane(lines, x, stageWidth, memory.detailOffsets.get(selected.id) ?? 0, "body");
        memory.detailOffsets.set(selected.id, offset);
        this.regions.at(-1)!.recordId = selected.id;
        if (offset === 0 && this.artifact.kind !== "changes") zone(top, x, 14, { kind: "arguments", id: selected.id });
      }
      return finish(records.length > 1 ? [["←→", "records"], ["↑↓", "scroll"]] : [["↑↓", "scroll"]]);
    }
    if (!options.panel) {
      const reduced = reducedMotionEnabled();
      const focusedControl = this.focused && !this.panelOpen ? this.flowControls.find((control) => control.key === memory.flowFocus) : undefined;
      const focusedKey = focusedControl ? this.flowRows[focusedControl.row]?.hoverKey : undefined;
      const flow = renderSessionFlow({ runs: this.selectedId === null ? this.runs : run ? [run] : [],
        width: stageWidth, compact: height < 12, paint, now: reduced ? 0 : now, reducedMotion: reduced,
        activity: this.latest && options.presence ? { runId: this.latest.id, presence: options.presence } : undefined,
        copiedRunId: this.copied && this.copied.until > now ? this.copied.runId : undefined,
        emphasis: (key) => focusedKey === key ? 1 : this.transitions.value(`hover:${key}`, this.hovered === key ? 1 : 0, now, reduced),
        expansion: (id) => this.memoryFor(id).expansion, argumentsOpen: this.argumentsOpen, markdown: options.markdown,
        keepOpen: this.unfoldable(options.drive ?? null) });
      const initialFlow = this.flowRows.length === 0;
      // Snapshots, navigation and geometry changes resolve immediately. Only
      // automatic prose following is paced, relative to the response so folded
      // reasoning cannot drag the reader back into an older part of the turn.
      const smoothScroll = options.animateScroll && !reduced && !initialFlow && !this.snapScroll
        && this.flowGeometry?.width === stageWidth && this.flowGeometry.height === bodyHeight;
      this.flowGeometry = { width: stageWidth, height: bodyHeight };
      this.snapScroll = false;
      this.flowRows = flow.rows;
      this.flowExpansions = flow.expansions;
      // Remember each automatic fold so the turn stays folded when the reader
      // later scrolls back; only an explicit toggle opens it again.
      for (const [key, expansion] of flow.expansions) {
        if (key.endsWith(":fold") && !expansion.open && !this.memoryFor(expansion.runId).expansion.has(key)) this.memoryFor(expansion.runId).expansion.set(key, false);
      }
      this.flowControls = flow.rows.flatMap((row, index) => row.controls.map((control, ordinal) => ({ key: `${row.key}:${row.line}:${ordinal}`, row: index, action: control.action })));
      const tail = Math.max(0, flow.rows.length - bodyHeight);
      const following = memory.followFlow && this.selectedId === null && (!this.panelOpen || this.drivePanelOpen);
      let offset = following || initialFlow && this.selectedId === null ? tail : memory.flowOffset;
      const response = run?.answer;
      if (following && response?.streaming && !run?.settled) {
        const key = entryKey(response.id);
        const start = flow.rows.findIndex((row) => row.key === key);
        if (start >= 0 && memory.responseWindow?.key !== key) {
          const context = Math.min(2, Math.floor(bodyHeight / 6));
          const alreadyNearTop = start >= memory.flowOffset && start - memory.flowOffset <= Math.floor(bodyHeight / 3);
          memory.responseWindow = { key, line: alreadyNearTop ? memory.flowOffset - start : -context };
        }
      }
      const window = memory.responseWindow;
      const start = window ? flow.rows.findIndex((row) => row.key === window.key) : -1;
      let windowOffset = 0;
      if (window && start >= 0) {
        const end = flow.rows.findLastIndex((row) => row.key === window.key);
        // The reading window can advance into tools and later-round thinking.
        // Clamping it to the old prose block rewinds every subsequent paint,
        // including the first paint after a manual jump to the live edge.
        // Still bound it when disclosures collapse or the viewport grows.
        window.line = Math.min(window.line, Math.max(end, tail) - start);
        windowOffset = Math.max(0, start + window.line);
        if (following) {
          if (response?.streaming && !run?.settled && entryKey(response.id) === window.key) {
            // Calculate the live target with breathing room below the text.
            const threshold = Math.max(1, bodyHeight - Math.max(1, Math.floor(bodyHeight / 5)));
            const overflow = end - windowOffset - threshold + 1;
            offset = windowOffset + Math.max(0, overflow);
          } else offset = Math.max(tail, windowOffset);
          // A provider burst or Markdown reflow can add many rows at once.
          // Show every intervening row instead of replacing a screenful in one
          // paint. Keep draining after settlement, even without more deltas.
          if (smoothScroll && offset > windowOffset) {
            const step = window.scrolledAt === undefined || now - window.scrolledAt >= 16 ? 1 : 0;
            const next = Math.min(offset, windowOffset + step);
            this.scrollPending = next < offset;
            if (next > windowOffset) window.scrolledAt = now;
            offset = next;
          } else window.scrolledAt = now;
          windowOffset = offset;
          window.line = offset - start;
        }
      }
      // Preserve the last reading window through settlement and tool changes;
      // removing its breathing room would pull the page backwards.
      const maximum = Math.max(tail, windowOffset);
      this.flowMaximum = maximum;
      if (!memory.followFlow && memory.anchor) {
        const candidates = flow.rows.flatMap((row, index) => row.key === memory.anchor!.key || row.anchors?.includes(memory.anchor!.key) ? [index] : []);
        if (candidates.length) offset = candidates[Math.min(memory.anchor.line, candidates.length - 1)]!;
      }
      if (this.reveal) {
        const at = flow.rows.findIndex((row) => row.key === this.reveal!.key && row.line === this.reveal!.line);
        if (at >= 0 && this.reveal.start) offset = at;
        else if (at >= 0 && this.reveal.block) {
          // Bring the record into view, not just its title. Short evidence keeps
          // the response above it; long output starts at its own heading.
          const end = flow.rows.findLastIndex((row) => row.key === this.reveal!.key || row.key.startsWith(`${this.reveal!.key}:`) || row.parents?.includes(this.reveal!.key));
          const needed = Math.min(bodyHeight, end - at + 1);
          if (at < offset) offset = at;
          else if (at + needed > offset + bodyHeight) offset = at + needed - bodyHeight;
        } else if (at >= 0 && (at < offset || at >= offset + bodyHeight - 1)) offset = at;
        this.reveal = null;
      }
      offset = Math.min(maximum, Math.max(0, offset));
      memory.flowOffset = offset;
      const first = flow.rows[offset];
      memory.anchor = first ? { key: first.key, line: first.line } : null;
      // Keep the active thinking heading in the conversation when its trace
      // fills the viewport. Inspecting earlier content never pins a live label
      // over an unrelated block; the rows below the heading retain their anchors.
      const thinkingAt = flow.rows.findIndex((row) => row.activeThinking || row.thinking && first?.parents?.includes(row.key));
      const thinking = flow.rows[thinkingAt];
      const sticky = thinking && thinkingAt < offset && bodyHeight > 1
        && (first?.parents?.includes(thinking.key) || memory.followFlow && !this.artifact) ? thinking : undefined;
      const answers = new Set(this.runs.flatMap((item) => item.status === "COMPLETE" && item.answer ? [entryKey(item.answer.id)] : []));
      for (let index = 0; index < bodyHeight; index++) {
        const row = index === 0 && sticky ? sticky : flow.rows[offset + index];
        if (!row) continue;
        const selected = this.focused ? row.controls.find((_, ordinal) => memory.flowFocus === `${row.key}:${row.line}:${ordinal}`) : undefined;
        put(top + index, x, row.text, stageWidth, selected ? "raised" : row.background ?? "ink");
        if (answers.has(row.key)) this.answerRows.push(canvas.rows[top + index]!);
        if (this.latest?.status === "COMPLETE" && this.latest.answer && row.key === entryKey(this.latest.answer.id)) this.latestAnswerRows.push(canvas.rows[top + index]!);
        if (selected) put(top + index, x + Math.max(0, selected.column - 1), paint.text("›", "electricBright"), 1, "raised");
        if (row.hoverKey) this.hoverRegions.push({ row: top + index, column: x + (row.hoverKey.endsWith(":card") ? 2 : 0), width: stageWidth - (row.hoverKey.endsWith(":card") ? 4 : 0), key: row.hoverKey });
        for (const control of row.controls) if (!control.hidden) zone(top + index, x + control.column, Math.min(control.width, stageWidth - control.column), control.action);
      }
      if (this.pointer) this.hoverReflow = this.hover(this.pointer.row, this.pointer.column, now);
      region({ row: top, column: x, width: stageWidth, height: bodyHeight, target: "flow" });
      if (this.focused && !this.panelOpen && height >= 10) {
        const position = this.selectedId !== null ? `Turn ${number(run?.number ?? 0)}` : "↑ Scrollback";
        const hints = stageWidth >= 70 ? "Tab select · Enter open · Esc prompt" : "Tab/Enter";
        const label = this.focused ? paused ? `${position} · ${hints}` : `Conversation · ${hints}` : position;
        const follow = "";
        put(layout.footerRow, x + 1, formatFooterLine(paint.text(label, "secondary"), paint.text(follow, "electricBright"), stageWidth - 2), stageWidth - 2);
      }
    } else {
      const isReview = memory.surface === "review";
      const records = this.records();
      this.selection = Math.max(0, Math.min(records.length - 1, this.selection));
      const selected = records[this.selection];
      const detail = records.find((record) => record.id === memory.detail);
      if (options.panel) {
        if (detail) {
          const label = "‹ Back";
          put(2, 1, paint.text(label, "electric"), width - 2, "surface");
          zone(2, 1, label.length, { kind: "back" });
        }
      }
      // A file navigator beside a spacious diff only when the stage is wide
      // enough for both; narrow stages drill into the selected detail.
      const split = width >= 120 && stageWidth >= 100 && bodyHeight >= 5;
      const listWidth = split ? Math.min(36, Math.floor(stageWidth * 0.3)) : stageWidth;
      const recordLabel = (record: RecordEntry): string => safe(record.type === "tool" ? record.detail ?? record.name : record.type === "user" ? "Request" : record.type === "assistant" ? "Response" : record.type === "reasoning" ? "Thinking" : record.type === "notice" ? record.text : "Session output");
      const recordSub = (record: RecordEntry): string => record.type === "tool" ? (record.phase === "verify" ? `    ${checkLabel(record)}` : `    ${stateLabel(record)}`) : `    ${record.type}`;
      const recordTone = (record: RecordEntry): PaletteColor => record.type !== "tool" ? "secondary"
        : record.waiting || toolFailed(record) || record.state === "denied" ? "signal"
        : toolPhaseColor(record.name === "run_command" ? "verify" : record.phase);
      const recordSurface = (record: RecordEntry): PaletteColor => record.type !== "tool" ? "ink" : record.state === "running" || record.waiting ? "toolActive" : "toolSurface";
      if (split || !detail) {
        if (!records.length) put(top, x + 2, paint.dim(isReview ? "No changes recorded." : "No activity recorded."), listWidth - 2);
        else if (isReview) {
          // The review is two labeled sections — changed files, then the
          // verification commands. Headers take one display row and records
          // take two, so the list pages by row and never clips a record.
          const verifyStart = records.findIndex((record) => record.type === "tool" && (record as ToolEntry).phase === "verify");
          const sections: { name: string; items: RecordEntry[] }[] = verifyStart < 0 ? [{ name: "Changes", items: records }]
            : [
              ...(verifyStart ? [{ name: "Changes", items: records.slice(0, verifyStart) }] : []),
              ...(records.length > verifyStart ? [{ name: "Verification", items: records.slice(verifyStart) }] : []),
            ];
          const display: { kind: "header" | "label" | "sub"; text: string; record: RecordEntry | null }[] = [];
          const recordRow: number[] = [];
          for (const section of sections) {
            display.push({ kind: "header", text: section.name, record: null });
            section.items.forEach((record, ordinal) => {
              recordRow.push(display.length);
              display.push({ kind: "label", text: ` ${number(ordinal + 1)} ${recordLabel(record)}`, record }, { kind: "sub", text: recordSub(record), record });
            });
          }
          const capacity = Math.max(1, bodyHeight - (bodyHeight > 3 ? 1 : 0));
          const selectedRow = recordRow[this.selection] ?? 0;
          let start = Math.max(0, Math.min(selectedRow - capacity + 1, Math.max(0, display.length - capacity)));
          let end = Math.min(display.length, start + capacity);
          // The window must not end on a record's label row, which would clip
          // its sub row; and it must never lose the selected record.
          if (end < display.length && display[end - 1]!.kind === "label") {
            if (selectedRow > start) { start++; end = Math.min(display.length, start + capacity); }
            else if (capacity >= 2 && start > 0) { start--; end = Math.min(display.length, start + capacity); }
            else if (capacity >= 2) end = start + capacity - 1;
            // A one-row stage can only show the selected label; its sub is
            // clipped there by necessity, and the selection stays visible.
          }
          for (let index = start; index < end; index++) {
            const row = top + index - start;
            const item = display[index]!;
            if (item.kind === "header") { put(row, x + 2, paint.bold(item.text, item.text === "Changes" ? "electric" : "execute"), listWidth - 3); continue; }
            const isSelected = item.record!.id === selected?.id;
            const background = item.kind === "label" && isSelected ? "raised" : recordSurface(item.record!);
            put(row, x + 1, item.kind === "label" ? paint.bold(item.text, recordTone(item.record!)) : paint.text(item.text, "secondary"), listWidth - 2, background);
            put(row, x + 1, paint.text(item.kind === "label" && isSelected ? "▎" : "│", recordTone(item.record!)), 1, background);
            zone(row, x + 1, listWidth - 2, { kind: "record", id: item.record!.id });
          }
          if (display.length > capacity && bodyHeight > 3) {
            if (panelFooter) pageNote = `${start + 1}–${end} of ${display.length}`;
            else put(height - 1, x + 1, paint.dim(` ${start + 1}–${end} / ${display.length} · PgUp/PgDn`), listWidth - 2);
          }
        } else {
          const capacity = Math.max(1, Math.floor(bodyHeight / 2));
          const start = Math.max(0, this.selection - capacity + 1);
          records.slice(start, start + capacity).forEach((record, index) => {
            const row = top + index * 2;
            const isSelected = record.id === selected?.id;
            const label = ` ${number(start + index + 1)} ${recordLabel(record)}`;
            const background = isSelected ? "raised" : recordSurface(record);
            put(row, x + 1, isSelected || record.type === "tool" ? paint.bold(label, recordTone(record)) : paint.text(label, "secondary"), listWidth - 2, background);
            if (isSelected || record.type === "tool") put(row, x + 1, paint.text(isSelected ? "▎" : "│", recordTone(record)), 1, background);
            put(row + 1, x + 1, paint.text(recordSub(record), "secondary"), listWidth - 2, recordSurface(record));
            if (record.type === "tool") put(row + 1, x + 1, paint.text("│", recordTone(record)), 1, recordSurface(record));
            zone(row, x + 1, listWidth - 2, { kind: "record", id: record.id });
            zone(row + 1, x + 1, listWidth - 2, { kind: "record", id: record.id });
          });
        }
        region({ row: top, column: x, width: listWidth, height: bodyHeight, target: "list" });
      }
      const shown = detail ?? (split ? selected : undefined);
      if (shown) {
        const detailX = split ? x + listWidth + 1 : x;
        const detailWidth = x + stageWidth - detailX;
        const lines = this.detailLines(shown, detailWidth - 4, paint, options.markdown).map((line) => `  ${line}`);
        const offset = pane(lines, detailX, detailWidth, memory.detailOffsets.get(shown.id) ?? 0, "body", shown.type === "tool" ? "toolSurface" : "ink");
        memory.detailOffsets.set(shown.id, offset);
        // On a wide stage, the highlighted record is already the inspected one.
        this.regions[this.regions.length - 1]!.recordId = shown.id;
        // The return action lives on the action row; the arguments toggle
        // leads the detail content, so it scrolls with it.
        if (offset === 0 && shown.type === "tool") zone(top, detailX + 2, 14, { kind: "arguments", id: shown.id });
      }
      if (options.panel) return detail ? finish([["↑↓", "scroll"], ["Tab", "next"], ["Alt+A", "args"]], "", "back")
        : finish([["↑↓", "select"], ["Enter", "open"]], pageNote);
    }
    return { rows, zones };
  }

  private detailLines(entry: RecordEntry, width: number, paint: Painter, markdown: (entry: AssistantEntry, width: number) => string[]): string[] {
    const wrap = (text: string) => text.split("\n").flatMap((line) => foldCells(safe(line), width));
    if (entry.type === "user") return [paint.bold("REQUEST", "secondary"), ...wrap(`${entry.at} · ${entry.model ?? "Model not recorded"}`), "", ...wrap(entry.text)];
    if (entry.type === "assistant") return [paint.bold("AGENT UPDATE", "electricBright"), paint.text(entry.at ? safe(entry.at) : "Time not recorded", "muted"), "", ...markdown(entry, width)];
    if (entry.type === "reasoning") return [paint.bold("THINKING RECORD", "secondary"), "", ...wrap(entry.raw)];
    if (entry.type === "notice") return wrap(entry.text);
    if (entry.type === "panel" || entry.type === "block") return entry.lines;
    const verifying = entry.name === "run_command" && entry.phase === "verify";
    const lines = [paint.dim(`Arguments ${this.argumentsOpen.has(entry.id) ? "▾" : "▸"}`),
      ...wrap(entry.detail ?? entry.name).map((line) => paint.bold(line, toolPhaseColor(entry.name === "run_command" ? "verify" : entry.phase))), paint.text(verifying ? checkLabel(entry) : stateLabel(entry), entry.state === "done" && !entry.exitCode && (entry.name !== "run_command" || entry.exitCode === 0) ? "citron" : entry.waiting || toolFailed(entry) || entry.state === "denied" ? "signal" : "secondary"),
      paint.dim(`${entry.name}${entry.exitCode === undefined ? "" : ` / exit ${entry.exitCode}`}${entry.durationMs === undefined ? "" : ` / ${entry.durationMs}ms`}`), ""];
    const failed = toolFailed(entry) || entry.state === "denied" || entry.state === "stopped";
    if (entry.message && failed) lines.push(paint.bold("RESULT", "secondary"), ...wrap(entry.message), "");
    if (entry.diff) lines.push(paint.bold(entry.state === "done" ? "RECORDED CHANGE" : "PROPOSED CHANGE", "secondary"),
      ...formatDiffPreview(entry.diff.oldText, entry.diff.newText, 10_000, paint).flatMap((line) => foldCells(line, width)), "");
    if (entry.message && !failed) lines.push(paint.bold("RESULT", "secondary"), ...wrap(entry.message), "");
    if (!entry.message && entry.name === "run_command" && entry.state !== "running") lines.push(paint.dim("No command output recorded."));
    if (this.argumentsOpen.has(entry.id)) lines.push(paint.bold("ARGUMENTS", "secondary"), ...wrap(JSON.stringify(entry.input, null, 2)));
    return lines;
  }
}
