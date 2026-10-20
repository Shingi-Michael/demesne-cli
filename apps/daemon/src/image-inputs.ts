import type { ProviderMessage } from "@demesne/providers";
import type { DemesneStore } from "@demesne/storage";
import { readArtifact } from "./artifacts.ts";

/** Resolve only the latest two retained tool images, and the images attached
 *  to the latest three messages that carry any. Durable transcripts contain
 *  IDs, never pixels. */
export async function hydrateImageInputs(store: DemesneStore, sessionId: string, messages: ProviderMessage[], signal: AbortSignal,
  include: { tools: boolean; attachments: boolean } = { tools: true, attachments: false }): Promise<ProviderMessage[]> {
  const ids = (role: "tool" | "user") => messages.flatMap((message) => message.role === role ? [message.imageArtifactIds ?? []] : []).filter((list) => list.length);
  const selected = new Set([
    ...(include.tools ? ids("tool").flat().slice(-2) : []),
    ...(include.attachments ? ids("user").slice(-3).flat() : []),
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
