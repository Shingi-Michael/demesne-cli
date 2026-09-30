import { formatFooterLine, sanitizeTerminalLine, truncateText, visibleLength, type Painter, type PaletteColor } from "@demesne/brand";
import type { WorkspaceFileInfo } from "@demesne/protocol";
import type { SessionRun } from "./session.ts";
import { codeDiff } from "./change-diff.ts";

/// What the agent did with a file this session: edits (with their net
/// lines) and reads. This is the Files panel's own information (Figma
/// 119:1190): git shows what changed, not what the agent looked at.
export interface FileTrail { edited: boolean; reads: number; added: number; removed: number; last: number }

export function readingTrail(runs: readonly SessionRun[]): Map<string, FileTrail> {
  const trail = new Map<string, FileTrail>();
  const entry = (path: string, order: number) => {
    const found = trail.get(path) ?? { edited: false, reads: 0, added: 0, removed: 0, last: 0 };
    found.last = Math.max(found.last, order);
    trail.set(path, found);
    return found;
  };
  const first = new Map<string, string>(), latest = new Map<string, string>();
  for (const tool of runs.flatMap((run) => run.tools).sort((a, b) => a.id - b.id)) {
    const input = tool.input as Record<string, unknown>;
    if (tool.name === "read_file" && typeof input.path === "string") entry(input.path, tool.id).reads++;
    if (tool.name === "read_files" && Array.isArray(input.files)) {
      for (const file of input.files) if (file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string") entry((file as { path: string }).path, tool.id).reads++;
    }
    if (tool.phase === "change" && tool.state === "done") {
      for (const change of tool.changes ?? []) {
        if (change.unavailable) continue;
        entry(change.path, tool.id).edited = true;
        if (!first.has(change.path)) first.set(change.path, change.beforeExists ? change.before ?? "" : "");
        latest.set(change.path, change.afterExists ? change.after ?? "" : "");
      }
    }
  }
  for (const [path, before] of first) {
    const diff = codeDiff(before, latest.get(path) ?? "");
    const found = trail.get(path)!;
    found.added = diff.added; found.removed = diff.removed;
  }
  return trail;
}

export interface FileListLine { text: string; path?: string }

const size = (bytes: number | null) => bytes === null ? "" : bytes < 1000 ? `${bytes}b` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)}k` : `${(bytes / 1_000_000).toFixed(1)}m`;
const STATUS: Record<string, [string, PaletteColor]> = { M: ["modified", "thinking"], A: ["added", "citron"], "??": ["untracked", "citron"], D: ["deleted", "signal"], R: ["renamed", "electric"] };

/// The Files list: THIS SESSION (edited, then read), GIT CHANGES, then ALL
/// FILES not already listed, each narrowed by `query`. Blank lines separate
/// the sections; lines with a `path` can be selected and opened.
export function fileListLines(files: readonly WorkspaceFileInfo[], trail: ReadonlyMap<string, FileTrail>, query: string, width: number, paint: Painter): FileListLine[] {
  const needle = query.trim().toLowerCase();
  const keep = (path: string) => !needle || path.toLowerCase().includes(needle);
  const name = (path: string, bright: boolean) => {
    const clean = sanitizeTerminalLine(path), slash = clean.lastIndexOf("/");
    return paint.text(clean.slice(0, slash + 1), "muted") + paint.text(clean.slice(slash + 1), bright ? "paper" : "secondary");
  };
  const row = (mark: string, path: string, right: string): FileListLine => {
    const room = Math.max(4, width - visibleLength(right) - 4);
    return { text: formatFooterLine(`${mark} ${truncateText(name(path, true), room)}`, right, width), path };
  };
  const heading = (label: string, count: number): FileListLine => ({ text: formatFooterLine(paint.text(label, "muted"), paint.text(String(count), "muted"), width) });
  const lines: FileListLine[] = [];
  const section = (label: string, rows: FileListLine[]) => {
    if (!rows.length) return;
    if (lines.length) lines.push({ text: "" });
    lines.push(heading(label, rows.length), ...rows);
  };
  const touched = [...trail.entries()].filter(([path]) => keep(path))
    .sort(([, a], [, b]) => Number(b.edited) - Number(a.edited) || b.last - a.last);
  section("THIS SESSION", touched.map(([path, info]) => info.edited
    ? row(paint.text("✎", "citron"), path, paint.text("edited", "citron") + (info.added || info.removed ? `  ${paint.text(`+${info.added}`, "citron")} ${paint.text(`−${info.removed}`, "signal")}` : ""))
    : row(paint.text("◉", "electric"), path, paint.text(info.reads > 1 ? `read ×${info.reads}` : "read", "muted"))));
  const changed = files.filter((file) => file.status && keep(file.path));
  section("GIT CHANGES", changed.map((file) => {
    const [word, tone] = STATUS[file.status!] ?? [file.status!, "secondary"];
    return row(paint.text(file.status!.slice(0, 1), tone), file.path, paint.text(word, "muted"));
  }));
  const shown = new Set([...touched.map(([path]) => path), ...changed.map((file) => file.path)]);
  section("ALL FILES", files.filter((file) => !shown.has(file.path) && keep(file.path)).map((file) => row(" ", file.path, paint.text(size(file.byteLength), "muted"))));
  if (!lines.length) lines.push({ text: paint.text(needle ? `No files match "${sanitizeTerminalLine(query)}".` : "No workspace files available.", "muted") });
  return lines;
}
