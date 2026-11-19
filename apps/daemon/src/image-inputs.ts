import type { ProviderMessage } from "@demesne/providers";
import type { DemesneStore } from "@demesne/storage";
import { readArtifact } from "./artifacts.ts";

/// Pictures stay with the conversation in blocks. Keeping "the latest two"
/// dropped a picture from an earlier message each time a new one arrived,
/// and a changed earlier message makes the provider read everything after it
/// again (docs/caching.md). So between `least` and `most` of the newest are
/// kept, and the older ones leave together, once per block instead of once
/// per picture: with 2 and 4, two to four pictures ride along and the
/// conversation is rewritten at every third picture, not at every one.
export function keptFrom(count: number, least: number, most: number): number {
  const block = most - least + 1;
  return count <= most ? 0 : block * Math.floor((count - least) / block);
}
const TOOL_PICTURES = [2, 4] as const, ATTACHED_MESSAGES = [3, 5] as const;

/** Resolve only the latest few retained tool images (two to four, see
 *  keptFrom), and the images attached to the latest three to five messages
 *  that carry any. Durable transcripts contain IDs, never pixels. */
export async function hydrateImageInputs(store: DemesneStore, sessionId: string, messages: ProviderMessage[], signal: AbortSignal,
  include: { tools: boolean | ((filename: string) => boolean); attachments: boolean } = { tools: true, attachments: false }): Promise<ProviderMessage[]> {
  const ids = (role: "tool" | "user") => messages.flatMap((message) => message.role === role ? [message.imageArtifactIds ?? []] : []).filter((list) => list.length);
  const newest = <Item>(items: Item[], [least, most]: readonly [number, number]) => items.slice(keptFrom(items.length, least, most));
  const selected = new Set([
    ...(include.tools === true ? newest(ids("tool").flat(), TOOL_PICTURES)
      // Only some tools' pictures: the latest few of those.
      : include.tools ? newest(ids("tool").flat().filter((id) => { const file = store.getImageArtifact(sessionId, id)?.filename; return file !== undefined && (include.tools as (filename: string) => boolean)(file); }), TOOL_PICTURES) : []),
    ...(include.attachments ? newest(ids("user"), ATTACHED_MESSAGES).flat() : []),
  ]);
  return Promise.all(messages.map(async (message): Promise<ProviderMessage> => {
    if ((message.role !== "tool" && message.role !== "user") || !message.imageArtifactIds?.length) return message;
    const imageInputs: NonNullable<ProviderMessage["imageInputs"]> = [];
    for (const id of message.imageArtifactIds) {
      if (!selected.has(id)) continue;
      signal.throwIfAborted();
      const artifact = store.getImageArtifact(sessionId, id);
      if (!artifact) continue;
      try {
        const bytes = await readArtifact(store, artifact, true);
        if (bytes.byteLength > 20 * 1024 * 1024) continue;
        imageInputs.push({ artifactId: id, url: `data:image/png;base64,${bytes.toString("base64")}`,
          ...(message.role === "user" ? { label: `Image the user attached: ${artifact.filename}` } : {}) });
      } catch {
        // Missing cached files must not prevent text-only replay of a session.
      }
    }
    signal.throwIfAborted();
    return imageInputs.length ? { ...message, imageInputs } : message;
  }));
}
