import { formatFooterLine, highlightCode, languageForPath, sanitizeTerminalLine, truncateText, visibleLength, type CodeHighlightState, type Painter, type PaletteColor } from "@demesne/brand";
import { keycap } from "./session-chrome.ts";
import type { ToolFileChange, WorkspaceFileText } from "@demesne/protocol";
import { fileChangeMarks, type FileChangeMarks } from "./file-marks.ts";
import type { ToolEntry } from "./entries.ts";
import type { SessionRun } from "./session.ts";
import { Canvas, foldCells } from "./canvas.ts";
import { codeDiff, type CodeDiff } from "./change-diff.ts";
import { diffSyntax } from "./diff-syntax.ts";
import { surface } from "./surface.ts";

const totals = new WeakMap<object, string>();
export function changeTotals(tool: ToolEntry): string {
  const source = tool.changes;
  if (tool.state !== "done" || !source?.length || source.some((change) => change.unavailable)) return "";
  const cached = totals.get(source);
  if (cached) return cached;
  let added = 0, removed = 0;
  for (const change of source) { const diff = codeDiff(change.before ?? "", change.after ?? ""); added += diff.added; removed += diff.removed; }
  const label = `+${added} −${removed}`;
  totals.set(source, label); return label;
}

const stateTone = (tool: ToolEntry): PaletteColor => tool.state === "done" ? "citron" : tool.state === "failed" || tool.state === "denied" || tool.waiting ? "signal"
  : tool.state === "stopped" ? "secondary" : "electric";

const LANGUAGES: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rs: "Rust", go: "Go", json: "JSON", yml: "YAML", yaml: "YAML", sh: "Shell", bash: "Shell", zsh: "Shell", md: "Markdown",
  toml: "TOML", css: "CSS", html: "HTML", swift: "Swift", rb: "Ruby", java: "Java", kt: "Kotlin", c: "C", h: "C", cpp: "C++", sql: "SQL" };
function languageName(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? LANGUAGES[extension] : undefined;
}

export type DiffAction = { kind: "diff-select"; path: string } | { kind: "diff-live" | "diff-expand" | "diff-view" | "diff-back" }
  | { kind: "diff-open"; runId: number; recordId?: number };
interface ChangeFile { path: string; tool: ToolEntry; applied?: ToolFileChange; previous?: ToolFileChange; revisions: number }

export const changeState = (tool: ToolEntry): string => tool.state === "failed" ? "Failed" : tool.state === "denied" ? "Denied"
  : tool.state === "stopped" ? "Stopped" : tool.state === "done" ? "Applied" : tool.waiting ? "Approval" : tool.drafting ? "Drafting" : "Pending";

/// This projection uses saved per-operation evidence, never today's file on
/// disk. Only contiguous snapshots are combined into a turn's accumulated diff.
export function changeFiles(tools: ToolEntry[]): ChangeFile[] {
  const files = new Map<string, ChangeFile>();
  for (const tool of tools.filter((tool) => tool.phase === "change")) {
    const paths = tool.changes?.map((change) => change.path) ?? [typeof tool.input.path === "string" ? tool.input.path
      : typeof tool.input.from === "string" ? `${tool.input.from} → ${tool.input.to ?? "…"}` : tool.detail ?? tool.name];
    for (const path of paths) {
      const file = files.get(path) ?? { path, tool, revisions: 0 };
      file.tool = tool; file.revisions++;
      const next = tool.state === "done" ? tool.changes?.find((change) => change.path === path) : undefined;
      if (next) {
        const previous = file.applied;
        if (previous && !previous.unavailable && !next.unavailable && previous.after === next.before && previous.afterExists === next.beforeExists)
          file.applied = { ...next, before: previous.before, beforeExists: previous.beforeExists };
        else { file.applied = next; if (previous) file.previous = previous; }
      }
      files.set(path, file);
    }
  }
  return [...files.values()];
}

/// `Diff │ Whole file` with the active view filled, then its key.
function viewSwitch(paint: Painter, active: "diff" | "whole"): { text: string } {
  const segment = (label: string, on: boolean) => on ? paint.wash(` ${label} `, "menuSelection", "electric") : paint.text(` ${label} `, "muted");
  return { text: segment("Diff", active === "diff") + paint.text("│", "rule") + segment("Whole file", active === "whole") + " " + keycap(paint, "v") };
}

