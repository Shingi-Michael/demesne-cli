/// Demesne's terminal identity: the canonical "private domain" palette,
/// the quiet motion vocabulary, and the shared card grammar.
///
/// Color roles (blueprint §8.2): electric marks authorship and primary
/// actions, signal marks boundaries and errors, citron marks verified and
/// local state, paper on ink is the canvas pair.

import { sliceAnsi, stringWidth } from "bun";
import { highlightCode as highlightCodeWithLanguage, type CodeHighlightState } from "./highlight.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const palette = {
  ink: "#111014",
  paper: "#F7F3EA",
  surface: "#181820",
  raised: "#21212B",
  rule: "#3B3B3F",
  secondary: "#AAA7A0",
  electric: "#3857EB",
  electricBright: "#8CA3FF",
  signal: "#D63D1F",
  citron: "#B8DB47",
} as const;

export type PaletteColor = keyof typeof palette;

// Terminal color occupies less visual space than the iOS surfaces, so the CLI
// uses lower-chroma accents while retaining the canonical palette above.
export const terminalPalette: Record<PaletteColor, string> = {
  ink: "#111014",
  paper: "#F7F3EA",
  surface: "#1A1A20",
  raised: "#23232A",
  rule: "#56545B",
  secondary: "#918E88",
  electric: "#6678C8",
  electricBright: "#8493D0",
  signal: "#C16B59",
  citron: "#96A865",
};

export const lightTerminalPalette: Record<PaletteColor, string> = {
  ink: "#111014",
  paper: "#27242A",
  surface: "#EEEAE2",
  raised: "#E4E0D8",
  rule: "#77727B",
  secondary: "#625E63",
  electric: "#4057B5",
  electricBright: "#314AAE",
  signal: "#A9422F",
  citron: "#5F741E",
};

export type TerminalTheme = "dark" | "light";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}

function ansiPalette(source: Record<PaletteColor, string>, mode: "38" | "48"): Record<PaletteColor, string> {
  return Object.fromEntries(
    Object.entries(source).map(([name, hex]) => [name, `\x1b[${mode};2;${rgb(hex)}m`]),
  ) as Record<PaletteColor, string>;
}

export interface Painter {
  readonly enabled: boolean;
  readonly theme: TerminalTheme;
  text(value: string, color?: PaletteColor): string;
  bold(value: string, color?: PaletteColor): string;
  dim(value: string): string;
  italic(value: string, color?: PaletteColor): string;
  underline(value: string, color?: PaletteColor): string;
  onBackground(value: string, color: PaletteColor): string;
  chip(label: string, color: PaletteColor): string;
}

export function createPainter(enabled: boolean, theme: TerminalTheme = "dark"): Painter {
  if (!enabled) {
    return {
      enabled,
      theme,
      text: (value) => value,
      bold: (value) => value,
      dim: (value) => value,
      italic: (value) => value,
      underline: (value) => value,
      onBackground: (value) => value,
      chip: (label) => `[${label}]`,
    };
  }
  const source = theme === "light" ? lightTerminalPalette : terminalPalette;
  const fg = ansiPalette(source, "38");
  const bg = ansiPalette(source, "48");
  return {
    enabled,
    theme,
    text: (value, color) => (color && color !== "paper" ? `${fg[color]}${value}${RESET}` : value),
    bold: (value, color) => (color && color !== "paper" ? `${BOLD}${fg[color]}${value}${RESET}` : `${BOLD}${value}${RESET}`),
    dim: (value) => `${DIM}${value}${RESET}`,
    italic: (value, color) => (color && color !== "paper" ? `${ITALIC}${fg[color]}${value}${RESET}` : `${ITALIC}${value}${RESET}`),
    underline: (value, color) => (color && color !== "paper" ? `${UNDERLINE}${fg[color]}${value}${RESET}` : `${UNDERLINE}${value}${RESET}`),
    onBackground: (value, color) => `${bg[color]}${value}${RESET}`,
    chip: (label, color) => `${bg[color]}${fg.ink}${BOLD} ${label} ${RESET}`,
  };
}

export function resolveTerminalTheme(
  configured: string | undefined,
  colorForegroundBackground: string | undefined,
): TerminalTheme {
  if (configured === "light" || configured === "dark") return configured;
  const background = Number(colorForegroundBackground?.split(";").at(-1));
  return Number.isFinite(background) && background >= 7 ? "light" : "dark";
}

export type SlashCommandId = "new" | "sessions" | "resume" | "status" | "context" | "undo" | "clear" | "help" | "exit";
export type SlashCommandArgument = "none" | "optional" | "required";
export type SlashCommandSection = "session" | "inspect" | "control";

export interface SlashCommand {
  id: SlashCommandId;
  name: `/${string}`;
  aliases: readonly `/${string}`[];
  argument: SlashCommandArgument;
  argumentLabel?: string;
  description: string;
  section: SlashCommandSection;
}

export interface SlashCommandInvocation {
  command: SlashCommand;
  argument: string;
  matchedName: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "new", name: "/new", aliases: [], argument: "optional", argumentLabel: "title", description: "Start a fresh session", section: "session" },
  { id: "sessions", name: "/sessions", aliases: [], argument: "none", description: "Browse recent sessions", section: "session" },
  { id: "resume", name: "/resume", aliases: ["/switch"], argument: "required", argumentLabel: "id", description: "Switch to a session", section: "session" },
  { id: "status", name: "/status", aliases: [], argument: "none", description: "Show session and runtime status", section: "inspect" },
  { id: "context", name: "/context", aliases: [], argument: "none", description: "Show context and run details", section: "inspect" },
  { id: "undo", name: "/undo", aliases: [], argument: "none", description: "Revert last turn's changes", section: "control" },
  { id: "clear", name: "/clear", aliases: [], argument: "none", description: "Refresh the current view", section: "control" },
  { id: "help", name: "/help", aliases: [], argument: "none", description: "Show command help", section: "control" },
  { id: "exit", name: "/exit", aliases: ["/quit", "/leave"], argument: "none", description: "Exit Demesne", section: "control" },
] as const;

export function slashCommandUsage(command: SlashCommand): string {
  if (command.argument === "none") return command.name;
  const label = command.argumentLabel ?? "value";
  return `${command.name} ${command.argument === "required" ? `<${label}>` : `[${label}]`}`;
}

export function slashCommandCompletion(command: SlashCommand): string {
  return command.argument === "none" ? command.name : `${command.name} `;
}

export function slashCommandMatches(value: string): SlashCommand[] {
  const query = value.trimStart().toLowerCase();
  if (!query.startsWith("/") || /\s/.test(query)) return [];
  return SLASH_COMMANDS.filter((command) =>
    command.name.toLowerCase().startsWith(query) || command.aliases.some((alias) => alias.startsWith(query))
  );
}

export function resolveSlashCommand(value: string): SlashCommandInvocation | null {
  const input = value.trim();
  if (!input.startsWith("/")) return null;
  const separator = input.search(/\s/);
  const matchedName = (separator === -1 ? input : input.slice(0, separator)).toLowerCase();
  const command = SLASH_COMMANDS.find((candidate) =>
    candidate.name === matchedName || candidate.aliases.includes(matchedName as `/${string}`)
  );
  if (!command) return null;
  return {
    command,
    argument: separator === -1 ? "" : input.slice(separator).trim(),
    matchedName,
  };
}

export function slashCommandValidationError(invocation: SlashCommandInvocation): string | null {
  if (invocation.command.argument === "required" && !invocation.argument) {
    return `Usage: ${slashCommandUsage(invocation.command)}`;
  }
  if (invocation.command.argument === "none" && invocation.argument) {
    return `Usage: ${slashCommandUsage(invocation.command)}`;
  }
  return null;
}

export function formatSlashCommandMenu(
  commands: readonly SlashCommand[],
  selectedIndex: number,
  width = 80,
  painter: Painter = createPainter(true),
): string {
  const available = Math.max(18, width - 4);
  const usages = commands.map(slashCommandUsage);
  const labelWidth = Math.min(18, Math.max(...usages.map((usage) => usage.length), 0));
  const showSections = commands.length >= 6;
  const lines: string[] = [];
  let currentSection: SlashCommandSection | null = null;
  commands.forEach((command, index) => {
    if (showSections && command.section !== currentSection) {
      currentSection = command.section;
      if (lines.length > 0) lines.push("");
      lines.push(`    ${painter.bold(command.section.toUpperCase(), "secondary")}`);
    }
    const marker = index === selectedIndex ? painter.bold("›", "electric") : " ";
    const usage = usages[index]!;
    const label = index === selectedIndex
      ? painter.bold(usage.padEnd(labelWidth), "paper")
      : painter.text(usage.padEnd(labelWidth), "secondary");
    const description = painter.dim(truncateText(command.description, available - labelWidth - 3));
    lines.push(`  ${marker} ${label} ${description}`);
  });
  return lines.join("\n");
}

