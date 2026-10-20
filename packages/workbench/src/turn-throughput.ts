import type { EventEnvelope } from "@demesne/protocol";

interface ProviderRoundMeasurement {
  usageSeen: boolean;
  metricsSeen: boolean;
  outputTokens: number | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  accounted: boolean;
}

export interface TurnThroughputSnapshot {
  outputTokens: number | null;
  providerDurationMs: number | null;
  tokensPerSecond: number | null;
  timeToFirstTokenMs: number | null;
  decodeTokensPerSecond: number | null;
  measuredRounds: number;
}

export class TurnThroughputTracker {
  private readonly rounds = new Map<string, ProviderRoundMeasurement>();
  private totalOutputTokens = 0;
  private totalProviderDurationMs = 0;
  private measuredRounds = 0;
  private totalTimeToFirstTokenMs = 0;
  private outputComplete = true;
  private timingComplete = true;
  private decodeTimingComplete = true;

  apply(event: EventEnvelope): void {
    if (event.type !== "model.usage" && event.type !== "model.metrics") return;
    const providerCallId = typeof event.payload.providerCallId === "string" ? event.payload.providerCallId : null;
    if (!providerCallId) return;

    const round = this.rounds.get(providerCallId) ?? {
      usageSeen: false,
      metricsSeen: false,
      outputTokens: null,
      durationMs: null,
      timeToFirstTokenMs: null,
      accounted: false,
    };
    this.rounds.set(providerCallId, round);
    if (round.accounted) return;

    if (event.type === "model.usage" && !round.usageSeen) {
      round.usageSeen = true;
      round.outputTokens = nonnegativeInteger(event.payload.outputTokens);
    }
    if (event.type === "model.metrics" && !round.metricsSeen) {
      round.metricsSeen = true;
      round.durationMs = nonnegativeNumber(event.payload.durationMs);
      round.timeToFirstTokenMs = nonnegativeNumber(event.payload.timeToFirstTokenMs);
    }

    if (!round.usageSeen || !round.metricsSeen) return;
    round.accounted = true;
    this.measuredRounds += 1;

    if (round.outputTokens === null) {
      this.outputComplete = false;
      this.timingComplete = false;
      return;
    }
    this.totalOutputTokens += round.outputTokens;

    if (round.durationMs === null || round.durationMs <= 0) {
      this.timingComplete = false;
      return;
    }
    this.totalProviderDurationMs += round.durationMs;
    if (round.timeToFirstTokenMs === null || round.timeToFirstTokenMs > round.durationMs) {
      this.decodeTimingComplete = false;
      return;
    }
    this.totalTimeToFirstTokenMs += round.timeToFirstTokenMs;
  }

  snapshot(): TurnThroughputSnapshot {
    const outputTokens = this.measuredRounds > 0 && this.outputComplete ? this.totalOutputTokens : null;
    const providerDurationMs = this.measuredRounds > 0 && this.timingComplete
      ? this.totalProviderDurationMs
      : null;
    const tokensPerSecond = outputTokens !== null && outputTokens > 0
      && providerDurationMs !== null && providerDurationMs > 0
      ? outputTokens / (providerDurationMs / 1_000)
      : null;
    const timeToFirstTokenMs = this.measuredRounds > 0 && this.timingComplete && this.decodeTimingComplete
      ? this.totalTimeToFirstTokenMs
      : null;
    const decodeDurationMs = providerDurationMs !== null && timeToFirstTokenMs !== null
      ? providerDurationMs - timeToFirstTokenMs
      : null;
    const decodeTokensPerSecond = outputTokens !== null && outputTokens > 0
      && decodeDurationMs !== null && decodeDurationMs > 0
      ? outputTokens / (decodeDurationMs / 1_000)
      : null;
    return {
      outputTokens,
      providerDurationMs,
      tokensPerSecond,
      timeToFirstTokenMs,
      decodeTokensPerSecond,
      measuredRounds: this.measuredRounds,
    };
  }
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
