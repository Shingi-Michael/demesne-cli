export interface InterruptKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export interface InterruptKeyState {
  lastEscapeAt: number;
  interrupt: boolean;
}

export function reduceInterruptKey(
  lastEscapeAt: number,
  key: InterruptKey,
  now: number,
): InterruptKeyState {
  if (key.ctrl && key.name === "c") return { lastEscapeAt: 0, interrupt: true };
  if (key.name !== "escape" || key.meta) return { lastEscapeAt: 0, interrupt: false };
  if (lastEscapeAt > 0 && now - lastEscapeAt <= 1_500) return { lastEscapeAt: 0, interrupt: true };
  return { lastEscapeAt: now, interrupt: false };
}
