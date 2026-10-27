import type { PendingPermissionSnapshot, QuestionState, Turn } from "@demesne/protocol";
import { isMailTurn } from "../../../packages/protocol/src/heartbeat-mail.ts";
import { isDriveReport } from "../../../packages/protocol/src/drive-report.ts";

/// Home's paragraph: what happened while you were away, written from the
/// app's own state (no model), at most three sentences, what needs you first.
/// Each underlined phrase is a control that unfolds that thing in place.

/// What a chat in the background waits on: an approval Home can answer, or a
/// question that opens the chat.
export type AwayAsk =
  | { kind: "permission"; id: string; verb: string; target: string; rule: string | null; allowedBefore: number }
  | { kind: "question"; text: string };

/// The first approval or question a chat waits on. A pending approval's
/// summary is "tool: {arguments}", cut at 500 characters.
export function waitingAsk(pending: PendingPermissionSnapshot[], questions: QuestionState[] = []): AwayAsk | null {
  const permission = pending[0];
  if (permission) {
    const colon = permission.summary.indexOf(": "),
      name = colon > 0 ? permission.summary.slice(0, colon) : permission.summary;
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(permission.summary.slice(colon + 2)) as Record<string, unknown>; } catch { /* cut short */ }
    const argv = Array.isArray(input.argv) ? input.argv.map(String) : null;
    const [verb, target] = name === "run_command"
      ? ["run", argv?.length ? [argv[0]!.split("/").at(-1)!, ...argv.slice(1)].join(" ") : String(input.command ?? "")]
      : name === "edit_file" || name === "write_file" ? [input.mode === "append" ? "append to" : "edit", String(input.path ?? "")]
      : name === "delete_file" ? ["delete", String(input.path ?? "")]
      : [name.replace(/_/g, " "), ""];
    return { kind: "permission", id: permission.id, verb, target: clip(target, 60), rule: permission.rule ?? null, allowedBefore: permission.allowedBefore ?? 0 };
  }
  const question = questions.find((item) => item.status !== "answered" && item.status !== "cancelled") ?? questions[0];
  const text = question?.questions[question.answers?.length ?? 0]?.question ?? question?.questions[0]?.question;
  return text ? { kind: "question", text: clip(text, 120) } : null;
}

/// The last prompt you sent, in full; never recall background-agent or system turns.
export function lastPrompt(turns: readonly { content: string; fromDrive?: boolean; kind?: string }[]): string {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.fromDrive || turn.kind || isMailTurn(turn.content) || isDriveReport(turn.content)) continue;
    if (turn.content.trim()) return turn.content;
  }
  return "";
}