export class DiffPanel {
  following = true;
  expanded = false;
  runId = 0;
  private followLatest = true;
  private runs: readonly SessionRun[] = [];
  private files: ChangeFile[] = [];
  private selectedPath: string | null = null;
  private offsets = new Map<string, number>();
  private maximum = 0;
  private pageSize = 10;
  private listOffset = 0;
  private lastSignature: unknown[] = [];
  private diffs = new Map<string, { before: string; after: string; diff: CodeDiff }>();
  private regions: { row: number; height: number; target: "files" | "code" }[] = [];
  private frozen: { key: string; file: ChangeFile } | null = null;
  private rendered: { signature: unknown[]; body: string[]; lines: (number | undefined)[] } | null = null;
  /// Figma 124:1038 / 117:813: one viewer, the changed parts ("diff") or the
  /// whole current file with this session's changes marked ("whole").
  view: "diff" | "whole" = "diff";
  /// A file opened on its own (from the Files list) rather than from a turn.
  standalone: string | null = null;
  /// Fetches a file's current text; the workbench supplies it.
  loader: ((path: string) => Promise<WorkspaceFileText>) | null = null;
  /// Called when a file finishes loading, so the view can repaint.
  onLoad: (() => void) | null = null;
  private texts = new Map<string, { revision: number; file: WorkspaceFileText | null }>();
  private changeIndex = new Map<string, number>();
  /// Search in the whole-file view: typing while `typing`, then Enter steps.
  search: { query: string; typing: boolean; index: number } | null = null;
  private wholeRendered: { key: string; text: string | null; rows: { line: number; first: boolean; code: string }[] } | null = null;

  reset(): void {
    this.following = true; this.expanded = false; this.runId = 0; this.followLatest = true;
    this.runs = []; this.files = []; this.selectedPath = null; this.offsets.clear(); this.diffs.clear(); this.lastSignature = []; this.regions = []; this.frozen = null; this.rendered = null;
    this.view = "diff"; this.standalone = null; this.texts.clear(); this.changeIndex.clear(); this.search = null; this.wholeRendered = null;
  }

  /// Opens one file on its own, in the whole-file view.
  openFile(runs: readonly SessionRun[], path: string): void {
    this.runs = runs; this.standalone = path; this.view = "whole"; this.following = false; this.search = null;
    this.ensureLoaded(path);
  }
  /// The file the viewer shows.
  get viewPath(): string | null { return this.standalone ?? this.selectedPath; }

  /// Every recorded change to a path this session, oldest first.
  private sessionChanges(path: string): ToolFileChange[] {
    return this.runs.flatMap((run) => run.tools).filter((tool) => tool.phase === "change" && tool.state === "done")
      .sort((a, b) => a.id - b.id).flatMap((tool) => tool.changes?.filter((change) => change.path === path && !change.unavailable) ?? []);
  }
  private ensureLoaded(path: string): void {
    const revision = this.sessionChanges(path).length;
    if (!this.loader || this.texts.get(path)?.revision === revision) return;
    this.texts.set(path, { revision, file: null });
    void this.loader(path).catch(() => ({ path, content: null, byteLength: null, reason: "could not load the file" }))
      .then((file) => { if (this.texts.get(path)?.revision === revision) this.texts.set(path, { revision, file }); this.onLoad?.(); });
  }
  /// The file now, or its latest recorded version while loading or when the
  /// daemon cannot read it; `note` explains a file that cannot be shown.
  private current(path: string): { text: string | null; note: string } {
    const loaded = this.texts.get(path);
    const latest = this.sessionChanges(path).at(-1);
    if (loaded?.file?.content != null) return { text: loaded.file.content, note: "" };
    if (latest?.afterExists) return { text: latest.after ?? "", note: loaded?.file ? "showing the last recorded version" : "" };
    if (loaded && !loaded.file) return { text: null, note: "Loading…" };
    return { text: null, note: loaded?.file?.reason ? `Can't show this file: ${loaded.file.reason}.` : "Loading…" };
  }
  /// This session's changes to a file, relative to before its first edit.
  marks(path: string): FileChangeMarks | null {
    const first = this.sessionChanges(path)[0];
    const now = this.current(path).text;
    if (!first || now === null) return null;
    return fileChangeMarks(first.beforeExists ? first.before ?? "" : "", now);
  }
  private get wholeKey(): string { return `whole:${this.viewPath}`; }

