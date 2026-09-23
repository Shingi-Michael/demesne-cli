import { truncateText, visibleLength, type Painter, type PaletteColor } from "@demesne/brand";

/// Paint a terminal region, restoring base colors after nested ANSI resets.
export function surface(text: string, width: number, paint: Painter, background: PaletteColor = "surface"): string {
  const content = truncateText(text, Math.max(0, width));
  const padded = content + " ".repeat(Math.max(0, width - visibleLength(content)));
  if (!paint.enabled) return padded;
  const rgb = (hex: string) => `${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
  const base = `\x1b[48;2;${rgb(paint.colors[background])}m\x1b[38;2;${rgb(paint.colors.paper)}m`;
  return base + padded.replace(/\x1b\[(?:0|39|49)?m/g, (reset) => reset + base) + "\x1b[0m";
}
