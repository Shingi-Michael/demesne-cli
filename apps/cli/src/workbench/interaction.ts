import type { Painter, PaletteColor } from "@demesne/brand";

export const INTERACTION_MS = 160;

/// Fixed cells pulse in amber without moving text or the reading anchor.
export function thinkingDots(paint: Painter, now: number, reduced = false): string {
  return [0, 1, 2].map((index) => tint(paint, "·", "surface", "electric",
    reduced || !paint.enabled ? 1 : 0.4 + 0.6 * (1 - Math.cos((now - index * 180) / 1400 * Math.PI * 2)) / 2)).join("");
}

export function thinkingCursor(paint: Painter, now: number, reduced = false): string {
  return paint.text(reduced || !paint.enabled || Math.floor(now / 550) % 2 === 0 ? "▌" : " ", "electric");
}

/// Cell geometry stays fixed during transitions; only the foreground changes.
export function tint(paint: Painter, text: string, from: PaletteColor, to: PaletteColor, amount: number): string {
  if (!paint.enabled) return text;
  const t = Math.max(0, Math.min(1, amount));
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(paint.colors[from].slice(offset, offset + 2), 16);
    const b = parseInt(paint.colors[to].slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * t);
  });
  return `\x1b[38;2;${channels.join(";")}m${text}\x1b[39m`;
}

export function clockLabel(at: number | string | undefined): string {
  const date = new Date(at ?? NaN);
  if (!Number.isFinite(date.getTime())) return "--:--:--";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

export function transitionValue(from: number, to: number, started: number, now: number): number {
  const t = Math.max(0, Math.min(1, (now - started) / INTERACTION_MS));
  return from + (to - from) * (1 - (1 - t) ** 3);
}

export class InteractionTransitions {
  private values = new Map<string, { from: number; to: number; started: number }>();
  clear(): void { this.values.clear(); }
  set(key: string, to: number, fallback: number, now: number): void {
    this.values.set(key, { from: this.value(key, fallback, now), to, started: now });
  }
  value(key: string, fallback: number, now: number, reduced = false): number {
    const value = this.values.get(key);
    return value ? reduced ? value.to : transitionValue(value.from, value.to, value.started, now) : fallback;
  }
  active(now: number): boolean {
    return [...this.values.values()].some((value) => value.from !== value.to && now < value.started + INTERACTION_MS);
  }
}
