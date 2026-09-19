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
  /// A second palette color, alternated frame by frame, so a moving mark also
  /// moves through the brand's colors instead of holding one flat tone.
  accent?: PaletteColor;
}

/// The animated states, each in one light glyph family so no frame jumps in
/// weight or shape, and each pulsing between two palette colors so the motion
/// carries the brand rather than a flat tone.
///
/// The palette pairs are deliberate: the blue states breathe between `electric`
/// and `electricBright`, `working` shifts blue to `citron` as work completes,
/// `verifying` shifts back, and `waiting` flashes `signal` because it is asking
/// for the user. Nothing uses a filled half-circle (`◐ ◓ ◑ ◒`): their weight
/// clashed with every other state's light geometry.
const PRESENCE: Record<PresenceState, PresenceSpec> = {
  idle: { frames: ["◇", "◆", "◆", "◇"], periodMs: 2600, color: "secondary", accent: "paper" },
  listening: { frames: ["◆", "◇", "◆", "◇"], periodMs: 1500, color: "electric", accent: "electricBright" },
  thinking: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], periodMs: 900, color: "electric", accent: "electricBright" },
  reasoning: { frames: ["◌", "○", "◍", "●", "◍", "○"], periodMs: 1300, color: "electricBright", accent: "electric" },
  working: { frames: ["◜", "◝", "◞", "◟"], periodMs: 760, color: "electric", accent: "citron" },
  writing: { frames: ["▏", "▎", "▍", "▌", "▍", "▎"], periodMs: 620, color: "electric", accent: "electricBright" },
  verifying: { frames: ["·", "•", "●", "•"], periodMs: 680, color: "citron", accent: "electricBright" },
  waiting: { frames: ["◆", "◇", "◇", "◆"], periodMs: 1100, color: "signal", accent: "electricBright" },
  done: { frames: ["✓"], periodMs: 0, color: "citron" },
  stopped: { frames: ["×"], periodMs: 0, color: "secondary" },
  error: { frames: ["×"], periodMs: 0, color: "signal" },
};

/// The state's glyph at a moment in time. Static when the frame set has one
/// entry or the painter is disabled, so plain output stays byte-stable.
export function renderPresence(state: PresenceState, nowMs: number, painter: Painter): string {
  const spec = PRESENCE[state];
  if (spec.frames.length === 1 || !painter.enabled || spec.periodMs === 0) {
    return painter.text(spec.frames[0]!, spec.color);
  }
  const frameMs = spec.periodMs / spec.frames.length;
  const index = Math.floor(nowMs / frameMs) % spec.frames.length;
  // The accent covers the second half of the cycle rather than alternating
  // every frame: at a 90-190ms frame rate, per-frame alternation reads as a
  // flicker instead of a pulse.
  const half = Math.ceil(spec.frames.length / 2);
  const color = index < half || !spec.accent ? spec.color : spec.accent;
  return painter.text(spec.frames[index]!, color);
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