/// Formats the `@` file-mention menu. Paths are workspace-relative and the
/// selected entry is emphasized; the caller caps the list.
export function formatMentionMenu(
  files: readonly string[],
  selectedIndex: number,
  width = 80,
  painter: Painter = createPainter(true),
): string {
  const available = Math.max(18, width - 6);
  return files.map((file, index) => {
    const marker = index === selectedIndex ? painter.bold("›", "electric") : " ";
    const label = truncateText(sanitizeTerminalLine(file), available);
    const styled = index === selectedIndex
      ? painter.bold(label, "paper")
      : painter.text(label, "secondary");
    return `  ${marker} ${styled}`;
  }).join("\n");
}

/// Strips ANSI codes to compute visual string length.
export function visibleLength(str: string): number {
  return stringWidth(str);
}

export function padVisibleEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function sanitizeTerminalLine(value: string): string {
  return sanitizeTerminalText(value).replace(/[\n\t]+/g, " ");
}

/// Truncates text with an ellipsis if it exceeds the maximum visible length.
export function truncateText(str: string, maxLen: number): string {
  if (visibleLength(str) <= maxLen) return str;
  if (maxLen <= 0) return "";
  return sliceAnsi(str, 0, maxLen, { ellipsis: "…" });
}

export function formatFooterLine(left: string, right: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (!left) {
    const text = truncateText(right, safeWidth);
    return `${" ".repeat(Math.max(0, safeWidth - visibleLength(text)))}${text}`;
  }
  if (!right) {
    const text = truncateText(left, safeWidth);
    return `${text}${" ".repeat(Math.max(0, safeWidth - visibleLength(text)))}`;
  }

  const preferredLeft = Math.min(visibleLength(left), Math.max(8, Math.floor(safeWidth * 0.42)));
  const rightText = truncateText(right, Math.max(1, safeWidth - preferredLeft - 1));
  const leftText = truncateText(left, Math.max(1, safeWidth - visibleLength(rightText) - 1));
  const gap = Math.max(1, safeWidth - visibleLength(leftText) - visibleLength(rightText));
  return `${leftText}${" ".repeat(gap)}${rightText}`;
}

export function wrapDisplayText(value: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  if (!value) return [""];
  const words = value.trim().split(/\s+/).flatMap((word) => {
    return visibleLength(word) <= maxWidth ? [word] : splitDisplayCells(word, maxWidth);
  });
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (visibleLength(current) + 1 + visibleLength(word) <= maxWidth) current += ` ${word}`;
    else {
      rows.push(current);
      current = word;
    }
  }
  if (current) rows.push(current);
  return rows.length > 0 ? rows : [""];
}

function splitDisplayCells(value: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const item of graphemeSegmenter.segment(value)) {
    const segmentWidth = visibleLength(item.segment);
    if (current && currentWidth + segmentWidth > maxWidth) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += item.segment;
    currentWidth += segmentWidth;
  }
  if (current || rows.length === 0) rows.push(current);
  return rows;
}

export interface PromptLineInfo {
  text: string;
  start: number;
  end: number;
}

export function wrapPromptParagraph(para: string, paraStart: number, width: number): PromptLineInfo[] {
  if (para.length === 0) {
    return [{ text: "", start: paraStart, end: paraStart }];
  }
  const maxWidth = Math.max(1, width);
  const lines: PromptLineInfo[] = [];
  let lineStart = 0;

  while (lineStart < para.length) {
    let columns = 0;
    let lineEnd = lineStart;
    let lastSpace = -1;
    let wrapped = false;
    for (const item of graphemeSegmenter.segment(para.slice(lineStart))) {
      const absoluteIndex = lineStart + item.index;
      const segmentWidth = visibleLength(item.segment);
      if (columns + segmentWidth > maxWidth && lineEnd > lineStart) {
        const end = lastSpace > lineStart ? lastSpace : lineEnd;
        const next = lastSpace > lineStart ? lastSpace + 1 : lineEnd;
        lines.push({
          text: para.slice(lineStart, end),
          start: paraStart + lineStart,
          end: paraStart + end,
        });
        lineStart = next;
        wrapped = true;
        break;
      }
      columns += segmentWidth;
      lineEnd = absoluteIndex + item.segment.length;
      if (item.segment === " ") lastSpace = absoluteIndex;
    }
    if (!wrapped) {
      lines.push({
        text: para.slice(lineStart),
        start: paraStart + lineStart,
        end: paraStart + para.length,
      });
      break;
    }
  }

  return lines;
}

export function computePromptVisualLines(
  value: string,
  cursor: number,
  maxWidth: number,
): {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  lineInfos: PromptLineInfo[];
} {
  const width = Math.max(1, maxWidth);
  const rawParas = value.split("\n");
  const allLines: PromptLineInfo[] = [];
  let globalOffset = 0;

  for (let i = 0; i < rawParas.length; i++) {
    const para = rawParas[i]!;
    const paraLines = wrapPromptParagraph(para, globalOffset, width);
    allLines.push(...paraLines);
    globalOffset += para.length + 1;
  }

  if (allLines.length === 0) {
    allLines.push({ text: "", start: 0, end: 0 });
  }

  let cursorLine = 0;
  let cursorCol = 0;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!;
    const nextLine = allLines[i + 1];
    if (nextLine && cursor >= nextLine.start) {
      continue;
    }
    if (cursor >= line.start) {
      cursorLine = i;
      cursorCol = visibleLength(value.slice(line.start, Math.min(cursor, line.end)));
      break;
    }
  }

  return {
    lines: allLines.map((l) => l.text),
    cursorLine,
    cursorCol,
    lineInfos: allLines,
  };
}

export function textIndexAtVisualColumn(value: string, column: number): number {
  const target = Math.max(0, column);
  let width = 0;
  let end = 0;
  for (const item of graphemeSegmenter.segment(value)) {
    const nextWidth = width + visibleLength(item.segment);
    if (nextWidth > target) return item.index;
    width = nextWidth;
    end = item.index + item.segment.length;
  }
  return end;
}

export function previousGraphemeBoundary(value: string, index: number): number {
  let previous = 0;
  for (const item of graphemeSegmenter.segment(value)) {
    if (item.index >= index) break;
    previous = item.index;
  }
  return previous;
}

export function nextGraphemeBoundary(value: string, index: number): number {
  for (const item of graphemeSegmenter.segment(value)) {
    const boundary = item.index + item.segment.length;
    if (boundary > index) return boundary;
  }
  return value.length;
}

/// Solid vermilion bar shown while a boundary hold is pending.
export function holdStripe(width: number, painter: Painter = createPainter(true)): string {
  if (!painter.enabled || width <= 0) return "";
  return painter.onBackground(" ".repeat(Math.max(1, width)), "signal");
}

function quietRouteLine(width: number, painter: Painter): string {
  const safeWidth = Math.max(0, width);
  return painter.text("─".repeat(safeWidth), "rule");
}

// MARK: - iOS Dynamic Beacon Engine

export type BeaconActivity = "thinking" | "reasoning" | "tool" | "generating" | "loading";

type RGBTuple = [number, number, number];

