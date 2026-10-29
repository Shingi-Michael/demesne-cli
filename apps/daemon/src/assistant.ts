import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DemesneStore } from "@demesne/storage";

/// The always-on assistant keeps one chat, not a chat per question: an
/// assistant is one relationship, and its routines, reminders and your
/// questions read as one timeline. The chat's id is kept beside the
/// database, so the same chat comes back after every restart; one that was
/// archived or is gone is replaced by a new one.
export class AssistantChat {
  constructor(
    private readonly file: string,
    private readonly store: Pick<DemesneStore, "getSession" | "createSession">,
    /// The assistant's own folder (its DEMESNE.md), when it has one you trust.
    private readonly home: () => string | undefined,
  ) {}

  /// The chat, if it has been opened yet and is still there.
  existing(): string | null {
    const saved = this.saved();
    const session = saved ? this.store.getSession(saved) : null;
    return session && !session.archivedAt ? session.id : null;
  }

  /// The chat, made the first time it's opened.
  id(): string {
    const existing = this.existing();
    if (existing) return existing;
    const made = this.store.createSession("Assistant", this.home()).session.id;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ sessionId: made }));
    renameSync(temporary, this.file);
    return made;
  }

  private saved(): string | null {
    try {
      const value = (JSON.parse(readFileSync(this.file, "utf8")) as { sessionId?: unknown }).sessionId;
      return typeof value === "string" ? value : null;
    } catch { return null; }
  }
}
