import {
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  slashCommandCompletion,
  type SlashCommand,
} from "@demesne/brand";

/// Pure state machine for the interactive prompt.
///
/// The terminal loop owns rendering and process effects; every editing
/// decision lives here so behavior is testable without a TTY. The state covers
/// readline-style navigation, a kill ring and undo stack, reverse search, and
/// the slash-command menu.
///
/// Up and Down navigate the menu when it is open, move between explicit lines
/// when the draft contains newlines, and otherwise walk history. Wrapped
/// visual lines are intentionally not addressable with Up/Down because history
/// recall is the behavior users expect from a single-line prompt.

export interface PromptEditorKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface PromptEditorState {
  value: string;
  cursor: number;
  menuSelected: number;
  menuDismissed: boolean;
  historyIndex: number | null;
  historyDraft: string;
  killRing: string;
  undoStack: Array<{ value: string; cursor: number }>;
  search: { query: string; index: number } | null;
  searchDraft: string;
  mentionSelected: number;
  mentionDismissed: boolean;
}

export type PromptEditorAction =
  | { type: "none" }
  | { type: "submit"; value: string }
  | { type: "cancel" }
  | { type: "compose" };

export interface PromptEditorInput {
  key: PromptEditorKey;
  text: string;
  commands: readonly SlashCommand[];
  history: readonly string[];
  mentions?: readonly string[];
}

export interface PromptEditorResult {
  state: PromptEditorState;
  action: PromptEditorAction;
}

export const PROMPT_UNDO_LIMIT = 50;

export function createPromptEditorState(): PromptEditorState {
  return {
    value: "",
    cursor: 0,
    menuSelected: 0,
    menuDismissed: false,
    historyIndex: null,
    historyDraft: "",
    killRing: "",
    undoStack: [],
    search: null,
    searchDraft: "",
    mentionSelected: 0,
    mentionDismissed: false,
  };
}

/// Replaces the draft after an external editor returns. The previous draft is
/// undoable so Ctrl+_ restores it.
export function setPromptValue(state: PromptEditorState, value: string): PromptEditorState {
  return {
    ...state,
    value,
    cursor: value.length,
    menuSelected: 0,
    menuDismissed: false,
    historyIndex: null,
    mentionSelected: 0,
    mentionDismissed: false,
    undoStack: pushUndo(state),
  };
}

/// Most recent first, case-insensitive substring matches, without duplicates.
export function reverseSearchMatches(history: readonly string[], query: string): string[] {
  const normalized = query.toLowerCase();
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const entry of history) {
    if (seen.has(entry)) continue;
    if (normalized && !entry.toLowerCase().includes(normalized)) continue;
    seen.add(entry);
    matches.push(entry);
  }
  return matches;
}

