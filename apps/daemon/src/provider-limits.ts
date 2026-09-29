export interface ProviderStreamLimits {
  providerFirstEventTimeoutMs?: number;
  providerRequestTimeoutMs?: number;
  providerEventLimit?: number;
}

/** Large reasoning budgets must fit through the stream as well as the API.
 * Explicit deadlines/limits still win; defaults allow 10 output tokens/sec,
 * several semantic events per token, and long token spellings. */
export function providerStreamLimits(maxOutputTokens: number | undefined, options: ProviderStreamLimits = {}) {
  const tokens = maxOutputTokens ?? 0;
  const firstEventTimeoutMs = options.providerFirstEventTimeoutMs ?? 180_000;
  return {
    firstEventTimeoutMs,
    requestTimeoutMs: options.providerRequestTimeoutMs ?? Math.max(900_000, firstEventTimeoutMs + tokens * 100),
    eventLimit: options.providerEventLimit ?? Math.max(20_000, tokens * 4 + 16),
    turnCharacterLimit: Math.max(1_000_000, tokens * 16),
  };
}
