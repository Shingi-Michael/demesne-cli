import type { DriveFix } from "@demesne/protocol";
import type { ThreadReport } from "../../../packages/protocol/src/thread-report.ts";

/// The orchestrator's side of threads (pass 126): the threads in its chat,
/// one line each (pass 216 A), with a ring that fills as the thread works
/// and turns amber when it needs you; the line above its composer that says how they're doing;
/// and Merge all, the one button, once they're back. The list is the only
/// switcher: the row you pick lights up and fills the right half.

export interface ThreadsView {
  list: DriveFix[];
  open: string | null;
  closed: boolean;
  busy: string | null;
  message: { text: string; tone: "ok" | "error" } | null;
}

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const button = (action: string, label: string, data: Record<string, unknown>, className = "", disabled = false) =>
  `<button type="button"${disabled ? " disabled" : ""} class="${className}" data-action="${action}" data-args="${esc(JSON.stringify(data))}">${label}</button>`;
const X = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const CHECK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

export type ThreadState = "work" | "you" | "ready" | "failed" | "merged" | "waits";
export function threadState(fix: DriveFix): ThreadState {
  if (fix.status === "applied") return "merged";
  if (fix.status === "ready") return "ready";
  if (fix.status === "failed" || fix.status === "discarded") return "failed";
  // Built on another thread: no chat yet until that one is back and checked.
  if (fix.status === "starting" && fix.thread?.after && !fix.sessionId) return "waits";
  return fix.waiting ? "you" : "work";
}

/// How full a thread's ring is: steps so far against a typical job, never
/// full until it is back.
export function threadProgress(fix: DriveFix): number {
  const state = threadState(fix);
  if (state === "waits") return 0.04;
  if (state !== "work" && state !== "you") return 1;
  const steps = fix.activity?.steps ?? 0;
  return Math.min(0.9, 0.08 + steps / (steps + 12));
}

export function ring(fix: DriveFix): string {
  const state = threadState(fix), c = 2 * Math.PI * 7;
  if (state === "merged") return `<svg class="th-ring ok" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7"/><path d="m5.6 9.2 2.2 2.2 4.4-4.6"/></svg>`;
  const offset = (c * (1 - threadProgress(fix))).toFixed(2);
  return `<svg class="th-ring ${state}" viewBox="0 0 18 18" aria-hidden="true"><circle class="bg" cx="9" cy="9" r="7"/><circle class="fg" cx="9" cy="9" r="7" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset}"/></svg>`;
}

const counts = (diff: DriveFix["diff"]) => diff ? `<span class="add">+${diff.additions}</span> <span class="del">−${diff.deletions}</span>` : "";
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh", "env"]);
const leaf = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

/// What a working thread is doing, in plain words (pass 216 A). The daemon
/// sends the step as "tool detail"; the row says "Editing csv.ts" or
/// "Running bun test", never the tool's name or a whole shell line.
export function threadDoing(last: string | null | undefined): string {
  const [tool = "", ...rest] = (last ?? "").trim().split(/\s+/);
  if (!tool) return "Working";
  if (/^(run|exec)/.test(tool)) {
    const program = leaf(rest[0] ?? "");
    if (!program || SHELLS.has(program)) return "Running a command";
    const more = rest.slice(1, 3).filter((word) => /^[\w@.:/-]+$/.test(word) && !word.startsWith("-")).map(leaf);
    const words = [program, ...more].join(" ");
    return `Running ${words.length > 28 ? program : words}`;
  }
  const verb = /^read/.test(tool) ? "Reading" : /^(edit|apply|patch)/.test(tool) ? "Editing" : /^write/.test(tool) ? "Writing" : /(search|grep|find)/.test(tool) ? "Searching"
    : /^list/.test(tool) ? "Listing" : /^(web|fetch)/.test(tool) ? "Reading the web" : "";
  if (!verb) return "Working";
  const target = verb === "Searching" || verb === "Reading the web" ? "" : leaf(rest.join(" "));
  return target && target.length <= 40 ? `${verb} ${target}` : verb === "Reading the web" || verb === "Searching" ? verb : `${verb} a file`;
}