/// Home's short preview of the last prompt: first line only.
export function lastAsk(turns: Pick<Turn, "content" | "fromDrive" | "kind">[]): string {
  return clip(lastPrompt(turns).trim().split("\n")[0]!.trim(), 140);
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/// "at 23:40", "yesterday at 23:40", "on Thursday", "on 12 Oct".
export function sinceWords(at: number, now: number): string {
  const then = new Date(at), today = new Date(now);
  const time = then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(today) - day(then)) / 86_400_000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  if (days < 7) return `on ${then.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `on ${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/// A phrase that does something; `tone` colours its underline: amber waits
/// on you, red failed, blue is going on now.
export interface AwayLink { text: string; action: string; args?: Record<string, unknown>; tone?: "warn" | "bad" | "live"; open?: boolean }
/// Plain words, a named thing (`name`), a command (`code`), or a link.
export type AwayPart = string | { name: string } | { code: string } | AwayLink;

export interface AwayInput {
  now: number;
  /// When the window was last in front of you; null the first time.
  leftAt: number | null;
  /// Drive's finished branches waiting for a decision.
  branches: { title: string; status: "ready" | "failed"; finishedAt: string | null; failedCheck?: string; unchanged?: boolean }[];
  /// Drive working now, on its own branch.
  running: { title: string; steps: number } | null;
  /// This project's other chats that wait on you.
  waiting: { sessionId: string; title: string; ask: AwayAsk | null }[];
  /// This project's other chats still working.
  busy: { sessionId: string; title: string }[];
  /// Routines that ran since you left.
  routines: { title: string; at: string; sessionId: string }[];
  /// Drive's ideas, when nothing else fills the paragraph.
  ideas: number;
  /// How often it asked you, this week and last.
  asks: { thisWeek: number; lastWeek: number } | null;
  /// What is unfolded under the paragraph.
  shown: { branches: boolean; drive: boolean; ideas: boolean; ask: string | null };
}

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number, one: string, many = `${one}s`) => `${NUMBERS[n] ?? n} ${n === 1 ? one : many}`;
const capital = (parts: AwayPart[]) => {
  const first = parts[0];
  if (typeof first === "string") parts[0] = first.replace(/^./, (c) => c.toUpperCase());
  else if (first && "text" in first) parts[0] = { ...first, text: first.text.replace(/^./, (c) => c.toUpperCase()) };
  return parts;
};

export function awaySentences(input: AwayInput): AwayPart[][] {
  const sentences: AwayPart[][] = [];
  const since = input.leftAt != null ? sinceWords(input.leftAt, input.now) : "";
  // Waits on you: one sentence for every chat that asks.
  if (input.waiting.length) {
    const first = input.waiting[0]!;
    const link = (chat: AwayInput["waiting"][number]): AwayLink => chat.ask?.kind === "permission"
      ? { text: chat.title, action: "away-ask", args: { id: chat.sessionId }, tone: "warn", open: input.shown.ask === chat.sessionId }
      : { text: chat.title, action: "select-session", args: { id: chat.sessionId }, tone: "warn" };
    if (input.waiting.length === 1) {
      const ask = first.ask;
      sentences.push(ask?.kind === "permission"
        ? [link(first), ` is waiting on your yes to ${ask.verb}`, ...(ask.target ? [" ", { code: ask.target }] : []), "."]
        : ask?.kind === "question" ? [link(first), " has a question for you."] : [link(first), " is waiting on you."]);
    } else if (input.waiting.length === 2) sentences.push([link(first), " and ", link(input.waiting[1]!), " are waiting on you."]);
    else sentences.push([link(first), ` and ${count(input.waiting.length - 1, "other chat")} are waiting on you.`]);
  }
  // Drive's finished branches: what passed, what failed.
  if (input.branches.length) {
    const fresh = since && input.branches.some((branch) => branch.finishedAt && Date.parse(branch.finishedAt) > input.leftAt!);
    const toggle = (text: string, tone?: AwayLink["tone"]): AwayLink => ({ text, action: "review-open", ...(tone ? { tone } : {}), open: input.shown.branches });
    const outcome = (branch: AwayInput["branches"][number]): AwayPart[] => branch.status === "failed"
      ? [{ name: branch.title }, " ", toggle(branch.unchanged ? "changed nothing" : "couldn't finish", branch.unchanged ? undefined : "bad")]
      : branch.failedCheck ? [{ name: branch.title }, " ", toggle("failed a check", "bad"), " (", { code: branch.failedCheck }, ")"]
      : [{ name: branch.title }, " passed its checks"];
    const head: AwayPart[] = [fresh ? `Since you left ${since}, ` : "", toggle(`Drive finished ${count(input.branches.length, "branch", "branches")}`)];
    if (input.branches.length <= 2) {
      const [a, b] = input.branches;
      sentences.push(capital([...head, ": ", ...outcome(a!), ...(b ? [", ", ...outcome(b)] : []), "."].filter((part) => part !== "")));
    } else {
      const bad = input.branches.filter((branch) => (branch.status === "failed" && !branch.unchanged) || branch.failedCheck).length;
      sentences.push(capital([...head, ...(bad ? ["; ", toggle(`${NUMBERS[bad] ?? bad} didn't pass`, "bad")] : []), "."].filter((part) => part !== "")));
    }
  }
  // Going on now.
  if (input.running)
    sentences.push([{ text: "Drive is working", action: "drive-show", tone: "live", open: input.shown.drive }, " on ", { name: input.running.title }, input.running.steps ? `, ${count(input.running.steps, "step")} in.` : "."]);
  if (input.busy.length && !input.waiting.length) {
    const [a, b] = input.busy;
    const open = (chat: { sessionId: string; title: string }): AwayLink => ({ text: chat.title, action: "select-session", args: { id: chat.sessionId } });
    sentences.push(input.busy.length === 1 ? [open(a!), " is still working."]
      : input.busy.length === 2 ? [open(a!), " and ", open(b!), " are still working."]
      : [open(a!), ` and ${count(input.busy.length - 1, "other chat")} are still working.`]);
  }
  // Ran on a schedule.
  for (const routine of input.routines.slice(0, 1))
    sentences.push(["Your ", { text: routine.title, action: "select-session", args: { id: routine.sessionId } }, ` ran ${sinceWords(Date.parse(routine.at), input.now)}.`]);
  const urgent = sentences.length;
  // Nothing waits on you, said when work is going on.
  if (!input.waiting.length && (input.running || input.busy.length)) sentences.push(["Nothing waits on you."]);
  if (!urgent) {
    sentences.push([since ? `Nothing has moved since you left ${since}.` : "Nothing waits on you."]);
    if (input.ideas) sentences.push(["Drive has ", { text: count(input.ideas, "idea"), action: "ideas-show", open: input.shown.ideas }, " for this project."]);
    return sentences.slice(0, 3);
  }
  if (input.ideas) sentences.push(["Drive has ", { text: count(input.ideas, "idea"), action: "ideas-show", open: input.shown.ideas }, "."]);
  if (input.asks && input.asks.lastWeek > 0) {
    const { thisWeek, lastWeek } = input.asks;
    sentences.push([`It asked you ${thisWeek === 1 ? "once" : thisWeek === 2 ? "twice" : `${thisWeek} times`} this week, ${thisWeek === lastWeek ? "the same as last week" : `${thisWeek < lastWeek ? "down" : "up"} from ${lastWeek}`}.`]);
  }
  return sentences.slice(0, 3);
}