function rgbTuple(hex: string): RGBTuple {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function beaconPalettes(source: Record<PaletteColor, string>): Record<BeaconActivity, RGBTuple[]> {
  const citron = rgbTuple(source.citron);
  const electric = rgbTuple(source.electric);
  const signal = rgbTuple(source.signal);
  return {
    reasoning: [citron, electric, signal],
    tool: [signal, citron, electric],
    loading: [citron, electric],
    thinking: [electric, signal, citron],
    generating: [electric, citron],
  };
}

/// The iOS beacon's state-driven color order, adapted to the quieter terminal palette.
export const BEACON_PALETTES = beaconPalettes(terminalPalette);
export const LIGHT_BEACON_PALETTES = beaconPalettes(lightTerminalPalette);

/// 2.1-second rotation cycle mirroring the iOS Dynamic Island beacon (ChatView.swift).
export const BEACON_PERIOD_MS = 2_100;

export function sampleBeaconRGB(
  phase: number,
  activity: BeaconActivity = "thinking",
  theme: TerminalTheme = "dark",
): RGBTuple {
  const stops = (theme === "light" ? LIGHT_BEACON_PALETTES : BEACON_PALETTES)[activity];
  const stopCount = stops.length;
  const wrapped = ((phase % 1.0) + 1.0) % 1.0;
  const scaled = wrapped * stopCount;
  const i1 = Math.floor(scaled) % stopCount;
  const i2 = (i1 + 1) % stopCount;
  const frac = scaled - Math.floor(scaled);

  const c1 = stops[i1]!;
  const c2 = stops[i2]!;

  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * frac),
    Math.round(c1[1] + (c2[1] - c1[1]) * frac),
    Math.round(c1[2] + (c2[2] - c1[2]) * frac),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export interface BeaconSegment {
  char: string;
  r: number;
  g: number;
  b: number;
  hex: string;
}

export function getBeaconSegments(
  phase: number,
  activity: BeaconActivity = "thinking",
  width = 16,
  theme: TerminalTheme = "dark",
): BeaconSegment[] {
  const innerLen = Math.max(2, width - 2);
  const cStart = sampleBeaconRGB(phase, activity, theme);
  const cEnd = sampleBeaconRGB(phase + (innerLen - 1) / (innerLen * 2), activity, theme);

  const segments: BeaconSegment[] = [
    { char: "◖", r: cStart[0], g: cStart[1], b: cStart[2], hex: rgbToHex(cStart[0], cStart[1], cStart[2]) },
  ];

  for (let i = 0; i < innerLen; i++) {
    const t = phase + i / innerLen;
    const [r, g, b] = sampleBeaconRGB(t, activity, theme);
    segments.push({ char: "━", r, g, b, hex: rgbToHex(r, g, b) });
  }

  segments.push({ char: "◗", r: cEnd[0], g: cEnd[1], b: cEnd[2], hex: rgbToHex(cEnd[0], cEnd[1], cEnd[2]) });
  return segments;
}

/// Renders a dynamic, rotating truecolor gradient beacon capsule in the terminal.
/// Smoothly interpolates the iOS beacon colors along the capsule bar.
export function renderBeacon(
  phase: number,
  activity: BeaconActivity = "thinking",
  width = 16,
  painter: Painter = createPainter(true),
): string {
  if (!painter.enabled) {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return "";
    if (safeWidth === 1) return "=";
    return `[${"=".repeat(safeWidth - 2)}]`;
  }

  const segments = getBeaconSegments(phase, activity, width, painter.theme);
  return segments
    .map((seg) => `\x1b[38;2;${seg.r};${seg.g};${seg.b}m${seg.char}\x1b[0m`)
    .join("");
}

/// Applies the dynamic beacon truecolor gradient sweep across the characters of a string.
export function renderBeaconText(
  text: string,
  phase: number,
  activity: BeaconActivity = "thinking",
  painter: Painter = createPainter(true),
): string {
  if (!painter.enabled || text.length === 0) {
    return text;
  }

  const len = text.length;
  return text
    .split("")
    .map((char, index) => {
      const charPhase = phase + index / Math.max(1, len * 1.5);
      const [r, g, b] = sampleBeaconRGB(charPhase, activity, painter.theme);
      return `\x1b[38;2;${r};${g};${b}m${char}\x1b[0m`;
    })
    .join("");
}

/// One accent color per activity: the quiet terminal replacement for the
/// hue-cycling capsule. A single glyph in a single color carries the state.
export const BEACON_ACCENTS: Record<BeaconActivity, PaletteColor> = {
  thinking: "electric",
  reasoning: "electricBright",
  loading: "electric",
  generating: "electric",
  tool: "citron",
};

/// Renders one braille spinner frame tinted with the activity's accent color.
export function renderSpinner(
  phase: number,
  activity: BeaconActivity = "thinking",
  painter: Painter = createPainter(true),
  accent?: PaletteColor,
): string {
  const frame = SPINNER_FRAMES[Math.abs(Math.floor(phase * SPINNER_FRAMES.length)) % SPINNER_FRAMES.length]!;
  if (!painter.enabled) return frame;
  return painter.text(frame, accent ?? BEACON_ACCENTS[activity]);
}

export interface CardRow {
  kind: "text" | "blank" | "divider" | "route";
  content?: string;
}

export function formatCardRow(
  content: string,
  width = 80,
  painter: Painter = createPainter(true),
  borderColor: PaletteColor = "rule",
): string {
  const innerWidth = Math.max(12, width - 6);
  const bar = painter.text("│", borderColor);
  const safeContent = truncateText(content, innerWidth);
  const padLen = Math.max(0, innerWidth - visibleLength(safeContent));
  return `  ${bar} ${safeContent}${" ".repeat(padLen)} ${bar}`;
}

/// Mathematically aligned terminal card builder.
/// Guarantees that every line (top border, content rows, blank rows, dividers, route lines, bottom border)
/// has the exact same visual length with flawless pixel-perfect alignment.
export function buildCard(
  options: {
    title?: string;
    badge?: string;
    rows: CardRow[];
    width?: number;
    borderColor?: PaletteColor;
    painter?: Painter;
  },
): string {
  const { title, badge, rows, width: reqWidth = 80, borderColor = "rule", painter = createPainter(true) } = options;
  // innerWidth is the space between the left "│ " (2 chars) and right " │" (2 chars)
  // Total box visual length from column 0 (including 2-space indent "  ") = innerWidth + 6 chars
  const innerWidth = Math.max(12, reqWidth - 6);
  const bar = painter.text("│", borderColor);

  // Top border: ╭─ Title [Badge] ──────╮
  let topBorder = "";
  if (title) {
    const titlePart = truncateText(`${title}${badge ? ` ${badge}` : ""}`, Math.max(1, innerWidth - 1));
    const titleLen = visibleLength(titlePart);
    const ruleLen = Math.max(0, innerWidth - titleLen - 1);
    topBorder = painter.text(`╭─ ${titlePart} ${"─".repeat(ruleLen)}╮`, borderColor);
  } else {
    topBorder = painter.text(`╭${"─".repeat(innerWidth + 2)}╮`, borderColor);
  }

  const bottomBorder = painter.text(`╰${"─".repeat(innerWidth + 2)}╯`, borderColor);

  const lines = rows.map((row) => {
    switch (row.kind) {
      case "text":
        return formatCardRow(row.content ?? "", reqWidth, painter, borderColor);
      case "blank":
        return `  ${bar} ${" ".repeat(innerWidth)} ${bar}`;
      case "divider":
        return `  ${painter.text(`├${"─".repeat(innerWidth + 2)}┤`, borderColor)}`;
      case "route": {
        const routeStripe = quietRouteLine(innerWidth, painter);
        return `  ${bar} ${routeStripe} ${bar}`;
      }
    }
  });

  return `  ${topBorder}\n${lines.join("\n")}\n  ${bottomBorder}`;
}

/// Maps raw tool names to human-readable titles like the mobile app's ToolAuditView.
export function humanToolTitle(name: string): string {
  const safeName = sanitizeTerminalLine(name);
  switch (safeName) {
    case "read_file": return "Host File Read";
    case "read_files": return "Host File Batch Read";
    case "edit_file": return "File Edit";
    case "write_file": return "File Write";
    case "search_files": return "Workspace Search";
    case "list_files": return "Directory Listing";
    case "git_status": return "Repository Status";
    case "git_diff": return "Repository Diff";
    case "move_path": return "Path Move";
    case "delete_path": return "Path Delete";
    case "run_command": return "Host Shell Command";
    case "command_logs": return "Command Logs";
    case "command_stop": return "Command Stop";
    case "web_search": return "Web Search";
    default: return safeName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export interface ToolBadge {
  chip: string;
  color: PaletteColor;
  title: string;
  beaconActivity: BeaconActivity;
}

/// Returns a structured badge, brand color, and associated beacon activity for a tool.
export function toolKindBadge(name: string): ToolBadge {
  const safeName = sanitizeTerminalLine(name);
  switch (safeName) {
    case "read_file":
      return { chip: "READ", color: "electric", title: "Host File Read", beaconActivity: "loading" };
    case "read_files":
      return { chip: "READ", color: "electric", title: "Host File Batch Read", beaconActivity: "loading" };
    case "edit_file":
      return { chip: "EDIT", color: "citron", title: "File Edit", beaconActivity: "tool" };
    case "write_file":
      return { chip: "WRITE", color: "citron", title: "File Write", beaconActivity: "tool" };
    case "search_files":
      return { chip: "SEARCH", color: "electric", title: "Workspace Search", beaconActivity: "loading" };
    case "list_files":
      return { chip: "LIST", color: "electric", title: "Directory Listing", beaconActivity: "loading" };
    case "git_status":
      return { chip: "GIT", color: "electric", title: "Repository Status", beaconActivity: "loading" };
    case "git_diff":
      return { chip: "DIFF", color: "electric", title: "Repository Diff", beaconActivity: "loading" };
    case "move_path":
      return { chip: "MOVE", color: "citron", title: "Path Move", beaconActivity: "tool" };
    case "delete_path":
      return { chip: "DELETE", color: "signal", title: "Path Delete", beaconActivity: "tool" };
    case "run_command":
      return { chip: "EXEC", color: "signal", title: "Host Shell Command", beaconActivity: "tool" };
    case "command_logs":
      return { chip: "LOG", color: "secondary", title: "Command Logs", beaconActivity: "loading" };
    case "command_stop":
      return { chip: "STOP", color: "signal", title: "Command Stop", beaconActivity: "tool" };
    case "web_search":
      return { chip: "WEB", color: "citron", title: "Web Search", beaconActivity: "loading" };
    default:
      return {
        chip: "TOOL",
        color: "secondary",
        title: humanToolTitle(safeName),
        beaconActivity: "tool",
      };
  }
}

/// Formats a compact unified diff preview for file edits or changes.
export function formatDiffPreview(
  oldText: string,
  newText: string,
  maxLines = 6,
  painter: Painter = createPainter(true),
): string[] {
  const lines = formatUnifiedDiff(oldText, newText, { context: 1, maxLines, compact: true, painter });
  return lines.length > 0 ? lines : [painter.dim("(no textual change)")];
}

export interface UnifiedDiffOptions {
  context?: number;
  maxLines?: number;
  compact?: boolean;
  painter?: Painter;
}

interface UnifiedDiffRow {
  kind: "header" | "context" | "removed" | "added";
  line: string;
  number?: number;
}

/// Formats a line-level unified diff.
///
/// The implementation trims the common prefix and suffix, then renders the
/// remaining change block with surrounding context. That is exact for the
/// contiguous hunks produced by `edit_file`; a file with several distant
/// changes is presented as one block between the first and last change rather
/// than as separate hunks. Output is bounded by `maxLines` with an explicit
/// omission row, and every line is sanitized before styling.
export function formatUnifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {},
): string[] {
  const painter = options.painter ?? createPainter(true);
  const context = Math.max(0, options.context ?? 3);
  const maxLines = Math.max(2, options.maxLines ?? 40);
  const compact = options.compact ?? false;
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return [];

  const contextBeforeStart = Math.max(0, prefix - context);
  const contextBefore = oldLines.slice(contextBeforeStart, prefix);
  const contextAfter = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(context, suffix));

  const rows: UnifiedDiffRow[] = [];
  if (!compact) {
    rows.push({ kind: "header", line: `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@` });
  }
  contextBefore.forEach((line, offset) => {
    rows.push({ kind: "context", line, number: contextBeforeStart + offset + 1 });
  });
  removed.forEach((line, offset) => {
    rows.push({ kind: "removed", line, number: prefix + offset + 1 });
  });
  added.forEach((line, offset) => {
    rows.push({ kind: "added", line, number: prefix + offset + 1 });
  });
  contextAfter.forEach((line, offset) => {
    rows.push({ kind: "context", line, number: oldLines.length - suffix + offset + 1 });
  });

  const rendered = rows.map((row) => renderUnifiedDiffRow(row, compact, painter));
  if (rendered.length <= maxLines) return rendered;

  const headCount = Math.max(1, Math.ceil(maxLines / 2) - 1);
  const tailCount = Math.max(1, maxLines - headCount - 1);
  const head = rendered.slice(0, headCount);
  const tail = rendered.slice(rendered.length - tailCount);
  const omitted = rendered.length - headCount - tailCount;
  return [...head, painter.dim(`${compact ? "" : "     │ "}… ${omitted} more lines`), ...tail];
}

function renderUnifiedDiffRow(row: UnifiedDiffRow, compact: boolean, painter: Painter): string {
  if (row.kind === "header") return painter.text(row.line, "electric");
  const text = sanitizeTerminalLine(row.line);
  if (compact) {
    if (row.kind === "removed") return painter.text(`- ${text}`, "signal");
    if (row.kind === "added") return painter.text(`+ ${text}`, "citron");
    return painter.dim(`  ${text}`);
  }
  const number = String(row.number ?? 0).padStart(4);
  if (row.kind === "removed") return painter.text(`${number} │ - ${text}`, "signal");
  if (row.kind === "added") return painter.text(`${number} │ + ${text}`, "citron");
  return painter.dim(`${number} │   ${text}`);
}

/// Wraps text in an OSC 8 hyperlink. Terminals without support ignore the
/// sequence, and the visible text is unchanged either way.
export function formatHyperlink(text: string, url: string, enabled = true): string {
  return enabled ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text;
}

export function fileUrl(absolutePath: string): string {
  return new URL(`file://${absolutePath}`).href;
}

/// Formats an authored user turn block spanning the width of the terminal.
export function formatUserMessage(
  content: string,
  timestamp?: string,
  width = 80,
  painter: Painter = createPainter(true),
): string {
  const author = painter.bold("YOU", "paper");
  const time = timestamp ? painter.dim(sanitizeTerminalLine(timestamp)) : "";
  const rail = painter.bold("▌", "electric");

  // Top header line with right-aligned timestamp
  const headerLeft = `  ${rail} ${author}`;
  const headerPad = Math.max(2, width - visibleLength(headerLeft) - visibleLength(time));
  const headerLine = `${headerLeft}${" ".repeat(headerPad)}${time}`;

  const bodyPrefix = `  ${rail} `;
  const bodyWidth = Math.max(1, width - visibleLength(bodyPrefix));
  const lines = sanitizeTerminalText(content).replaceAll("\t", "  ").split("\n");
  const formattedLines = lines.flatMap((line) => {
    const indentation = line.match(/^\s*/)?.[0] ?? "";
    const safeIndentation = " ".repeat(Math.min(visibleLength(indentation), Math.max(0, bodyWidth - 2)));
    const wrapped = wrapDisplayText(line.trim(), Math.max(2, bodyWidth - visibleLength(safeIndentation)));
    return wrapped.map((row) => `${bodyPrefix}${painter.bold(`${safeIndentation}${row}`, "paper")}`);
  }).join("\n");

  return `\n${headerLine}\n${formattedLines}\n`;
}

/// Formats a compact model attribution for the final response.
export function formatAssistantHeader(
  modelName?: string,
  width = 80,
  painter: Painter = createPainter(true),
  providerName?: string,
  timestamp?: string,
): string {
  const safeWidth = Math.max(8, width);
  const model = painter.bold(sanitizeTerminalLine(modelName ?? "model").toLowerCase(), "paper");
  const route = providerName ? painter.dim(` · ${sanitizeTerminalLine(providerName)}`) : "";
  const rail = painter.bold("▌", "citron");
  const fullLeft = `  ${rail} ${model}${route}`;
  const time = timestamp ? painter.dim(sanitizeTerminalLine(timestamp)) : "";
  if (!time) return `${truncateText(fullLeft, safeWidth)}\n\n`;
  const left = truncateText(fullLeft, Math.max(1, safeWidth - visibleLength(time) - 2));
  const padding = Math.max(1, safeWidth - visibleLength(left) - visibleLength(time));
  return `${left}${" ".repeat(padding)}${time}\n\n`;
}

export function formatToolGroupHeader(count: number, painter: Painter = createPainter(true)): string {
  const label = `${count} tool${count === 1 ? "" : "s"}`;
  return `  ${painter.text("⋮", "secondary")} ${painter.dim(label)}`;
}

export type ToolPhase = "inspect" | "change" | "verify";

export function formatToolPhaseHeader(
  phase: ToolPhase,
  count: number,
  painter: Painter = createPainter(true),
): string {
  const presentation = phase === "inspect"
    ? { glyph: "◇", color: "electricBright" as const }
    : phase === "change"
      ? { glyph: "◆", color: "signal" as const }
      : { glyph: "●", color: "citron" as const };
  const label = `${count} call${count === 1 ? "" : "s"}`;
  return `\n  ${painter.bold(`${presentation.glyph} ${phase.toUpperCase()}`, presentation.color)} ${painter.dim(`· ${label}`)}`;
}

export function formatToolResultLine(
  state: "done" | "failed" | "denied",
  name: string,
  detail: string | undefined,
  durationMs: number | undefined,
  last: boolean,
  width = 80,
  painter: Painter = createPainter(true),
  options: { linkPath?: (styledDisplay: string, path: string) => string } = {},
): string {
  const badge = toolKindBadge(sanitizeTerminalLine(name));
  const color: PaletteColor = state === "done" ? "citron" : "signal";
  const glyph = state === "done" ? "✓" : state === "denied" ? "!" : "×";
  const branch = last ? "└" : "├";
  const prefix = `  ${painter.text(branch, color)} ${painter.text(glyph, color)} ${painter.bold(`[${badge.chip}]`, badge.color)} `;
  const duration = durationMs === undefined ? "" : ` · ${durationMs}ms`;
  const fallback = badge.title;
  const available = Math.max(8, width - visibleLength(prefix) - visibleLength(duration));
  const sanitized = sanitizeTerminalLine(detail ?? fallback);
  const description = truncateText(sanitized, available);
  const styled = painter.text(description, state === "done" ? "paper" : "signal");
  const linked = state === "done" && options.linkPath && looksLikePath(sanitized)
    ? options.linkPath(styled, sanitized)
    : styled;
  return `${prefix}${linked}${painter.dim(duration)}`;
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return trimmed.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
}

/// Formats one step in the compact tool activity timeline.
export function formatToolCard(
  state: "running" | "done" | "failed" | "denied",
  name: string,
  detail?: string,
  durationMs?: number,
  width = 80,
  painter: Painter = createPainter(true),
): string {
  const badge = toolKindBadge(sanitizeTerminalLine(name));
  const title = badge.title;
  const dotColor: PaletteColor =
    state === "done" ? "citron" : state === "running" ? "electric" : "signal";
  const stateLabel =
    state === "done" ? "complete" : state === "running" ? "running" : state === "denied" ? "denied" : "failed";

  const branch = painter.text(state === "running" ? "├" : "└", dotColor);
  const chipStr = painter.bold(`[${badge.chip}]`, badge.color);
  const leftHeader = `  ${branch} ${chipStr} ${painter.bold(title, "paper")}`;
  const statusStr = painter.text(stateLabel, dotColor);
  const timeStr = durationMs !== undefined ? painter.dim(` · ${durationMs}ms`) : "";
  const headerRow = `${leftHeader}  ${statusStr}${timeStr}`;

  if (detail) {
    const maxDetailLen = Math.max(16, width - 8);
    return `${headerRow}\n  ${painter.dim("│")} ${painter.text(truncateText(sanitizeTerminalLine(detail), maxDetailLen), "secondary")}`;
  }
  return headerRow;
}

/// Formats a tool activity line.
export function formatToolEvent(
  state: "running" | "done" | "failed" | "denied",
  name: string,
  argsSummary?: string,
  painter: Painter = createPainter(true),
): string {
  const dotColor: PaletteColor =
    state === "done" ? "citron" : state === "running" ? "electric" : "signal";
  const stateLabel =
    state === "done" ? "done" : state === "running" ? "running" : state === "denied" ? "denied" : "failed";

  const dot = painter.text("●", dotColor);
  const toolName = painter.bold(sanitizeTerminalLine(name), "paper");
  const args = argsSummary ? ` ${painter.dim(sanitizeTerminalLine(argsSummary))}` : "";
  const status = painter.text(` (${stateLabel})`, dotColor);

  return `  ${dot} ${toolName}${args}${state === "running" ? "" : status}`;
}

/// Formats a rich boundary approval card when a dangerous tool is invoked.
export function formatPermissionCard(
  summary: string,
  toolName?: string,
  width = 80,
  painter: Painter = createPainter(true),
  previewRows?: string[],
): string {
  const innerWidth = Math.max(12, width - 6);
  const rows: CardRow[] = [];
  const safeToolName = toolName ? sanitizeTerminalLine(toolName) : undefined;
  const badge = safeToolName ? toolKindBadge(safeToolName) : undefined;
  const badgeChip = badge ? `[${badge.chip}]` : undefined;

  if (toolName) {
    rows.push({
      kind: "text",
      content: `${painter.bold("Tool:", "paper")}   ${painter.text(badge?.title ?? safeToolName!, "secondary")}${badge ? ` ${painter.bold(`[${badge.chip}]`, badge.color)}` : ""}`.trim(),
    });
  }
  rows.push({
    kind: "text",
    content: `${painter.bold("Action:", "paper")} ${painter.text(truncateText(sanitizeTerminalLine(summary), innerWidth - 10), "paper")}`,
  });

  if (previewRows && previewRows.length > 0) {
    rows.push({ kind: "divider" });
    for (const line of previewRows) {
      rows.push({ kind: "text", content: truncateText(line, innerWidth) });
    }
  }

  return `\n${buildCard({
    title: painter.bold("◆ APPROVAL REQUIRED", "signal"),
    badge: badgeChip ? painter.bold(badgeChip, "signal") : undefined,
    rows,
    width,
    borderColor: "signal",
    painter,
  })}\n`;
}

/// Formats a turn completion summary inspired by the mobile app's InferenceDetailsView.
export function formatTurnSummary(
  durationSeconds: number,
  _modelName?: string,
  tokenCount?: number,
  tokensPerSec?: number,
  width = 80,
  painter: Painter = createPainter(true),
  timeToFirstTokenMs?: number,
  decodeTokensPerSec?: number,
): string {
  const dot = painter.text("✓", "citron");
  const durationStr = `${durationSeconds.toFixed(1)}s`;
  const tokensStr = tokenCount ? ` · ${tokenCount} tok` : "";
  const ttftStr = timeToFirstTokenMs !== undefined ? ` · ${(timeToFirstTokenMs / 1_000).toFixed(1)}s ttft` : "";
  const decodeStr = decodeTokensPerSec ? ` · ${decodeTokensPerSec.toFixed(1)} tok/s decode` : "";
  const fallbackSpeed = !decodeTokensPerSec && tokensPerSec ? ` · ${tokensPerSec.toFixed(1)} effective tok/s` : "";
  const rule = painter.text(`  ${"─".repeat(Math.max(8, width - 4))}`, "rule");
  return `\n  ${dot} ${painter.dim(`complete · ${durationStr}${tokensStr}${ttftStr}${decodeStr}${fallbackSpeed}`)}\n${rule}\n`;
}

export interface TurnReceiptChange {
  operation: "A" | "M" | "R" | "D";
  path: string;
  state: "queued" | "running" | "done" | "failed" | "denied";
}

export interface TurnReceiptValidation {
  command: string;
  state: "queued" | "running" | "done" | "failed" | "denied";
  exitCode?: number;
}

export function formatTurnReceipt(options: {
  durationSeconds: number;
  rounds: number;
  tools: number;
  changes: readonly TurnReceiptChange[];
  validations: readonly TurnReceiptValidation[];
  tokenCount?: number;
  tokensPerSec?: number;
  timeToFirstTokenMs?: number;
  decodeTokensPerSec?: number;
  width?: number;
  painter?: Painter;
}): string {
  const {
    durationSeconds,
    rounds,
    tools,
    changes,
    validations,
    tokenCount,
    tokensPerSec,
    timeToFirstTokenMs,
    decodeTokensPerSec,
    width = 80,
    painter = createPainter(true),
  } = options;
  const safeWidth = Math.max(8, width);
  const lines: string[] = [];

  if (changes.length > 0) {
    lines.push(`  ${painter.bold("CHANGES", "secondary")} ${painter.dim(String(changes.length))}`);
    for (const change of changes) {
      const passed = change.state === "done";
      const glyph = passed ? "✓" : change.state === "denied" ? "!" : "×";
      const color: PaletteColor = passed ? "citron" : "signal";
      const prefix = `  ${painter.text(glyph, color)} ${painter.bold(change.operation, color)} `;
      lines.push(`${prefix}${painter.text(truncateText(sanitizeTerminalLine(change.path), safeWidth - visibleLength(prefix)), passed ? "paper" : "signal")}`);
    }
  }

  if (validations.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`  ${painter.bold("VERIFY", "secondary")} ${painter.dim(String(validations.length))}`);
    for (const validation of validations) {
      const passed = validation.state === "done";
      const glyph = passed ? "✓" : validation.state === "denied" ? "!" : "×";
      const color: PaletteColor = passed ? "citron" : "signal";
      const exit = validation.exitCode === undefined ? "" : ` · exit ${validation.exitCode}`;
      const prefix = `  ${painter.text(glyph, color)} `;
      const available = safeWidth - visibleLength(prefix) - visibleLength(exit);
      lines.push(`${prefix}${painter.text(truncateText(sanitizeTerminalLine(validation.command), available), passed ? "paper" : "signal")}${painter.dim(exit)}`);
    }
  }

  const tokenPart = tokenCount === undefined ? "" : ` · ${tokenCount} tok`;
  const ttftPart = timeToFirstTokenMs === undefined ? "" : ` · ${(timeToFirstTokenMs / 1_000).toFixed(1)}s ttft`;
  const decodePart = decodeTokensPerSec === undefined
    ? tokensPerSec === undefined ? "" : ` · ${tokensPerSec.toFixed(1)} effective tok/s`
    : ` · ${decodeTokensPerSec.toFixed(1)} tok/s decode`;
  const evidence = `${rounds} round${rounds === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}`;
  const summary = `complete · ${durationSeconds.toFixed(1)}s · ${evidence}${tokenPart}${ttftPart}${decodePart}`;
  if (lines.length > 0) lines.push("");
  lines.push(`  ${painter.text("✓", "citron")} ${painter.dim(truncateText(summary, safeWidth - 4))}`);
  lines.push(painter.text(`  ${"─".repeat(Math.max(1, safeWidth - 2))}`, "rule"));
  return `\n${lines.join("\n")}\n`;
}

