/// Raw truecolor helpers for the workbench's neon identity.
///
/// The painter API only accepts named palette roles, so gradients and glows
/// use these functions directly. All values align exactly with the brand
/// package's `neonTerminalPalette`.

export const NEON = {
  base: "#0A0C14",
  surface: "#0F1220",
  panel: "#11141F",
  raised: "#161A2B",
  rule: "#2A3250",
  dim: "#7C86A6",
  text: "#E8ECF8",
  cyan: "#58C6FF",
  violet: "#8F7BFF",
  mint: "#3DF0B0",
  amber: "#FFB454",
  red: "#FF5C7A",
} as const;

function hexParts(color: string): [number, number, number] {
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
}

/// Linear blend between two hex colors.
export function mixColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexParts(a);
  const [r2, g2, b2] = hexParts(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
  return `#${[f(r1, r2), f(g1, g2), f(b1, b2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function rgb(text: string, color: string): string {
  const [r, g, b] = hexParts(color);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function brgb(text: string, color: string): string {
  const [r, g, b] = hexParts(color);
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function fgCode(color: string): string {
  const [r, g, b] = hexParts(color);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bgCode(color: string): string {
  const [r, g, b] = hexParts(color);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export const RESET = "\x1b[0m";

/// Gradient text: each character steps between two colors.
export function gradientText(value: string, from: string, to: string): string {
  const characters = [...value];
  if (characters.length === 1) return rgb(value, from);
  return characters
    .map((character, index) => rgb(character, mixColor(from, to, index / (characters.length - 1))))
    .join("");
}

/// A horizontal gradient run of the given glyph, used for panel edges.
export function gradientRule(glyph: string, from: string, to: string, steps: number): string {
  const count = Math.max(1, steps);
  let value = "";
  for (let index = 0; index < count; index++) {
    value += rgb(glyph, mixColor(from, to, count === 1 ? 0 : index / (count - 1)));
  }
  return value;
}