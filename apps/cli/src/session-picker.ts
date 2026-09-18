import type { Session } from "@demesne/protocol";
import {
  formatSessionPickerLine,
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
