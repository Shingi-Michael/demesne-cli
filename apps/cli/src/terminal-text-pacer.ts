const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/y;

interface PacerUnit {
  value: string;
  visible: boolean;
}

interface TerminalTextPacerOptions {
  sink: (text: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  frameMilliseconds?: number;
  initialCharactersPerSecond?: number;
  minimumCharactersPerSecond?: number;
  maximumCharactersPerSecond?: number;
  maximumBacklogMilliseconds?: number;
}

/**
 * Smooths bursty speculative output without changing its bytes or ordering.
 * ANSI sequences are emitted atomically and visible text is split by grapheme,
 * so styles and composed Unicode characters are never torn across frames.
 */
export class TerminalTextPacer {
  private readonly sink: (text: string) => void;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly frameMilliseconds: number;
  private readonly minimumCharactersPerSecond: number;
  private readonly maximumCharactersPerSecond: number;
  private readonly maximumBacklogMilliseconds: number;
  private readonly units: PacerUnit[] = [];
  private unitIndex = 0;
  private queuedVisibleCharacters = 0;
  private visibleBudget = 0;
  private charactersPerSecond: number;
  private catchUpCharactersPerSecond = 0;
  private observedCharacters = 0;
  private observationStartedAt: number | null = null;
  private pumpPromise: Promise<void> | null = null;

  constructor(options: TerminalTextPacerOptions) {
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? Bun.sleep;
    this.frameMilliseconds = options.frameMilliseconds ?? 16;
    this.minimumCharactersPerSecond = options.minimumCharactersPerSecond ?? 80;
    this.maximumCharactersPerSecond = options.maximumCharactersPerSecond ?? 360;
    this.maximumBacklogMilliseconds = options.maximumBacklogMilliseconds ?? 1_500;
    this.charactersPerSecond = options.initialCharactersPerSecond ?? 120;
  }

  /** Updates the target cadence from raw model text, before markdown formatting. */
  observe(delta: string): void {
    const visibleCharacters = countVisibleGraphemes(delta);
    if (visibleCharacters === 0) return;
    const observedAt = this.now();
    if (this.observationStartedAt === null) this.observationStartedAt = observedAt;
    this.observedCharacters += visibleCharacters;
    const elapsedMilliseconds = observedAt - this.observationStartedAt;
    if (elapsedMilliseconds < 250) return;
    const observedRate = this.observedCharacters / (elapsedMilliseconds / 1_000);
    const boundedRate = clamp(
      observedRate,
      this.minimumCharactersPerSecond,
      this.maximumCharactersPerSecond,
    );
    this.charactersPerSecond = this.charactersPerSecond * 0.7 + boundedRate * 0.3;
  }

  write(text: string): void {
    if (!text) return;
    for (const unit of splitTerminalUnits(text)) {
      this.units.push(unit);
      if (unit.visible) this.queuedVisibleCharacters += 1;
    }
    this.catchUpCharactersPerSecond = Math.max(
      this.catchUpCharactersPerSecond,
      this.queuedVisibleCharacters / (this.maximumBacklogMilliseconds / 1_000),
    );
    this.ensurePump();
  }

  async drain(): Promise<void> {
    while (this.pumpPromise) await this.pumpPromise;
  }

  /** Emits queued text immediately, used on interruption and failure boundaries. */
  flushNow(): void {
    if (this.unitIndex >= this.units.length) return;
    let output = "";
    for (; this.unitIndex < this.units.length; this.unitIndex += 1) {
      output += this.units[this.unitIndex]!.value;
    }
    this.queuedVisibleCharacters = 0;
    this.visibleBudget = 0;
    this.catchUpCharactersPerSecond = 0;
    this.compactQueue();
    if (output) this.sink(output);
  }

  private ensurePump(): void {
    if (this.pumpPromise) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      this.compactQueue();
      if (this.unitIndex < this.units.length) this.ensurePump();
    });
  }

  private async pump(): Promise<void> {
    while (this.unitIndex < this.units.length) {
      const activeRate = Math.max(this.charactersPerSecond, this.catchUpCharactersPerSecond);
      this.visibleBudget += activeRate * (this.frameMilliseconds / 1_000);
      if (this.visibleBudget < 1) {
        await this.sleep(this.frameMilliseconds);
        continue;
      }

      let budget = Math.floor(this.visibleBudget);
      this.visibleBudget -= budget;
      let output = "";

      while (this.unitIndex < this.units.length && budget > 0) {
        const unit = this.units[this.unitIndex]!;
        this.unitIndex += 1;
        output += unit.value;
        if (unit.visible) {
          budget -= 1;
          this.queuedVisibleCharacters -= 1;
        }
      }

      if (output) this.sink(output);
      if (this.unitIndex < this.units.length) await this.sleep(this.frameMilliseconds);
    }
    this.visibleBudget = 0;
    this.catchUpCharactersPerSecond = 0;
  }

  private compactQueue(): void {
    if (this.unitIndex === 0) return;
    this.units.splice(0, this.unitIndex);
    this.unitIndex = 0;
  }
}

export function splitTerminalUnits(text: string): PacerUnit[] {
  const units: PacerUnit[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let index = 0;
  while (index < text.length) {
    ANSI_SEQUENCE.lastIndex = index;
    const ansi = ANSI_SEQUENCE.exec(text);
    if (ansi?.index === index) {
      units.push({ value: ansi[0], visible: false });
      index += ansi[0].length;
      continue;
    }

    const nextEscape = text.indexOf("\x1b", index);
    const end = nextEscape < 0 ? text.length : nextEscape;
    const plain = text.slice(index, end);
    for (const segment of segmenter.segment(plain)) {
      units.push({ value: segment.segment, visible: segment.segment !== "\n" && segment.segment !== "\r" });
    }
    index = end;
  }
  return units;
}

function countVisibleGraphemes(text: string): number {
  return splitTerminalUnits(text).reduce((total, unit) => total + (unit.visible ? 1 : 0), 0);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
