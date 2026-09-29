import { sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import { sliceAnsi } from "bun";
import { stripVTControlCharacters } from "node:util";
import { Canvas } from "./canvas.ts";

export interface DriveFeedback {
  label: string;
  target?: { row: number; column: number; width: number };
}

/** A real action target and a short header receipt, drawn over the native frame.
 * The driver removes these annotations before taking its next observation. */
export function drawDriveFeedback(rows: string[], width: number, bannerWidth: number, paint: Painter, feedback: DriveFeedback): string[] {
  const canvas = new Canvas(width, rows.length, paint);
  rows.forEach((row, index) => canvas.put(index, 0, row, width));
  const label = truncateText(`▷ DRIVE · ${sanitizeTerminalLine(feedback.label)}`, Math.max(1, bannerWidth - 4));
  canvas.put(0, 1, paint.bold(` ${label} `, "electric"), Math.min(bannerWidth - 2, visibleLength(label) + 2), "accentSurface");
  const target = feedback.target;
  if (target && target.row > 0 && target.row < rows.length && target.column >= 0 && target.column < width) {
    const size = Math.min(target.width, width - target.column);
    const text = stripVTControlCharacters(sliceAnsi(rows[target.row]!, target.column, target.column + size));
    canvas.put(target.row, target.column, paint.bold(text, "electric"), size, "accentSurface");
    // This cursor marks the actual hit target; it never moves the OS pointer.
    const pointer = target.column >= 2 ? target.column - 2 : target.column + size + 1;
    if (pointer < width) canvas.put(target.row, pointer, paint.bold("▷", "electric"), 1, "accentSurface");
  }
  return canvas.rows;
}

/** Bounded, grapheme-safe entry so long prompts don't create minutes of typing. */
export function driveTypingChunks(text: string): string[] {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((item) => item.segment);
  const size = Math.max(4, Math.ceil(graphemes.length / 30));
  const chunks: string[] = [];
  for (let index = 0; index < graphemes.length; index += size) chunks.push(graphemes.slice(index, index + size).join(""));
  return chunks;
}

export function waitForDriveFrame(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
