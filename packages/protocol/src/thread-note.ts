/// Words an orchestrator passes to one of its threads with `message_thread`.
/// They open with a line saying who they are from and what they are for, so
/// the thread's model knows they aren't the person's own words, and the
/// window draws them as a short note with its purpose instead of as
/// something "you" typed.

export const THREAD_NOTE_HEADER = "From the orchestrator · ";
/// A note is a correction, a rule or an answer, never a document.
export const THREAD_NOTE_MAX_CHARS = 1_200;
export const THREAD_NOTE_PURPOSE_MAX_CHARS = 80;

export interface ThreadNote { purpose: string; text: string }

export function formatThreadNote(note: ThreadNote): string {
  return `${THREAD_NOTE_HEADER}${note.purpose.replace(/\s+/g, " ").trim().slice(0, THREAD_NOTE_PURPOSE_MAX_CHARS)}\n\n${note.text.trim()}`;
}

export function parseThreadNote(content: string): ThreadNote | null {
  if (!content.startsWith(THREAD_NOTE_HEADER)) return null;
  const [head = "", ...rest] = content.split("\n\n");
  const purpose = head.slice(THREAD_NOTE_HEADER.length).trim();
  return purpose ? { purpose, text: rest.join("\n\n").trim() } : null;
}