export function reducePromptEditor(state: PromptEditorState, input: PromptEditorInput): PromptEditorResult {
  if (state.search) return reduceSearch(state, input);
  const key = input.key;
  const none = (next: PromptEditorState): PromptEditorResult => ({ state: next, action: { type: "none" } });
  const menuOpen = input.commands.length > 0 && !state.menuDismissed;

  if (key.ctrl && key.name === "c") return { state, action: { type: "cancel" } };
  if (key.ctrl && key.name === "d" && state.value.length === 0) return { state, action: { type: "cancel" } };
  if (key.ctrl && key.name === "o") return { state, action: { type: "compose" } };
  if (key.ctrl && key.name === "r") {
    return none({ ...state, search: { query: "", index: 0 }, searchDraft: state.value });
  }

  // Readline history aliases stay available for multi-line drafts.
  if (key.ctrl && key.name === "p") return none(historyPrevious(state, input.history));
  if (key.ctrl && key.name === "n") return none(historyNext(state, input.history));

  const mention = mentionTokenAt(state.value, state.cursor);
  const mentionCandidates = mention && (input.mentions?.length ?? 0) > 0
    ? mentionMatches(input.mentions!, mention.query)
    : [];
  const mentionActive = !state.mentionDismissed && mention !== null && mentionCandidates.length > 0;

  // Esc closes the file menu, including its "no files match" state, and
  // never clears the draft while that menu is showing.
  const mentionOpen = mentionActive || !state.mentionDismissed && mention !== null && mention.query.length > 0 && (input.mentions?.length ?? 0) > 0;
  if (mentionOpen && key.name === "escape") return none({ ...state, mentionDismissed: true });
  if (mentionActive && (key.name === "pageup" || key.name === "pagedown")) {
    return none({ ...state, mentionSelected: Math.max(0, Math.min(mentionCandidates.length - 1, state.mentionSelected + (key.name === "pageup" ? -5 : 5))) });
  }

  if (mentionActive && key.name === "up") {
    return none({
      ...state,
      mentionSelected: (state.mentionSelected - 1 + mentionCandidates.length) % mentionCandidates.length,
    });
  }
  if (mentionActive && key.name === "down") {
    return none({ ...state, mentionSelected: (state.mentionSelected + 1) % mentionCandidates.length });
  }

  if (menuOpen && key.name === "up") {
    return none({ ...state, menuSelected: (state.menuSelected - 1 + input.commands.length) % input.commands.length });
  }
  if (menuOpen && key.name === "down") {
    return none({ ...state, menuSelected: (state.menuSelected + 1) % input.commands.length });
  }
  if (menuOpen && key.name === "escape") return none({ ...state, menuDismissed: true });
  if (menuOpen && (key.name === "pageup" || key.name === "pagedown")) {
    return none({ ...state, menuSelected: Math.max(0, Math.min(input.commands.length - 1, state.menuSelected + (key.name === "pageup" ? -8 : 8))) });
  }

  if (isNewlineKey(key, input.text)) {
    const value = `${state.value.slice(0, state.cursor)}\n${state.value.slice(state.cursor)}`;
    return none(mutate(state, value, state.cursor + 1, { dismissMenu: true }));
  }

  if (mentionActive && (key.name === "tab" || key.name === "return" || key.name === "enter")) {
    const file = mentionCandidates[Math.min(state.mentionSelected, mentionCandidates.length - 1)]!;
    const completed = `@${mentionLabel(file, input.mentions!)} `;
    const value = state.value.slice(0, mention.start) + completed + state.value.slice(state.cursor);
    return none(mutate(state, value, mention.start + completed.length));
  }

  if (menuOpen && (key.name === "tab" || key.name === "return" || key.name === "enter")) {
    const command = input.commands[Math.min(state.menuSelected, input.commands.length - 1)]!;
    if (command.argument === "none") return { state, action: { type: "submit", value: command.name } };
    const completed = slashCommandCompletion(command);
    return none(mutate(state, completed, completed.length, { dismissMenu: true }));
  }

  if (key.name === "return" || key.name === "enter") {
    return { state, action: { type: "submit", value: state.value } };
  }

  if (key.name === "escape") {
    return none({
      ...state,
      value: "",
      cursor: 0,
      menuSelected: 0,
      menuDismissed: false,
      historyIndex: null,
      mentionSelected: 0,
      undoStack: pushUndo(state),
    });
  }

  if (key.name === "up" || key.name === "down") {
    if (state.value.includes("\n")) {
      return none(moveToExplicitLine(state, key.name === "up" ? -1 : 1));
    }
    return none(key.name === "up" ? historyPrevious(state, input.history) : historyNext(state, input.history));
  }

  if (key.name === "backspace") {
    if (state.cursor === 0) return none(state);
    const previous = previousGraphemeBoundary(state.value, state.cursor);
    return none(mutate(state, state.value.slice(0, previous) + state.value.slice(state.cursor), previous));
  }

  if (key.name === "delete") {
    if (state.cursor >= state.value.length) return none(state);
    const next = nextGraphemeBoundary(state.value, state.cursor);
    return none(mutate(state, state.value.slice(0, state.cursor) + state.value.slice(next), state.cursor));
  }

  if (key.ctrl && key.name === "u") {
    const start = lineStart(state.value, state.cursor);
    const killed = state.value.slice(start, state.cursor);
    if (!killed) return none(state);
    return none({
      ...mutate(state, state.value.slice(0, start) + state.value.slice(state.cursor), start),
      killRing: killed,
    });
  }

  if (key.ctrl && key.name === "k") {
    const end = lineEnd(state.value, state.cursor);
    const killed = state.value.slice(state.cursor, end);
    if (!killed) return none(state);
    return none({
      ...mutate(state, state.value.slice(0, state.cursor) + state.value.slice(end), state.cursor),
      killRing: killed,
    });
  }

  if (key.ctrl && key.name === "w") {
    const start = previousWordBoundary(state.value, state.cursor);
    const killed = state.value.slice(start, state.cursor);
    if (!killed) return none(state);
    return none({
      ...mutate(state, state.value.slice(0, start) + state.value.slice(state.cursor), start),
      killRing: killed,
    });
  }

  if (key.ctrl && key.name === "y") {
    if (!state.killRing) return none(state);
    const value = state.value.slice(0, state.cursor) + state.killRing + state.value.slice(state.cursor);
    return none(mutate(state, value, state.cursor + state.killRing.length));
  }

  if (key.ctrl && (key.name === "_" || key.name === "underscore" || key.name === "/")) {
    const snapshot = state.undoStack.at(-1);
    if (!snapshot) return none(state);
    return none({
      ...state,
      value: snapshot.value,
      cursor: snapshot.cursor,
      menuSelected: 0,
      historyIndex: null,
      undoStack: state.undoStack.slice(0, -1),
    });
  }

  if (key.name === "left") {
    const cursor = (key.ctrl || key.meta)
      ? previousWordBoundary(state.value, state.cursor)
      : previousGraphemeBoundary(state.value, state.cursor);
    return none({ ...state, cursor });
  }
  if (key.name === "right") {
    const cursor = (key.ctrl || key.meta)
      ? nextWordBoundary(state.value, state.cursor)
      : nextGraphemeBoundary(state.value, state.cursor);
    return none({ ...state, cursor });
  }
  if (key.meta && key.name === "b") return none({ ...state, cursor: previousWordBoundary(state.value, state.cursor) });
  if (key.meta && key.name === "f") return none({ ...state, cursor: nextWordBoundary(state.value, state.cursor) });

  if (key.name === "home" || (key.ctrl && key.name === "a")) {
    return none({ ...state, cursor: lineStart(state.value, state.cursor) });
  }
  if (key.name === "end" || (key.ctrl && key.name === "e")) {
    return none({ ...state, cursor: lineEnd(state.value, state.cursor) });
  }

  if (!key.ctrl && !key.meta && input.text) {
    const cleaned = cleanText(input.text);
    if (!cleaned) return none(state);
    const value = state.value.slice(0, state.cursor) + cleaned + state.value.slice(state.cursor);
    return none(mutate(state, value, state.cursor + cleaned.length));
  }

  return none(state);
}

