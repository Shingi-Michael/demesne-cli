export interface InferenceLease {
  readonly queueDurationMs: number;
  release(options: { turnContinues: boolean }): void;
}

export interface InferenceBoundarySnapshot {
  activeCount: 0;
  queuedCount: number;
  settledLeaseCount: number;
  pendingContinuationTurnCount: number;
  continuationDrainActive: boolean;
}

export interface InferenceContinuationDrainRequest {
  action: "drain_continuations";
  timeoutMs: number;
  onTimeout?: () => void;
}

export interface InferenceBoundaryHook {
  (snapshot: InferenceBoundarySnapshot, signal: AbortSignal): Promise<void | InferenceContinuationDrainRequest>;
  supportsContinuationDrain?: boolean;
}

interface Waiter {
  turnId: string;
  enqueuedAt: number;
  signal: AbortSignal;
  resolve: (lease: InferenceLease) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

export class InferenceScheduler {
  readonly capacity: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly lifecycle = new AbortController();
  private pumping = false;
  private settledLeaseCount = 0;
  private lastBoundaryLeaseCount = 0;
  private readonly pendingContinuationTurns = new Set<string>();
  private continuationDrainActive = false;
  private continuationDrainTimer: ReturnType<typeof setTimeout> | undefined;
  private continuationDrainTimeoutCallback: (() => void) | undefined;
  private boundaryDisabled = false;
  private terminal = false;
  private terminalReason: unknown;
  private pumpTask: Promise<void> | undefined;

  constructor(
    capacity = 1,
    private readonly now: () => number = () => performance.now(),
    private readonly beforeNextGrant?: InferenceBoundaryHook,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) {
      throw new Error("Inference scheduler capacity must be an integer between 1 and 1024");
    }
    if (beforeNextGrant && capacity !== 1) {
      throw new Error("Inference scheduler boundary hooks require capacity 1");
    }
    this.capacity = capacity;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(turnId: string, signal: AbortSignal): Promise<InferenceLease> {
    if (!turnId) return Promise.reject(new Error("Inference scheduler turn ID cannot be empty"));
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.terminal) return Promise.reject(this.terminalReason);
    return new Promise<InferenceLease>((resolve, reject) => {
      const waiter: Waiter = {
        turnId,
        enqueuedAt: this.now(),
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.requestDrain();
    });
  }

  async close(reason: unknown = new DOMException("Inference scheduler closed", "AbortError")): Promise<void> {
    if (!this.terminal) this.fail(reason);
    await this.pumpTask;
  }

  finishTurn(turnId: string): void {
    if (!this.pendingContinuationTurns.delete(turnId)) return;
    this.requestDrain();
  }

  private requestDrain(): void {
    if (this.pumping || this.terminal) return;
    this.pumpTask = this.drain();
  }

  private async drain(): Promise<void> {
    this.pumping = true;
    try {
      while (this.active < this.capacity && !this.terminal) {
        this.removeAbortedWaiters();
        if (this.waiters.length === 0) return;
        const canEvaluatePendingContinuations = this.beforeNextGrant?.supportsContinuationDrain === true;
        const shouldEvaluateBoundary = this.beforeNextGrant && !this.boundaryDisabled && this.active === 0 && (
          this.continuationDrainActive
            ? this.pendingContinuationTurns.size === 0
            : this.settledLeaseCount > this.lastBoundaryLeaseCount
              && (this.pendingContinuationTurns.size === 0 || canEvaluatePendingContinuations)
        );
        if (shouldEvaluateBoundary) {
          if (!this.continuationDrainActive) this.lastBoundaryLeaseCount = this.settledLeaseCount;
          const result = await this.beforeNextGrant!({
            activeCount: 0,
            queuedCount: this.waiters.length,
            settledLeaseCount: this.settledLeaseCount,
            pendingContinuationTurnCount: this.pendingContinuationTurns.size,
            continuationDrainActive: this.continuationDrainActive,
          }, this.lifecycle.signal);
          if (result?.action === "drain_continuations") this.startContinuationDrain(result);
          else if (this.continuationDrainActive) this.stopContinuationDrain(false);
          this.removeAbortedWaiters();
          if (this.waiters.length === 0) return;
        }
        const waiterIndex = this.continuationDrainActive
          ? this.waiters.findIndex((waiter) => this.pendingContinuationTurns.has(waiter.turnId))
          : 0;
        if (waiterIndex < 0) return;
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        if (!waiter) return;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal.aborted) {
          waiter.reject(waiter.signal.reason ?? new DOMException("Aborted", "AbortError"));
          continue;
        }
        this.active += 1;
        this.pendingContinuationTurns.delete(waiter.turnId);
        let released = false;
        waiter.resolve({
          queueDurationMs: Math.max(0, this.now() - waiter.enqueuedAt),
          release: ({ turnContinues }) => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.settledLeaseCount += 1;
            if (turnContinues) this.pendingContinuationTurns.add(waiter.turnId);
            else this.pendingContinuationTurns.delete(waiter.turnId);
            this.requestDrain();
          },
        });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
      this.pumpTask = undefined;
      if (!this.terminal && this.active < this.capacity && this.hasGrantableWaiter()) {
        this.requestDrain();
      }
    }
  }

  private hasGrantableWaiter(): boolean {
    return this.waiters.length > 0 && (!this.continuationDrainActive
      || this.pendingContinuationTurns.size === 0
      || this.waiters.some((waiter) => this.pendingContinuationTurns.has(waiter.turnId)));
  }

  private startContinuationDrain(request: InferenceContinuationDrainRequest): void {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 10 * 60_000) {
      throw new Error("Inference continuation drain timeout must be an integer between 1 and 600000");
    }
    if (this.pendingContinuationTurns.size === 0) {
      throw new Error("Inference continuation drain requires a pending turn continuation");
    }
    if (this.continuationDrainActive) return;
    this.continuationDrainActive = true;
    this.continuationDrainTimeoutCallback = request.onTimeout;
    this.continuationDrainTimer = setTimeout(() => {
      if (!this.continuationDrainActive || this.terminal) return;
      this.stopContinuationDrain(true);
      this.requestDrain();
    }, request.timeoutMs);
  }

  private stopContinuationDrain(disableBoundary: boolean): void {
    if (this.continuationDrainTimer) clearTimeout(this.continuationDrainTimer);
    this.continuationDrainTimer = undefined;
    const onTimeout = disableBoundary ? this.continuationDrainTimeoutCallback : undefined;
    this.continuationDrainTimeoutCallback = undefined;
    this.continuationDrainActive = false;
    if (disableBoundary) this.boundaryDisabled = true;
    onTimeout?.();
  }

  private removeAbortedWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (!waiter.signal.aborted) continue;
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(waiter.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
  }

  private fail(reason: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.terminalReason = reason;
    this.stopContinuationDrain(false);
    this.lifecycle.abort(reason);
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(reason);
    }
  }
}
