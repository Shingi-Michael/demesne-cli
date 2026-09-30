import { formatFooterLine, sanitizeTerminalLine, truncateText, visibleLength, type Painter, type PaletteColor } from "@demesne/brand";
import { keycap } from "./session-chrome.ts";
import type { ToolFileChange } from "@demesne/protocol";
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
  : tool.state === "stopped" ? "secondary" : "thinking";

const LANGUAGES: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rs: "Rust", go: "Go", json: "JSON", yml: "YAML", yaml: "YAML", sh: "Shell", bash: "Shell", zsh: "Shell", md: "Markdown",
  toml: "TOML", css: "CSS", html: "HTML", swift: "Swift", rb: "Ruby", java: "Java", kt: "Kotlin", c: "C", h: "C", cpp: "C++", sql: "SQL" };
function languageName(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? LANGUAGES[extension] : undefined;
}

export type DiffAction = { kind: "diff-select"; path: string } | { kind: "diff-live" | "diff-expand" }
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
  private rendered: { signature: unknown[]; body: string[] } | null = null;

  reset(): void {
    this.following = true; this.expanded = false; this.runId = 0; this.followLatest = true;
    this.runs = []; this.files = []; this.selectedPath = null; this.offsets.clear(); this.diffs.clear(); this.lastSignature = []; this.regions = []; this.frozen = null; this.rendered = null;
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
    if (action.kind === "diff-select") {
      this.frozen = null; this.following = false; this.selectedPath = action.path;
      if (this.selected) this.frozen = { key: this.offsetKey, file: { ...this.selected, tool: { ...this.selected.tool } } };
    }
    if (action.kind === "diff-live") { this.frozen = null; this.following = true; this.followLatest = true; this.lastSignature = []; this.sync(this.runs); }
    if (action.kind === "diff-expand") this.expanded = !this.expanded;
  }
  step(delta: number): void {
    const i = this.files.findIndex((file) => file.path === this.selectedPath);
    const file = this.files[Math.max(0, Math.min(this.files.length - 1, i + delta))];
    if (file) { this.act({ kind: "diff-select", path: file.path }); this.listOffset = Math.max(0, this.files.indexOf(file) - 2); }
  }
  scroll(amount: number): boolean {
    if (!this.frozen && this.selected) this.frozen = { key: this.offsetKey, file: { ...this.selected, tool: { ...this.selected.tool } } };
    this.following = false;
    const before = this.offsets.get(this.offsetKey) ?? 0;
    const next = Math.max(0, Math.min(this.maximum, before + amount));
    this.offsets.set(this.offsetKey, next); return before !== next;
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
    if (name === "left" || name === "right") this.step(name === "left" ? -1 : 1);
    else if (["up", "down", "pageup", "pagedown", "home", "end"].includes(name ?? "")) this.scroll(name === "home" ? -Infinity : name === "end" ? Infinity
      : (name === "up" || name === "pageup" ? -1 : 1) * (name?.startsWith("page") ? this.pageSize : 1));
    else return false;
    return true;
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
      + (drafting ? paint.text(` · ${drafting} drafting`, "thinking") : "");
    const expand = this.expanded ? "restore" : "expand";
    const followLabel = this.following ? " following edits " : " paused ";
    const controlsWidth = followLabel.length + 2 + "Alt+↵".length + 1 + expand.length;
    const summaryRow = 2;
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
    const file = this.frozen?.key === this.offsetKey ? this.frozen.file : this.selected;
    const signature = [width, paint.colors, paint.enabled, file?.path, file?.tool.diff, file?.tool.state, file?.tool.message, file?.tool.changes, file?.applied, file?.previous];
    const cached = this.rendered?.signature.every((value, index) => value === signature[index]);
    const body: string[] = cached ? this.rendered!.body : [];
    const text = (value: string, tone: PaletteColor = "muted") => body.push(...value.split("\n").flatMap((line) => foldCells(paint.text(sanitizeTerminalLine(line), tone), Math.max(1, width - 2))));
    const show = (key: string, before: string, after: string) => {
      const diff = this.diff(key, before, after);
      const digits = Math.max(2, String(Math.max(before.split("\n").length, after.split("\n").length)).length);
      const highlighted = diffSyntax(file?.path ?? "", before, after, diff.rows.slice(0, 10_000), paint);
      for (const [index, row] of diff.rows.entries()) {
        if (index >= 10_000) { text(`… ${diff.rows.length - index} more diff lines (preview limit)`); break; }
        // Folded context reads `… 41 unchanged lines` in the number column.
        if (row.kind === "gap") { body.push(surface(paint.text(`${" ".repeat(digits * 2 + 1)}${row.text}`, "muted"), width - 2, paint, "raised")); continue; }
        const numbers = `${String(row.old ?? "").padStart(digits)} ${String(row.next ?? "").padStart(digits)} `;
        const mark = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ";
        const tone = row.kind === "added" ? "citron" : row.kind === "removed" ? "signal" : "muted";
        // The diff is an inset code block: unchanged lines on the page color.
        const background = row.kind === "added" ? "diffAddedSurface" : row.kind === "removed" ? "diffRemovedSurface" : "ink";
        const code = highlighted.get(row) ?? sanitizeTerminalLine(row.text.replaceAll("\t", "  "));
        foldCells(code, Math.max(1, width - 2 - numbers.length - 2)).forEach((part, index) => {
          const gutter = index ? paint.text(" ".repeat(numbers.length) + "↪ ", "muted") : paint.text(numbers, "muted") + paint.text(mark + " ", tone);
          body.push(surface(gutter + part, width - 2, paint, background));
        });
      }
      if (!diff.rows.length) text("No textual change.");
    };
    if (file) {
      // `app.test.ts  Applied · TypeScript · 2 edits` with the totals on the right.
      const path = sanitizeTerminalLine(file.path), name = path.slice(path.lastIndexOf("/") + 1);
      const details = [paint.text(changeState(file.tool), stateTone(file.tool)), languageName(path), `${file.revisions} edit${file.revisions === 1 ? "" : "s"}`]
        .filter(Boolean).map((part, index) => index ? paint.text(part!, "muted") : part).join(paint.text(" · ", "muted"));
      canvas.put(top++, 1, formatFooterLine(`${paint.text(name, "paper")}  ${details}`, styledCounts(counts(file)), width - 3), width - 2, "surface");
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
    this.rendered = { signature, body };
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
