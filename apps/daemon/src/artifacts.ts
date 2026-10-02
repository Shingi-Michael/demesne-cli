import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { DemesneStore } from "@demesne/storage";
import type { ImageArtifact } from "@demesne/protocol";
// Native image codecs are shipped beside the compiled daemon. Loading through
// its real executable directory avoids resolving native addons inside Bun's VFS.
const nativeRequire = createRequire(import.meta.path.startsWith("/$bunfs/")
  ? join(dirname(process.execPath), "native.cjs") : import.meta.url);
const sharp: typeof import("sharp").default = nativeRequire(import.meta.path.startsWith("/$bunfs/")
  ? join(dirname(process.execPath), "node_modules/sharp/dist/index.cjs") : "sharp");

export interface ImageOutput { data: Uint8Array; mimeType: string; filename?: string; modelId?: string; revisionOf?: string; viewport?:ImageArtifact["viewport"] }
export interface StructuredToolResult { text: string; images: ImageOutput[] }
const memoryRoots = new WeakMap<DemesneStore, string>();
export function artifactRoot(store: DemesneStore): string {
  if (store.filename !== ":memory:") return join(dirname(store.filename), "artifacts");
  let root = memoryRoots.get(store);
  if (!root) { root = join(tmpdir(), `demesne-artifacts-${crypto.randomUUID()}`); memoryRoots.set(store, root); }
  return root;
}

export async function ingestImage(store: DemesneStore, image: ImageOutput,
  origin: { sessionId: string; turnId: string; toolCallId: string; name: string }, index: number): Promise<ImageArtifact> {
  if (image.data.byteLength > 20 * 1024 * 1024) throw new Error("Image exceeds 20 MiB");
  const decoder = sharp(image.data, { limitInputPixels: 40_000_000, animated: false });
  const info = await decoder.metadata();
  const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[info.format as "png" | "jpeg" | "webp"];
  if (!mime || mime !== image.mimeType || !info.width || !info.height || (info.pages ?? 1) > 1) throw new Error("Unsupported or mismatched image format");
  const preview = await decoder.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const hash = createHash("sha256").update(image.data).digest("hex");
  const root = artifactRoot(store);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [suffix, data] of [["original", image.data], ["png", preview]] as const) {
    const target = join(root, `${hash}.${suffix}`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, target);
  }
  const revision = image.revisionOf ? store.getImageArtifact(origin.sessionId, image.revisionOf) : null;
  return store.recordImageArtifact({ id: crypto.randomUUID(), kind: "image", sessionId: origin.sessionId,
    turnId: origin.turnId, toolCallId: origin.toolCallId, createdAt: new Date().toISOString(),
    filename: image.filename ?? `image-${index + 1}.${info.format === "jpeg" ? "jpg" : info.format}`,
    mimeType: mime, width: info.autoOrient.width, height: info.autoOrient.height, byteLength: image.data.byteLength, sha256: hash,
    source: { kind: origin.name.startsWith("mcp__") ? "mcp" : "tool", name: origin.name, modelId: image.modelId ?? null },
    revisionOf: revision?.id ?? null, ...(image.viewport?{viewport:image.viewport}:{}) }, `${origin.toolCallId}:${index}`);
}

export function readArtifact(store: DemesneStore, artifact: ImageArtifact, preview: boolean): Promise<Buffer> {
  return readFile(join(artifactRoot(store), `${artifact.sha256}.${preview ? "png" : "original"}`));
}