/// Formats the welcome masthead card inspired by Demesne WelcomeView & AppIntro.
export function formatWelcomeCard(
  options: {
    model?: string;
    provider?: string;
    workspace: string;
    permissionMode?: string;
    width?: number;
    painter?: Painter;
  },
): string {
  const { model, provider, workspace, permissionMode = "ask", width = 80, painter = createPainter(true) } = options;
  const innerWidth = Math.max(12, width - 6);
  const safeModel = sanitizeTerminalLine(model ?? "default");
  const safeProvider = provider ? sanitizeTerminalLine(provider) : undefined;
  const safeWorkspace = sanitizeTerminalLine(workspace);

  const rows: CardRow[] = [
    { kind: "text", content: painter.dim("YOUR MODEL. ON YOUR HARDWARE.") },
    { kind: "blank" },
  ];

  const modelPill = `${painter.text("●", "electric")} ${painter.bold("Model:", "paper")} ${safeProvider ? `${painter.text(safeProvider, "secondary")}/` : ""}${painter.bold(safeModel, "paper")}`;
  const policyPill = `${painter.text("●", "secondary")} ${painter.bold("Policy:", "paper")} ${painter.text(permissionMode === "ask" ? "ask on write" : "auto", "secondary")}`;

  // If wide enough and combined pills fit in innerWidth, format horizontally
  const fixedLen = visibleLength(modelPill) + 4 + visibleLength(policyPill) + 4 + 14;
  const availableWsLen = innerWidth - fixedLen;

  if (availableWsLen >= 14) {
    const wsPill = `${painter.text("●", "secondary")} ${painter.bold("Workspace:", "paper")} ${painter.text(truncateText(safeWorkspace, availableWsLen), "secondary")}`;
    rows.push({ kind: "text", content: `${modelPill}    ${wsPill}    ${policyPill}` });
  } else {
    const modelInfo = model
      ? `${painter.text("●", "electric")} ${painter.bold("Model:", "paper")}      ${safeProvider ? `${painter.text(safeProvider, "secondary")}/` : ""}${painter.bold(safeModel, "paper")}`
      : `${painter.text("●", "secondary")} ${painter.bold("Model:", "paper")}      ${painter.dim("default / loopback")}`;
    const wsInfo = `${painter.text("●", "secondary")} ${painter.bold("Workspace:", "paper")}  ${painter.text(truncateText(safeWorkspace, innerWidth - 16), "secondary")}`;
    const policyInfo = `${painter.text("●", "secondary")} ${painter.bold("Policy:", "paper")}     ${painter.text(permissionMode === "ask" ? "approval required on write/execute" : "automatic", "secondary")}`;
    rows.push({ kind: "text", content: modelInfo });
    rows.push({ kind: "text", content: wsInfo });
    rows.push({ kind: "text", content: policyInfo });
  }

  rows.push({ kind: "route" });
  rows.push({
    kind: "text",
    content: `${painter.dim("Type a prompt to begin ·")} ${painter.bold("/help", "electric")} ${painter.dim("for commands ·")} ${painter.bold("/exit", "electric")} ${painter.dim("to quit")}`,
  });

  return `\n${buildCard({
    title: painter.bold("◆ DEMESNE", "paper"),
    badge: painter.dim("v0.1.0 · LOCAL/PRIVATE"),
    rows,
    width,
    borderColor: "rule",
    painter,
  })}\n`;
}

