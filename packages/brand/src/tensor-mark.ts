/// Terminal rendering of the iOS "living tensor mark" (AppIntro.swift).
/// The mark is a stack of five transformer sheets whose parameter dashes
/// carry a scan pulse, then attention signal, before settling. Terminals
/// are too coarse to simulate it pixel-for-pixel, so the renderer keeps the
/// iOS timeline mathematics exactly and quantizes the geometry onto the
/// character grid: one dash per layer and context band, sheet frames in box
/// glyphs, and the attention bend expressed as rows shifting toward focus.

import { type Painter } from "./index.ts";

export const TENSOR_MARK_COLS = 29;
export const TENSOR_MARK_ROWS = 11;
/// Matches AppMotion.launchAnimationEnd: the last timeline event of the intro.
export const TENSOR_INTRO_END_S = 3.2;

const LAYER_COUNT = 10;
const BAND_COUNT = 5;
const SHEET_COUNT = 5;
/// Interior cells: dashes sit on even columns, context rules on odd ones.
const INTERIOR_COLS = LAYER_COUNT * 2 - 1;
const SHEET_COLS = INTERIOR_COLS + 2;
const SHEET_ROWS = BAND_COUNT + 2;
const SHEET_SHIFT_X = 2;
const SHEET_SHIFT_Y = 1;

const NEUTRAL_DARK: readonly [number, number, number] = [255, 255, 255];
const NEUTRAL_LIGHT: readonly [number, number, number] = [17, 16, 20];
/// AppColor.activeElectric: electricBright on dark canvases, electric on light.
const ELECTRIC_DARK: readonly [number, number, number] = [0x8c, 0xa3, 0xff];
const ELECTRIC_LIGHT: readonly [number, number, number] = [0x38, 0x57, 0xeb];
const SIGNAL: readonly [number, number, number] = [0xd6, 0x3d, 0x1f];

export function tensorCanvasBase(theme: "dark" | "light"): string {
  return theme === "light" ? "#EDE9E1" : "#15151A";
}

/// One full spinner revolution: brisk at the 80ms footer tick, and
/// intentionally independent of the slower beacon color cycle.
export const SPINNER_PERIOD_MS = 800;

export function easedProgress(elapsed: number, start: number, end: number): number {
  const progress = Math.min(Math.max((elapsed - start) / (end - start), 0), 1);
  return 1 - Math.pow(1 - progress, 3);
}

export function settlingProgress(elapsed: number, start: number, duration: number): number {
  const time = Math.min(Math.max((elapsed - start) / duration, 0), 1);
  const damping = 7.0;
  const value = 1 - (1 + damping * time) * Math.exp(-damping * time);
  const finalValue = 1 - (1 + damping) * Math.exp(-damping);
  return value / finalValue;
}

export function activationPulse(elapsed: number, center: number, halfDuration: number): number {
  const progress = Math.min(Math.max((elapsed - center + halfDuration) / (2 * halfDuration), 0), 1);
  const sine = Math.sin(Math.PI * progress);
  return sine * sine;
}

export function mixHex(a: string, b: string, t: number): string {
  const mix = Math.min(1, Math.max(0, t));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * mix);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * mix);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * mix);
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

interface MarkCell {
  glyph: string;
  hex: string;
  alpha: number;
}

interface ColorStamp {
  rgb: readonly [number, number, number];
  a: number;
}