function reduceSearch(state: PromptEditorState, input: PromptEditorInput): PromptEditorResult {
  const key = input.key;
  const search = state.search!;
  const none = (next: PromptEditorState): PromptEditorResult => ({ state: next, action: { type: "none" } });
  const matches = reverseSearchMatches(input.history, search.query);

  if (key.ctrl && key.name === "c") {
    return { state: { ...state, search: null, searchDraft: "" }, action: { type: "cancel" } };
  }
  if (key.ctrl && key.name === "r") {
    return none({
      ...state,
      search: { ...search, index: matches.length === 0 ? 0 : (search.index + 1) % matches.length },
    });
  }
  if (key.name === "escape" || (key.ctrl && key.name === "g")) {
    return none({
      ...state,
      search: null,
      searchDraft: "",
      value: state.searchDraft,
      cursor: state.searchDraft.length,
    });
  }
  if (key.name === "return" || key.name === "enter") {
    const match = matches[Math.min(search.index, Math.max(0, matches.length - 1))];
    const value = match ?? state.searchDraft;
    return none({
      ...state,
      search: null,
      searchDraft: "",
      value,
      cursor: value.length,
      historyIndex: null,
      menuSelected: 0,
      menuDismissed: false,
      mentionSelected: 0,
      undoStack: pushUndo(state),
    });
  }
  if (key.name === "backspace") {
    return none({ ...state, search: { query: search.query.slice(0, -1), index: 0 } });
  }
  if (!key.ctrl && !key.meta && input.text) {
    const cleaned = cleanText(input.text).replaceAll("\n", " ");
    if (!cleaned) return none(state);
    return none({ ...state, search: { query: search.query + cleaned, index: 0 } });
  }
  return none(state);
}