/// Formats the `/help` command overview card across the terminal width.
export function formatHelpCard(painter: Painter = createPainter(true), width = 80): string {
  const innerWidth = Math.max(12, width - 6);
  const rows: CardRow[] = [];
  let currentSection: SlashCommandSection | null = null;
  for (const command of SLASH_COMMANDS.filter((candidate) => candidate.id !== "help")) {
    if (command.section !== currentSection) {
      if (rows.length > 0) rows.push({ kind: "blank" });
      currentSection = command.section;
      rows.push({ kind: "text", content: painter.bold(command.section.toUpperCase(), "secondary") });
    }
    const usage = slashCommandUsage(command);
    const cmdStr = painter.bold(usage.padEnd(16), "electric");
    const descStr = painter.text(truncateText(command.description, innerWidth - 18), "paper");
    rows.push({ kind: "text", content: `${cmdStr} ${descStr}` });
  }

  return `\n${buildCard({
    title: painter.bold("Session Commands", "paper"),
    rows,
    width,
    borderColor: "rule",
    painter,
  })}\n`;
}

/// Formats the `/status` card with session stats and daemon details.
export function formatInfoCard(
  options: {
    sessionId: string;
    title: string;
    turnCount: number;
    model?: string;
    provider?: string;
    contextWindow?: number;
    workspace: string;
    width?: number;
    painter?: Painter;
  },
): string {
  const { sessionId, title, turnCount, model, provider, contextWindow, workspace, width = 80, painter = createPainter(true) } = options;
  const innerWidth = Math.max(12, width - 6);
  const safeModel = model ? sanitizeTerminalLine(model) : undefined;
  const safeProvider = provider ? sanitizeTerminalLine(provider) : undefined;

  const rows: CardRow[] = [
    { kind: "text", content: `${painter.bold("Session ID:", "paper")}  ${painter.text(sanitizeTerminalLine(sessionId), "secondary")}` },
    { kind: "text", content: `${painter.bold("Title:", "paper")}       ${painter.bold(truncateText(sanitizeTerminalLine(title), innerWidth - 16), "paper")}` },
    { kind: "text", content: `${painter.bold("Turns:", "paper")}       ${painter.text(String(turnCount), "secondary")}` },
    { kind: "text", content: `${painter.bold("Model:", "paper")}       ${painter.text(safeModel ? `${safeProvider ? `${safeProvider}/` : ""}${safeModel}` : "default", "secondary")}` },
    { kind: "text", content: `${painter.bold("Context:", "paper")}     ${painter.text(contextWindow ? `${formatTokenCount(contextWindow)} tokens` : "unknown", contextWindow ? "secondary" : "signal")}` },
    { kind: "text", content: `${painter.bold("Workspace:", "paper")}   ${painter.text(truncateText(sanitizeTerminalLine(workspace), innerWidth - 16), "secondary")}` },
  ];

  return `\n${buildCard({
    title: painter.bold("Runtime Status", "paper"),
    rows,
    width,
    borderColor: "rule",
    painter,
  })}\n`;
}

