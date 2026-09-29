import { sanitizeTerminalLine, truncateText, type Painter, type PaletteColor } from "@demesne/brand";
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
    const run = this.runs.find((run) => run.id === this.runId);
    put(2, `Turn ${run?.number ?? "—"} · ${this.following ? "Follow edits" : "Paused"}`, this.following ? "electric" : "secondary");
    control(2, Math.max(1, width - 7), "Live", { kind: "diff-live" });
    put(3, `${this.files.length} file${this.files.length === 1 ? "" : "s"}`);
    control(3, Math.max(1, width - (this.expanded ? 11 : 10)), this.expanded ? "Restore" : "Expand", { kind: "diff-expand" });
    // Reserve the file-list height so incoming files cannot shift inspected code.
    const capacity = Math.max(0, Math.min(5, Math.floor((height - 9) / 3)));
    this.listOffset = Math.min(this.listOffset, Math.max(0, this.files.length - capacity));
    this.files.slice(this.listOffset, this.listOffset + capacity).forEach((file, i) => {
      const status = changeState(file.tool), selected = file === this.selected;
      const suffix = ` ${status}`;
      put(4 + i, `${selected ? "›" : " "} ${truncateText(sanitizeTerminalLine(file.path), Math.max(1, width - suffix.length - 5))}${suffix}`,
        selected ? "electricBright" : "secondary", selected ? "menuSelection" : "surface");
      zones.push({ row: 4 + i, column: 1, width: width - 2, action: { kind: "diff-select", path: file.path } });
    });
    this.regions = [{ row: 4, height: capacity, target: "files" }];
    let top = 4 + capacity;
    put(top++, "─".repeat(Math.max(0, width - 2)), "rule");
    const file = this.frozen?.key === this.offsetKey ? this.frozen.file : this.selected;
    const signature = [width, paint.colors, paint.enabled, file?.path, file?.tool.diff, file?.tool.state, file?.tool.message, file?.tool.changes, file?.applied, file?.previous];
    const cached = this.rendered?.signature.every((value, index) => value === signature[index]);
    const body: string[] = cached ? this.rendered!.body : [];
    const text = (value: string, tone: PaletteColor = "muted") => body.push(...value.split("\n").flatMap((line) => foldCells(paint.text(sanitizeTerminalLine(line), tone), Math.max(1, width - 2))));
    const show = (key: string, before: string, after: string) => {
      const diff = this.diff(key, before, after);
      text(`+${diff.added} −${diff.removed}`, "secondary");
      const digits = Math.max(2, String(Math.max(before.split("\n").length, after.split("\n").length)).length);
      const highlighted = diffSyntax(file?.path ?? "", before, after, diff.rows.slice(0, 10_000), paint);
      for (const [index, row] of diff.rows.entries()) {
        if (index >= 10_000) { text(`… ${diff.rows.length - index} more diff lines (preview limit)`); break; }
        if (row.kind !== "gap" && (index === 0 || diff.rows[index - 1]?.kind === "gap")) {
          let end = index;
          while (end < diff.rows.length && diff.rows[end]!.kind !== "gap") end++;
          const segment = diff.rows.slice(index, end);
          const old = segment.filter((row) => row.old !== undefined), next = segment.filter((row) => row.next !== undefined);
          text(`@@ -${old[0]?.old ?? Math.max(0, (next[0]?.next ?? 1) - 1)},${old.length} +${next[0]?.next ?? Math.max(0, (old[0]?.old ?? 1) - 1)},${next.length} @@`, "electric");
        }
        if (row.kind === "gap") { text(row.text); continue; }
        const numbers = `${String(row.old ?? "").padStart(digits)} ${String(row.next ?? "").padStart(digits)} `;
        const mark = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ";
        const tone = row.kind === "added" ? "citron" : row.kind === "removed" ? "signal" : "muted";
        const background = row.kind === "added" ? "diffAddedSurface" : row.kind === "removed" ? "diffRemovedSurface" : "surface";
        const code = highlighted.get(row) ?? sanitizeTerminalLine(row.text.replaceAll("\t", "  "));
        foldCells(code, Math.max(1, width - 2 - numbers.length - 2)).forEach((part, index) => {
          const gutter = index ? paint.text(" ".repeat(numbers.length) + "↪ ", "muted") : paint.text(numbers, "muted") + paint.text(mark + " ", tone);
          body.push(surface(gutter + part, width - 2, paint, background));
        });
      }
      if (!diff.rows.length) text("No textual change.");
    };
    if (file) {
      put(top++, sanitizeTerminalLine(file.path), "paper");
      put(top++, `${changeState(file.tool)}${this.frozen?.key === this.offsetKey ? " · paused snapshot" : file.revisions > 1 ? ` · ${file.revisions} operations` : ""}`, file.tool.state === "done" ? "citron" : file.tool.state === "running" ? "thinking" : "signal");
      if (!cached) {
        const completedEvidence = file.tool.state === "done" && file.tool.changes?.some((change) => change.path === file.path);
        if (!completedEvidence) {
          text(file.tool.state === "done" ? "Recorded input · fragment line numbers" : "Proposed code · not applied · fragment lines");
          if (file.tool.diff) show(`${this.runId}:${file.path}:proposal`, file.tool.diff.oldText, file.tool.diff.newText);
          else text(file.tool.name === "move_path" ? `Move ${file.path}` : file.tool.name === "delete_path" ? `Delete ${file.path}` : "Waiting for code…");
          if (file.tool.message) text(file.tool.message, file.tool.state === "done" ? "muted" : "signal");
        }
        if (file.applied) {
          text(completedEvidence ? `${!file.applied.beforeExists && !file.applied.afterExists ? "Created then deleted" : !file.applied.beforeExists ? "New file" : !file.applied.afterExists ? "Deleted file" : "File changes"} · applied this turn` : "Earlier applied changes", "secondary");
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
    if (footer) put(height - 1, "←/→ files · ↑/↓ scroll · Ctrl+G live", "muted");
    return { rows: canvas.rows, zones };
  }
}
