import type { Painter, PaletteColor } from "./index.ts";

/// The agent's visible presence.
///
/// A single animated glyph carries the agent's state — idle, listening,
/// considering, reasoning, working, writing, checking, waiting, done — so the
/// interface feels alive without pretending to be conscious. Motion is
/// deterministic for a given timestamp and fully disabled under reduced motion
/// or `NO_COLOR`, where the state's static glyph is used.

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

const PRESENCE: Record<PresenceState, PresenceSpec> = {
  idle: { frames: ["◇", "◆", "◆", "◇"], periodMs: 2600, color: "secondary" },
  listening: { frames: ["◆", "◇", "◆", "◇"], periodMs: 1500, color: "electric" },
  thinking: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], periodMs: 900, color: "electric" },
  reasoning: { frames: ["◌", "○", "◍", "●", "◍", "○"], periodMs: 1300, color: "electricBright" },
  working: { frames: ["◐", "◓", "◑", "◒"], periodMs: 760, color: "electric" },
  writing: { frames: ["▖", "▌", "▛", "▜", "▌", "▖"], periodMs: 620, color: "electric" },
  verifying: { frames: ["·", "•", "●", "•"], periodMs: 680, color: "citron" },
  waiting: { frames: ["◆", "◇", "◇", "◆"], periodMs: 1100, color: "signal" },
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
  return painter.text(spec.frames[index]!, spec.color);
}

/// Narrative wording for the footer. Present tense, no false claims: the label
/// says what is actually happening, not what the agent "feels".
export function presenceLabel(state: PresenceState): string {
  switch (state) {
    case "idle": return "ready";
    case "listening": return "listening";
    case "thinking": return "considering";
    case "reasoning": return "reasoning";
    case "working": return "working";
    case "writing": return "writing";
    case "verifying": return "checking";
    case "waiting": return "needs your go-ahead";
    case "done": return "done";
    case "stopped": return "stopped";
    case "error": return "hit a problem";
  }
}

/// Maps a tool name to the presence state it implies. Validation commands
/// check, edits write, everything else works.
export function presenceForTool(name: string, isValidation: boolean): PresenceState {
  if (name === "edit_file" || name === "write_file" || name === "move_path" || name === "delete_path") return "writing";
  if (isValidation) return "verifying";
  return "working";
}

/// A traveling highlight for the assistant rail while text streams. Returns
/// the styled rail cell for a given row; reduced motion and plain output get a
/// steady dim rail.
export function renderRailCell(row: number, nowMs: number, painter: Painter, streaming: boolean): string {
  if (!streaming || !painter.enabled) return painter.text("│", "rule");
  const wave = Math.sin((nowMs / 420) - row * 0.55);
  if (wave > 0.82) return painter.text("┃", "electric");
  if (wave > 0.4) return painter.text("│", "secondary");
  return painter.text("│", "rule");
}