interface MutateOptions {
  dismissMenu?: boolean;
}

function mutate(state: PromptEditorState, value: string, cursor: number, options: MutateOptions = {}): PromptEditorState {
  return {
    ...state,
    value,
    cursor: Math.max(0, Math.min(cursor, value.length)),
    menuSelected: 0,
    menuDismissed: options.dismissMenu ?? false,
    historyIndex: null,
    mentionSelected: 0,
    mentionDismissed: false,
    undoStack: pushUndo(state),
  };
}

function pushUndo(state: PromptEditorState): Array<{ value: string; cursor: number }> {
  return [...state.undoStack, { value: state.value, cursor: state.cursor }].slice(-PROMPT_UNDO_LIMIT);
}

function historyPrevious(state: PromptEditorState, history: readonly string[]): PromptEditorState {
  if (history.length === 0) return state;
  if (state.historyIndex === null) {
    const entry = history[0]!;
    return {
      ...state,
      historyDraft: state.value,
      historyIndex: 0,
      value: entry,
      cursor: entry.length,
      menuSelected: 0,
      menuDismissed: true,
      undoStack: pushUndo(state),
    };
  }
  const index = Math.min(state.historyIndex + 1, history.length - 1);
  const entry = history[index]!;
  if (entry === state.value) return state;
  return {
    ...state,
    historyIndex: index,
    value: entry,
    cursor: entry.length,
    menuSelected: 0,
    menuDismissed: true,
    undoStack: pushUndo(state),
  };
}

function historyNext(state: PromptEditorState, history: readonly string[]): PromptEditorState {
  if (state.historyIndex === null) return state;
  if (state.historyIndex === 0) {
    return {
      ...state,
      historyIndex: null,
      value: state.historyDraft,
      cursor: state.historyDraft.length,
      menuSelected: 0,
      menuDismissed: true,
      undoStack: pushUndo(state),
    };
  }
  const index = state.historyIndex - 1;
  const entry = history[index] ?? state.historyDraft;
  return {
    ...state,
    historyIndex: index,
    value: entry,
    cursor: entry.length,
    menuSelected: 0,
    menuDismissed: true,
    undoStack: pushUndo(state),
  };
}

function moveToExplicitLine(state: PromptEditorState, direction: -1 | 1): PromptEditorState {
  const start = lineStart(state.value, state.cursor);
  const column = state.cursor - start;
  if (direction === -1) {
    if (start === 0) return { ...state, cursor: 0 };
    const previousEnd = start - 1;
    const previousStart = lineStart(state.value, previousEnd);
    return { ...state, cursor: previousStart + Math.min(column, previousEnd - previousStart) };
  }
  const end = lineEnd(state.value, state.cursor);
  if (end === state.value.length) return { ...state, cursor: state.value.length };
  const nextStart = end + 1;
  const nextEnd = lineEnd(state.value, nextStart);
  return { ...state, cursor: nextStart + Math.min(column, nextEnd - nextStart) };
}

