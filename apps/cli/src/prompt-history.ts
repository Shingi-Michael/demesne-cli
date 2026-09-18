import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/// Append-only prompt history stored as JSON lines.
///
/// Records are tagged with the workspace so a future policy can scope recall
/// without a migration, but navigation and reverse search currently use the
/// global recency order, matching shell behavior. The cap is enforced on load
/// and in memory; the file is rewritten only when the cap is crossed, so
/// ordinary prompts append a single line.

export const PROMPT_HISTORY_LIMIT = 500;

export interface PromptHistoryRecord {
  text: string;
  workspace?: string;
  at: string;
}

export class PromptHistory {
  private records: PromptHistoryRecord[];

  constructor(readonly path: string | null, records: PromptHistoryRecord[] = []) {
    this.records = records.slice(-PROMPT_HISTORY_LIMIT);
  }

  static load(path: string | null): PromptHistory {
    if (!path || !existsSync(path)) return new PromptHistory(path);
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      // An unreadable history must not prevent the session from starting.
      return new PromptHistory(path);
    }
    const records: PromptHistoryRecord[] = [];
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<PromptHistoryRecord>;
        if (typeof value.text !== "string" || value.text.length === 0) continue;
        records.push({
          text: value.text,
          ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
          at: typeof value.at === "string" ? value.at : new Date(0).toISOString(),
        });
      } catch {
        // A truncated final line is expected after a crash; skip it.
      }
    }
    return new PromptHistory(path, records);
  }

  /// Most recent first with duplicates collapsed, which is what history
  /// navigation and reverse search want.
  entries(): string[] {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const text = this.records[index]!.text;
      if (seen.has(text)) continue;
      seen.add(text);
      entries.push(text);
    }
    return entries;
  }

  search(query: string): string[] {
    const normalized = query.toLowerCase();
    const entries = this.entries();
    return normalized ? entries.filter((entry) => entry.toLowerCase().includes(normalized)) : entries;
  }

  add(text: string, workspace?: string): boolean {
    if (!text.trim()) return false;
    if (this.records.at(-1)?.text === text) return false;
    const record: PromptHistoryRecord = {
      text,
      ...(workspace ? { workspace } : {}),
      at: new Date().toISOString(),
    };
    this.records.push(record);
    if (!this.path) return true;
    try {
      if (this.records.length > PROMPT_HISTORY_LIMIT) {
        this.records = this.records.slice(-PROMPT_HISTORY_LIMIT);
        writeFileSync(this.path, serialize(this.records), { encoding: "utf8", mode: 0o600 });
        return true;
      }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // History is a convenience; a write failure must not fail the prompt.
    }
    return true;
  }
}

function serialize(records: PromptHistoryRecord[]): string {
  return records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}