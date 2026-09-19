import type { Painter, PaletteColor } from "./index.ts";

/// The agent's visible presence.
///
/// A single animated glyph carries the state — idle, listening, thinking,
/// reasoning, working, writing, checking, waiting, done — so the interface shows
/// what is happening without narrating it. Motion is deterministic for a given
/// timestamp and fully disabled under reduced motion or `NO_COLOR`, where the
/// state's static glyph is used.

export type PresenceState =
  | "idle"
  | "listening"
  | "thinking"
  | "reasoning"
  | "working"
  | "writing"
  | "verifying"
  | "waiting"
  | "done"
  | "stopped"
  | "error";

interface PresenceSpec {
  frames: readonly string[];
  periodMs: number;
  color: PaletteColor;
}

/// The animated states, each in one light glyph family so no frame jumps in
/// weight or shape, and each holding a single color.
///
/// The inference spinner (`thinking`) is deliberately uncolored: it is the mark
/// on screen the longest, and a color there competes with the turn's real
/// status. Color is reserved for states that mean something — `waiting` in
/// `signal` because it is asking for the user, `verifying` and `done` in
/// `citron`. Nothing uses a filled half-circle (`◐ ◓ ◑ ◒`): their weight
/// clashed with every other state's light geometry.
const PRESENCE: Record<PresenceState, PresenceSpec> = {
  idle: { frames: ["◇", "◆", "◆", "◇"], periodMs: 2600, color: "secondary" },
  listening: { frames: ["◆", "◇", "◆", "◇"], periodMs: 1500, color: "electric" },
  thinking: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], periodMs: 900, color: "secondary" },
  reasoning: { frames: ["◌", "○", "◍", "●", "◍", "○"], periodMs: 1300, color: "electricBright" },
  working: { frames: ["◜", "◝", "◞", "◟"], periodMs: 760, color: "electric" },
  writing: { frames: ["▏", "▎", "▍", "▌", "▍", "▎"], periodMs: 620, color: "electric" },
  verifying: { frames: ["·", "•", "●", "•"], periodMs: 680, color: "citron" },
  waiting: { frames: ["◆", "◇", "◇", "◆"], periodMs: 1100, color: "signal" },
  done: { frames: ["✓"], periodMs: 0, color: "citron" },
  stopped: { frames: ["×"], periodMs: 0, color: "secondary" },
  error: { frames: ["×"], periodMs: 0, color: "signal" },
};

/// Glyphs drawn by states that animate.
///
/// A flickering shape repeated in two places reads as a rendering fault, so the
/// transcript's static marks stay outside this set. Single-frame states (`done`,
/// `stopped`, `error`) are excluded: `✓` and `×` mean the same thing wherever
/// they appear, and a finished tool row and a finished turn sharing one is not
/// the duplication that reads as a mistake.
export function animatedPresenceGlyphs(): Set<string> {
  const glyphs = new Set<string>();
  for (const spec of Object.values(PRESENCE)) {
    if (spec.frames.length > 1) {
      for (const frame of spec.frames) glyphs.add(frame);
    }
  }
  return glyphs;
}

/// Every glyph the footer's states can draw.
///
/// The transcript's static marks must stay outside this set, so a row and the
/// status line below it never show the same shape at the same time. That
/// duplication has been reported more than once, so it is asserted in tests.
export function presenceGlyphs(): Set<string> {
  const glyphs = new Set<string>();
  for (const spec of Object.values(PRESENCE)) {
    for (const frame of spec.frames) glyphs.add(frame);
  }
  return glyphs;
}

/// The state's glyph at a moment in time. Static when the frame set has one
/// entry or the painter is disabled, so plain output stays byte-stable.
export function renderPresence(state: PresenceState, nowMs: number, painter: Painter): string {
  const spec = PRESENCE[state];
  if (spec.frames.length === 1 || !painter.enabled || spec.periodMs === 0) {
    return painter.text(spec.frames[0]!, spec.color);
  }
  const frameMs = spec.periodMs / spec.frames.length;
  const index = Math.floor(nowMs / frameMs) % spec.frames.length;
  return painter.text(spec.frames[index]!, spec.color);
}

/// The state's name in the footer. These are the conventional words for what a
/// model is doing, not a narration of it: the footer says which state the turn
/// is in, and nothing speaks as though it had feelings or intentions.
export function presenceLabel(state: PresenceState): string {
  switch (state) {
    case "idle": return "ready";
    case "listening": return "listening";
    case "thinking": return "thinking";
    case "reasoning": return "reasoning";
    case "working": return "working";
    case "writing": return "writing";
    case "verifying": return "checking";
    case "waiting": return "needs approval";
    case "done": return "done";
    case "stopped": return "stopped";
    case "error": return "failed";
  }
}

/// Maps a tool name to the presence state it implies. Validation commands
/// check, edits write, everything else works.
export function presenceForTool(name: string, isValidation: boolean): PresenceState {
  if (name === "edit_file" || name === "write_file" || name === "move_path" || name === "delete_path") return "writing";
  if (isValidation) return "verifying";
  return "working";
}


