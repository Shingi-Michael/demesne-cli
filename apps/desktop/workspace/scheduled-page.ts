/// Scheduled: chats that start on their own. Routines are one sentence each,
/// when and then what, and Drive's own quiet-time runs sit with them, so
/// there is one place to see and switch them.
import type { DriveAuto, Routine } from "@demesne/protocol";
import { dayWord } from "./chats-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;
const projectWords = (path: string | null | undefined) => path ? path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path : "Just a chat";
/// "today", "tomorrow", or the weekday: when a routine runs next.
const aheadWord = (date: string, now: number) => {
  const then = new Date(date), today = new Date(now);
  const days = Math.round((new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : then.toLocaleDateString([], { weekday: "long" });
};
const clock = (date: string) => new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export interface ScheduledView {
  routines: Routine[] | null;
  /// Drive's quiet-time runs in this window's project, when it has one.
  auto: DriveAuto | null;
  /// This window's project, so a run's chat opens in place or switches.
  here: string;
  /// Opened from the assistant's chat: a new routine runs there.
  assistant?: boolean;
  error: string;
  draft: string;
}

const onOff = (on: boolean, action: string, args: Record<string, unknown>, name: string) =>
  btn(action, on ? "On" : "Off", { ...args, on: !on }, `sp-switch${on ? " on" : ""}`).replace("<button ", `<button aria-pressed="${on}" aria-label="${h(`${name}: ${on ? "on" : "off"}`)}" `);

export function scheduledPage(view: ScheduledView, now = Date.now()) {
  const routines = view.routines;
  const rows = routines === null ? '<p class="cp-empty">Reading your routines…</p>' : [
    ...routines.map((routine) => `<div class="sp-row${routine.on ? "" : " off"}"><span class="sp-when" title="${h(routine.text)}">${h(routine.when ?? routine.at)}</span><span class="sp-what"><b>${h(routine.prompt)}</b><span class="sp-sub">${routine.on && routine.next ? `Next ${h(aheadWord(routine.next, now))} at ${h(clock(routine.next))}` : routine.on ? "" : "Off"}${routine.runs.length ? ` · ran ${routine.runs.length}×` : ""}</span></span><span class="sp-where">${h(routine.assistant ? "Assistant" : projectWords(routine.workspace))}</span>${btn("routine-remove", "Delete", { id: routine.id }, "sp-remove").replace("<button ", `<button aria-label="${h(`Delete ${routine.prompt}`)}" `)}${onOff(routine.on, "routine-set", { id: routine.id }, routine.prompt)}</div>`),
    view.auto ? `<div class="sp-row${view.auto.on ? "" : " off"}"><span class="sp-when">After ${view.auto.quietMinutes} quiet minutes</span><span class="sp-what"><b>Drive runs its best idea</b><span class="sp-sub">One branch at a time, at most ${view.auto.perDay} a day, never pushes${view.auto.usedToday ? ` · ${view.auto.usedToday} today` : ""}</span></span><span class="sp-where">${h(projectWords(view.auto.workspace))}</span>${onOff(view.auto.on, "drive-auto", {}, "Drive runs its best idea")}</div>` : "",
  ].join("") || '<p class="cp-empty">No routines yet. Write one below.</p>';
  const week = now - 7 * 86_400_000;
  const runs = (routines ?? []).flatMap((routine) => routine.runs.filter((run) => Date.parse(run.at) >= week).map((run) => ({ ...run, routine })))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  const runRows = runs.map((run) => {
    const here = !run.routine.workspace || run.routine.workspace === view.here;
    const open = btn(here ? "select-session" : "project-session", "Open ›", { id: run.sessionId, ...(run.routine.workspace ? { path: run.routine.workspace } : {}) }, "sp-open");
    return `<div class="sp-row"><span class="sp-when">${h(dayWord(run.at, new Date(now)))} · ${h(clock(run.at))}</span><span class="sp-what">${h(run.routine.prompt)}<span class="sp-sub"> · ${h(run.routine.assistant ? "Assistant" : projectWords(run.routine.workspace))}</span></span>${open}</div>`;
  }).join("");
  const count = routines ? routines.length + (view.auto ? 1 : 0) : "";
  return `<h1 class="cp-title">Scheduled</h1><p class="cp-lede">Chats that start on their own. Each run is a chat in its project, listed like any other.</p>`
    + `<div class="cp-head"><span>Routines</span><span>${count}</span></div><div class="cp-list">${rows}</div>`
    + (runRows ? `<div class="cp-head"><span>Last runs</span><span>this week</span></div><div class="cp-list">${runRows}</div>` : "")
    + `<form class="sp-new" id="routine-new"><input name="routine" value="${h(view.draft)}" placeholder="Every Monday at 9, list the PRs waiting on me" aria-label="A new routine: when, then what" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">↵</kbd></form>`
    + (view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : `<p class="sp-hint">When first, then what. ${view.assistant ? "At its time the assistant answers it in its chat" : `At its time it opens a chat in ${h(view.here ? projectWords(view.here) : "Just a chat")}`}, whether or not this window is open.</p>`);
}