/// Source-over compositing of ordered stamps, resolved against the canvas
/// base so faint marks read correctly on any terminal background. Display
/// alpha is gently boosted because character cells carry far less ink than
/// the iOS canvas strokes.
function stampHex(
  base: readonly [number, number, number],
  stamps: readonly ColorStamp[],
): { hex: string; alpha: number } | null {
  let alpha = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const stamp of stamps) {
    const a = Math.min(1, stamp.a);
    if (a <= 0.004) continue;
    const inverse = 1 - alpha;
    r = stamp.rgb[0] * a + r * inverse;
    g = stamp.rgb[1] * a + g * inverse;
    b = stamp.rgb[2] * a + b * inverse;
    alpha = a + alpha * inverse;
  }
  if (alpha <= 0.02) return null;
  const display = Math.min(1, alpha * 1.6);
  const colorR = r / alpha;
  const colorG = g / alpha;
  const colorB = b / alpha;
  const mixedR = Math.round(base[0] + (colorR - base[0]) * display);
  const mixedG = Math.round(base[1] + (colorG - base[1]) * display);
  const mixedB = Math.round(base[2] + (colorB - base[2]) * display);
  return {
    hex: `#${((1 << 24) + (mixedR << 16) + (mixedG << 8) + mixedB).toString(16).slice(1)}`,
    alpha,
  };
}

function weightMagnitude(sheet: number, layer: number, band: number): number {
  const row = band * 3 + 1;
  const weight = Math.sin(0.73 * (layer + 1) + 0.47 * (row + 1) + 0.91 * sheet)
    * Math.cos(0.31 * (layer - row) + 0.53 * sheet);
  return Math.abs(weight);
}