/// Formats the `/sessions` list as a table spanning the screen.
export interface SessionListItem {
  id: string;
  title: string;
  turnCount: number;
  root?: string;
  updatedAt?: string;
  status?: string;
}

export function formatSessionsTable(
  sessions: readonly SessionListItem[],
  currentId?: string,
  width = 80,
  painter: Painter = createPainter(true),
  now = Date.now(),
): string {
  const innerWidth = Math.max(12, width - 6);
  const rows: CardRow[] = sessions.slice(0, 10).map((session, index) => {
    const isCurrent = session.id === currentId;
    const marker = isCurrent ? painter.text("●", "electric") : painter.dim("○");
    const number = painter.bold(String(index + 1).padStart(2), isCurrent ? "electric" : "secondary");
    const age = session.updatedAt ? formatRelativeAge(session.updatedAt, now) : "age unknown";
    const turns = `${session.turnCount} turn${session.turnCount === 1 ? "" : "s"}`;
    const status = sanitizeTerminalLine(session.status ?? (session.turnCount === 0 ? "empty" : "unknown"));
    const safeId = sanitizeTerminalLine(session.id);
    const safeTitle = sanitizeTerminalLine(session.title);
    const workspace = session.root ? sanitizeTerminalLine(session.root).split("/").filter(Boolean).at(-1) : undefined;
    const metadata = [age, turns, status, workspace].filter(Boolean).join(" · ");

    if (innerWidth < 48) {
      const prefix = `${number} ${marker} `;
      const suffix = ` · ${metadata}`;
      const titleWidth = Math.max(6, innerWidth - visibleLength(prefix) - Math.min(18, visibleLength(suffix)));
      const title = isCurrent
        ? painter.bold(truncateText(safeTitle, titleWidth), "paper")
        : painter.text(truncateText(safeTitle, titleWidth), "secondary");
      return { kind: "text", content: `${prefix}${title}${painter.dim(truncateText(suffix, Math.max(0, innerWidth - visibleLength(prefix) - visibleLength(title))))}` };
    }

    const id = painter.dim(safeId.slice(0, 8));
    const fixedWidth = visibleLength(`${index + 1} ${marker} ${safeId.slice(0, 8)}    ${metadata}`);
    const titleWidth = Math.max(12, innerWidth - fixedWidth - 2);
    const title = isCurrent
      ? painter.bold(padVisibleEnd(truncateText(safeTitle, titleWidth), titleWidth), "paper")
      : painter.text(padVisibleEnd(truncateText(safeTitle, titleWidth), titleWidth), "secondary");
    return { kind: "text", content: `${number} ${marker} ${id}  ${title}  ${painter.dim(metadata)}` };
  });

  if (rows.length === 0) {
    rows.push({ kind: "text", content: painter.dim("No sessions found.") });
  }

  return `\n${buildCard({
    title: painter.bold("Recent Sessions", "paper"),
    rows: sessions.length > 0
      ? [...rows, { kind: "route" }, { kind: "text", content: painter.dim("↑/↓ or j/k navigate · enter resume · esc cancel") }]
      : rows,
    width,
    borderColor: "rule",
    painter,
  })}\n`;
}

