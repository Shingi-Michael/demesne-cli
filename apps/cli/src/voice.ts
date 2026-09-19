/// The agent's voice for turn-level narration.
///
/// Tool rows are structural (verb, target, duration) so they can be scanned,
/// which means the first-person voice belongs at the boundaries of a turn: the
/// question it asks before acting, and the account it gives when finished.

/// A soft first-person cue for a turn that needs approval.
export function narrateWaiting(summary: string): string {
  return `I need your go-ahead: ${sentence(summary)}`;
}

/// Closers for turn ends, in the agent's voice.
export function narrateTurnEnd(
  kind: "completed" | "stopped" | "failed",
  details: string,
): string {
  switch (kind) {
    case "completed":
      return `I’m done${details ? ` — ${details}` : "."}`;
    case "stopped":
      return `I stopped${details ? ` — ${details}` : "."}`;
    case "failed":
      return `I hit a problem${details ? ` — ${details}` : "."}`;
  }
}

/// Normalizes untrusted text into a single safe clause: control characters
/// removed, whitespace collapsed, length bounded, trailing punctuation dropped
/// so the caller controls the sentence ending.
export function sentence(value: string): string {
  const sanitized = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const text = sanitized.length > 200 ? `${sanitized.slice(0, 199)}…` : sanitized;
  return text.replace(/[.!?]+$/, "");
}
