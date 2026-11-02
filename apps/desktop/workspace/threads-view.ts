import type { DriveFix } from "@demesne/protocol";
import type { ThreadReport } from "../../../packages/protocol/src/thread-report.ts";

/// The orchestrator's side of threads (pass 126): the thread list in its
/// chat, with a ring per thread that fills as it works and turns amber when
/// it needs you; the line above its composer that says how they're doing;
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
const CHECK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

export type ThreadState = "work" | "you" | "ready" | "failed" | "merged";
export function threadState(fix: DriveFix): ThreadState {
  if (fix.status === "applied") return "merged";
  if (fix.status === "ready") return "ready";
  if (fix.status === "failed" || fix.status === "discarded") return "failed";
  return fix.waiting ? "you" : "work";
}

/// How full a thread's ring is: steps so far against a typical job, never
/// full until it is back.
export function threadProgress(fix: DriveFix): number {
  const state = threadState(fix);
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
const checksWord = (fix: DriveFix) => !fix.checks?.length ? "" : fix.checks.every((check) => check.passed) ? "checks passed" : "a check failed";

/// One plain line on what a thread is doing or how it ended.
export function threadLine(fix: DriveFix): string {
  const state = threadState(fix);
  if (state === "you") return `<span class="amber">Waits for you</span>`;
  if (state === "work") return esc(fix.activity?.last ? `${fix.activity.last}…` : fix.status === "starting" ? "Starting…" : "Working…");
  if (state === "merged") return "Merged onto your branch";
  if (state === "failed") return `<span class="danger">${esc(fix.error ?? "It stopped.")}</span>`;
  return ["Ready", counts(fix.diff), checksWord(fix)].filter(Boolean).join(" · ");
}

function meta(fix: DriveFix): string {
  const state = threadState(fix);
  if (state === "you") return `<span class="th-pill you">Needs you</span>`;
  if (state === "ready") return `<span class="th-ok">${CHECK}</span>`;
  if (state === "work" && fix.startedAt) return `<span>${Math.max(1, Math.round((Date.now() - Date.parse(fix.startedAt)) / 60_000))}m</span>`;
  return "";
}

export function threadListHTML(view: ThreadsView): string {
  if (!view.list.length) return "";
  return `<div class="th-label">Threads</div><div class="th-list">${view.list.map((fix) => {
    const on = !view.closed && view.open === fix.id;
    return `<button type="button" class="th-row${on ? " on" : ""}" data-action="thread-open" data-args="${esc(JSON.stringify({ id: fix.id }))}" aria-pressed="${on}" title="${esc(fix.thread?.files.length ? `Claims ${fix.thread.files.join(", ")}` : fix.title)}">${ring(fix)}<span class="th-name">${esc(fix.title)}</span><span class="th-meta">${meta(fix)}</span><span class="th-line">${threadLine(fix)}</span></button>`;
  }).join("")}</div>`;
}

/// Above the orchestrator's composer: how the threads are doing in one line,
/// or, once they're all back, the bar with Merge all.
export function threadsFootHTML(view: ThreadsView): string {
  const open = view.list.filter((fix) => threadState(fix) !== "merged" && fix.status !== "discarded");
  const message = view.message ? `<p class="th-msg ${view.message.tone}"><span>${esc(view.message.text)}</span>${button("threads-message-close", "×", {}, "th-x")}</p>` : "";
  if (!open.length) return message;
  const by = (state: ThreadState) => open.filter((fix) => threadState(fix) === state).length;
  const you = by("you"), work = by("work"), ready = by("ready"), failed = by("failed");
  if (!you && !work && ready) {
    const back = open.filter((fix) => threadState(fix) === "ready");
    const passed = back.every((fix) => fix.checks?.length && fix.checks.every((check) => check.passed));
    const merging = view.busy === "merge";
    return `${message}<div class="th-merge"><span><b>${ready} ready to merge</b>${passed ? " · checks passed on each" : ""}${failed ? ` · ${failed} stopped` : ""}</span>${button("threads-merge", merging ? "Merging…" : ready === 1 ? "Merge" : ready === 2 ? "Merge both" : `Merge all ${ready}`, {}, "primary", Boolean(view.busy))}</div>`;
  }
  const parts = [you ? `<span class="amber">${you} need${you === 1 ? "s" : ""} you</span>` : "", work ? `${work} working` : "", ready ? `${ready} ready` : "", failed ? `${failed} stopped` : ""].filter(Boolean);
  return `${message}<div class="th-status">${parts.join(" · ")}</div>`;
}

/// The right half's head: the thread's name, where it works and how it is,
/// then Merge once it is ready, and ×. Nothing else.
export function threadHeadHTML(view: ThreadsView, fix: DriveFix): string {
  const state = threadState(fix), index = view.list.indexOf(fix);
  const how = { work: "working", you: "waits for you", ready: "ready", merged: "merged", failed: "stopped" }[state];
  const merge = state === "ready" ? button("thread-merge", view.busy === fix.id ? "Merging…" : "Merge", { id: fix.id }, "tp-merge", Boolean(view.busy)) : "";
  return `<div class="tp-title"><b>${esc(fix.title)}</b><span>${esc(fix.branch)} · <span class="${state === "you" ? "amber" : state === "failed" ? "danger" : ""}">${how}</span>${view.list.length > 1 ? ` · ${index + 1} of ${view.list.length}` : ""}</span></div><span class="sp"></span>${merge}${button("thread-close", '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>', {}, "tp-x").replace("<button ", '<button aria-label="Close the thread" title="Close" ')}`;
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
  const what = failed ? "stopped" : ["finished", report.diff ? `${report.diff.files} file${report.diff.files === 1 ? "" : "s"}` : "", report.checks?.length ? report.checks.every((check) => check.passed) ? "checks passed" : "a check failed" : ""].filter(Boolean).join(" · ");
  return `<div class="request thread-report${failed ? " failed" : ""}" title="${esc(report.summary)}">${button("thread-open", `<span class="tr-mark">${failed ? "×" : CHECK}</span><b>${esc(report.title)}</b><span class="tr-what">${esc(what)}</span>`, { id: report.fix }, "tr-line")}<span class="request-meta"><time>${esc(time)}</time></span></div>`;
}
