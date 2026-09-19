#!/usr/bin/env bun
/// Renders the target redesign as a live preview in your terminal.
///
/// This is the spec: run it, look at it for a few seconds, and judge the
/// visual itself. It cycles through the agent's states — considering, then
/// waiting for your go-ahead — and exits cleanly after about six seconds.

const BASE = "#0A0C14";
const PANEL = "#11141F";
const TEXT = "#E8ECF8";
const MUTED = "#6E7691";
const CYAN = "#58C6FF";
const VIOLET = "#8F7BFF";
const MINT = "#3DF0B0";
const AMBER = "#FFB454";
const RED = "#FF5C7A";

const ESC = "\x1b";
const out = process.stdout;
const width = Math.min(120, (process.stdout.columns ?? 100) - 2);

function hex(color: string): [number, number, number] {
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[f(r1, r2), f(g1, g2), f(b1, b2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const fg = (color: string) => `${ESC}[38;2;${hex(color).join(";")}m`;
const bg = (color: string) => `${ESC}[48;2;${hex(color).join(";")}m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

/// Gradient wordmark: cyan melting into violet, one letter at a time.
function wordmark(): string {
  const letters = [..."demesne"];
  return letters
    .map((letter, index) => `${BOLD}${fg(mix(CYAN, VIOLET, index / (letters.length - 1)))}${letter}`)
    .join("")
    + RESET;
}

/// The core: a faint panel block behind a bright state glyph.
function core(frame: number, color: string, glyphs: string[]): string {
  const glyph = glyphs[frame % glyphs.length]!;
  return `${bg(PANEL)} ${fw(color, 0.25)}${BOLD}${glyph}${RESET}${bg(PANEL)} ${RESET}`;
}

function fw(color: string, t: number): string {
  const [r, g, b] = hex(color);
  const f = (x: number) => Math.round(x + (255 - x) * t);
  return `${ESC}[38;2;${f(r)};${f(g)};${f(b)}m`;
}

/// A hairline with one traveling light.
function rule(frame: number): string {
  let value = " " + DIM;
  for (let index = 0; index < width; index++) {
    const distance = Math.abs(index - ((frame * 2) % width));
    const t = Math.max(0, 1 - distance / 7);
    value += t > 0 ? fg(mix("#1B2130", CYAN, t)) : fg("#1B2130");
    value += "─";
  }
  return value + RESET;
}

function meter(ratio: number, color: string): string {
  const filled = Math.round(ratio * 5);
  return `${fg(color)}${"▰".repeat(filled)}${fg("#232A3D")}${"▱".repeat(5 - filled)}${RESET}`;
}

function sparkline(frame: number): string {
  const glyphs = "▁▂▃▄▅▆▇█";
  const values = [0.15, 0.3, 0.6, 0.85, 1, 0.75, 0.5, 0.35, 0.25];
  const shift = Math.floor(frame / 4) % values.length;
  return values
    .map((value, index) => {
      const next = values[(index + shift) % values.length]!;
      const lit = index === values.length - 1 - (frame % 3);
      return `${fg(lit ? CYAN : "#33415F")}${glyphs[Math.round(next * (glyphs.length - 1))]!}`;
    })
    .join("") + RESET;
}

function padLine(left: string, right: string): string {
  let current = "  ";
  current += left;
  const rightWidth = [...right].length;
  const used = [...current].length;
  const padding = Math.max(1, width - 2 - used - rightWidth + 2);
  return current + " ".repeat(padding) + right + RESET;
}

const CONSIDERING = {
  label: "considering",
  core: ["◌", "○", "◍", "●", "◍", "○"],
  color: CYAN,
} as const;

const WAITING = {
  label: "needs your go-ahead",
  core: ["◆", "◇", "◇", "◆"],
  color: AMBER,
} as const;

function render(frame: number): void {
  const scene = Math.floor(frame / 24) % 2 === 0 ? CONSIDERING : WAITING;

  out.write(`${ESC}[2J${ESC}[H`);
  out.write(`${padLine(`${core(frame, scene.color, scene.core)}  ${wordmark()}`, `${DIM}${fg(MUTED)}fake-model · main`)}\n`);
  out.write(rule(frame) + "\n\n");

  // The user, right-aligned.
  out.write(`${padLine("", `${BOLD}${fg(TEXT)}fix the parser`) + `  ${DIM}${fg(MUTED)}21:03`}\n\n`);

  // The agent: core, then its voice.
  out.write(`  ${core(frame, scene.color, scene.core)}\n\n`);
  const lines: Array<[string, string]> = scene === CONSIDERING
    ? [
        [` ${fg(MUTED)}`, "I read src/lexer.ts."],
        [` ${fg(TEXT)}`, "I changed the unicode guard — here's the difference:"],
        [` ${fg(MINT)}`, "   + if (c > 0x7f) continue"],
        [` ${fg(RED)}`, "   - if (c > 127) throw"],
        [` ${DIM}${fg(MUTED)}`, "   I ran bun test — it passed."],
      ]
    : [
        [` ${fg(TEXT)}`, "I want to change src/lexer.ts."],
        [` ${fg(AMBER)}${BOLD}`, "waiting for your go-ahead"],
        [` ${fg(MINT)}`, "   + if (c > 0x7f) continue"],
        [` ${fg(RED)}`, "   - if (c > 127) throw"],
        [` ${DIM}${fg(MUTED)}`, "   allow once  ·  always here  ·  always (save)  ·  deny"],
      ];
  for (const [style, text] of lines) {
    out.write(`    ${style}${text}${RESET}\n`);
  }
  out.write(`    ${DIM}${fg(MUTED)}I'm done — 1.1s · 1 round · 3 tools · 14 t/s${RESET}\n\n\n`);

  // The input line.
  out.write(`  ${core(frame, scene.color, scene.core)}  ${DIM}${fg(MUTED)}this is where we talk — type / for commands${RESET}\n\n`);

  // The footer — kept exactly as today's contract.
  out.write(
    `  ${core(frame, scene.color, scene.core)} ${BOLD}${fg(scene.color)}${scene.label}${RESET}`
      + `  ${DIM}${fg(MUTED)}· 0:05 ·${RESET} ${sparkline(frame)} ${fg(MUTED)}14 t/s${RESET}`
      + `        ${DIM}${fg(MUTED)}✓ ngram-mod · fake-model · main · ${RESET}${meter(scene === CONSIDERING ? 0.42 : 0.45, scene.color)}\n`,
  );
}

out.write(`${ESC}[?1049h${ESC}[?25l`);
let frame = 0;
const timer = setInterval(() => {
  render(frame);
  frame += 1;
  if (frame > 24 * 3) {
    clearInterval(timer);
    out.write(`${ESC}[?25h${RESET}\n`);
    process.exit(0);
  }
}, 400);

process.on("SIGINT", () => {
  out.write(`${ESC}[?25h${RESET}\n`);
  process.exit(0);
});