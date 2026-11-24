/// Step 4 of pass 273 A, whiteboards: notes, arrows and groups you move
/// around. The model writes JSON and Demesne draws it
/// (apps/desktop/electron/foundry-more-kinds.ts, boardPage).
///   { "notes": [{ "id": "who", "text": "Who books", "x": 40, "y": 60, "tone": "sand" }],
///     "arrows": [{ "from": "who", "to": "why", "label": "because" }],
///     "groups": [{ "label": "Today", "x": 20, "y": 20, "w": 480, "h": 300 }] }
/// Places are optional: notes without one are laid out in rows.

export const BOARD_TONES = ["plain", "sand", "sky", "mint", "rose", "lilac"] as const;
export type BoardTone = typeof BOARD_TONES[number];
export interface BoardNote { id: string; text: string; x: number; y: number; tone: BoardTone }
export interface BoardArrow { from: string; to: string; label: string }
export interface BoardGroup { label: string; x: number; y: number; w: number; h: number }
export interface Board { notes: BoardNote[]; arrows: BoardArrow[]; groups: BoardGroup[] }

export const BOARD_MAX_NOTES = 200;
export const BOARD_MAX_GROUPS = 30;
export const BOARD_NOTE_WIDTH = 180;
const MAX_PLACE = 8000;
const HINT = 'Hint: JSON {"notes":[{"id":"a","text":"Who books","x":40,"y":60}],"arrows":[{"from":"a","to":"b"}],"groups":[{"label":"Today","x":20,"y":20,"w":480,"h":300}]}; x and y are optional';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const place = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(MAX_PLACE, Math.max(0, value))) : null;

/// The board a source holds, or why it can't be drawn.
export function readBoard(source: string): { board: Board } | { problem: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return { problem: `A board is JSON, and this doesn't parse. ${HINT}` }; }
  if (!isRecord(parsed) || !Array.isArray(parsed.notes)) return { problem: `A board needs a list of notes. ${HINT}` };
  if (!parsed.notes.length) return { problem: `A board needs at least one note. ${HINT}` };
  if (parsed.notes.length > BOARD_MAX_NOTES) return { problem: `A board holds up to ${BOARD_MAX_NOTES} notes, not ${parsed.notes.length}` };
  const notes: BoardNote[] = [], ids = new Set<string>();
  for (const [at, one] of parsed.notes.entries()) {
    if (!isRecord(one) || typeof one.text !== "string" || !one.text.trim()) return { problem: `Note ${at + 1} needs its words in "text". ${HINT}` };
    const id = typeof one.id === "string" && one.id.trim() ? one.id.trim().slice(0, 80) : typeof one.id === "number" ? String(one.id) : `n${at + 1}`;
    if (ids.has(id)) return { problem: `Two notes are called "${id}"; each note needs its own id` };
    ids.add(id);
    const tone = (BOARD_TONES as readonly string[]).includes(one.tone as string) ? one.tone as BoardTone : "plain";
    notes.push({ id, text: one.text.trim().slice(0, 600), x: place(one.x) ?? -1, y: place(one.y) ?? -1, tone });
  }
  // Notes without a place go in rows of four, under any that have one.
  const placed = notes.filter((note) => note.x >= 0 && note.y >= 0);
  const top = placed.length ? Math.max(...placed.map((note) => note.y)) + 160 : 40;
  notes.filter((note) => note.x < 0 || note.y < 0).forEach((note, at) => { note.x = 40 + (at % 4) * (BOARD_NOTE_WIDTH + 40); note.y = top + Math.floor(at / 4) * 160; });
  const arrows: BoardArrow[] = [];
  for (const [at, one] of (Array.isArray(parsed.arrows) ? parsed.arrows : []).entries()) {
    if (!isRecord(one)) return { problem: `Arrow ${at + 1} needs "from" and "to", the ids of two notes. ${HINT}` };
    const from = String(one.from ?? ""), to = String(one.to ?? "");
    if (!ids.has(from) || !ids.has(to)) return { problem: `Arrow ${at + 1} goes from "${from}" to "${to}", but ${!ids.has(from) ? `"${from}"` : `"${to}"`} isn't a note's id` };
    arrows.push({ from, to, label: typeof one.label === "string" ? one.label.trim().slice(0, 80) : "" });
  }
  const groupsIn = Array.isArray(parsed.groups) ? parsed.groups : [];
  if (groupsIn.length > BOARD_MAX_GROUPS) return { problem: `A board holds up to ${BOARD_MAX_GROUPS} groups` };
  const groups: BoardGroup[] = [];
  for (const [at, one] of groupsIn.entries()) {
    if (!isRecord(one) || place(one.x) === null || place(one.y) === null || !place(one.w) || !place(one.h)) return { problem: `Group ${at + 1} needs x, y, w and h. ${HINT}` };
    groups.push({ label: typeof one.label === "string" ? one.label.trim().slice(0, 80) : "", x: place(one.x)!, y: place(one.y)!, w: Math.max(80, place(one.w)!), h: Math.max(60, place(one.h)!) });
  }
  return { board: { notes, arrows, groups } };
}

/// Why a board can't be kept, or null when it can.
export function boardProblem(source: string): string | null {
  const read = readBoard(source);
  return "problem" in read ? read.problem : null;
}

/// A board's words, for search: its groups' labels, notes and arrows' labels.
export function boardWords(source: string): string {
  const read = readBoard(source);
  if ("problem" in read) return source;
  return [...read.board.groups.map((group) => group.label), ...read.board.notes.map((note) => note.text), ...read.board.arrows.map((arrow) => arrow.label)].filter(Boolean).join(" ");
}
