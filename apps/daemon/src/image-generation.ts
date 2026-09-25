import type { ImageGenerationConfig } from "@demesne/config";
import { isRecord } from "@demesne/protocol";
import type { DemesneStore } from "@demesne/storage";
import { readArtifact, type StructuredToolResult } from "./artifacts.ts";
import type { AgentTool, ToolContext } from "./tools.ts";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const RESPONSE_LIMIT = Math.ceil(IMAGE_LIMIT / 3) * 4 + 64 * 1024;
const sizes = ["auto", "1024x1024", "1536x1024", "1024x1536"];

/** OpenAI Images API adapter. Explicit configuration is independent of the chat model. */
export function imageGenerationTool(config: ImageGenerationConfig, store: DemesneStore, request: typeof fetch = fetch): AgentTool {
  if (!config.url || !config.model) throw new Error("Image generation requires images.url and images.model");
  const base = config.url.replace(/\/+$/, "");
  const model = config.model;
  async function generate(input: unknown, context: ToolContext): Promise<StructuredToolResult> {
    if (!isRecord(input) || Object.keys(input).some((key) => !["prompt", "size", "referenceArtifactId"].includes(key))
      || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32_000
      || (input.size !== undefined && !sizes.includes(input.size as string))
      || (input.referenceArtifactId !== undefined && (typeof input.referenceArtifactId !== "string" || !input.referenceArtifactId))) {
      throw new Error("generate_image requires a nonempty prompt (at most 32000 characters), a supported size, and an optional referenceArtifactId");
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(config.requestTimeoutMs ?? 300_000)]);
    signal.throwIfAborted();
    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    let body: string | FormData;
    let endpoint = "generations";
    if (input.referenceArtifactId) {
      const artifact = context.sessionId ? store.getImageArtifact(context.sessionId, input.referenceArtifactId as string) : null;
      if (!artifact) throw new Error("Reference image was not found in this session");
      const bytes = await readArtifact(store, artifact, false);
      body = new FormData();
      body.set("model", model); body.set("prompt", input.prompt); body.set("n", "1");
      body.set("size", (input.size as string | undefined) ?? "auto");
      body.set("image", new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }), artifact.filename);
      endpoint = "edits";
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ model, prompt: input.prompt, n: 1, size: input.size ?? "auto" });
    }
    let response: Response;
    try {
      response = await request(`${base}/images/${endpoint}`, { method: "POST", headers, body, signal, redirect: "error" });
    } catch {
      signal.throwIfAborted();
      throw new Error("Image provider could not be reached; check images.url and network connectivity");
    }
    // Provider error bodies may contain credentials or enormous payloads. Keep errors actionable and bounded.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Image provider returned HTTP ${response.status}; check image credentials, model access, quota, and endpoint support`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Image provider returned an empty response");
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > RESPONSE_LIMIT) throw new Error("Image provider response exceeds the image size limit");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Image provider returned invalid JSON"); }
    const item = isRecord(payload) && Array.isArray(payload.data) && payload.data.length === 1 ? payload.data[0] : null;
    if (!isRecord(item) || typeof item.b64_json !== "string") throw new Error("Image provider must return one image as b64_json; URL-only responses are unsupported");
    const encoded = item.b64_json;
    if (!encoded.length || encoded.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Image provider returned invalid or oversized base64 image data");
    const data = Buffer.from(encoded, "base64");
    if (data.length > IMAGE_LIMIT) throw new Error("Generated image exceeds 20 MiB");
    const mimeType = data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg"
      : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : "image/png";
    signal.throwIfAborted();
    return { text: "Image generated and saved to Preview. Use its artifact ID for subsequent edits.",
      images: [{ data, mimeType, modelId: model, revisionOf: input.referenceArtifactId as string | undefined }] };
  }
  return {
    definition: { name: "generate_image", description: "Generate an image from a prompt and display it in Preview. For edits, supply referenceArtifactId from an earlier image result in this session and describe the requested changes. Returns a saved artifact ID; never invent image links.",
      inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 32_000 },
        size: { type: "string", enum: sizes }, referenceArtifactId: { type: "string" } }, required: ["prompt"], additionalProperties: false } },
    permission: () => null,
    execute: async () => { throw new Error("generate_image requires artifact-aware execution"); },
    executeWithArtifacts: generate,
  };
}