  /// Switches between the two views, keeping the same lines in view.
  toggleView(): void {
    const path = this.viewPath;
    if (!path) return;
    if (this.view === "diff") {
      const offset = this.offsets.get(this.offsetKey) ?? 0;
      const line = this.rendered?.lines.slice(offset).find((value) => value !== undefined);
      this.view = "whole"; this.ensureLoaded(path);
      if (line !== undefined) this.offsets.set(this.wholeKey, Math.max(0, line - 3));
    } else {
      if (this.standalone && !this.files.some((file) => file.path === path)) return;
      const top = (this.offsets.get(this.wholeKey) ?? 0) + 3;
      this.view = "diff";
      const index = this.rendered?.lines.findIndex((value) => value !== undefined && value >= top) ?? -1;
      if (index >= 0) { this.following = false; this.offsets.set(this.offsetKey, index); }
    }
  }
  /// Steps to the next or previous change in the whole-file view.
  stepChange(delta: number): void {
    const path = this.viewPath, changes = path ? this.marks(path)?.changes ?? [] : [];
    if (!path || !changes.length) return;
    const index = ((this.changeIndex.get(path) ?? -1) + delta + changes.length) % changes.length;
    this.changeIndex.set(path, index);
    this.offsets.set(this.wholeKey, Math.max(0, changes[index]!.start - 4));
  }
  private searchMatches(path: string): number[] {
    const text = this.current(path).text, query = this.search?.query.toLowerCase();
    if (!text || !query) return [];
    return text.split("\n").flatMap((line, index) => line.toLowerCase().includes(query) ? [index + 1] : []);
  }
  private stepSearch(delta: number): void {
    const path = this.viewPath, matches = path ? this.searchMatches(path) : [];
    if (!this.search || !matches.length) return;
    this.search.index = (this.search.index + delta + matches.length) % matches.length;
    this.offsets.set(this.wholeKey, Math.max(0, matches[this.search.index]! - 4));
  }
  /// The viewer's letter keys and its search field. `draftEmpty` keeps
  /// ordinary typing in the composer when there is a draft.
  letterKey(text: string, name: string | undefined, draftEmpty: boolean): boolean {
    if (this.search?.typing) {
      if (name === "escape") { this.search = null; return true; }
      if (name === "return" || name === "enter") { this.search.typing = false; this.search.index = -1; this.stepSearch(1); return true; }
      if (name === "backspace") { this.search.query = this.search.query.slice(0, -1); return true; }
      if (text && !/[\x00-\x1f\x7f]/.test(text)) { this.search.query += text; this.search.index = -1; this.stepSearch(1); this.search.typing = true; return true; }
      return true;
    }
    if (this.search && name === "escape") { this.search = null; return true; }
    if (!draftEmpty || !text || text.length !== 1) return false;
    if (text === "v") { this.toggleView(); return true; }
    if (this.view === "whole" && (text === "n" || text === "p")) {
      if (this.search && !this.search.typing) this.stepSearch(text === "n" ? 1 : -1); else this.stepChange(text === "n" ? 1 : -1);
      return true;
    }
    if (this.view === "whole" && text === "/") { this.search = { query: "", typing: true, index: -1 }; return true; }
    return false;
  }
  open(runs: readonly SessionRun[], runId: number, recordId?: number): void {
    this.frozen = null;
    this.runId = runId; this.followLatest = runId === runs.at(-1)?.id || !runs.length; this.following = recordId === undefined && this.followLatest;
    this.lastSignature = []; this.sync(runs);
    const tools = runs.find((run) => run.id === runId)?.tools ?? [];
    const file = recordId === undefined ? undefined : changeFiles(tools.filter((tool) => tool.id <= recordId)).findLast((file) => file.tool.id === recordId);
    if (file) { this.selectedPath = file.path; this.frozen = { key: this.offsetKey, file: { ...file, tool: { ...file.tool } } }; }
  }
  sync(runs: readonly SessionRun[]): void {
    this.runs = runs;
    if (this.following && this.followLatest) this.runId = runs.at(-1)?.id ?? this.runId;
    const tools = runs.find((run) => run.id === this.runId)?.tools.filter((tool) => tool.phase === "change") ?? [];
    const signature = [this.runId, ...tools.flatMap((tool) => [tool.id, tool.diff, tool.changes, tool.state, tool.waiting, tool.drafting, tool.detail])];
    if (signature.length === this.lastSignature.length && signature.every((part, i) => part === this.lastSignature[i])) return;
    this.lastSignature = signature;
    this.files = changeFiles(tools);
    if (this.following || !this.files.some((file) => file.path === this.selectedPath)) {
      const latest = [...this.files].sort((a, b) => a.tool.id - b.tool.id).at(-1);
      this.selectedPath = latest?.path ?? null;
      this.listOffset = Math.max(0, this.files.findIndex((file) => file.path === this.selectedPath) - 2);
    }
  }
  get selected(): ChangeFile | undefined { return this.files.find((file) => file.path === this.selectedPath); }
  private get offsetKey(): string { return `${this.runId}:${this.selectedPath}`; }
  act(action: DiffAction): void {
    // Choosing a file stays on it without freezing it: its diff keeps
    // updating as the agent edits; only switching files and scrolling stop.
    if (action.kind === "diff-select") { this.frozen = null; this.following = false; this.selectedPath = action.path; }
    if (action.kind === "diff-live") { this.frozen = null; this.following = true; this.followLatest = true; this.lastSignature = []; this.sync(this.runs); }
    if (action.kind === "diff-expand") this.expanded = !this.expanded;
    if (action.kind === "diff-view") this.toggleView();
  }
  step(delta: number): void {
    const i = this.files.findIndex((file) => file.path === this.selectedPath);
    const file = this.files[Math.max(0, Math.min(this.files.length - 1, i + delta))];
    if (file) { this.act({ kind: "diff-select", path: file.path }); this.listOffset = Math.max(0, this.files.indexOf(file) - 2); }
  }
  scroll(amount: number): boolean {
    this.following = false;
    const key = this.view === "whole" ? this.wholeKey : this.offsetKey;
    const before = this.offsets.get(key) ?? 0;
    const next = Math.max(0, Math.min(this.maximum, before + amount));
    this.offsets.set(key, next); return before !== next;
  }
  wheel(row: number, amount: number): boolean {
    const region = this.regions.find((region) => row >= region.row && row < region.row + region.height);
    if (!region) return false;
    if (region.target === "files") {
      const before = this.listOffset;
      this.following = false; this.listOffset = Math.max(0, Math.min(Math.max(0, this.files.length - region.height), this.listOffset + amount));
      return before !== this.listOffset;
    }
    return this.scroll(amount);
  }
  get scrollRegions() {
    return this.regions.map((region) => ({ ...region, surface: `diff-${region.target}`,
      offset: region.target === "code" ? this.offsets.get(this.offsetKey) ?? 0 : this.listOffset,
      maximum: region.target === "code" ? this.maximum : Math.max(0, this.files.length - region.height) }));
  }
  key(name?: string): boolean {
    if ((name === "left" || name === "right") && this.standalone) return false;
    if (name === "left" || name === "right") this.step(name === "left" ? -1 : 1);
    else if (["up", "down", "pageup", "pagedown", "home", "end"].includes(name ?? "")) this.scroll(name === "home" ? -Infinity : name === "end" ? Infinity
      : (name === "up" || name === "pageup" ? -1 : 1) * (name?.startsWith("page") ? this.pageSize : 1));
    else return false;
    return true;
  }
  /// Figma 117:813: the whole current file, this session's changes marked in
  /// the gutter (▌ added or changed, ▾ where lines were removed), the
  /// current change or search match highlighted.
  private renderWhole(canvas: Canvas, zones: { row: number; column: number; width: number; action: DiffAction }[], top: number, width: number, height: number, paint: Painter, path: string) {
    this.ensureLoaded(path);
    const { text, note } = this.current(path);
    const marks = this.marks(path);
    const changes = marks?.changes ?? [];
    const index = this.changeIndex.get(path) ?? -1;
    const clean = sanitizeTerminalLine(path), name = clean.slice(clean.lastIndexOf("/") + 1);
    const lines = text === null ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    // "change 1 of 3" on the right already counts the changes.
    const details = [languageName(path), text === null ? "" : `${lines.length} line${lines.length === 1 ? "" : "s"}`,
      changes.length ? "" : "no changes this session"].filter(Boolean).join(" · ");
    const back = this.standalone ? paint.text("‹ Files", "electric") : "";
    const lead = this.standalone ? back : paint.text(name, "paper");
    const view = changes.length || !this.standalone ? viewSwitch(paint, "whole").text : "";
    const matches = this.search ? this.searchMatches(path) : [];
    const right = this.search ? paint.text(`/${this.search.query}${this.search.typing ? "▏" : ""}`, "electric") + paint.text(matches.length ? ` · ${Math.max(0, this.search.index) + 1} of ${matches.length}` : this.search.query ? " · no matches" : "", "muted")
      : changes.length ? paint.text(`change ${index >= 0 ? index + 1 : "–"} of ${changes.length}`, "electric") : "";
    // As in the diff view, details give way before the switch.
    const fitsWith = (value: string) => visibleLength(value) + (view ? visibleLength(view) + 2 : 0) + visibleLength(right) + 2 <= width - 3;
    const withDetails = `${lead}  ${paint.text(details, "muted")}`;
    const left = fitsWith(withDetails) ? withDetails : lead;
    const fits = fitsWith(left);
    canvas.put(top, 1, formatFooterLine(fits && view ? `${left}  ${view}` : left, right, width - 3), width - 2, "surface");
    if (this.standalone) zones.push({ row: top, column: 1, width: 7, action: { kind: "diff-back" } });
    if (fits && view) zones.push({ row: top, column: 1 + visibleLength(left) + 2, width: visibleLength(view), action: { kind: "diff-view" } });
    top++;
    if (note) canvas.put(top++, 1, paint.text(note, "muted"), width - 2, "surface");
    // Rows: numbered, marked and highlighted; long lines fold.
    const digits = Math.max(2, String(lines.length).length);
    const key = `${path}:${width}:${paint.enabled}:${paint.themeName}`;
    let rows = this.wholeRendered?.key === key && this.wholeRendered.text === text ? this.wholeRendered.rows : null;
    if (!rows) {
      const built: { line: number; first: boolean; code: string }[] = [];
      const language = languageForPath(path), state: CodeHighlightState = { inBlockComment: false };
      lines.forEach((line, lineIndex) => {
        const plain = sanitizeTerminalLine(line.replaceAll("\t", "  "));
        const styled = paint.enabled && language ? highlightCode(plain, language, paint, state) : plain;
        foldCells(styled, Math.max(1, width - 2 - digits - 3)).forEach((code, part) => built.push({ line: lineIndex + 1, first: part === 0, code }));
      });
      rows = built;
      this.wholeRendered = { key, text, rows };
    }
    const footer = height >= 12 ? 1 : 0;
    const room = Math.max(0, height - top - footer);
    this.maximum = Math.max(0, rows.length - room); this.pageSize = Math.max(1, room - 1);
    // Offsets count file lines; map them to the first row of that line.
    const firstRow = (line: number) => { const at = rows!.findIndex((row) => row.line > line); return at < 0 ? Math.max(0, rows!.length - 1) : at; };
    const offset = Math.min(this.maximum, firstRow(this.offsets.get(this.wholeKey) ?? 0));
    const current = index >= 0 ? changes[index] : undefined;
    const match = this.search && this.search.index >= 0 ? matches[this.search.index] : undefined;
    for (let i = 0; i < room; i++) {
      const row = rows[offset + i];
      if (row === undefined) { canvas.put(top + i, 1, "", width - 2, "surface"); continue; }
      const { line: number, first, code } = row;
      const mark = marks?.added.has(number) ? paint.text("▌", "citron") : marks?.removedBefore.has(number) ? paint.text("▾", "signal") : " ";
      const gutter = first ? `${paint.text(String(number).padStart(digits), current && number >= current.start && number <= current.end ? "electric" : "muted")} ${mark} ` : `${" ".repeat(digits)} ${paint.text("↪", "muted")} `;
      const background: PaletteColor = number === match ? "accentSurface" : current && number >= current.start && number <= current.end ? "menuSelection" : "ink";
      canvas.put(top + i, 1, surface(gutter + code, width - 2, paint, background), width - 2, "surface");
    }
    this.regions.push({ row: top, height: room, target: "code" });
    return { rows: canvas.rows, zones };
  }

