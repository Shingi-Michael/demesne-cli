export interface InferenceLease {
  readonly queueDurationMs: number;
  release(): void;
}

interface Waiter {
  /// Set on a Drive check-in: the worker turn it reviews.
  reviewFor?: string;
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
  /// One queued or active review per worker turn.
  private readonly reviewOwners = new Map<string, string>();
  private lastGrantWasReview = false;
  private readonly waiters: Waiter[] = [];
  private pumping = false;
  private terminal = false;
  private terminalReason: unknown;
  private pumpTask: Promise<void> | undefined;

  constructor(
    capacity = 1,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) {
      throw new Error("Inference scheduler capacity must be an integer between 1 and 1024");
    }
    this.capacity = capacity;
  }

  get activeCount(): number {
    return this.active;
  }

  /// 1-based position the turn would be granted at, or null when not queued.
  queuePosition(turnId: string): number | null {
    const pending = [...this.waiters];
    let lastReview = this.lastGrantWasReview, position = 0;
    while (pending.length) {
      const next = this.nextWaiterIndex(pending, lastReview);
      const [waiter] = pending.splice(next < 0 ? 0 : next, 1);
      position++;
      if (waiter!.turnId === turnId) return position;
      lastReview = Boolean(waiter!.reviewFor);
    }
    return null;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(turnId: string, signal: AbortSignal, options: { reviewFor?: string } = {}): Promise<InferenceLease> {
    if (!turnId) return Promise.reject(new Error("Inference scheduler turn ID cannot be empty"));
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.terminal) return Promise.reject(this.terminalReason);
    if (options.reviewFor && this.reviewOwners.has(options.reviewFor)) return Promise.reject(new Error("A review for this worker is already queued or running"));
    if (options.reviewFor) this.reviewOwners.set(options.reviewFor, turnId);
    return new Promise<InferenceLease>((resolve, reject) => {
      const waiter: Waiter = {
        reviewFor: options.reviewFor,
        turnId,
        enqueuedAt: this.now(),
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          if (waiter.reviewFor) this.reviewOwners.delete(waiter.reviewFor);
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
        const waiterIndex = this.nextWaiterIndex();
        if (waiterIndex < 0) return;
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        if (!waiter) return;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal.aborted) {
          if (waiter.reviewFor) this.reviewOwners.delete(waiter.reviewFor);
          waiter.reject(waiter.signal.reason ?? new DOMException("Aborted", "AbortError"));
          continue;
        }
        this.active += 1;
        this.lastGrantWasReview = Boolean(waiter.reviewFor);
        let released = false;
        waiter.resolve({
          queueDurationMs: Math.max(0, this.now() - waiter.enqueuedAt),
          release: () => {
            if (released) return;
            released = true;
            this.active -= 1;
            if (waiter.reviewFor) this.reviewOwners.delete(waiter.reviewFor);
            this.requestDrain();
          },
        });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
      this.pumpTask = undefined;
      if (!this.terminal && this.active < this.capacity && this.waiters.length > 0) {
        this.requestDrain();
      }
    }
  }

  /// Drive reviews take the next slot, alternating with normal work so neither
  /// starves.
  private nextWaiterIndex(waiters = this.waiters, lastReview = this.lastGrantWasReview): number {
    const review = waiters.findIndex((waiter) => Boolean(waiter.reviewFor));
    const normal = waiters.findIndex((waiter) => !waiter.reviewFor);
    if (review >= 0 && (!lastReview || normal < 0)) return review;
    return normal >= 0 ? normal : 0;
  }

  private removeAbortedWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (!waiter.signal.aborted) continue;
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.reviewFor) this.reviewOwners.delete(waiter.reviewFor);
      waiter.reject(waiter.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
  }

  private fail(reason: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.terminalReason = reason;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.reviewFor) this.reviewOwners.delete(waiter.reviewFor);
      waiter.reject(reason);
    }
  }
}

/// One scheduler per provider, so separate model servers never queue behind
/// each other: a sub-agent on a local model can run while the main turn's
/// cloud model is busy. Each provider can override the default slot count. With a single provider this is exactly one scheduler.
export class InferenceSchedulers {
  private readonly others = new Map<string, InferenceScheduler>();
  private closed = false;

  constructor(readonly primary: InferenceScheduler, private readonly primaryProviderId: string,
    private readonly overrides: Readonly<Record<string, number>> = {}, private readonly defaultCapacity = primary.capacity) {
    for (const capacity of [defaultCapacity, ...Object.values(overrides)]) {
      if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) throw new Error("Provider inference slots must be between 1 and 1024");
    }
    if (overrides[primaryProviderId] !== undefined && overrides[primaryProviderId] !== primary.capacity) throw new Error("Primary scheduler capacity does not match its provider override");
  }

  capacityFor(providerId: string): number { return providerId === this.primaryProviderId ? this.primary.capacity : this.overrides[providerId] ?? this.defaultCapacity; }
  get capacities(): Record<string, number> { return { ...this.overrides, [this.primaryProviderId]: this.primary.capacity, ...Object.fromEntries([...this.others].map(([id, scheduler]) => [id, scheduler.capacity])) }; }

  for(providerId: string): InferenceScheduler {
    if (providerId === this.primaryProviderId || this.closed) return this.primary;
    let scheduler = this.others.get(providerId);
    if (!scheduler) this.others.set(providerId, scheduler = new InferenceScheduler(this.capacityFor(providerId)));
    return scheduler;
  }

  private get all(): InferenceScheduler[] { return [this.primary, ...this.others.values()]; }
  get activeCount(): number { return this.all.reduce((sum, scheduler) => sum + scheduler.activeCount, 0); }
  get queuedCount(): number { return this.all.reduce((sum, scheduler) => sum + scheduler.queuedCount, 0); }
  queuePosition(turnId: string): number | null {
    for (const scheduler of this.all) { const position = scheduler.queuePosition(turnId); if (position !== null) return position; }
    return null;
  }
  async close(reason?: unknown): Promise<void> {
    this.closed = true;
    await Promise.all(this.all.map((scheduler) => scheduler.close(reason)));
  }
}
