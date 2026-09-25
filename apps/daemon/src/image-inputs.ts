import type { ProviderMessage } from "@demesne/providers";
import type { DemesneStore } from "@demesne/storage";
import { readArtifact } from "./artifacts.ts";

/** Resolve only the latest two retained images. Durable transcripts contain IDs, never pixels. */
export async function hydrateImageInputs(store: DemesneStore, sessionId: string, messages: ProviderMessage[], signal: AbortSignal): Promise<ProviderMessage[]> {
  const selected = new Set(messages.flatMap((message) => message.role === "tool" ? message.imageArtifactIds ?? [] : []).slice(-2));
  return Promise.all(messages.map(async (message): Promise<ProviderMessage> => {
    if (message.role !== "tool" || !message.imageArtifactIds?.length) return message;
    const imageInputs: NonNullable<ProviderMessage["imageInputs"]> = [];
    for (const id of message.imageArtifactIds) {
      if (!selected.has(id)) continue;
      signal.throwIfAborted();
      const artifact = store.getImageArtifact(sessionId, id);
      if (!artifact) continue;
      try {
        const bytes = await readArtifact(store, artifact, true);
        if (bytes.byteLength > 20 * 1024 * 1024) continue;
        imageInputs.push({ artifactId: id, url: `data:image/png;base64,${bytes.toString("base64")}` });
      } catch {
        // Missing cached files must not prevent text-only replay of a session.
      }
    }
    signal.throwIfAborted();
    return imageInputs.length ? { ...message, imageInputs } : message;
  }));
}
