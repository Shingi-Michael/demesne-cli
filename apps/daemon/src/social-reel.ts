/// Agent socials, step 3: the Friday reel's opening clip. Once a week the
/// three agents get one short video together, made by the `[images]`
/// backend's video model (an OpenAI-style /videos API: start a job, wait for
/// it, download the MP4). A picture of their three drawn faces is the
/// reference, so they look like themselves. Everything else in the reel is
/// put together in the app from the week's real posts, at no cost.
import type { ImageGenerationConfig } from "@demesne/config";
import { isRecord } from "@demesne/protocol";
import { agentFace } from "@demesne/brand";
import type { AgentId } from "./agent-cli.ts";
import { LOOKS } from "./social-pictures.ts";

/// How long the clip runs, and its frame (portrait, for the reel player).
export const CLIP_SECONDS = 8;
export const CLIP_SIZE = { width: 720, height: 1280 };

export type ClipMaker = (agents: AgentId[], scene: string) => Promise<Uint8Array | null>;

export interface ClipDeps {
  /// An SVG made into a PNG of the clip's size (sharp in the daemon).
  png: (svg: string, width: number, height: number) => Promise<Uint8Array>;
  request?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /// How often to ask whether the video is done, and how long to wait in all.
  pollMs?: number;
  waitMs?: number;
}

/// The video model to use: the configured one, sora-2 on OpenAI, or none.
export function videoModel(config: ImageGenerationConfig): string | null {
  const set = config.videoModel?.trim();
  if (set) return set.toLowerCase() === "none" ? null : set;
  try { return new URL(config.url ?? "").hostname === "api.openai.com" ? "sora-2" : null; } catch { return null; }
}

export function clipPrompt(agents: AgentId[], scene: string): string {
  return [
    "A short, gentle anime print animation: flat colours, soft woodblock texture, cherry blossom petals drifting, a palette of soft pink, cream and deep night blue.",
    `The characters are friends who build software together: ${agents.map((id) => LOOKS[id]).join("; ")}. Draw them exactly like the faces in the reference image.`,
    `The scene: ${scene}`,
    "Slow, calm camera. No words, letters, numbers, logos or readable screens. Not photographic, and no real people. No dialogue.",
  ].join(" ");
}

/// The reference frame: the agents' drawn faces side by side on soft pink.
export function referenceSvg(agents: AgentId[]): string {
  const { width, height } = CLIP_SIZE, size = 200, gap = 24;
  const left = (width - (agents.length * size + (agents.length - 1) * gap)) / 2;
  const faces = agents.map((id, index) => agentFace(id).replace("<svg ", `<svg x="${left + index * (size + gap)}" y="${(height - size) / 2}" width="${size}" height="${size}" `)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#f7c6d4"/>${faces}</svg>`;
}

const VIDEO_LIMIT = 80 * 1024 * 1024;

/// One clip, or null when there is no video model, it says no, or it takes
/// too long.
export function clipMaker(config: ImageGenerationConfig, deps: ClipDeps): ClipMaker | null {
  const model = videoModel(config);
  if (!config.url || !model) return null;
  const base = config.url.replace(/\/+$/, ""), request = deps.request ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const auth = (): Record<string, string> => config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  const json = async (response: Response): Promise<Record<string, unknown> | null> => {
    if (!response.ok) { await response.body?.cancel(); return null; }
    try { const value = await response.json(); return isRecord(value) ? value : null; } catch { return null; }
  };
  return async (agents, scene) => {
    try {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", clipPrompt(agents, scene));
      form.set("seconds", String(CLIP_SECONDS));
      form.set("size", `${CLIP_SIZE.width}x${CLIP_SIZE.height}`);
      const reference = await deps.png(referenceSvg(agents), CLIP_SIZE.width, CLIP_SIZE.height);
      form.set("input_reference", new Blob([new Uint8Array(reference)], { type: "image/png" }), "agents.png");
      const job = await json(await request(`${base}/videos`, { method: "POST", headers: auth(), body: form, signal: AbortSignal.timeout(60_000), redirect: "error" }));
      const id = typeof job?.id === "string" ? job.id : null;
      if (!id || !/^[\w-]+$/.test(id)) return null;
      const until = Date.now() + (deps.waitMs ?? 20 * 60_000);
      let status = String(job?.status ?? "");
      while (status !== "completed") {
        if (status === "failed" || status === "cancelled" || Date.now() > until) return null;
        await sleep(deps.pollMs ?? 15_000);
        const state = await json(await request(`${base}/videos/${id}`, { headers: auth(), signal: AbortSignal.timeout(30_000), redirect: "error" }));
        status = String(state?.status ?? "failed");
      }
      const response = await request(`${base}/videos/${id}/content`, { headers: auth(), signal: AbortSignal.timeout(120_000), redirect: "follow" });
      if (!response.ok) { await response.body?.cancel(); return null; }
      if (Number(response.headers.get("content-length") ?? 0) > VIDEO_LIMIT) { await response.body?.cancel(); return null; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength && bytes.byteLength <= VIDEO_LIMIT ? bytes : null;
    } catch { return null; }
  };
}
