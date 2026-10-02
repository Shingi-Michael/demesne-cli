import type { GraphicsHost } from "./host.ts";
import type { GraphicsRun } from "./session-model.ts";
import type { WorkbenchEntry } from "../cli/src/workbench/entries.ts";

export type GraphicsSnapshot = ReturnType<GraphicsHost["snapshot"]>;
type Fields = { set: Record<string, unknown>; unset: string[] };
type EntryUpdate =
  | { id: number; value: WorkbenchEntry }
  | { id: number; fields: Fields; append?: { offset: number; text: string } };
type RunUpdate =
  | { id: string; value: GraphicsRun }
  | { id: string; fields: Fields; entries: EntryUpdate[]; order?: number[] };
export type StateUpdate =
  | { kind: "snapshot"; state: GraphicsSnapshot }
  | {
      kind: "patch";
      base: number;
      revision: number;
      fields: Fields;
      runs: RunUpdate[];
      order?: string[];
    };
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
const differentOrder = <T>(a: T[], b: T[]) =>
  a.length !== b.length || a.some((value, i) => value !== b[i]);
function omit(value: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}
function diff(a: Record<string, unknown>, b: Record<string, unknown>): Fields {
  const set: Record<string, unknown> = {},
    unset: string[] = [];
  for (const key of Object.keys(a))
    if (a[key] !== undefined && (!own(b, key) || b[key] === undefined))
      unset.push(key);
  for (const [key, value] of Object.entries(b))
    if (value !== undefined && JSON.stringify(a[key]) !== JSON.stringify(value))
      set[key] = value;
  return { set, unset };
}
const changed = (fields: Fields) =>
  fields.unset.length > 0 || Object.keys(fields.set).length > 0;
function assign<T extends object>(value: T, fields: Fields): T {
  const result = { ...value, ...fields.set };
  for (const key of fields.unset)
    delete (result as Record<string, unknown>)[key];
  return result;
}
function entryUpdate(
  previous: WorkbenchEntry,
  next: WorkbenchEntry,
): EntryUpdate | null {
  if (previous === next) return null;
  if (
    (next.type === "assistant" || next.type === "reasoning") &&
    previous.type === next.type &&
    "raw" in previous &&
    next.raw.startsWith(previous.raw)
  ) {
    const fields = diff(omit(previous, ["raw"]), omit(next, ["raw"]));
    const append =
      next.raw.length > previous.raw.length
        ? {
            offset: previous.raw.length,
            text: next.raw.slice(previous.raw.length),
          }
        : undefined;
    return changed(fields) || append
      ? { id: next.id, fields, ...(append ? { append } : {}) }
      : null;
  }
  return JSON.stringify(previous) === JSON.stringify(next)
    ? null
    : { id: next.id, value: next };
}
function runUpdate(
  previous: GraphicsRun | undefined,
  next: GraphicsRun,
): RunUpdate | null {
  if (!previous) return { id: next.id, value: next };
  if (previous === next) return null;
  const fields = diff(omit(previous, ["entries"]), omit(next, ["entries"]));
  const old = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const entries: EntryUpdate[] = [];
  for (const entry of next.entries) {
    const before = old.get(entry.id);
    const patch = before
      ? entryUpdate(before, entry)
      : { id: entry.id, value: entry };
    if (patch) entries.push(patch);
  }
  const order = next.entries.map((entry) => entry.id);
  const reordered = differentOrder(
    previous.entries.map((entry) => entry.id),
    order,
  );
  return changed(fields) || entries.length || reordered
    ? { id: next.id, fields, entries, ...(reordered ? { order } : {}) }
    : null;
}

/** Cached run projections are immutable; small mutable host fields are retained
 * as JSON values. Neither unchanged history nor earlier streaming text is sent. */
