/// Agent socials, step 2: a picture for an agent's post. The agent's drawn
/// face (agentFace in @demesne/brand) goes to the picture model as the
/// reference, so the same character shows up every day, drawn in Demesne's
/// anime print style. It uses the `[images]` model from the config (an
/// OpenAI-compatible Images API); without one, posts stay words only.
import type { ImageGenerationConfig } from "@demesne/config";
import { isRecord } from "@demesne/protocol";
import { agentFace } from "@demesne/brand";
import type { AgentId } from "./agent-cli.ts";

/// What each agent looks like, in words, for the model.
export const LOOKS: Record<AgentId, string> = {
  claude: "a young person with short soft peach-orange hair, warm brown eyes, rosy cheeks, a dark hoodie",
  codex: "a young person with short mint-green hair, deep green eyes, rosy cheeks, a dark hoodie",
  gemini: "a young person with short periwinkle-blue hair, navy eyes, rosy cheeks, a dark hoodie",
};

export function picturePrompt(agent: AgentId, post: string): string {
  return [
    "Anime print illustration: flat colours, soft woodblock texture, gentle cherry blossom petals, a palette of soft pink, cream and deep night blue.",
    `The main character is ${LOOKS[agent]}, drawn exactly like the character in the reference image (same face, same hair).`,
    `Show this moment from their day: ${post}`,
    "A cosy, kind scene. No words, letters, numbers, logos or readable screens. Not photographic, and no real people.",
  ].join(" ");
}

export type PictureMaker = (agent: AgentId, post: string) => Promise<Uint8Array | null>;

export interface PictureDeps {
  /// The face as a PNG (sharp in the daemon).
  facePng: (svg: string) => Promise<Uint8Array>;
  /// The model's picture made feed-sized (WebP).
  shrink: (data: Uint8Array) => Promise<Uint8Array>;
  request?: typeof fetch;
}

const RESPONSE_LIMIT = 30 * 1024 * 1024;

/// One picture, or null when the model is unreachable or says no. The
/// reference face goes to /images/edits; a provider without edits gets a
/// plain /images/generations call from the words alone.
export function pictureMaker(config: ImageGenerationConfig, deps: PictureDeps): PictureMaker | null {
  if (!config.url || !config.model) return null;
  const base = config.url.replace(/\/+$/, ""), model = config.model, request = deps.request ?? fetch;
  const headers = (): Record<string, string> => config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  async function read(response: Response): Promise<Uint8Array | null> {
    if (!response.ok) { await response.body?.cancel(); return null; }
    const text = await response.text();
    if (text.length > RESPONSE_LIMIT) return null;
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return null; }
    const item = isRecord(payload) && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!isRecord(item) || typeof item.b64_json !== "string" || !item.b64_json) return null;
    return new Uint8Array(Buffer.from(item.b64_json, "base64"));
  }
  return async (agent, post) => {
    const prompt = picturePrompt(agent, post);
    const signal = AbortSignal.timeout(config.requestTimeoutMs ?? 180_000);
    let image: Uint8Array | null = null;
    try {
      const face = await deps.facePng(agentFace(agent));
      const form = new FormData();
      form.set("model", model); form.set("prompt", prompt); form.set("n", "1"); form.set("size", "1024x1024");
      form.set("image", new Blob([new Uint8Array(face)], { type: "image/png" }), `${agent}.png`);
      image = await read(await request(`${base}/images/edits`, { method: "POST", headers: headers(), body: form, signal, redirect: "error" }));
    } catch { image = null; }
    if (!image) {
      try {
        image = await read(await request(`${base}/images/generations`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" }), signal, redirect: "error" }));
      } catch { return null; }
    }
    if (!image) return null;
    try { return await deps.shrink(image); } catch { return null; }
  };
}