function isNewlineKey(key: PromptEditorKey, text: string): boolean {
  return Boolean(key.meta && (key.name === "return" || key.name === "enter"))
    || Boolean(key.shift && (key.name === "return" || key.name === "enter"))
    || Boolean(key.ctrl && key.name === "j")
    || key.name === "linefeed"
    || text === "\x1b\r"
    || text === "\x1b\n";
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .replaceAll("\t", "  ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function previousWordBoundary(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(value[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1]!)) index -= 1;
  return index;
}

export function nextWordBoundary(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && /\s/.test(value[index]!)) index += 1;
  while (index < value.length && !/\s/.test(value[index]!)) index += 1;
  return index;
}

export function lineStart(value: string, cursor: number): number {
  const index = value.lastIndexOf("\n", Math.max(0, cursor - 1));
  return index === -1 ? 0 : index + 1;
}

export function lineEnd(value: string, cursor: number): number {
  const index = value.indexOf("\n", cursor);
  return index === -1 ? value.length : index;
}

export interface MentionToken {
  start: number;
  query: string;
}

/// Returns the `@` token the cursor is inside, if any. A mention must start at
/// the beginning of the line or after whitespace, so `user@host` is not one.
export function mentionTokenAt(value: string, cursor: number): MentionToken | null {
  let index = cursor - 1;
  while (index >= 0) {
    const character = value[index]!;
    if (character === "@") {
      const before = value[index - 1];
      if (before === undefined || /\s/.test(before)) {
        return { start: index, query: value.slice(index + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(character)) return null;
    index -= 1;
  }
  return null;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/// What a completed mention puts in the draft (Figma 39:452): the file's
/// name when no other workspace file shares it, otherwise its path.
export function mentionLabel(file: string, files: readonly string[]): string {
  const name = basename(file);
  return name !== file && files.filter((other) => basename(other) === name).length === 1 ? name : file;
}

/// The workspace file an `@name` token refers to: an exact path, or a name
/// only one file has. Anything else is plain text, not an attachment.
export function resolveMention(name: string, files: readonly string[]): string | null {
  if (!name) return null;
  if (files.includes(name)) return name;
  const matches = name.includes("/") ? [] : files.filter((file) => basename(file) === name);
  return matches.length === 1 ? matches[0]! : null;
}

/// `@name` tokens in a draft that resolve to workspace files, with where each
/// token (including `@`) sits in the text.
export function draftMentions(value: string, files: readonly string[]): { start: number; length: number; path: string }[] {
  return [...value.matchAll(/(^|\s)@([^\s@]+)/g)].flatMap((match) => {
    const path = resolveMention(match[2]!, files);
    return path ? [{ start: match.index! + match[1]!.length, length: match[2]!.length + 1, path }] : [];
  });
}

/// A submitted draft names files by path, so the agent never has to guess
/// which `lexer.ts` a short mention meant.
export function expandMentions(value: string, files: readonly string[]): string {
  let result = "", last = 0;
  for (const mention of draftMentions(value, files)) {
    result += value.slice(last, mention.start) + `@${mention.path}`;
    last = mention.start + mention.length;
  }
  return result + value.slice(last);
}

/// Ranks workspace files for a mention query: basename prefixes first, then
/// earlier substring matches, then shorter paths. Paths containing whitespace
/// are excluded because completion inserts a bare token.
export function mentionMatches(files: readonly string[], query: string, limit = 8): string[] {
  const normalized = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    if (/\s/.test(file)) continue;
    const lower = file.toLowerCase();
    const index = normalized ? lower.indexOf(normalized) : 0;
    if (normalized && index === -1) continue;
    const basename = lower.slice(lower.lastIndexOf("/") + 1);
    const basePrefix = normalized && !basename.startsWith(normalized) ? 1 : 0;
    scored.push({ file, score: basePrefix * 1_000 + index + file.length / 100 });
  }
  scored.sort((left, right) => left.score - right.score || left.file.localeCompare(right.file));
  return scored.slice(0, limit).map((entry) => entry.file);
}
