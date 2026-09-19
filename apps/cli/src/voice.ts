/// The harness's own wording for turn boundaries.
///
/// These are status lines, not narration. The footer and the turn closer say
/// which state the turn reached; nothing speaks in the first person or claims
/// intentions. The model's own prose is untouched and is the only voice in the
/// transcript.

/// A status cue for a turn that is blocked on the user.
export function narrateWaiting(summary: string): string {
  return `needs approval: ${sentence(summary)}`;
}

/// Closers for turn ends.
export function narrateTurnEnd(
  kind: "completed" | "stopped" | "failed",
  details: string,
): string {
  const label = kind === "completed" ? "done" : kind === "stopped" ? "stopped" : "failed";
  return details ? `${label} — ${details}` : label;
}

/// Normalizes untrusted text into a single safe clause: control characters
/// removed, whitespace collapsed, length bounded, trailing punctuation dropped
/// so the caller controls the sentence ending.
export function sentence(value: string): string {
  const sanitized = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const text = sanitized.length > 200 ? `${sanitized.slice(0, 199)}…` : sanitized;
  return text.replace(/[.!?]+$/, "");
}