export function formatSessionPickerLine(
  session: SessionListItem,
  index: number,
  count: number,
  width = 80,
  painter: Painter = createPainter(true),
): string {
  const prefix = `  ${painter.bold("›", "electric")} ${painter.bold(`${index + 1}/${count}`, "paper")}  `;
  const status = sanitizeTerminalLine(session.status ?? (session.turnCount === 0 ? "empty" : "unknown"));
  const detail = `${sanitizeTerminalLine(session.id).slice(0, 8)} · ${session.turnCount} turn${session.turnCount === 1 ? "" : "s"} · ${status}`;
  const available = Math.max(4, width - visibleLength(prefix));
  const titleWidth = Math.max(4, available - Math.min(32, detail.length) - 3);
  const title = painter.bold(truncateText(sanitizeTerminalLine(session.title), titleWidth), "paper");
  return truncateText(`${prefix}${title}${painter.dim(` · ${detail}`)}`, Math.max(1, width));
}

export function formatRelativeAge(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "age unknown";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/// Formats the `/models` list as a clean table.
export function formatModelsTable(
  models: Array<{ id: string; provider: string; contextWindow?: number }>,
  width = 80,
  painter: Painter = createPainter(true),
): string {
  const rows: CardRow[] = models.map((m) => {
    const dot = painter.text("●", "secondary");
    const idStr = painter.bold(padVisibleEnd(sanitizeTerminalLine(m.id), 28), "paper");
    const providerStr = painter.dim(`(${sanitizeTerminalLine(m.provider)})`);
    const contextStr = painter.dim(m.contextWindow ? `${formatTokenCount(m.contextWindow)} ctx` : "context unknown");
    return {
      kind: "text",
      content: `${dot} ${idStr} ${providerStr} · ${contextStr}`,
    };
  });

  if (rows.length === 0) {
    rows.push({ kind: "text", content: painter.dim("No models discovered.") });
  }

  return `\n${buildCard({
    title: painter.bold("Available Models", "paper"),
    rows,
    width,
    borderColor: "rule",
    painter,
  })}\n`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

/// Width-aware formatter for a live reasoning trace. It buffers only the
/// incomplete word so streamed output remains responsive without ragged wraps.
export class TerminalReasoningStream {
  private pendingWord = "";
  private lineLength = 0;
  private lineOpen = false;
  private needsSpace = false;
  private previousWasNewline = false;
  private contentWidth: number;

  constructor(
    private readonly painter: Painter,
    width = 80,
  ) {
    this.contentWidth = Math.max(1, width - 6);
  }

  write(chunk: string): string {
    let output = "";

    for (const character of sanitizeTerminalText(chunk)) {
      if (character === "\r") continue;
      if (character === "\n") {
        output += this.emitPendingWord();
        output += this.endLine();
        if (this.previousWasNewline) output += this.blankLine();
        this.previousWasNewline = true;
        continue;
      }
      if (/\s/u.test(character)) {
        output += this.emitPendingWord();
        this.needsSpace = this.lineOpen;
        continue;
      }

      this.pendingWord += character;
      this.previousWasNewline = false;
    }

    return output;
  }

  setWidth(width: number): void {
    this.contentWidth = Math.max(1, width - 6);
  }

  flush(): string {
    const output = this.emitPendingWord() + this.endLine();
    this.previousWasNewline = false;
    return output;
  }

  private emitPendingWord(): string {
    if (!this.pendingWord) return "";

    let output = "";
    const word = this.pendingWord;
    this.pendingWord = "";

    const separatorWidth = this.needsSpace && this.lineOpen ? 1 : 0;
    if (this.lineOpen && this.lineLength + separatorWidth + visibleLength(word) <= this.contentWidth) {
      if (separatorWidth > 0) output += " ";
      output += this.painter.dim(word);
      this.lineLength += separatorWidth + visibleLength(word);
      this.needsSpace = false;
      return output;
    }
    if (this.lineOpen) output += this.endLine();

    const segments = splitDisplayCells(word, this.contentWidth);
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      output += this.prefix();
      this.lineOpen = true;
      this.lineLength = visibleLength(segment);
      output += this.painter.dim(segment);
      if (index < segments.length - 1) output += this.endLine();
    }
    this.needsSpace = false;

    return output;
  }

  private endLine(): string {
    this.needsSpace = false;
    if (!this.lineOpen) return "";
    this.lineOpen = false;
    this.lineLength = 0;
    return "\n";
  }

  private blankLine(): string {
    return `  ${this.painter.text("│", "rule")}\n`;
  }

  private prefix(): string {
    return `  ${this.painter.text("│", "rule")} `;
  }
}

type TableAlignment = "left" | "center" | "right";

function parseMarkdownTableRow(line: string): string[] | null {
  let text = line.trim();
  if (!text.includes("|")) return null;
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && text[index + 1] === "|") {
      cell += "|";
      index++;
      continue;
    }
    if (char === "`") {
      inCode = !inCode;
      cell += char;
      continue;
    }
    if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function tableAlignments(cells: string[], columns: number): TableAlignment[] | null {
  if (cells.length !== columns) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const marker = cell.trim();
    if (!/^:?-{3,}:?$/.test(marker)) return null;
    alignments.push(marker.startsWith(":") && marker.endsWith(":")
      ? "center"
      : marker.endsWith(":") ? "right" : "left");
  }
  return alignments;
}

