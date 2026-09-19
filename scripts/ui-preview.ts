#!/usr/bin/env bun
/// Renders the harness design live in your terminal.
///
/// Run `bun run ui:preview`. It cycles the agent through considering, writing,
/// and waiting-for-approval so you can judge the motion and the grid on your
/// own screen, then exits cleanly.

import {
  createPainter,
  formatPulseLine,
  formatToolRow,
  formatTurnOpener,
  HARNESS,
  renderPresence,
  streamingCaret,
  visibleLength,
  type PresenceState,
} from "../packages/brand/src/index.ts";

const paint = createPainter(true, "dark");
const width = Math.min(110, (process.stdout.columns ?? 100) - 1);
const ESC = "\x1b";
const out = process.stdout;

const SESSION = "parser hardening";
const MODEL = "qwen3.8-27b · llama.cpp";

interface Scene {
  state: PresenceState;
  intensity: number;
  footer: string;
  rows: (frame: number) => string[];
}

const head = (label: string) => `${" ".repeat(HARNESS.mark)}${label} `;
const indent = " ".repeat(HARNESS.content);

/// The transcript up to the current scene, so each scene reads as a live
/// continuation of the same turn.
const baseRows = (frame: number, state: PresenceState): string[] => [
  formatTurnOpener("you", "21:03", width, paint),
  `${indent}${paint.bold("fix the parser", "paper")}`,
  "",
  `${indent}${paint.text("⋯", "rule")} ${paint.dim("thought 4.2s · ctrl+x")}`,
  formatToolRow("done", "read", "src/lexer.ts", "12ms", width, paint),
  "",
  `${head(renderPresence(state === "waiting" ? "writing" : state, Date.now(), paint))}`
    + `I read the guard. It rejects everything above 127, so I will narrow it`,
  `${indent}to a proper unicode check and add a regression test.`,
  "",
];

const scenes: Scene[] = [
  {
    state: "writing",
    intensity: 0.85,
    footer: "writing · 0:06 · 18.2 tok/s",
    rows: (frame) => [
      ...baseRows(frame, "writing"),
      formatToolRow("running", "edit", "src/lexer.ts", undefined, width, paint, renderPresence("writing", Date.now(), paint)),
      "",
      `${head(renderPresence("writing", Date.now(), paint))}${paint.dim("so the fix is")}${streamingCaret(paint)}`,
    ],
  },
  {
    state: "waiting",
    intensity: 0.3,
    footer: "needs your go-ahead · 0:19",
    rows: (frame) => [
      ...baseRows(frame, "waiting"),
      formatToolRow("waiting", "edit", "src/lexer.ts", "needs you", width, paint, renderPresence("waiting", Date.now(), paint)),
      `${indent}${paint.text("- if (c > 127) throw new Error(\"bad byte\")", "signal")}`,
      `${indent}${paint.text("+ if (c > 0x7f) continue", "citron")}`,
      "",
      `${indent}${paint.dim("allow once  ·  always here  ·  always (save)  ·  deny")}`,
    ],
  },
  {
    state: "idle",
    intensity: 0.12,
    footer: "ready",
    rows: (frame) => [
      ...baseRows(frame, "idle"),
      formatToolRow("done", "edit", "src/lexer.ts", "8ms", width, paint),
      `${indent}${paint.text("- if (c > 127) throw new Error(\"bad byte\")", "signal")}`,
      `${indent}${paint.text("+ if (c > 0x7f) continue", "citron")}`,
      formatToolRow("done", "run", "$ bun test", "1.2s", width, paint),
      `${indent}${paint.dim("610 pass · 0 fail")}`,
      "",
      `${head(paint.text("◆", "citron"))}I changed the guard and the tests pass.`,
      "",
      `${indent}${paint.text("✓", "citron")} ${paint.dim("I’m done — 7.4s · 4 rounds · 3 tools · 384 tok · 18.2 tok/s")}`,
    ],
  },
];

function header(): string {
  const left = `${" ".repeat(HARNESS.margin)}${paint.text("◈", "electric")} ${paint.bold("demesne", "paper")}`
    + paint.dim(` · ${SESSION}`);
  const right = paint.dim(MODEL);
  const padding = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(padding)}${right}`;
}

function composer(scene: Scene): string[] {
  const mark = renderPresence(scene.state === "waiting" ? "waiting" : "listening", Date.now(), paint);
  const prompt = scene.state === "waiting"
    ? paint.dim("waiting for you")
    : paint.dim("ask anything · / for commands");
  return [`${" ".repeat(HARNESS.mark)}${mark} ${prompt}`];
}

function footer(scene: Scene): string {
  const left = `  ${renderPresence(scene.state, Date.now(), paint)} ${paint.bold(scene.footer.split(" ·")[0]!, "paper")} `
    + paint.dim(`· ${scene.footer.split(" · ").slice(1).join(" · ")}`);
  const right = paint.dim(`${MODEL.split(" ·")[0]} · main · ▰▰▱▱▱ 4% · swap 7.1G`);
  const padding = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(padding)}${right}`;
}

function render(frame: number): void {
  const scene = scenes[Math.floor(frame / 14) % scenes.length]!;
  const rows = scene.rows(frame);
  const body = rows.slice(0, Math.max(0, 22));
  out.write(`${ESC}[2J${ESC}[H`);
  out.write(`${header()}\n`);
  for (const line of body) out.write(`${line}\n`);
  // Fill to the composer so the pulse always sits directly above it.
  for (let i = body.length; i < 22; i++) out.write("\n");
  out.write(`${formatPulseLine(width, pulseProgress(scene.state), scene.intensity, paint)}\n`);
  for (const line of composer(scene)) out.write(`${line}\n`);
  out.write(`${footer(scene)}\n`);
}

function pulseProgress(state: PresenceState): number {
  const now = Date.now();
  const active = state === "writing" || state === "working" || state === "verifying";
  const thinking = state === "thinking" || state === "reasoning";
  const period = active ? 1_100 : thinking ? 2_600 : 7_000;
  return (now % period) / period;
}

out.write(`${ESC}[?1049h${ESC}[?25l`);
let frame = 0;
const timer = setInterval(() => {
  render(frame);
  frame += 1;
  if (frame > 14 * 3 + 6) {
    clearInterval(timer);
    out.write(`${ESC}[?25h${ESC}[0m\n`);
    process.exit(0);
  }
}, 420);

process.on("SIGINT", () => {
  out.write(`${ESC}[?25h${ESC}[0m\n`);
  process.exit(0);
});