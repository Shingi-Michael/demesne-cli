import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolDefinition,
} from "@demesne/providers";
import type { RuntimeProfileStatus } from "@demesne/protocol";
import type { RuntimeProfileVerifier } from "./ollama-runtime.ts";
import type { InferenceOverrides, TurnInference, TurnProcessor } from "./processor.ts";

type ProviderRequestDefaults = Pick<ProviderRequest, "maxOutputTokens" | "temperature" | "seed">;

export class ProviderTurnProcessor implements TurnProcessor {
  readonly providerId: string;
  private currentModelId: string;
  private modelGeneration = 0;
  private readonly discoveredContextCapacities = new Map<string, number>();
  private readonly allowedModelIds: ReadonlySet<string> | undefined;

  constructor(
    private readonly provider: ProviderAdapter,
    modelId: string,
    private readonly requestDefaults: ProviderRequestDefaults = {},
    private readonly runtimeVerifier?: RuntimeProfileVerifier,
    private readonly configuredContextCapacity?: number,
    allowedModelIds?: readonly string[],
    readonly preservesPromptCache = false,
  ) {
    this.providerId = provider.id;
    this.currentModelId = modelId;
    this.allowedModelIds = allowedModelIds ? new Set(allowedModelIds) : undefined;
    if (this.allowedModelIds && !this.allowedModelIds.has(modelId)) {
      throw new Error(`Configured model is not in DEMESNE_ALLOWED_MODELS: ${modelId}`);
    }
  }

  get modelId(): string {
    return this.currentModelId;
  }

  setModel(modelId: string): void {
    if (this.allowedModelIds && !this.allowedModelIds.has(modelId)) {
      throw new Error(`Model is not allowed by this daemon: ${modelId}`);
    }
    this.currentModelId = modelId;
    this.modelGeneration += 1;
    this.runtimeVerifier?.reset();
  }

  runtimeStatus(): RuntimeProfileStatus {
    return this.runtimeVerifier?.status() ?? {
      profile: null,
      state: "unconfigured",
      expected: null,
      observed: null,
      mismatches: [],
      observedAt: null,
    };
  }

  get contextCapacity(): number | undefined {
    return this.effectiveContextCapacity(this.currentModelId);
  }

  get maxOutputTokens(): number | undefined {
    return this.requestDefaults.maxOutputTokens;
  }

  get temperature(): number | undefined {
    return this.requestDefaults.temperature;
  }

  get seed(): number | undefined {
    return this.requestDefaults.seed;
  }

  async listModels(signal?: AbortSignal) {
    const discovered = await this.provider.listModels(signal);
    const models = this.allowedModelIds
      ? discovered.filter((model) => this.allowedModelIds!.has(model.id))
      : discovered;
    for (const model of models) {
      if (model.contextWindow) this.discoveredContextCapacities.set(model.id, model.contextWindow);
    }
    return models;
  }

  createTurnInference(thinkingEnabled: boolean | undefined, overrides?: InferenceOverrides): TurnInference {
    const model = this.currentModelId;
    const modelGeneration = this.modelGeneration;
    const profile = this.runtimeVerifier?.status().profile ?? null;
    const requestDefaults = { ...this.requestDefaults };
    // A cap only ever lowers the configured output limit.
    if (overrides?.maxOutputTokens) requestDefaults.maxOutputTokens = Math.min(requestDefaults.maxOutputTokens ?? overrides.maxOutputTokens, overrides.maxOutputTokens);
    const contextCapacity = this.effectiveContextCapacity(model);
    if (contextCapacity && requestDefaults.maxOutputTokens && requestDefaults.maxOutputTokens >= contextCapacity) {
      throw new Error("The model output limit must be smaller than the effective context capacity");
    }
    return Object.freeze({
      providerId: this.providerId,
      modelId: model,
      profile,
      thinkingEnabled,
      preservesPromptCache: this.preservesPromptCache,
      contextCapacity,
      maxOutputTokens: requestDefaults.maxOutputTokens,
      temperature: requestDefaults.temperature,
      seed: requestDefaults.seed,
      stream: (messages: ProviderMessage[], tools: ProviderToolDefinition[], signal: AbortSignal) => (
        this.streamModel(model, modelGeneration, requestDefaults, messages, tools, signal, thinkingEnabled)
      ),
    });
  }

  private effectiveContextCapacity(model: string): number | undefined {
    const limits = [
      this.configuredContextCapacity,
      this.discoveredContextCapacities.get(model),
      this.runtimeVerifier?.status().expected?.contextWindow,
    ].filter((value): value is number => value !== undefined);
    return limits.length > 0 ? Math.min(...limits) : undefined;
  }

  async *stream(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    signal: AbortSignal,
    thinkingEnabled: boolean | undefined,
    onFirstProviderEvent?: () => void,
  ): AsyncGenerator<ProviderStreamEvent> {
    const inference = this.createTurnInference(thinkingEnabled);
    yield* this.streamModel(
      inference.modelId,
      this.modelGeneration,
      { maxOutputTokens: inference.maxOutputTokens, temperature: inference.temperature, seed: inference.seed },
      messages,
      tools,
      signal,
      thinkingEnabled,
      onFirstProviderEvent,
    );
  }

  private async *streamModel(
    model: string,
    modelGeneration: number,
    requestDefaults: ProviderRequestDefaults,
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    signal: AbortSignal,
    thinkingEnabled: boolean | undefined,
    onFirstProviderEvent?: () => void,
  ): AsyncGenerator<ProviderStreamEvent> {
    const runtimeBaseline = this.runtimeVerifier?.capture();
    const stream = this.provider.stream({
      ...requestDefaults,
      model,
      messages,
      tools,
      ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    }, signal);
    const iterator = stream[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (!first.done) onFirstProviderEvent?.();
      try {
        if (this.runtimeVerifier) await this.runtimeVerifier.verify(model, runtimeBaseline ?? null, signal);
      } catch (error) {
        if (modelGeneration !== this.modelGeneration) this.runtimeVerifier?.reset();
        throw error;
      }
      if (modelGeneration !== this.modelGeneration) this.runtimeVerifier?.reset();
      if (!first.done) yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }
}
