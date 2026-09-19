export interface InterruptKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  /// The raw bytes the keypress parser read. A terminal coalesces rapid Escape
  /// presses into one read, so this is the only place the second press is
  /// visible.
  sequence?: string;
}

export interface InterruptKeyState {
  lastEscapeAt: number;
  interrupt: boolean;
}

/// How many Escape presses a keypress represents.
///
/// Two quick presses do not arrive as two events. The terminal buffers them and
/// the keypress parser reports a single escape with `meta: true` and a sequence
/// of two ESC bytes, so counting the bytes is the only reliable way to see the
/// second press.
export function escapePresses(key: InterruptKey): number {
  if (key.name !== "escape") return 0;
  const sequence = key.sequence ?? "";
  let count = 0;
  for (const character of sequence) {
    if (character === "\x1b") count += 1;
  }
  return Math.max(1, count);
}

export function reduceInterruptKey(
  lastEscapeAt: number,
  key: InterruptKey,
  now: number,
): InterruptKeyState {
  if (key.ctrl && key.name === "c") return { lastEscapeAt: 0, interrupt: true };
  if (key.name !== "escape") return { lastEscapeAt: 0, interrupt: false };
  // Both escapes arrived in one read: interrupt immediately.
  if (escapePresses(key) >= 2) return { lastEscapeAt: 0, interrupt: true };
  if (lastEscapeAt > 0 && now - lastEscapeAt <= 1_500) return { lastEscapeAt: 0, interrupt: true };
  return { lastEscapeAt: now, interrupt: false };
}
