/// Chat notes: one fixed start per chat. A provider's prompt cache reuses a
/// request only as far as it repeats the one before it, and the instructions
/// and the tool list come first. So nothing that can change during a chat
/// lives there any more. Plan mode, who approves, whether anyone is at the
/// window, what Drive and the other agents are doing, the sources you keep:
/// each is told to the model as a note that goes out with the message it
/// came with, after its text, and stays with that message from then on. The
/// conversation only ever grows at its end, so the cache holds.
///
/// A note is sent when what it says differs from the last note of its kind
/// still in the conversation; a few short ones (plan mode, the hidden note
/// of a long chat) repeat with every message while they hold. What the
/// engine allows is decided where a tool runs, not by the note.
///
/// Read more: https://code.claude.com/docs/en/prompt-caching#what-invalidates-the-cache
/// (why the start must stay the same) and
/// https://developers.openai.com/api/docs/guides/prompt-caching#structuring-prompts
/// (static content first, what changes last).
import type { ChatNote } from "@demesne/protocol";
import type { ProviderMessage } from "@demesne/providers";
import { NOTE_INSTRUCTION } from "./turn-notes.ts";

/// One thing a chat can be told. `text` null: its usual state, nothing to say.
export interface NoteState {
  kind: string;
  text: string | null;
  /// What to say when it goes back to its usual state. None: say nothing.
  off?: string;
  /// Said with every message while it holds, not only when it changes.
  everyTurn?: boolean;
}

const OPEN = "<system-note>", CLOSE = "</system-note>";

/// The one line the instructions carry about notes. It never changes.
export const NOTES_GUIDANCE = `A message may end with a ${OPEN} block. It is from Demesne, not the person: it says what has changed in this chat (plan mode, approvals, whether anyone is at the window, Drive, sources). Follow the latest note of each kind, and never mention the notes.`;

export const PLAN_NOTE = "Plan mode is on: this message is read-only for the project. Inspect with the read and search tools, do not attempt edits or commands (they are refused), and finish with a concise, ordered plan the user can approve. Foundry pages are allowed: they change no project files.";
const PLAN_OFF = "Plan mode is off: edits and commands are available again.";
const AUTO_APPROVE_NOTE = "Session auto-approve is on: the user authorizes all tool approvals, including file changes, host commands and publishing, within the requested task. Execute necessary actions without requesting tool approval. Follow explicit read-only or no-edit instructions; workspace restrictions and tool validation still apply.";
const ACCEPT_EDITS_NOTE = "Accept edits is on for this session: file edits, new files and moves run without approval. Deletes and host commands still ask, so batch commands sensibly.";
const APPROVALS_OFF = "Approvals are back to usual: reads are automatic; edits and commands need approval.";
const WINDOW_OFF = "The person is at the window again: open, show and ask_user work, and Foundry pages are for them to look at.";
const CONTEXT_OFF = "The earlier note about Drive and the other agents no longer applies.";
const SOURCES_OFF = "No sources are kept with this chat any more.";

export function unattendedNote(canAsk: boolean): string {
  return `Nobody is watching this message (Drive, a routine or a turn that runs on its own): open and show are refused${canAsk ? "" : ", and so is ask_user, so decide small things yourself and say what you chose"}. Make a Foundry page only when the task asks for a page, a mockup or a design, and don't offer to save skills.`;
}

/// Everything a chat can be told, from how this message arrived.
export function noteStates(now: { planOnly: boolean; autoApprove: boolean; acceptEdits: boolean; attended: boolean; canAsk: boolean;
  hint?: string | null; context?: string | null; sources?: string | null; noting: boolean }): NoteState[] {
  return [
    { kind: "plan", text: now.planOnly ? PLAN_NOTE : null, off: PLAN_OFF, everyTurn: true },
    { kind: "approvals", text: now.autoApprove ? AUTO_APPROVE_NOTE : now.acceptEdits ? ACCEPT_EDITS_NOTE : null, off: APPROVALS_OFF },
    { kind: "window", text: now.attended ? null : unattendedNote(now.canAsk), off: WINDOW_OFF },
    { kind: "context", text: now.context?.trim() || null, off: CONTEXT_OFF },
    { kind: "sources", text: now.sources?.trim() || null, off: SOURCES_OFF },
    { kind: "hint", text: now.hint?.trim() || null, everyTurn: true },
    { kind: "long-chat", text: now.noting ? NOTE_INSTRUCTION.trim() : null, everyTurn: true },
  ];
}

/// The last note of each kind the conversation still holds. Turns that were
/// compacted away took their notes with them, so what they said is said again.
export function lastNotes(messages: readonly ProviderMessage[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const message of messages) if (message.role === "user") for (const note of message.notes ?? []) last.set(note.kind, note.text);
  return last;
}

/// The notes this message carries: what differs from what the chat was last told.
export function notesFor(states: readonly NoteState[], history: readonly ProviderMessage[]): ChatNote[] {
  const last = lastNotes(history), notes: ChatNote[] = [];
  for (const state of states) {
    const told = last.get(state.kind);
    // Back to usual is only worth saying after something else was said.
    const text = state.text ?? (told !== undefined && state.off && told !== state.off ? state.off : null);
    if (text && (text !== told || (state.everyTurn && state.text !== null))) notes.push({ kind: state.kind, text });
  }
  return notes;
}

/// A message as the provider gets it: its notes after its text. The stored
/// message keeps them apart, so search, exports and the notes of a compacted
/// turn read only what the person wrote.
export function withNotes<Message extends ProviderMessage>(message: Message): Message {
  if (message.role !== "user" || !message.notes?.length) return message;
  const { notes, ...rest } = message;
  return { ...rest, content: `${message.content}\n\n${OPEN}\n${notes.map((note) => note.text).join("\n")}\n${CLOSE}` } as Message;
}

/// A message's own text, without the notes sent after it.
export function withoutNotes(content: string): string {
  const at = content.lastIndexOf(`\n\n${OPEN}\n`);
  return at >= 0 && content.endsWith(CLOSE) ? content.slice(0, at) : content;
}
