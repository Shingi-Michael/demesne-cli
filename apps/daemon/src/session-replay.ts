import type { EventEnvelope, ReplayEvent, SessionReplayPage } from "@demesne/protocol";
import { InvalidStateError, type DemesneStore } from "@demesne/storage";

const MAX_DELTA_CHARACTERS = 64 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_PAGES = 128;

/// Only plain text fragments are coalesced. Metadata, empty-delta timestamps,
/// model rounds, tools, approvals, and settlement boundaries stay intact.
export function coalesceReplayEvents(events: readonly EventEnvelope[]): ReplayEvent[] {
  const result: ReplayEvent[] = [];
  let previous: ReplayEvent | undefined;
  for (const event of events) {
    const delta = event.payload.delta;
    const mergeable = (event.type === "message.delta" || event.type === "reasoning.delta")
      && typeof delta === "string" && delta.length > 0 && Object.keys(event.payload).length === 1;
    if (mergeable && previous && previous.type === event.type && previous.turnId === event.turnId
      && previous.sessionId === event.sessionId && previous.agentRunId === event.agentRunId && previous.workspaceId === event.workspaceId
      && (previous.payload.delta as string).length + delta.length <= MAX_DELTA_CHARACTERS) {
      previous.payload.delta += delta;
      previous.throughEventId = event.eventId;
      previous.deltaCount = (previous.deltaCount ?? 1) + 1;
    } else {
      const copy: ReplayEvent = mergeable ? { ...event, payload: { ...event.payload } } : event;
      result.push(copy);
      previous = mergeable ? copy : undefined;
    }
  }
  return result;
}

/// Serialized, bounded LRU pages avoid rebuilding unchanged history on resume.
/// The snapshot cursor is part of the key, so a later turn cannot use stale data.
export class SessionReplay {
  private readonly pages = new Map<string, { body: string; bytes: number }>();
  private bytes = 0;

  constructor(private readonly store: Pick<DemesneStore, "eventsBetween">, private readonly budget = CACHE_BYTES) {}

  page(sessionId: string, after: number, through: number): string {
    const key = `${sessionId}:${after}:${through}`;
    const cached = this.pages.get(key);
    if (cached) { this.pages.delete(key); this.pages.set(key, cached); return cached.body; }
    const events = this.store.eventsBetween(sessionId, after, through);
    const last = events.at(-1)?.eventId ?? after;
    if (last === after && after < through) throw new InvalidStateError("Saved history cursor is unavailable");
    const page: SessionReplayPage = { events: coalesceReplayEvents(events), throughEventId: through, nextCursor: last < through ? last : null };
    const body = JSON.stringify(page);
    const bytes = Buffer.byteLength(body);
    if (bytes <= this.budget) {
      while ((this.bytes + bytes > this.budget || this.pages.size >= CACHE_PAGES) && this.pages.size) {
        const oldest = this.pages.keys().next().value!;
        this.bytes -= this.pages.get(oldest)!.bytes;
        this.pages.delete(oldest);
      }
      this.pages.set(key, { body, bytes });
      this.bytes += bytes;
    }
    return body;
  }
}
