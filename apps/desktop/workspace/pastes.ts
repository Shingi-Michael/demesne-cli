/// Big pastes fold up (pass 115): a long log or file pasted into the composer
/// becomes one chip instead of a wall of text. It's sent whole, as a fenced
/// block marked "paste", and the sent message shows that block as the same
/// chip, which unfolds on a click. The model still gets every line.

/// Long enough to fold: many lines, or one very long line.
export const foldsUp = (text: string) => text.split("\n").length >= 30 || text.length >= 3000;

export interface Paste { id: string; text: string }

const lines = (text: string) => text.replace(/\n$/, "").split("\n").length;
/// "Pasted text · 840 lines"
export const pasteLabel = (text: string) => `Pasted text · ${lines(text)} line${lines(text) === 1 ? "" : "s"}`;

/// Text in a fence longer than any it holds, marked with what it is.
export function fenced(text: string, info: "paste" | "parts"): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${fence}${info}\n${text.replace(/\n$/, "")}\n${fence}`;
}
/// The message with its pastes after it, each in a fence longer than any it holds.
export function withPastes(message: string, pastes: readonly Paste[]): string {
  return [message.trim(), ...pastes.map(({ text }) => fenced(text, "paste"))].filter(Boolean).join("\n\n");
}

export type MessagePiece = { kind: "text"; text: string } | { kind: "paste"; text: string } | { kind: "parts"; text: string };
/// A sent message in pieces: its words, its pastes to show as chips, and the
/// parts of a mockup that notes were pinned to (foundry-notes.ts), folded the same way.
export function splitPastes(content: string): MessagePiece[] {
  const parts: MessagePiece[] = [];
  const pattern = /(?:^|\n\n)(`{3,})(paste|parts)\n([\s\S]*?)\n\1(?=\n|$)/g;
  let at = 0;
  for (const match of content.matchAll(pattern)) {
    const before = content.slice(at, match.index);
    if (before.trim()) parts.push({ kind: "text", text: before.trim() });
    parts.push({ kind: match[2] as "paste" | "parts", text: match[3]! });
    at = match.index! + match[0].length;
  }
  const rest = content.slice(at);
  if (rest.trim() || !parts.length) parts.push({ kind: "text", text: parts.length ? rest.trim() : content });
  return parts;
}
/// "Pinned notes · 2": the chip a message's notes on a mockup fold into. A change is numbered, a keep has a heart.
export const partsLabel = (text: string) => { const n = text.split("\n").filter((line) => /^(\d+|♥)\. /.test(line)).length; return `Pinned note${n === 1 ? "" : "s"} · ${n}`; };