/// One plain line on what a thread is doing or how it ended. `list` names
/// the thread a waiting one waits for.
export function threadLine(fix: DriveFix, list: DriveFix[] = []): string {
  const state = threadState(fix);
  if (state === "you") return `<span class="amber">Needs you</span>`;
  if (state === "waits") return esc(`After ${list.find((item) => item.id === fix.thread?.after)?.title ?? "the thread it's built on"}`);
  if (state === "work") return fix.review?.sentBack ? `<span class="sent">Sent back</span>${fix.review.note ? ` · ${esc(fix.review.note)}` : ""}`
    : fix.status === "starting" && !fix.activity?.last ? "Starting" : esc(threadDoing(fix.activity?.last));
  if (state === "merged") return "Merged";
  if (state === "failed") return `<span class="danger">Stopped</span>${fix.error ? ` · ${esc(fix.error)}` : ""}`;
  const failed = fix.checks?.some((check) => !check.passed) ? "a check failed" : "";
  return ["Ready", counts(fix.diff), failed, !fix.review?.checked && fix.review?.note && fix.review.note !== failed ? esc(fix.review.note) : ""].filter(Boolean).join(" · ");
}

/// What a row's hover says: everything the line leaves out.
function threadTip(fix: DriveFix): string {
  const state = threadState(fix);
  const checks = !fix.checks?.length ? "" : fix.checks.every((check) => check.passed) ? "checks passed" : "a check failed";
  return [fix.title, fix.thread?.files.length ? `Only touches ${fix.thread.files.join(", ")}` : "", state === "ready" ? [fix.review?.checked ? "checked by the orchestrator" : "", checks].filter(Boolean).join(" · ") : "",
    state === "failed" ? fix.error ?? "" : ""].filter(Boolean).join("\n");
}

/// The threads a chat started, each as one line where it started them (pass
/// 216 A): its ring, its name, what it is doing in plain words, and at the
/// end how long it has worked or, once it is ready, Merge. A row opens its
/// thread; the × on a row deletes it (pass 131 A): a merged thread goes at
/// once, one with work on its branch asks once more, the × turning into
/// "Delete".
export function threadListHTML(view: ThreadsView, armed: string | null = null): string {
  if (!view.list.length) return "";
  return `<div class="th-list" role="group" aria-label="Threads">${view.list.map((fix) => {
    const on = !view.closed && view.open === fix.id, merged = fix.status === "applied", sure = merged || armed === fix.id;
    const del = `<button type="button" class="th-del${armed === fix.id ? " armed" : ""}" data-action="${sure ? "thread-delete" : "thread-delete-arm"}" data-args="${esc(JSON.stringify({ id: fix.id }))}" aria-label="Delete ${esc(fix.title)}" title="${merged ? "Delete this thread (its merge stays)" : "Delete this thread and its branch"}"${view.busy ? " disabled" : ""}>${armed === fix.id ? "Delete" : X}</button>`;
    // A ready thread merges on its own (pass 211 A): nothing waits for the rest.
    const state = threadState(fix), ready = state === "ready";
    const merge = ready ? button("thread-merge", view.busy === fix.id ? "Merging…" : "Merge", { id: fix.id }, "th-merge-one", Boolean(view.busy)) : "";
    const time = state === "work" && fix.startedAt ? `<span class="th-end">${Math.max(1, Math.round((Date.now() - Date.parse(fix.startedAt)) / 60_000))}m</span>` : "";
    return `<div class="th-item ${state}"><button type="button" class="th-row${on ? " on" : ""}" data-action="thread-open" data-args="${esc(JSON.stringify({ id: fix.id }))}" aria-pressed="${on}" title="${esc(threadTip(fix))}">${ring(fix)}<span class="th-name">${esc(fix.title)}</span><span class="th-line">${threadLine(fix, view.list)}</span>${time}</button>${merge}${del}</div>`;
  }).join("")}</div>`;
}

/// Above the orchestrator's composer: how the threads are doing in one line,
/// or, once they're all back, the bar with Merge all.
export function threadsFootHTML(view: ThreadsView): string {
  const open = view.list.filter((fix) => threadState(fix) !== "merged" && fix.status !== "discarded");
  const message = view.message ? `<p class="th-msg ${view.message.tone}"><span>${esc(view.message.text)}</span>${button("threads-message-close", "×", {}, "th-x")}</p>` : "";
  if (!open.length) return message;
  const by = (state: ThreadState) => open.filter((fix) => threadState(fix) === state).length;
  const you = by("you"), work = by("work") + by("waits"), ready = by("ready"), failed = by("failed");
  if (!you && !work && ready) {
    const back = open.filter((fix) => threadState(fix) === "ready");
    const passed = back.every((fix) => fix.review?.checked || (fix.checks?.length && fix.checks.every((check) => check.passed)));
    const merging = view.busy === "merge";
    return `${message}<div class="th-merge"><span><b>${ready} ready to merge</b>${passed ? " · checks passed on each" : ""}${failed ? ` · ${failed} stopped` : ""}</span>${button("threads-merge", merging ? "Merging…" : ready === 1 ? "Merge" : ready === 2 ? "Merge both" : `Merge all ${ready}`, {}, "primary", Boolean(view.busy))}</div>`;
  }
  const parts = [you ? `<span class="amber">${you} need${you === 1 ? "s" : ""} you</span>` : "", work ? `${work} working` : "", ready ? `${ready} ready` : "", failed ? `${failed} stopped` : ""].filter(Boolean);
  return `${message}<div class="th-status">${parts.join(" · ")}</div>`;
}