export class StateEncoder {
  private previous: {
    revision: number;
    sessionId: string | null;
    fields: Record<string, unknown>;
    runs: Map<string, GraphicsRun>;
    order: string[];
  } | null = null;
  reset(state: GraphicsSnapshot) {
    this.previous = {
      revision: state.revision,
      sessionId: state.session?.id ?? null,
      fields: JSON.parse(JSON.stringify(omit(state, ["runs", "revision"]))),
      runs: new Map(state.runs.map((run) => [run.id, run])),
      order: state.runs.map((run) => run.id),
    };
  }
  encode(state: GraphicsSnapshot): StateUpdate {
    const before = this.previous;
    if (!before || before.sessionId !== (state.session?.id ?? null)) {
      this.reset(state);
      return { kind: "snapshot", state };
    }
    const fields = diff(before.fields, omit(state, ["runs", "revision"]));
    const runs: RunUpdate[] = [];
    for (const run of state.runs) {
      const update = runUpdate(before.runs.get(run.id), run);
      if (update) runs.push(update);
    }
    const order = state.runs.map((run) => run.id);
    const update: StateUpdate = {
      kind: "patch",
      base: before.revision,
      revision: state.revision,
      fields,
      runs,
      ...(differentOrder(before.order, order) ? { order } : {}),
    };
    this.reset(state);
    return update;
  }
}

/** Apply atomically and preserve identities of unchanged runs/entries. Missing or
 * out-of-order deltas trigger a fresh snapshot instead of displaying stale data. */
export class StateReceiver {
  state: GraphicsSnapshot | null = null;
  needsReset = false;
  private pending: Extract<StateUpdate, { kind: "patch" }>[] = [];
  private remember(update: Extract<StateUpdate, { kind: "patch" }>) {
    if (!this.pending.some((item) => item.revision === update.revision))
      this.pending.push(update);
    if (this.pending.length > 128) this.pending.shift();
    this.needsReset = true;
  }
  seed(state: GraphicsSnapshot): GraphicsSnapshot | null {
    const previous = this.state;
    if (!this.state || state.revision >= this.state.revision)
      this.state = state;
    const pending = this.pending.sort((a, b) => a.revision - b.revision);
    this.pending = [];
    for (const update of pending) this.apply(update);
    this.needsReset = this.pending.length > 0;
    return this.state === previous ? null : this.state;
  }
  apply(update: StateUpdate): GraphicsSnapshot | null {
    this.needsReset = this.pending.length > 0;
    if (update.kind === "snapshot") return this.seed(update.state);
    if (this.state && update.revision <= this.state.revision) return null;
    if (!this.state || this.state.revision !== update.base) {
      this.remember(update);
      return null;
    }
    try {
      const previous = this.state;
      let runs = previous.runs;
      if (update.runs.length || update.order) {
        const byId = new Map(runs.map((run) => [run.id, run]));
        for (const patch of update.runs) {
          if ("value" in patch) {
            byId.set(patch.id, patch.value);
            continue;
          }
          const before = byId.get(patch.id);
          if (!before) throw new Error("Missing turn");
          const byEntry = new Map(
            before.entries.map((entry) => [entry.id, entry]),
          );
          for (const entryPatch of patch.entries) {
            if ("value" in entryPatch) {
              byEntry.set(entryPatch.id, entryPatch.value);
              continue;
            }
            const old = byEntry.get(entryPatch.id);
            if (!old) throw new Error("Missing entry");
            let entry = assign(old, entryPatch.fields);
            if (entryPatch.append) {
              if (
                !("raw" in entry) ||
                entry.raw.length !== entryPatch.append.offset
              )
                throw new Error("Missing text prefix");
              entry = { ...entry, raw: entry.raw + entryPatch.append.text };
            }
            byEntry.set(entry.id, entry);
          }
          const entries = (
            patch.order ?? before.entries.map((entry) => entry.id)
          ).map((id) => {
            const entry = byEntry.get(id);
            if (!entry) throw new Error("Missing ordered entry");
            return entry;
          });
          byId.set(patch.id, { ...assign(before, patch.fields), entries });
        }
        runs = (update.order ?? runs.map((run) => run.id)).map((id) => {
          const run = byId.get(id);
          if (!run) throw new Error("Missing ordered turn");
          return run;
        });
      }
      return (this.state = {
        ...assign(previous, update.fields),
        runs,
        revision: update.revision,
      });
    } catch {
      this.remember(update);
      return null;
    }
  }
}
