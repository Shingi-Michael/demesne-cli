import type { ModelDescriptor, RuntimeProfileStatus } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent, ProviderToolDefinition } from "@demesne/providers";

export interface TurnInference {
  readonly providerId: string;
  readonly modelId: string;
  readonly profile: string | null;
  readonly thinkingEnabled: boolean | undefined;
  readonly preservesPromptCache: boolean;
  readonly contextCapacity?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly seed?: number;
  stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
}

export interface TurnProcessor {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextCapacity?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly seed?: number;
  readonly preservesPromptCache?: boolean;
  createTurnInference?(thinkingEnabled: boolean | undefined, overrides?: InferenceOverrides): TurnInference;
  setModel?(modelId: string): void;
  runtimeStatus?(): RuntimeProfileStatus;
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    signal: AbortSignal,
    thinkingEnabled: boolean | undefined,
    onFirstProviderEvent?: () => void,
  ): AsyncIterable<ProviderStreamEvent>;
}

/// Per-call adjustments, e.g. Drive's cap on a single decision's output.
export interface InferenceOverrides { maxOutputTokens?: number }

export function snapshotTurnInference(
  processor: TurnProcessor,
  thinkingEnabled: boolean | undefined,
  overrides?: InferenceOverrides,
): TurnInference {
  const inference = processor.createTurnInference?.(thinkingEnabled, overrides);
  if (inference) return inference;
  if (processor.setModel) {
    throw new Error("A model-switching turn processor must implement createTurnInference");
  }
  const providerId = processor.providerId;
  const modelId = processor.modelId;
  const profile = processor.runtimeStatus?.().profile ?? null;
  const contextCapacity = processor.contextCapacity;
  const maxOutputTokens = processor.maxOutputTokens;
  const temperature = processor.temperature;
  const seed = processor.seed;
  const preservesPromptCache = processor.preservesPromptCache === true;
  return Object.freeze({
    providerId,
    modelId,
    profile,
    thinkingEnabled,
    preservesPromptCache,
    contextCapacity,
    maxOutputTokens,
    temperature,
    seed,
    stream: (messages: ProviderMessage[], tools: ProviderToolDefinition[], signal: AbortSignal) => {
      const activeProfile = processor.runtimeStatus?.().profile ?? null;
      if (
        processor.providerId !== providerId
        || processor.modelId !== modelId
        || activeProfile !== profile
        || processor.contextCapacity !== contextCapacity
        || processor.maxOutputTokens !== maxOutputTokens
        || processor.temperature !== temperature
        || processor.seed !== seed
      ) {
        throw new Error("Turn processor configuration changed after inference was snapshotted");
      }
      return processor.stream(messages, tools, signal, thinkingEnabled);
    },
  });
}

export class PlaceholderTurnProcessor implements TurnProcessor {
  readonly providerId = "placeholder";
  readonly modelId = "deterministic";

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: this.modelId, provider: this.providerId, ownedBy: "demesne" }];
  }

  async *stream(
    messages: ProviderMessage[],
    _tools: ProviderToolDefinition[],
    signal: AbortSignal,
    _thinkingEnabled: boolean | undefined,
  ): AsyncGenerator<ProviderStreamEvent> {
    await Bun.sleep(10);
    if (signal.aborted) throw signal.reason;
    const lastUser = messages.findLast((message) => message.role === "user");
    yield { type: "text_delta", delta: `Request accepted: ${lastUser?.content ?? ""}` };
  }
}
