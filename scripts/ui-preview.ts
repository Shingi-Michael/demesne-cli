#!/usr/bin/env bun
/// Renders the harness design live in your terminal.
///
/// Run `bun run ui:preview`. It cycles the agent through writing, waiting for
/// approval, and done so you can judge the structure, color, and motion on your
/// own screen, then exits cleanly.

import {
  createPainter,
  formatToolRow,
  formatTurnCloser,
  formatTurnOpener,
  HARNESS,
  renderPresence,
  streamingCaret,
  toolPhaseColor,
  turnRail,
  visibleLength,
  type PresenceState,
  type ToolPhaseName,
} from "../packages/brand/src/index.ts";

const paint = createPainter(true, "dark");
const width = Math.min(110, (process.stdout.columns ?? 100) - 1);
const ESC = "\x1b";
const out = process.stdout;

const SESSION = "parser hardening";
const WORKSPACE = "…/projects/demesne-cli";
const BRANCH = "main";
const MODEL = "qwen3.8-27b";

const rail = turnRail(paint);
const bar = paint.text("│", "rule");
const rule = paint.text(`${" ".repeat(HARNESS.margin)}${"─".repeat(Math.max(4, width - HARNESS.margin - HARNESS.gutter))}`, "rule");
const indent = " ".repeat(HARNESS.content);

/// The header carries identity; the footer carries live state. The model
/// appears once, in the footer.
function header(): string {
  const left = `${" ".repeat(HARNESS.margin)}${paint.text("◈", "electric")} ${paint.bold("demesne", "paper")}`
    + paint.dim(` · ${SESSION}`);
  const right = paint.dim(`${WORKSPACE} · ${BRANCH}`);
  const padding = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(padding)}${right}`;
}

function toolRow(
  state: "done" | "failed" | "running" | "waiting",
  phase: ToolPhaseName,
  verb: string,
  target: string,
  meta: string | undefined,
  mark?: string,
): string {
  return formatToolRow(state, verb, target, meta, width, paint, { phase, ...(mark ? { mark } : {}) });
}

/// Transcript shared by every scene, so each scene reads as the same turn
/// progressing rather than as a different example.
const transcript = (state: PresenceState): string[] => [
  formatTurnOpener("you", "21:03", width, paint),
  `${indent}${paint.bold("fix the parser", "paper")}`,
  `${rail}${paint.text("⋯", "rule")} ${paint.dim("thought 4.2s · ctrl+x")}`,
  toolRow("done", "inspect", "read", "src/lexer.ts", "12ms"),
  "",
  `${" ".repeat(HARNESS.rail)}${bar} ${state === "done" ? paint.text("◆", "citron") : renderPresence("writing", Date.now(), paint)} `
    + `I read the guard. It rejects everything above 127, so I will`,
  `${rail}narrow it to a proper unicode check and add a regression test.`,
  "",
];

interface Scene {
  state: PresenceState;
  status: string;
  rows: () => string[];
}

const scenes: Scene[] = [
  {
    state: "writing",
    status: "writing · 0:06 · 18.2 tok/s",
    rows: () => [
      ...transcript("writing"),
      toolRow("running", "change", "edit", "src/lexer.ts", undefined, renderPresence("writing", Date.now(), paint)),
      `${indent}${paint.text("- if (c > 127) throw new Error(\"bad byte\")", "signal")}`,
      `${indent}${paint.text("+ if (c > 0x7f) continue", "citron")}`,
      "",
      `${" ".repeat(HARNESS.rail)}${bar} ${renderPresence("writing", Date.now(), paint)} ${paint.dim("so the fix is")}${streamingCaret(paint)}`,
    ],
  },
  {
    state: "waiting",
    status: "needs your go-ahead · 0:19",
    rows: () => [
      ...transcript("waiting"),
      toolRow("waiting", "change", "edit", "src/lexer.ts", "needs you", renderPresence("waiting", Date.now(), paint)),
      `${indent}${paint.text("- if (c > 127) throw new Error(\"bad byte\")", "signal")}`,
      `${indent}${paint.text("+ if (c > 0x7f) continue", "citron")}`,
      "",
      `${rail}${paint.dim("allow once  ·  always here  ·  always (save)  ·  deny")}`,
    ],
  },
  {
    state: "idle",
    status: "ready",
    rows: () => [
      ...transcript("idle"),
      toolRow("done", "change", "edit", "src/lexer.ts", "8ms"),
      `${indent}${paint.text("- if (c > 127) throw new Error(\"bad byte\")", "signal")}`,
      `${indent}${paint.text("+ if (c > 0x7f) continue", "citron")}`,
      toolRow("done", "verify", "run", "$ bun test", "1.2s"),
      `${rail}${paint.dim("610 pass · 0 fail")}`,
      "",
      `${" ".repeat(HARNESS.rail)}${bar} ${paint.text("◆", "citron")} I changed the guard and the tests pass.`,
      "",
      formatTurnCloser("I’m done — 7.4s · 4 rounds · 3 tools · 384 tok · 18.2 tok/s", width, paint),
    ],
  },
];

const ROWS = 22;

function composer(scene: Scene): string {
  const mark = renderPresence(scene.state === "waiting" ? "waiting" : "listening", Date.now(), paint);
  const prompt = scene.state === "waiting"
    ? paint.dim("waiting for you")
    : paint.dim("ask anything · / for commands");
  const hint = paint.dim("⏎ send · ^O editor");
  const left = `${" ".repeat(HARNESS.rail)}${mark} ${prompt}`;
  const padding = Math.max(1, width - visibleLength(left) - visibleLength(hint) - HARNESS.gutter);
  return `${left}${" ".repeat(padding)}${hint}`;
}

function footer(scene: Scene): string {
  const label = scene.status.split(" ·")[0]!;
  const rest = scene.status.split(" · ").slice(1).join(" · ");
  const left = `  ${renderPresence(scene.state, Date.now(), paint)} ${paint.bold(label, "paper")}`
    + (rest ? paint.dim(` · ${rest}`) : "");
  const right = `${paint.text("✓", "citron")} ${paint.dim(`ngram-mod · ${MODEL} · ▰▰▱▱▱ 4%`)}`;
  const padding = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(padding)}${right}`;
}

function render(frame: number): void {
  const scene = scenes[Math.floor(frame / 14) % scenes.length]!;
  const body = scene.rows();
  out.write(`${ESC}[2J${ESC}[H`);
  out.write(`${header()}\n`);
  out.write(`${rule}\n`);
  for (let i = 0; i < ROWS; i++) out.write(`${body[i] ?? ""}\n`);
  out.write(`${rule}\n`);
  out.write(`${composer(scene)}\n`);
  out.write(`${footer(scene)}\n`);
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