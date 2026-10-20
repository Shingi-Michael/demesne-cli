import { OpenAICompatibleProvider } from "@demesne/providers";
import type { ModelDescriptor } from "@demesne/protocol";

/// Direct provider probing for `demesne setup` and `demesne doctor`. These run
/// before the daemon exists, so they talk to the OpenAI-compatible endpoint
/// themselves instead of going through `/v1/models`.

export interface ProbeTarget {
  id: string;
  label: string;
  url: string;
}

export const DEFAULT_PROBE_TARGETS: ProbeTarget[] = [
  { id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { id: "llama.cpp", label: "llama.cpp", url: "http://127.0.0.1:11436/v1" },
];

export interface ProbeResult {
  target: ProbeTarget;
  reachable: boolean;
  models: ModelDescriptor[];
  error?: string;
}

export interface ProbeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function probeProvider(target: ProbeTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
  const provider = new OpenAICompatibleProvider({
    baseUrl: target.url,
    providerId: target.id,
    fetch: options.fetch,
  });
  try {
    const models = await provider.listModels(AbortSignal.timeout(options.timeoutMs ?? 2_000));
    return { target, reachable: true, models };
  } catch (error) {
    return {
      target,
      reachable: false,
      models: [],
      error: error instanceof Error ? error.message : "Provider did not respond",
    };
  }
}

export async function probeTargets(
  targets: ProbeTarget[] = DEFAULT_PROBE_TARGETS,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  return Promise.all(targets.map((target) => probeProvider(target, options)));
}

export function targetForUrl(url: string, targets: ProbeTarget[] = DEFAULT_PROBE_TARGETS): ProbeTarget {
  const normalized = url.endsWith("/") ? url : `${url}/`;
  return targets.find((target) => (target.url.endsWith("/") ? target.url : `${target.url}/`) === normalized)
    ?? { id: "openai-compatible", label: new URL(normalized).host, url: normalized };
}
