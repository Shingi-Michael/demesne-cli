import type { ModelDescriptor } from "@demesne/protocol";
import type { ProviderMessage, ProviderToolDefinition } from "@demesne/providers";
import { snapshotTurnInference, type InferenceOverrides, type TurnProcessor } from "./processor.ts";

/** Routes model selection while keeping each queued turn bound to its original provider. */
export class MultiProviderProcessor implements TurnProcessor {
  private selected: TurnProcessor;
  private routes = new Map<string, TurnProcessor>();
  /// The model you were moved off when its provider went away (signed out);
  /// it comes back when the provider does, unless you chose another since.
  private displaced: { model: string; provider: string; reasoning?: string } | null = null;

  constructor(private processors: TurnProcessor[], configuredModels: string[][]) {
    if (!processors.length) throw new Error("At least one provider is required");
    this.selected = processors[0]!;
    this.routes = this.buildRoutes(processors, configuredModels);
  }

  private buildRoutes(processors: TurnProcessor[], configuredModels: string[][]) {
    const routes = new Map<string, TurnProcessor>();
    processors.forEach((processor, index) => {
      for (const id of new Set([processor.modelId, ...(configuredModels[index] ?? [])])) {
        this.addRoute(routes, id, processor);
      }
    });
    return routes;
  }

  /// Swaps in a new provider set (after signing in or out). The selected
  /// model stays when its provider is still there; otherwise selection moves
  /// to a local provider, else the first. Turns already queued keep the
  /// provider they were bound to.
  replace(processors: TurnProcessor[], configuredModels: string[][], local: boolean[] = []) {
    if (!processors.length) throw new Error("At least one provider is required");
    const previous = { model: this.selected.modelId, provider: this.selected.providerId, reasoning: this.selected.reasoning };
    const routes = this.buildRoutes(processors, configuredModels);
    const kept = routes.get(previous.model);
    this.processors = processors;
    this.routes = routes;
    const back = this.displaced && routes.get(this.displaced.model);
    if (back && back.providerId === this.displaced!.provider) {
      const restored = this.displaced!;
      back.setModel?.(restored.model, restored.reasoning);
      this.selected = back;
      this.displaced = null;
      return { switched: true, restored: true, model: restored.model, provider: restored.provider, previous };
    }
    if (kept && kept.providerId === previous.provider) {
      kept.setModel?.(previous.model, previous.reasoning ?? undefined);
      this.selected = kept;
      return { switched: false, model: previous.model, provider: previous.provider, previous };
    }
    const fallback = processors.findIndex((_, index) => local[index]);
    // Moved again while already displaced: remember your choice, not the fallback.
    this.displaced ??= { model: previous.model, provider: previous.provider, ...(previous.reasoning ? { reasoning: previous.reasoning } : {}) };
    this.selected = processors[fallback >= 0 ? fallback : 0]!;
    return { switched: true, model: this.selected.modelId, provider: this.selected.providerId, previous };
  }

  private addRoute(routes: Map<string, TurnProcessor>, id: string, processor: TurnProcessor) {
    if (routes.has(id) && routes.get(id) !== processor) throw new Error(`Ambiguous model ID across providers: ${id}`);
    routes.set(id, processor);
  }

  get providerId() { return this.selected.providerId; }
  get modelId() { return this.selected.modelId; }
  get reasoning() { return this.selected.reasoning; }
  get contextCapacity() { return this.selected.contextCapacity; }
  get maxOutputTokens() { return this.selected.maxOutputTokens; }
  get temperature() { return this.selected.temperature; }
  get seed() { return this.selected.seed; }
  get preservesPromptCache() { return this.selected.preservesPromptCache; }
  runtimeStatus() {
    return this.selected.runtimeStatus?.() ?? {
      profile: null, state: "unconfigured" as const, expected: null, observed: null,
      mismatches: [], observedAt: null,
    };
  }

  availableModels() {
    return [...this.routes.entries()].map(([id, processor]) => ({ id, provider: processor.providerId }));
  }

  setModel(id: string, reasoning?: string) {
    const processor = this.routes.get(id);
    if (!processor) throw new Error(`Unknown model: ${id}`);
    this.displaced = null;
    processor.setModel?.(id, reasoning);
    this.selected = processor;
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const results = await Promise.allSettled(this.processors.map((processor) =>
      processor.listModels(AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]))));
    if (signal?.aborted) throw signal.reason;
    const routes = new Map(this.routes);
    const models: ModelDescriptor[] = [];
    let succeeded = false;
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      succeeded = true;
      for (const model of result.value) {
        this.addRoute(routes, model.id, this.processors[index]!);
        models.push(model);
      }
    });
    if (!succeeded) throw new Error("No configured model provider is reachable");
    this.routes = routes;
    return models;
  }

  /// The selected model's call, or with `overrides.model` another configured
  /// model's, on whichever provider serves it. Overrides (such as Drive's
  /// output cap) pass through to that provider.
  createTurnInference(thinkingEnabled: boolean | undefined, overrides?: InferenceOverrides) {
    const processor = overrides?.model ? this.routes.get(overrides.model) : this.selected;
    if (!processor) throw new Error(`Unknown model: ${overrides!.model}`);
    return snapshotTurnInference(processor, thinkingEnabled, overrides);
  }

  async *stream(messages: ProviderMessage[], tools: ProviderToolDefinition[], signal: AbortSignal,
    thinkingEnabled: boolean | undefined, onFirstProviderEvent?: () => void) {
    const inference = this.createTurnInference(thinkingEnabled);
    let first = true;
    for await (const event of inference.stream(messages, tools, signal)) {
      if (first) { first = false; onFirstProviderEvent?.(); }
      yield event;
    }
  }
}
