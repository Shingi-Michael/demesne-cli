import {
  easedProgress,
  mixHex,
  renderTensorMark,
  settlingProgress,
  tensorCanvasBase,
  visibleLength,
  TENSOR_INTRO_END_S,
  TENSOR_MARK_COLS,
  type Painter,
} from "@demesne/brand";
import { lightTerminalPalette, terminalPalette } from "@demesne/brand";
import { emitKeypressEvents } from "node:readline";
import { reducedMotionEnabled } from "./motion.ts";

const PLAYBACK_SPEED = 1.6;
const HOLD_SECONDS = 0.5;
const FRAME_MILLISECONDS = 33;
const SKIPPED_HOLD_MILLISECONDS = 180;
const WORDMARK = "D E M E S N E";
const TAGLINE = "YOUR MODEL. ON YOUR HARDWARE.";
const STUDIO = "PREPPRO LABS";
const BAR_COLORS_DARK = ["#8CA3FF", "#D63D1F", "#B8DB47"] as const;
const BAR_COLORS_LIGHT = ["#3857EB", "#D63D1F", "#B8DB47"] as const;

function center(line: string, cols: number): string {
  const pad = Math.max(0, Math.floor((cols - visibleLength(line)) / 2));
  return `${" ".repeat(pad)}${line}`;
}

/// Pure composer for the full intro screen at a point on the timeline.
/// Returns rows - 1 lines so the cursor never reaches the final row.
export function composeIntroFrame(
  elapsedSeconds: number,
  rows: number,
  cols: number,
  painter: Painter,
): string[] {
  const elapsed = Math.max(0, elapsedSeconds);
  const dark = painter.theme !== "light";
  const baseHex = tensorCanvasBase(dark ? "dark" : "light");
  const secondaryHex = (dark ? terminalPalette : lightTerminalPalette).secondary;
  const barColors = dark ? BAR_COLORS_DARK : BAR_COLORS_LIGHT;

  const markLines = renderTensorMark(elapsed, painter);
  const markLeft = Math.max(0, Math.floor((cols - TENSOR_MARK_COLS) / 2));
  const markIndent = " ".repeat(markLeft);

  const titleProgress = easedProgress(elapsed, 0.26, 0.70);
  const revealed = WORDMARK.slice(0, Math.round(titleProgress * WORDMARK.length));
  const wordmarkLine = revealed
    ? center(painter.enabled ? painter.bold(revealed, "paper") : revealed, cols)
    : "";

  const taglineProgress = easedProgress(elapsed, 2.32, 2.72);
  let taglineLine = "";
  if (taglineProgress > 0.01) {
    const tagline = painter.enabled
      ? `\x1b[38;2;${rgbComponents(mixHex(baseHex, secondaryHex, taglineProgress))}m${TAGLINE}\x1b[0m`
      : TAGLINE;
    taglineLine = center(tagline, cols);
  }

  const barGlyphs = barColors.map((color, index) => {
    const progress = settlingProgress(elapsed, 2.70 + index * 0.08, 0.42);
    if (progress < 0.5) return " ";
    return painter.enabled ? `\x1b[38;2;${rgbComponents(color)}m▮\x1b[0m` : "▮";
  }).join("");
  const footerProgress = easedProgress(elapsed, 2.82, 3.20);
  const studio = footerProgress > 0.01
    ? painter.enabled
      ? `\x1b[38;2;${rgbComponents(mixHex(baseHex, secondaryHex, footerProgress))}m${STUDIO}\x1b[0m`
      : STUDIO
    : "";
  const footerLine = `  ${barGlyphs}${studio ? ` ${studio}` : ""}`;

  const contentRows = markLines.length + 3;
  const topPad = Math.max(0, Math.floor((rows - contentRows - 2) * 0.38));
  const midPad = Math.max(1, rows - 1 - topPad - contentRows - 1);

  const lines: string[] = [];
  for (let index = 0; index < topPad; index++) lines.push("");
  for (const line of markLines) lines.push(`${markIndent}${line}`);
  lines.push("");
  lines.push(wordmarkLine);
  lines.push(taglineLine);
  for (let index = 0; index < midPad; index++) lines.push("");
  lines.push(footerLine);
  return lines.slice(0, Math.max(0, rows - 1));
}

function rgbComponents(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}

function introAllowed(environment: Record<string, string | undefined>): boolean {
  const disabled = environment.DEMESNE_NO_INTRO?.toLowerCase();
  return !(disabled === "1" || disabled === "true");
}

/// Plays the launch intro once on an interactive TTY. Any keypress skips to
/// the settled frame. Reduced motion renders the settled frame only.
export async function playTensorIntro(
  painter: Painter,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) return;
  if (!introAllowed(environment)) return;
  let rows = output.rows ?? 24;
  let cols = output.columns ?? 80;
  if (rows < 24 || cols < TENSOR_MARK_COLS + 8) return;

  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let skipped = false;
  const onKeypress = () => {
    skipped = true;
  };
  input.on("keypress", onKeypress);
  output.write("\x1b[?25l\x1b[?7l\x1b[2J\x1b[H");

  try {
    if (reducedMotionEnabled(environment)) {
      output.write(composeIntroFrame(TENSOR_INTRO_END_S, rows, cols, painter).join("\r\n"));
      await Bun.sleep(200);
      return;
    }

    const startedAt = Date.now();
    while (true) {
      rows = output.rows ?? rows;
      cols = output.columns ?? cols;
      const wallSeconds = (Date.now() - startedAt) / 1_000;
      const elapsed = skipped
        ? TENSOR_INTRO_END_S
        : Math.min(wallSeconds * PLAYBACK_SPEED, TENSOR_INTRO_END_S);
      output.write(`\x1b[H${composeIntroFrame(elapsed, rows, cols, painter).join("\r\n")}`);
      if (skipped) {
        await Bun.sleep(SKIPPED_HOLD_MILLISECONDS);
        return;
      }
      if (wallSeconds * PLAYBACK_SPEED >= TENSOR_INTRO_END_S + HOLD_SECONDS) return;
      await Bun.sleep(FRAME_MILLISECONDS);
    }
  } finally {
    output.write("\x1b[0m\x1b[2J\x1b[H\x1b[?7h\x1b[?25h");
    input.removeListener("keypress", onKeypress);
    input.setRawMode(Boolean(wasRaw));
    input.pause();
  }
}
