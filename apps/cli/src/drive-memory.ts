import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DriveMemoryEntry } from "@demesne/protocol";

/// A workspace's project memory: what you told Drive to keep in mind
/// (preferences, decisions) and what Drive learned (finished outcomes,
/// blockers). Drive reads it before every decision and adds to it as it
/// works, so a new mission starts from what is already known.
///
/// One JSON object per line, append-only: an entry, or `{ "forget": id }`.
/// Plain text you can read and edit; compacted when it grows.

const MAX_LINES = 600;
const KEEP = 400;

export class ProjectMemory {
  constructor(readonly path: string) {}

  /// Current entries, oldest first. Unreadable lines are skipped.
  list(): DriveMemoryEntry[] {
    if (!existsSync(this.path)) return [];
    const entries = new Map<string, DriveMemoryEntry>();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.forget === "string") entries.delete(value.forget);
        else if (isEntry(value)) entries.set(value.id, value);
      } catch { /* a hand-edited or partial line */ }
    }
    return [...entries.values()];
  }

  add(entry: Omit<DriveMemoryEntry, "id" | "at"> & { at?: string }): DriveMemoryEntry {
    const text = entry.text.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!text) throw new Error("Nothing to remember.");
    // The same thing said twice is kept once.
    const existing = this.list().find((item) => item.kind === entry.kind && item.text.toLowerCase() === text.toLowerCase());
    if (existing) return existing;
    const saved: DriveMemoryEntry = { id: crypto.randomUUID().slice(0, 8), kind: entry.kind, text, source: entry.source, at: entry.at ?? new Date().toISOString() };
    this.write(JSON.stringify(saved));
    return saved;
  }

  /// Removes the entry whose id starts with `prefix`; throws unless exactly one matches.
  forget(prefix: string): DriveMemoryEntry {
    const matches = this.list().filter((item) => item.id.startsWith(prefix.trim()));
    if (matches.length !== 1) throw new Error(matches.length ? "That matches several memories; use more of the id." : "No memory with that id.");
    this.write(JSON.stringify({ forget: matches[0]!.id }));
    return matches[0]!;
  }

  /// What the planner sees: every preference and decision, then the most
  /// recent outcomes and blockers, within a character budget.
  forPlanner(budget = 6000): DriveMemoryEntry[] {
    const all = this.list();
    const standing = all.filter((item) => item.kind === "preference" || item.kind === "decision");
    const learned = all.filter((item) => item.kind === "outcome" || item.kind === "blocker").reverse();
    const chosen: DriveMemoryEntry[] = [];
    let used = 0;
    for (const item of [...standing, ...learned]) {
      if (used + item.text.length > budget || chosen.length >= 60) break;
      chosen.push(item); used += item.text.length;
    }
    return chosen;
  }

  private write(line: string) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    // Compact: keep every standing entry and the newest learned ones.
    const all = this.list();
    const keep = [...all.filter((item) => item.kind === "preference" || item.kind === "decision"),
      ...all.filter((item) => item.kind === "outcome" || item.kind === "blocker").slice(-KEEP)];
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, keep.sort((a, b) => a.at.localeCompare(b.at)).map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

function isEntry(value: Record<string, unknown>): value is DriveMemoryEntry & Record<string, unknown> {
  return typeof value.id === "string" && typeof value.text === "string" && typeof value.at === "string"
    && ["preference", "decision", "outcome", "blocker"].includes(String(value.kind)) && ["you", "drive"].includes(String(value.source));
}