  private diff(key: string, before: string, after: string): CodeDiff {
    const cached = this.diffs.get(key);
    if (cached?.before === before && cached.after === after) return cached.diff;
    const diff = codeDiff(before, after);
    this.diffs.set(key, { before, after, diff });
    if (this.diffs.size > 128) this.diffs.delete(this.diffs.keys().next().value!);
    return diff;
  }
  render(width: number, height: number, paint: Painter): { rows: string[]; zones: { row: number; column: number; width: number; action: DiffAction }[] } {
    const canvas = new Canvas(width, height, paint), zones: { row: number; column: number; width: number; action: DiffAction }[] = [];
    const put = (row: number, text: string, tone: PaletteColor = "secondary", background: PaletteColor = "surface") => {
      if (row >= 2 && row < height) canvas.put(row, 1, paint.text(truncateText(text, width - 2), tone), width - 2, background);
    };
    const control = (row: number, column: number, label: string, action: DiffAction) => {
      if (row >= height || column + label.length > width) return;
      canvas.put(row, column, paint.text(label, "electric"), label.length, "surface"); zones.push({ row, column, width: label.length, action });
    };
    // Figma 20:124. Row 2: totals on the left; follow state and expand on the right.
    const counts = (file: ChangeFile): { added: number; removed: number } | null => {
      if (file.applied && !file.applied.unavailable) { const diff = this.diff(`${this.runId}:${file.path}:applied`, file.applied.before ?? "", file.applied.after ?? ""); return { added: diff.added, removed: diff.removed }; }
      if (file.tool.diff) { const diff = this.diff(`${this.runId}:${file.path}:proposal`, file.tool.diff.oldText, file.tool.diff.newText); return { added: diff.added, removed: diff.removed }; }
      return null;
    };
    const styledCounts = (value: { added: number; removed: number } | null) => value ? `${paint.text(`+${value.added}`, "citron")} ${paint.text(`−${value.removed}`, "signal")}` : "";
    const totals = this.files.reduce((sum, file) => { const value = counts(file); return value ? { added: sum.added + value.added, removed: sum.removed + value.removed } : sum; }, { added: 0, removed: 0 });
    const drafting = this.files.filter((file) => file.tool.state === "running" || file.tool.waiting).length;
    const summary = paint.text(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`, "paper") + (this.files.length ? ` ${styledCounts(totals)}` : "")
      + (drafting ? paint.text(` · ${drafting} drafting`, "electric") : "");
    const expand = this.expanded ? "restore" : "expand";
    // Following switches to whichever file the agent edits; pinned stays on
    // this one. Either way the diff shown is live.
    const followLabel = this.following ? " following edits " : " pinned ";
    const controlsWidth = followLabel.length + 2 + "Alt+↵".length + 1 + expand.length;
    const summaryRow = 2;
    // A file opened on its own has no turn to summarize: straight to the file.
    if (this.standalone) return this.renderWhole(canvas, zones, 2, width, height, paint, this.standalone);
    // Figma panel v2: the summary and the file list form one raised tile.
    const showControls = width - 4 >= controlsWidth + 12;
    canvas.put(summaryRow, 1, "", width - 2, "raised");
    canvas.put(summaryRow, 2, summary, Math.max(1, showControls ? width - controlsWidth - 6 : width - 4), "raised");
    if (showControls) {
      const followColumn = width - 2 - controlsWidth;
      canvas.put(summaryRow, followColumn, this.following ? paint.wash(followLabel, "accentSurface", "electric") : paint.text(followLabel, "secondary"), followLabel.length, "raised");
      zones.push({ row: summaryRow, column: followColumn, width: followLabel.length, action: { kind: "diff-live" } });
      const expandColumn = followColumn + followLabel.length + 2;
      canvas.put(summaryRow, expandColumn, keycap(paint, "Alt+↵") + paint.text(` ${expand}`, "muted"), controlsWidth - followLabel.length - 2, "raised");
      zones.push({ row: summaryRow, column: expandColumn, width: controlsWidth - followLabel.length - 2, action: { kind: "diff-expand" } });
    }
    // Reserve the file-list height so incoming files cannot shift inspected code.
    const capacity = Math.max(0, Math.min(5, Math.floor((height - 9) / 3)));
    this.listOffset = Math.min(this.listOffset, Math.max(0, this.files.length - capacity));
    this.files.slice(this.listOffset, this.listOffset + capacity).forEach((file, i) => {
      const row = 3 + i, selected = file === this.selected;
      const state = changeState(file.tool), tone = stateTone(file.tool);
      const mark = file.tool.state === "done" ? "✓" : file.tool.state === "failed" || file.tool.state === "denied" ? "×" : file.tool.state === "stopped" ? "■" : file.tool.waiting ? "!" : "◌";
      const right = `${paint.text(state, tone)}${counts(file) ? `  ${styledCounts(counts(file))}` : ""}`;
      const path = sanitizeTerminalLine(file.path), slash = path.lastIndexOf("/");
      const name = paint.text(path.slice(0, slash + 1), "muted") + paint.text(path.slice(slash + 1), selected ? "electricBright" : "paper");
      const background: PaletteColor = selected ? "tileSelection" : "raised";
      canvas.put(row, 1, selected ? paint.text("▎", "electric") : "", width - 2, background);
      canvas.put(row, 2, formatFooterLine(`${paint.text(mark, tone)} ${truncateText(name, Math.max(4, width - 10 - visibleLength(right)))}`, right, width - 5), width - 4, background);
      zones.push({ row, column: 1, width: width - 2, action: { kind: "diff-select", path: file.path } });
    });
    this.regions = [{ row: 3, height: capacity, target: "files" }];
    // The tile's lower edge, then the file's code.
    if (paint.enabled) canvas.put(3 + capacity, 1, paint.text("▀".repeat(width - 2), "raised"), width - 2, "surface");
    let top = 3 + capacity + 1;
    if (this.view === "whole" && this.viewPath) return this.renderWhole(canvas, zones, top, width, height, paint, this.viewPath);
    const file = this.frozen?.key === this.offsetKey ? this.frozen.file : this.selected;
    const signature = [width, paint.colors, paint.enabled, file?.path, file?.tool.diff, file?.tool.state, file?.tool.message, file?.tool.changes, file?.applied, file?.previous];
    const cached = this.rendered?.signature.every((value, index) => value === signature[index]);
    const body: string[] = cached ? this.rendered!.body : [];
    // The file line each body row shows, so switching views keeps your place.
    const bodyLines: (number | undefined)[] = cached ? this.rendered!.lines : [];
    const text = (value: string, tone: PaletteColor = "muted") => {
      const parts = value.split("\n").flatMap((line) => foldCells(paint.text(sanitizeTerminalLine(line), tone), Math.max(1, width - 2)));
      body.push(...parts); bodyLines.push(...parts.map(() => undefined));
    };
    const show = (key: string, before: string, after: string) => {
      const diff = this.diff(key, before, after);
      const digits = Math.max(2, String(Math.max(before.split("\n").length, after.split("\n").length)).length);
      const highlighted = diffSyntax(file?.path ?? "", before, after, diff.rows.slice(0, 10_000), paint);
      for (const [index, row] of diff.rows.entries()) {
        if (index >= 10_000) { text(`… ${diff.rows.length - index} more diff lines (preview limit)`); break; }
        // Folded context reads `… 41 unchanged lines` in the number column.
        if (row.kind === "gap") { body.push(surface(paint.text(`${" ".repeat(digits * 2 + 1)}${row.text}`, "muted"), width - 2, paint, "raised")); bodyLines.push(undefined); continue; }
        const numbers = `${String(row.old ?? "").padStart(digits)} ${String(row.next ?? "").padStart(digits)} `;
        const mark = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ";
        const tone = row.kind === "added" ? "citron" : row.kind === "removed" ? "signal" : "muted";
        // The diff is an inset code block: unchanged lines on the page color.
        const background = row.kind === "added" ? "diffAddedSurface" : row.kind === "removed" ? "diffRemovedSurface" : "ink";
        const code = highlighted.get(row) ?? sanitizeTerminalLine(row.text.replaceAll("\t", "  "));
        foldCells(code, Math.max(1, width - 2 - numbers.length - 2)).forEach((part, index) => {
          const gutter = index ? paint.text(" ".repeat(numbers.length) + "↪ ", "muted") : paint.text(numbers, "muted") + paint.text(mark + " ", tone);
          body.push(surface(gutter + part, width - 2, paint, background)); bodyLines.push(row.next);
        });
      }
      if (!diff.rows.length) text("No textual change.");
    };
    if (file) {
      // `app.test.ts  Applied · TypeScript · 2 edits` with the totals on the right.
      const path = sanitizeTerminalLine(file.path), name = path.slice(path.lastIndexOf("/") + 1);
      const details = [paint.text(changeState(file.tool), stateTone(file.tool)), languageName(path), `${file.revisions} edit${file.revisions === 1 ? "" : "s"}`]
        .filter(Boolean).map((part, index) => index ? paint.text(part!, "muted") : part).join(paint.text(" · ", "muted"));
      // The switch outranks the details: they give way first on narrow panels.
      const view = viewSwitch(paint, "diff"), right = styledCounts(counts(file));
      const withDetails = `${paint.text(name, "paper")}  ${details}`, bare = paint.text(name, "paper");
      const room = (left: string) => visibleLength(left) + 2 + visibleLength(view.text) + visibleLength(right) + 2 <= width - 3;
      const headerLeft = room(withDetails) ? withDetails : bare;
      const fits = room(headerLeft);
      canvas.put(top, 1, formatFooterLine(fits ? `${headerLeft}  ${view.text}` : headerLeft, right, width - 3), width - 2, "surface");
      if (fits) zones.push({ row: top, column: 1 + visibleLength(headerLeft) + 2, width: visibleLength(view.text), action: { kind: "diff-view" } });
      top++;
      // A past edit opened from the conversation shows the file as it was
      // then; say when the agent has changed it since.
      const live = this.selected;
      if (file === this.frozen?.file && live && live.tool.id !== file.tool.id) {
        canvas.put(top++, 1, paint.text("Showing an earlier edit · newer edits since · ", "secondary") + keycap(paint, "Ctrl+G") + paint.text(" latest", "muted"), width - 2, "surface");
      }
      if (!cached) {
        const completedEvidence = file.tool.state === "done" && file.tool.changes?.some((change) => change.path === file.path);
        if (!completedEvidence) {
          text(file.tool.state === "done" ? "Recorded input · fragment line numbers" : "Proposed code · not applied · fragment lines");
          if (file.tool.diff) show(`${this.runId}:${file.path}:proposal`, file.tool.diff.oldText, file.tool.diff.newText);
          else text(file.tool.name === "move_path" ? `Move ${file.path}` : file.tool.name === "delete_path" ? `Delete ${file.path}` : "Waiting for code…");
          if (file.tool.message) text(file.tool.message, file.tool.state === "done" ? "muted" : "signal");
        }
        if (file.applied) {
          const kind = !file.applied.beforeExists && !file.applied.afterExists ? "Created then deleted" : !file.applied.beforeExists ? "New file" : !file.applied.afterExists ? "Deleted file" : "";
          if (!completedEvidence) text("Earlier applied changes", "secondary");
          else if (kind) text(`${kind} · applied this turn`, "secondary");
          if (file.previous) text("File changed between operations; showing latest recorded segment.");
          if (file.applied.unavailable) text(file.applied.unavailable);
          else show(`${this.runId}:${file.path}:applied`, file.applied.before ?? "", file.applied.after ?? "");
        }
      }
    } else if (!cached) {
      text("Waiting for file changes."); text("Code will appear here as the agent drafts an edit.");
    }
    this.rendered = { signature, body, lines: bodyLines };
    const footer = height >= 12 ? 1 : 0;
    const room = Math.max(0, height - top - footer);
    this.maximum = Math.max(0, body.length - room); this.pageSize = Math.max(1, room - 1);
    let offset = Math.min(this.maximum, this.offsets.get(this.offsetKey) ?? 0);
    if (this.following) offset = file?.tool.drafting && file.tool.state === "running" ? this.maximum : 0;
    this.offsets.set(this.offsetKey, offset);
    for (let i = 0; i < room; i++) canvas.put(top + i, 1, body[offset + i] ?? "", width - 2, "surface");
    this.regions.push({ row: top, height: room, target: "code" });
    return { rows: canvas.rows, zones };
  }
}
