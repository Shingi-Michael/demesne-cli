/// The edge is a timeline: where the conversation's scrollbar was, a hairline
/// that shows the chat's shape. A dot for each message you sent, a ring for
/// each answer, a green tick for a turn that edited files and a red one where
/// a check failed. This module only places and names the marks; live.ts
/// measures the conversation and draws them.

export type MarkKind = "you" | "answer" | "edit" | "fail";

export interface Mark {
  kind: MarkKind;
  /// Where the mark sits down the conversation, 0 (top) to 1 (bottom).
  at: number;
  /// What the mark says when pointed at, and its quieter tail.
  label: string;
  meta: string;
  /// The scroll offset that brings the marked place into view.
  top: number;
}

/// What one turn contributes, measured from its rendered article.
export interface TurnFacts {
  ask: string;
  time: string;
  askTop: number | null;
  answerTop: number | null;
  stepsTop: number | null;
  receiptTop: number | null;
  edited: string[];
  failed: { name: string; at: string } | null;
}

const clip = (text: string, size: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > size ? `${line.slice(0, size - 1).trimEnd()}…` : line;
};

/// The marks for a conversation `height` pixels tall, in order down the page.
/// Marks closer than `gap` of the line give way to the more telling one
/// (a failure over an edit over a message), so the line never clumps.
export function timelineMarks(turns: readonly TurnFacts[], height: number, gap = 0.012): Mark[] {
  if (height <= 0) return [];
  const marks: Mark[] = [];
  const at = (top: number) => Math.min(1, Math.max(0, top / height));
  for (const turn of turns) {
    if (turn.askTop !== null) marks.push({ kind: "you", at: at(turn.askTop), label: clip(turn.ask, 48) || "You", meta: turn.time, top: turn.askTop });
    const work = turn.stepsTop ?? turn.answerTop ?? turn.askTop;
    if (turn.edited.length && work !== null) {
      const names = turn.edited.map((path) => path.split(/[\\/]/).at(-1) ?? path);
      marks.push({ kind: "edit", at: at(work), label: names.length === 1 ? `Edited ${names[0]}` : `Edited ${names.length} files`, meta: names.length > 1 ? clip(names.slice(0, 3).join(", "), 40) : "", top: work });
    }
    if (turn.answerTop !== null) marks.push({ kind: "answer", at: at(turn.answerTop), label: "Answer", meta: turn.time, top: turn.answerTop });
    const failedAt = turn.receiptTop ?? work;
    if (turn.failed && failedAt !== null) marks.push({ kind: "fail", at: at(failedAt), label: "Check failed", meta: [clip(turn.failed.name, 28), turn.failed.at].filter(Boolean).join(" · "), top: failedAt });
  }
  marks.sort((a, b) => a.at - b.at);
  const weight: Record<MarkKind, number> = { fail: 3, edit: 2, you: 1, answer: 0 };
  const kept: Mark[] = [];
  for (const mark of marks) {
    const last = kept.at(-1);
    if (last && mark.at - last.at < gap) {
      if (weight[mark.kind] > weight[last.kind]) kept[kept.length - 1] = mark;
      continue;
    }
    kept.push(mark);
  }
  return kept;
}

/// The mark nearest a point on the line, if one is within `reach` of it.
export function markNear(marks: readonly Mark[], at: number, reach: number): Mark | null {
  let best: Mark | null = null;
  for (const mark of marks) if (Math.abs(mark.at - at) <= reach && (!best || Math.abs(mark.at - at) < Math.abs(best.at - at))) best = mark;
  return best;
}
