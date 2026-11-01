/// Steps while a turn works (pass 122 A): finished reads, edits and writes
/// between two commands fold into one line, "Changed 9 files · 2 new ·
/// read 7 · live.ts, host.ts" with the totals, so the guide stays a few
/// lines long instead of a wall of paths. A command keeps its own row,
/// since that is where you look for a result; so does the step running
/// now, and anything failed, denied or waiting on you.
import type { ToolEntry } from "@demesne/workbench/entries.ts";

type Step = Pick<ToolEntry, "name" | "state" | "input" | "waiting" | "drafting" | "repo" | "detail" | "changes" | "created" | "durationMs">;

/// Tools that look: they read, search, list, or ask git.
export const LOOK_TOOLS = new Set(["read_file", "read_files", "view_image", "git_diff", "git_status", "git_history", "search_files", "list_files", "session_tools", "recall_turn", "foundry_read"]);
/// Tools that change files.
export const CHANGE_TOOLS = new Set(["edit_file", "write_file", "move_path", "delete_path"]);

/// Whether a step can hide in a stretch: a finished look or change that
/// nothing waits on. A commit keeps its row for the tree drawn under it.
export const inStretch = (tool: Step) =>
  tool.state === "done" && !tool.waiting && !tool.drafting && !tool.repo && (LOOK_TOOLS.has(tool.name) || CHANGE_TOOLS.has(tool.name));

export type StepGroup<T> = { kind: "one"; tool: T } | { kind: "stretch"; tools: T[] };

/// Consecutive steps that can hide become one stretch, from `min` of them.
export function stretches<T extends Step>(tools: readonly T[], min = 2): StepGroup<T>[] {
  const groups: StepGroup<T>[] = [];
  for (let i = 0; i < tools.length; i++) {
    let j = i;
    while (j < tools.length && inStretch(tools[j]!)) j++;
    if (j - i >= min) { groups.push({ kind: "stretch", tools: tools.slice(i, j) }); i = j - 1; }
    else if (j > i) { for (const tool of tools.slice(i, j)) groups.push({ kind: "one", tool }); i = j - 1; }
    else groups.push({ kind: "one", tool: tools[i]! });
  }
  return groups;
}

/// The files a read step read, as the tool was asked.
export function readPaths(tool: Pick<ToolEntry, "name" | "input" | "detail">): string[] {
  if (tool.name === "read_files" && Array.isArray(tool.input.files))
    return tool.input.files.map((file) => typeof file === "object" && file && typeof (file as { path?: unknown }).path === "string" ? (file as { path: string }).path : "").filter(Boolean);
  const path = typeof tool.input.path === "string" ? tool.input.path : tool.detail ?? "";
  return path ? [path] : [];
}

/// The files a change step touched.
export const changedPaths = (tool: Pick<ToolEntry, "input" | "detail" | "changes">) =>
  tool.changes?.map((change) => change.path) ?? [String(tool.input.path ?? tool.input.to ?? tool.detail ?? "")].filter(Boolean);

/// A path's file name, for a line that names files.
export const fileName = (path: string) => path.split(/[\\/]/).at(-1) || path;

export interface StretchWords {
  /// "Changed 9 files", "Read 7 files", "Explored · 4 steps".
  verb: string;
  /// The dim part after it: "2 new · read 7 · live.ts, host.ts".
  files: string;
  /// Distinct files changed, and how many of those were new.
  changed: number; fresh: number;
  /// Files read (a read of three files is three).
  reads: number;
  added: number; removed: number;
  durationMs: number;
}

/// What a stretch's one line says.
export function stretchWords(tools: readonly Step[], totals: (tool: Step) => { added: number; removed: number }): StretchWords {
  const changed = new Map<string, boolean>();
  let reads = 0, looks = 0, added = 0, removed = 0, durationMs = 0;
  const last: string[] = [];
  for (const tool of tools) {
    durationMs += tool.durationMs ?? 0;
    if (CHANGE_TOOLS.has(tool.name)) {
      const total = totals(tool);
      added += total.added; removed += total.removed;
      for (const path of changedPaths(tool)) {
        const fresh = tool.created === true || tool.changes?.some((change) => change.path === path && change.beforeExists === false) === true;
        changed.set(path, (changed.get(path) ?? false) || fresh);
        const name = fileName(path);
        if (last.at(-1) !== name) { if (last.includes(name)) last.splice(last.indexOf(name), 1); last.push(name); }
      }
    } else if (["read_file", "read_files", "view_image"].includes(tool.name)) reads += Math.max(1, readPaths(tool).length);
    else looks++;
  }
  const fresh = [...changed.values()].filter(Boolean).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (changed.size) return {
    verb: `Changed ${plural(changed.size, "file")}`,
    files: [fresh ? `${fresh} new` : "", reads ? `read ${reads}` : "", last.slice(-2).join(", ")].filter(Boolean).join(" · "),
    changed: changed.size, fresh, reads, added, removed, durationMs,
  };
  if (reads && !looks) return { verb: `Read ${plural(reads, "file")}`, files: "", changed: 0, fresh: 0, reads, added, removed, durationMs };
  return { verb: `Explored · ${plural(tools.length, "step")}`, files: reads ? `read ${reads}` : "", changed: 0, fresh: 0, reads, added, removed, durationMs };
}