/// How a thread stands, in words, for its tab's hover.
function threadHow(fix: DriveFix): string {
  return { work: fix.review?.sentBack ? "sent back" : "working", you: "waits for you", ready: fix.review?.checked ? "checked" : "ready", merged: "merged", failed: "stopped", waits: "waits" }[threadState(fix)];
}

/// Merge, in the thread's composer once it is ready (pass 130 A: the thread
/// side has no head bar).
export function threadMergeHTML(view: ThreadsView, fix: DriveFix): string {
  return threadState(fix) === "ready" ? button("thread-merge", view.busy === fix.id ? "Merging…" : "Merge", { id: fix.id }, "tp-merge", Boolean(view.busy)) : "";
}

const PANEL_CLOSE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/><path d="m8 10 2 2-2 2"/></svg>';

/// The thread tabs, in the window's top bar over the thread side (pass 131
/// A), one per thread you haven't closed, with its ring. A tab's × only
/// closes the tab; the panel icon at the end puts the thread side away.
/// ⌘[ and ⌘] step through them.
export function threadTabsHTML(view: ThreadsView, closed: ReadonlySet<string> = new Set()): string {
  return `<div class="tp-tabs" role="tablist" aria-label="Threads">${view.list.filter((fix) => !closed.has(fix.id)).map((fix) => {
    const on = view.open === fix.id;
    return `<div class="tp-tab${on ? " on" : ""}"><button type="button" role="tab" class="tp-tab-open" aria-selected="${on}" data-action="thread-open" data-args="${esc(JSON.stringify({ id: fix.id }))}" title="${esc(`${fix.title}\n${fix.branch} · ${threadHow(fix)}`)}">${ring(fix)}<span>${esc(fix.title)}</span></button><button type="button" class="tp-tab-x" data-action="thread-tab-close" data-args="${esc(JSON.stringify({ id: fix.id }))}" aria-label="Close the ${esc(fix.title)} tab" title="Close this tab">${X}</button></div>`;
  }).join("")}</div><button type="button" class="tp-hide" data-action="thread-close" aria-label="Close the thread side" title="Close the thread side (Esc)">${PANEL_CLOSE}</button>`;
}

/// What the orchestrator told the thread, at the top of its chat in place
/// of the long prompt it was started with.
export function threadBriefHTML(fix: DriveFix | null, prompt: string): string {
  const brief = fix?.thread?.brief ?? /\nYour job: [^\n]*\n([^\n]+)/.exec(prompt)?.[1] ?? "";
  const files = fix?.thread?.files ?? [];
  return `<div class="th-brief"><span class="k">Its brief</span>${esc(brief || prompt.slice(0, 400))}${files.length ? `<span class="th-claims">Only touches ${files.map((file) => `<code>${esc(file)}</code>`).join(" ")}</span>` : ""}</div>`;
}

/// A thread reporting back, as one quiet line in the orchestrator's chat.
export function threadReportHTML(report: ThreadReport, time: string): string {
  const failed = report.status === "failed";
  const what = failed ? "stopped" : ["finished", report.diff ? `${report.diff.files} file${report.diff.files === 1 ? "" : "s"}` : "", report.review?.checked ? "checked" : report.checks?.length ? report.checks.every((check) => check.passed) ? "checks passed" : "a check failed" : "",
    report.review?.sentBack ? `sent back ${report.review.sentBack === 1 ? "once" : `${report.review.sentBack} times`}` : ""].filter(Boolean).join(" · ");
  return `<div class="request thread-report${failed ? " failed" : ""}" title="${esc(report.summary)}">${button("thread-open", `<span class="tr-mark">${failed ? "×" : CHECK}</span><b>${esc(report.title)}</b><span class="tr-what">${esc(what)}</span>`, { id: report.fix }, "tr-line")}<span class="request-meta"><time>${esc(time)}</time></span></div>`;
}
