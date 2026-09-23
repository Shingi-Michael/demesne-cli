import type { Session } from "@demesne/protocol";
import {
  formatSessionPickerLine,
  previousGraphemeBoundary,
  type Painter,
  type SessionListItem,
} from "@demesne/brand";
import { emitKeypressEvents } from "node:readline";

export interface SessionPickerKey {
  name?: string;
  ctrl?: boolean;
}

export interface SessionPickerState {
  index: number;
  decision: "continue" | "select" | "cancel";
}

/// The dialog picker used inside the workbench (`/theme`, `/model`,
/// `/sessions`): navigation plus a type-to-filter query. `index` addresses the
/// filtered list; the caller maps it back to the original items.
export interface DialogPickerState {
  index: number;
  query: string;
}

export interface DialogPickerKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export interface DialogPickerResult {
  state: DialogPickerState;
  decision: "continue" | "select" | "cancel";
}

/// Case-insensitive filter over dialog items. Every query character must
/// appear in order (a subsequence); whole-substring matches rank ahead of
/// subsequence matches, both preserving their original order. An empty query
/// keeps everything.
export function filterDialogIndices(items: readonly string[], query: string): number[] {
  const needle = query.toLowerCase();
  if (!needle) return items.map((_, index) => index);
  return items
    .map((item, index) => {
      const lowered = item.toLowerCase();
      return { index, substring: lowered.includes(needle) ? 1 : 0, subsequence: isSubsequence(lowered, needle) ? 1 : 0 };
    })
    .filter((entry) => entry.substring || entry.subsequence)
    .sort((a, b) => (b.substring - a.substring) || (a.index - b.index))
    .map((entry) => entry.index);
}

function isSubsequence(haystack: string, needle: string): boolean {
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor >= needle.length) return true;
  }
  return needle.length === 0;
}

export function reduceDialogPicker(
  state: DialogPickerState,
  count: number,
  key: DialogPickerKey,
  text: string,
): DialogPickerResult {
  const bounded = Math.max(1, count);
  const navigate = (index: number): DialogPickerState => ({
    ...state,
    index: ((index % bounded) + bounded) % bounded,
  });
  if (key.ctrl && key.name === "c") return { state, decision: "cancel" };
  if (key.name === "escape") return { state, decision: "cancel" };
  if (key.name === "return" || key.name === "enter") return { state, decision: count ? "select" : "continue" };
  if (key.name === "backspace") {
    if (!state.query) return { state, decision: "continue" };
    return {
      state: { index: 0, query: state.query.slice(0, previousGraphemeBoundary(state.query, state.query.length)) },
      decision: "continue",
    };
  }
  if (key.name === "up") {
    return { state: navigate(state.index - 1), decision: "continue" };
  }
  if (key.name === "down" || key.name === "tab") {
    return { state: navigate(state.index + 1), decision: "continue" };
  }
  if (key.name === "home") return { state: { ...state, index: 0 }, decision: "continue" };
  if (key.name === "end") return { state: { ...state, index: bounded - 1 }, decision: "continue" };
  // Digits jump straight to a row while the filter is empty; once typing has
  // begun they are ordinary characters of the query.
  if (state.query === "" && /^[1-9]$/.test(text)) {
    const selected = Number(text) - 1;
    return { state: { ...state, index: selected < count ? selected : state.index }, decision: "continue" };
  }
  if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) {
    return { state: { index: 0, query: state.query + text }, decision: "continue" };
  }
  return { state, decision: "continue" };
}

export function reduceSessionPicker(
  index: number,
  count: number,
  text: string,
  key: SessionPickerKey,
): SessionPickerState {
  if (count <= 0) return { index: 0, decision: "cancel" };
  if (key.ctrl && key.name === "c") return { index, decision: "cancel" };
  if (key.name === "escape" || text === "q") return { index, decision: "cancel" };
  if (key.name === "return" || key.name === "enter") return { index, decision: "select" };
  if (/^[1-9]$/.test(text)) {
    const selected = Number(text) - 1;
    return selected < count ? { index: selected, decision: "select" } : { index, decision: "continue" };
  }
  if (key.name === "up" || text === "k") return { index: (index - 1 + count) % count, decision: "continue" };
  if (key.name === "down" || key.name === "tab" || text === "j") return { index: (index + 1) % count, decision: "continue" };
  if (key.name === "home") return { index: 0, decision: "continue" };
  if (key.name === "end") return { index: count - 1, decision: "continue" };
  return { index, decision: "continue" };
}

export function sessionListItem(session: Session): SessionListItem {
  return {
    id: session.id,
    title: session.title,
    turnCount: session.turns.length,
    updatedAt: session.updatedAt,
    status: session.turns.at(-1)?.status ?? "empty",
    ...(session.workspace?.root ? { root: session.workspace.root } : {}),
  };
}

export async function selectSessionInteractive(
  sessions: readonly Session[],
  currentId: string | undefined,
  painter: Painter,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<Session | null> {
  if (sessions.length === 0 || !input.isTTY || !output.isTTY) return null;
  const wasRaw = input.isRaw;
  let index = Math.max(0, sessions.findIndex((session) => session.id === currentId));
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const render = () => {
      const session = sessions[index]!;
      const line = formatSessionPickerLine(
        sessionListItem(session),
        index,
        sessions.length,
        Math.max(20, (output.columns ?? 80) - 2),
        painter,
      );
      output.write(`\r\x1b[2K${line}`);
    };
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", render);
      input.setRawMode(Boolean(wasRaw));
      output.write("\r\x1b[2K");
    };
    const finish = (session: Session | null) => {
      cleanup();
      resolve(session);
    };
    const onKeypress = (text: string, key: SessionPickerKey) => {
      const next = reduceSessionPicker(index, sessions.length, text, key);
      index = next.index;
      if (next.decision === "select") finish(sessions[index]!);
      else if (next.decision === "cancel") finish(null);
      else render();
    };

    input.on("keypress", onKeypress);
    output.on("resize", render);
    render();
  });
}
