import type { ToolFileChange } from "@demesne/protocol";
import type { ToolEntry } from "@demesne/workbench/entries.ts";
import { codeDiff } from "@demesne/workbench/change-diff.ts";
import type { WorkspaceRun } from "./session-model.ts";

export interface DeferredChanges { revision: number; added: number; removed: number }
type DisplayTool = ToolEntry & { deferredChanges?: DeferredChanges };
export const deferredChanges = (tool: ToolEntry) => (tool as DisplayTool).deferredChanges;

/** Only the desktop wire projection is light. Journals, review and undo retain
 * the exact recorded files. Full text is requested when a step is unfolded. */
export class DisplayRuns {
  private runs = new WeakMap<WorkspaceRun, WorkspaceRun>();
  private changes = new Map<string, { source: ToolFileChange[]; light: ToolFileChange[]; summary: DeferredChanges }>();
  private revision = 0;
  project(runs: WorkspaceRun[]): WorkspaceRun[] {
    return runs.map(run => {
      const cached = this.runs.get(run);
      if (cached) return cached;
      const entries = run.entries.map(entry => {
        if (entry.type !== "tool" || !entry.changes?.length || entry.state === "running" || entry.drafting) return entry;
        const key = `${run.id}:${entry.toolCallId}`;
        let cached = this.changes.get(key);
        if (!cached || !sameChanges(cached.source, entry.changes)) {
          let added = 0, removed = 0;
          const light = entry.changes.map(change => {
            const diff = codeDiff(change.before ?? "", change.after ?? "");
            added += diff.added; removed += diff.removed;
            return { ...change, before: null, after: null };
          });
          cached = { source: entry.changes, light, summary: { revision: ++this.revision, added, removed } };
          this.changes.set(key, cached);
        }
        return { ...entry, changes: cached.light, deferredChanges: cached.summary } satisfies DisplayTool;
      });
      const display = { ...run, entries };
      this.runs.set(run, display);
      return display;
    });
  }
}
function sameChanges(a: ToolFileChange[], b: ToolFileChange[]) {
  return a === b || a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    return x.path === y.path && x.before === y.before && x.after === y.after && x.beforeExists === y.beforeExists && x.afterExists === y.afterExists && x.unavailable === y.unavailable;
  });
}