function padTableCell(text: string, width: number, alignment: TableAlignment): string {
  const remaining = Math.max(0, width - visibleLength(text));
  if (alignment === "right") return `${" ".repeat(remaining)}${text}`;
  if (alignment === "center") {
    const left = Math.floor(remaining / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(remaining - left)}`;
  }
  return `${text}${" ".repeat(remaining)}`;
}

/// Lightweight, unboxed streaming markdown formatter for the terminal.
export class TerminalMarkdownStream {
  private buffer = "";
  private inCodeBlock = false;
  private codeBlockLang = "";
  private highlightState: CodeHighlightState = { inBlockComment: false };
  private tableLines: string[] = [];
  private painter: Painter;
  private width: number;
  private prefix: string;

  constructor(painter: Painter, width = 80, leftPadding = 0) {
    this.painter = painter;
    this.width = Math.max(16, width);
    this.prefix = " ".repeat(Math.max(0, leftPadding));
  }

  write(chunk: string): string {
    this.buffer += sanitizeTerminalText(chunk).replaceAll("\t", "  ");
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    let output = "";
    for (const line of lines) {
      for (const formatted of this.processLine(line)) output += `${formatted}\n`;
    }
    return output;
  }

  setWidth(width: number): void {
    this.width = Math.max(16, width);
  }

  flush(): string {
    const blocks = this.buffer ? this.processLine(this.buffer) : [];
    this.buffer = "";
    if (this.tableLines.length > 0) blocks.push(this.flushTable());
    return blocks.join("\n");
  }

  private processLine(line: string): string[] {
    if (this.inCodeBlock) return this.formattedBlocks(line);

    const cells = parseMarkdownTableRow(line);
    if (this.tableLines.length === 0) {
      if (cells) {
        this.tableLines.push(line);
        return [];
      }
      return this.formattedBlocks(line);
    }

    if (this.tableLines.length === 1) {
      const header = parseMarkdownTableRow(this.tableLines[0]!);
      if (header && cells && tableAlignments(cells, header.length)) {
        this.tableLines.push(line);
        return [];
      }
      const candidate = this.tableLines.pop()!;
      return [...this.formattedBlocks(candidate), ...this.processLine(line)];
    }

    const columns = parseMarkdownTableRow(this.tableLines[0]!)?.length ?? 0;
    if (cells?.length === columns) {
      this.tableLines.push(line);
      return [];
    }

    return [this.flushTable(), ...this.processLine(line)];
  }

  private formattedBlocks(line: string): string[] {
    const formatted = this.formatLine(line);
    return formatted === null ? [] : [formatted];
  }

  private flushTable(): string {
    const lines = this.tableLines;
    this.tableLines = [];
    if (lines.length < 2) return this.formatLine(lines[0] ?? "") ?? "";

    const header = parseMarkdownTableRow(lines[0]!);
    const separator = parseMarkdownTableRow(lines[1]!);
    if (!header || !separator) return lines.map((line) => this.formatLine(line) ?? "").join("\n");
    const alignments = tableAlignments(separator, header.length);
    if (!alignments) return lines.map((line) => this.formatLine(line) ?? "").join("\n");
    const rows = lines.slice(2).flatMap((line) => {
      const row = parseMarkdownTableRow(line);
      return row?.length === header.length ? [row] : [];
    });
    return this.renderTable(header, rows, alignments);
  }

  private renderTable(header: string[], rows: string[][], alignments: TableAlignment[]): string {
    const available = Math.max(1, this.width - visibleLength(this.prefix));
    const borderWidth = header.length * 3 + 1;
    const contentWidth = available - borderWidth;
    if (header.length > 4 || contentWidth < header.length * 12) {
      return this.renderStackedTable(header, rows);
    }

    const naturalWidths = header.map((cell, column) => Math.max(
      3,
      visibleLength(cell),
      ...rows.map((row) => visibleLength(row[column] ?? "")),
    ));
    const baseWidth = Math.max(6, Math.min(12, Math.floor(contentWidth / header.length)));
    const widths = naturalWidths.map((width) => Math.max(3, Math.min(width, baseWidth)));
    while (widths.reduce((sum, width) => sum + width, 0) < contentWidth) {
      const pressure = naturalWidths.map((width, index) => width > widths[index]! ? width / widths[index]! : 0);
      const column = pressure.reduce((best, value, index) => value > pressure[best]! ? index : best, 0);
      if (pressure[column] === 0) break;
      widths[column] = widths[column]! + 1;
    }

    const rule = (left: string, middle: string, right: string) => this.painter.text(
      `${this.prefix}${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`,
      "rule",
    );
    const renderRow = (cells: string[], heading: boolean) => {
      const wrapped = cells.map((cell, index) => wrapDisplayText(cell, widths[index]!));
      const height = Math.max(...wrapped.map((cell) => cell.length));
      return Array.from({ length: height }, (_, rowIndex) => {
        const rendered = wrapped.map((cell, column) => {
          const text = cell[rowIndex] ?? "";
          const styled = heading
            ? this.painter.bold(this.formatInline(text), "paper")
            : this.formatInline(text);
          return ` ${padTableCell(styled, widths[column]!, alignments[column] ?? "left")} `;
        });
        return `${this.prefix}${this.painter.text("│", "rule")}${rendered.join(this.painter.text("│", "rule"))}${this.painter.text("│", "rule")}`;
      }).join("\n");
    };

    return [
      rule("┌", "┬", "┐"),
      renderRow(header, true),
      rule("├", "┼", "┤"),
      ...rows.map((row) => renderRow(row, false)),
      rule("└", "┴", "┘"),
    ].join("\n");
  }

  private renderStackedTable(header: string[], rows: string[][]): string {
    if (rows.length === 0) return this.wrapRegularLine(header.join(" · "));
    const records = rows.map((row) => header.flatMap((label, column) => {
      const value = row[column]?.trim();
      if (!value) return [];
      const labelText = `${label}: `;
      const styledLabel = this.painter.bold(labelText, "electric");
      return [this.wrapStyledLine(
        value,
        `${this.prefix}${styledLabel}`,
        `${this.prefix}${" ".repeat(visibleLength(labelText))}`,
        (text) => this.formatInline(text),
      )];
    }).join("\n"));
    return records.join(`\n${this.prefix}\n`);
  }

  private formatLine(rawLine: string): string | null {
    const trimmed = rawLine.trim();

    // Fenced code block boundary
    if (trimmed.startsWith("```")) {
      this.inCodeBlock = !this.inCodeBlock;
      this.highlightState = { inBlockComment: false };
      if (this.inCodeBlock) {
        this.codeBlockLang = trimmed.slice(3).trim();
        const rawHeader = this.codeBlockLang ? ` [${this.codeBlockLang}] ` : " ";
        const header = truncateText(rawHeader, Math.max(1, this.width - visibleLength(this.prefix) - 3));
        const ruleLen = Math.max(0, this.width - visibleLength(this.prefix) - visibleLength(header) - 3);
        return `\n${this.painter.text(`${this.prefix}┌──${header}${"─".repeat(ruleLen)}`, "rule")}`;
      }
      return `${this.painter.text(`${this.prefix}└──${"─".repeat(Math.max(0, this.width - visibleLength(this.prefix) - 3))}`, "rule")}\n`;
    }

    // Inside a code block: format with clean indentation and subtle rule border (preserve code as-is)
    if (this.inCodeBlock) {
      const border = this.painter.text(`${this.prefix}│ `, "rule");
      const codeWidth = Math.max(1, this.width - visibleLength(border));
      return splitDisplayCells(rawLine, codeWidth)
        .map((segment) => `${border}${this.highlightCode(segment)}`)
        .join("\n");
    }

    // Outside code blocks: strip model structural framing tags (<response>, </response>, <thought>, </thought>, <think>, </think>, <answer>, </answer>)
    const stripped = rawLine.replace(/<\/?(?:response|thought|think|answer)>/gi, "");
    if (!stripped.trim() && /<\/?(?:response|thought|think|answer)>/i.test(rawLine)) {
      return null;
    }
    const line = stripped;

    if (!this.painter.enabled && !this.prefix) return line;

    // Headings
    if (line.startsWith("### ")) {
      return `\n${this.wrapStyledLine(line.slice(4), this.prefix, this.prefix, (row) => this.painter.bold(row, "paper"))}`;
    }
    if (line.startsWith("## ")) {
      return `\n${this.wrapStyledLine(line.slice(3), this.prefix, this.prefix, (row) => this.painter.bold(row, "paper"))}`;
    }
    if (line.startsWith("# ")) {
      return `\n${this.wrapStyledLine(line.slice(2), this.prefix, this.prefix, (row) => this.painter.bold(row, "paper"))}`;
    }

    // Unordered lists
    if (/^\s*[-*]\s+/.test(line)) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const content = line.replace(/^\s*[-*]\s+/, "");
      const bullet = this.painter.text("•", "electric");
      const firstPrefix = `${this.prefix}${indent}${bullet} `;
      const continuationPrefix = `${this.prefix}${indent}  `;
      return this.wrapStyledLine(content, firstPrefix, continuationPrefix, (row) => this.formatInline(row));
    }

    // Ordered lists
    if (/^\s*\d+\.\s+/.test(line)) {
      const match = line.match(/^(\s*)(\d+\.)\s+(.+)$/);
      if (match) {
        const [, indent, num, content] = match;
        const numStyled = this.painter.bold(num!, "electric");
        const firstPrefix = `${this.prefix}${indent}${numStyled} `;
        const continuationPrefix = `${this.prefix}${indent}${" ".repeat(num!.length + 1)}`;
        return this.wrapStyledLine(content!, firstPrefix, continuationPrefix, (row) => this.formatInline(row));
      }
    }

    // Blockquotes
    if (line.startsWith("> ") || line === ">") {
      const quote = line.slice(2);
      const quotePrefix = this.painter.text(`${this.prefix}│ `, "rule");
      return this.wrapStyledLine(quote, quotePrefix, quotePrefix, (row) => this.painter.dim(this.formatInline(row)));
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      return this.painter.text(`${this.prefix}${"─".repeat(Math.max(0, this.width - visibleLength(this.prefix)))}`, "rule");
    }

    // Regular line with inline formatting
    return this.wrapRegularLine(line);
  }

  private wrapRegularLine(line: string): string {
    if (!line.trim()) return this.prefix;
    return this.wrapStyledLine(line, this.prefix, this.prefix, (row) => this.formatInline(row));
  }

  private wrapStyledLine(
    content: string,
    firstPrefix: string,
    continuationPrefix: string,
    format: (row: string) => string,
  ): string {
    const maxPrefixWidth = Math.max(0, this.width - 2);
    const safeFirstPrefix = truncateText(firstPrefix, maxPrefixWidth);
    const safeContinuationPrefix = truncateText(continuationPrefix, maxPrefixWidth);
    const contentWidth = Math.max(2, this.width - Math.max(
      visibleLength(safeFirstPrefix),
      visibleLength(safeContinuationPrefix),
    ));
    return wrapDisplayText(content, contentWidth).map((row, index) =>
      `${index === 0 ? safeFirstPrefix : safeContinuationPrefix}${format(row)}`
    ).join("\n");
  }

  private formatInline(text: string): string {
    if (!this.painter.enabled) return text;

    // Inline code `code`
    let result = text.replace(/`([^`]+)`/g, (_, code) => {
      return this.painter.text(code, "electric");
    });

    // Bold **text** or __text__
    result = result.replace(/\*\*([^*]+)\*\*/g, (_, boldText) => {
      return this.painter.bold(boldText, "paper");
    });

    // Italic *text* or _text_
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, italicText) => {
      return this.painter.italic(italicText, "secondary");
    });

    return result;
  }

  private highlightCode(code: string): string {
    return highlightCodeWithLanguage(code, this.codeBlockLang, this.painter, this.highlightState);
  }
}

export * from "./highlight.ts";
export * from "./tensor-mark.ts";