/// Evaluates one frame of the tensor mark timeline and lays it out as
/// TENSOR_MARK_ROWS lines of exactly TENSOR_MARK_COLS cells each.
export function renderTensorMark(elapsedSeconds: number, painter: Painter): string[] {
  const elapsed = Math.max(0, elapsedSeconds);
  const dark = painter.theme !== "light";
  const neutral = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const electric = dark ? ELECTRIC_DARK : ELECTRIC_LIGHT;
  const base = parseHex(tensorCanvasBase(painter.theme));

  const settledAttention = easedProgress(elapsed, 1.84, 2.24);
  const grid: Array<Array<MarkCell | null>> = Array.from(
    { length: TENSOR_MARK_ROWS },
    () => new Array<MarkCell | null>(TENSOR_MARK_COLS).fill(null),
  );

  const placeCell = (row: number, col: number, cell: MarkCell | null): void => {
    if (row < 0 || row >= TENSOR_MARK_ROWS || col < 0 || col >= TENSOR_MARK_COLS) return;
    grid[row]![col] = cell;
  };

  for (let sheet = SHEET_COUNT - 1; sheet >= 0; sheet--) {
    const depth = sheet / (SHEET_COUNT - 1);
    const sheetReveal = easedProgress(elapsed, 0.02 + sheet * 0.05, 0.32 + sheet * 0.05);
    const sheetOpacity = (0.48 + 0.52 * (1 - depth)) * sheetReveal;
    const left = sheet * SHEET_SHIFT_X;
    const top = (SHEET_COUNT - 1 - sheet) * SHEET_SHIFT_Y;

    for (let row = 0; row < SHEET_ROWS; row++) {
      for (let col = 0; col < SHEET_COLS; col++) {
        placeCell(top + row, left + col, null);
      }
    }
    if (sheetOpacity <= 0.02) continue;

    const depthResponse = activationPulse(elapsed, 1.22 + sheet * 0.055, 0.36);
    const frameColor = stampHex(base, [{ rgb: neutral, a: (0.26 + 0.05 * depthResponse) * sheetOpacity * 0.65 }]);
    if (frameColor) {
      const frameCell = (glyph: string): MarkCell => ({ glyph, hex: frameColor.hex, alpha: frameColor.alpha });
      for (let col = 1; col < SHEET_COLS - 1; col++) {
        placeCell(top, left + col, frameCell("─"));
        placeCell(top + SHEET_ROWS - 1, left + col, frameCell("─"));
      }
      for (let row = 1; row < SHEET_ROWS - 1; row++) {
        placeCell(top + row, left, frameCell("│"));
        placeCell(top + row, left + SHEET_COLS - 1, frameCell("│"));
      }
      placeCell(top, left, frameCell("┌"));
      placeCell(top, left + SHEET_COLS - 1, frameCell("┐"));
      placeCell(top + SHEET_ROWS - 1, left, frameCell("└"));
      placeCell(top + SHEET_ROWS - 1, left + SHEET_COLS - 1, frameCell("┘"));
    }

    const contextColor = stampHex(base, [{ rgb: neutral, a: 0.12 * sheetOpacity }]);

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const activation = activationPulse(elapsed, 0.88 + layer * 0.10 + sheet * 0.012, 0.18);
      const focus = 2 + 1.55 * Math.sin((2 * Math.PI * layer) / 9);
      const focusY = 0.303 + focus * 0.096;
      const encodedProgress = easedProgress(
        elapsed,
        0.88 + layer * 0.10 + sheet * 0.012,
        1.24 + layer * 0.10 + sheet * 0.012,
      );
      const parameterDelay = layer * 0.038 + 0.008 + sheet * 0.012;
      const parameterReveal = easedProgress(elapsed, 0.08 + parameterDelay, 0.28 + parameterDelay);
      const scanPulse = activationPulse(elapsed, 0.21 + parameterDelay, 0.13);

      for (let band = 0; band < BAND_COUNT; band++) {
        const bandCenter = 0.303 + band * 0.096;
        const bend = Math.round(0.28 * activation * (focusY - bandCenter) / 0.096);
        const row = Math.min(BAND_COUNT - 1, Math.max(0, band + bend));
        const magnitude = weightMagnitude(sheet, layer, band);

        const receivedAttention = Math.max(0, 1 - Math.abs(band - focus));
        const activeStrength = activation * (0.22 + 0.78 * receivedAttention);
        const settledStrength = settledAttention * 0.46 * receivedAttention;
        const signalStrength = Math.max(activeStrength, settledStrength) * sheetOpacity;

        const scanStrength = scanPulse * (0.12 + 0.24 * magnitude) * sheetOpacity;
        const encodedStrength = encodedProgress * (0.08 + 0.20 * magnitude) * sheetOpacity;
        const emphasis = Math.max(scanStrength, encodedStrength, signalStrength);
        const stamps: ColorStamp[] = [{
          rgb: neutral,
          a: (0.14 + 0.22 * magnitude) * sheetOpacity * parameterReveal * (1 - 0.7 * emphasis),
        }];
        if (scanStrength > 0.01) stamps.push({ rgb: electric, a: scanStrength });
        if (encodedStrength > 0.01) stamps.push({ rgb: electric, a: encodedStrength });
        if (signalStrength > 0.01) stamps.push({ rgb: SIGNAL, a: signalStrength });

        const color = stampHex(base, stamps);
        if (color) {
          if (signalStrength > 0.05) {
            color.hex = mixHex(color.hex, "#d63d1f", signalStrength * 0.55);
          }
          const lit = signalStrength > 0.12;
          const glyph = lit || magnitude >= 0.5 ? "━" : "─";
          placeCell(top + 1 + row, left + 1 + layer * 2, { glyph, hex: color.hex, alpha: color.alpha });
        }

        if (layer < LAYER_COUNT - 1 && contextColor) {
          placeCell(top + 1 + row, left + 2 + layer * 2, {
            glyph: "─",
            hex: contextColor.hex,
            alpha: contextColor.alpha,
          });
        }
      }
    }
  }

  const lines: string[] = [];
  for (const gridRow of grid) {
    if (!painter.enabled) {
      let line = "";
      for (const cell of gridRow) {
        const alpha = cell ? Math.min(1, cell.alpha * 1.6) : 0;
        line += ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(alpha * ASCII_RAMP.length))]!;
      }
      lines.push(line);
      continue;
    }
    let line = "";
    for (const cell of gridRow) {
      if (!cell) {
        line += " ";
        continue;
      }
      line += `\x1b[38;2;${rgbComponents(cell.hex)}m${cell.glyph}\x1b[0m`;
    }
    lines.push(line);
  }
  return lines;
}

const ASCII_RAMP = " .,:~+#" as const;

function rgbComponents(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}
