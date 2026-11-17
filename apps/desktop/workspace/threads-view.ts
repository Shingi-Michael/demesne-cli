import type { DriveFix, DriveFixChange } from "@demesne/protocol";
import type { ThreadReport } from "../../../packages/protocol/src/thread-report.ts";

/// Threads in the chat that started them (pass 232). Threads are separate
/// jobs: each can be on a different thing and start at a different time. So
/// the chat keeps one ribbon at its top for every thread that is still
/// live, sorted by what needs you, each line ending in its one next step. A
/// line opens in place to the thread's last steps, or to what it changed
/// with Merge right there. A merged thread leaves the ribbon; the reply that
/// started it keeps one quiet line as the record.

export interface ThreadsView {
  list: DriveFix[];
  /// The thread whose line is open, by its job id.
  open: string | null;
  busy: string | null;
  message: { text: string; tone: "ok" | "error" } | null;
  /// What the open line's thread changed, once it is back.
  changes?: { id: string; files: DriveFixChange[]; more: number } | null;
}

/// What only the window knows about the ribbon.
export interface ThreadsLook {
  folded: boolean;
  /// The file whose diff is unfolded in the open line.
  file: string | null;
  /// The thread whose Delete was pressed once.
  armed: string | null;
  /// The open thread's last words and last steps, drawn by the chat's own code.
  peek: { of: string; say: string; steps: string } | null;
  /// The thread whose question waits at the end of this chat.
  asking: string | null;
}

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const button = (action: string, label: string, data: Record<string, unknown>, className = "", disabled = false) =>
  `<button type="button"${disabled ? " disabled" : ""} class="${className}" data-action="${action}" data-args="${esc(JSON.stringify(data))}">${label}</button>`;
const CHECK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const chevron = (className: string) => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;

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

const counts = (additions: number, deletions: number) => `<span class="plus">+${additions}</span> <span class="minus">−${deletions}</span>`;
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
  if (state === "you") return `<span class="amber">Asks you</span>`;
  if (state === "waits") return esc(`After ${list.find((item) => item.id === fix.thread?.after)?.title ?? "the thread it's built on"}`);
  if (state === "work") return fix.review?.sentBack ? `<span class="sent">Sent back</span>${fix.review.note ? ` · ${esc(fix.review.note)}` : ""}`
    : fix.status === "starting" && !fix.activity?.last ? "Starting" : esc(threadDoing(fix.activity?.last));
  if (state === "merged") return fix.mergedElsewhere === "github" ? "Merged on GitHub" : "Merged";
  if (state === "failed") return `<span class="red">Stopped</span>${fix.error ? ` · ${esc(fix.error)}` : ""}`;
  const failed = fix.checks?.some((check) => !check.passed) ? "a check failed" : "";
  return ["Ready", fix.diff ? counts(fix.diff.additions, fix.diff.deletions) : "", failed, !fix.review?.checked && fix.review?.note && fix.review.note !== failed ? esc(fix.review.note) : ""].filter(Boolean).join(" · ");
}

/// What a line's hover says: everything the line leaves out.
function threadTip(fix: DriveFix): string {
  const state = threadState(fix);
  const checks = !fix.checks?.length ? "" : fix.checks.every((check) => check.passed) ? "checks passed" : "a check failed";
  return [fix.title, fix.thread?.files.length ? `Only touches ${fix.thread.files.join(", ")}` : "", state === "ready" ? [fix.review?.checked ? "checked by the orchestrator" : "", checks].filter(Boolean).join(" · ") : "",
    state === "failed" ? fix.error ?? "" : ""].filter(Boolean).join("\n");
}

/// The threads the ribbon holds: every one that isn't merged, with what
/// needs you first (asks you, stopped), then ready, then working. Among
/// equals the order they started in stays, so a line only moves when its
/// thread's state does.
const RANK: Record<ThreadState, number> = { you: 0, failed: 1, ready: 2, work: 3, waits: 4, merged: 5 };
export function liveThreads(list: DriveFix[]): DriveFix[] {
  return list.map((fix, at) => ({ fix, at })).filter(({ fix }) => fix.status !== "applied" && fix.status !== "discarded")
    .sort((a, b) => RANK[threadState(a.fix)] - RANK[threadState(b.fix)] || a.at - b.at).map(({ fix }) => fix);
}

const NUMBER = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
const threads = (count: number) => `${NUMBER[count] ?? count} thread${count === 1 ? "" : "s"}`;

/// The bar's words: how every live thread stands, counted across them
/// whatever each is on. A single thread that needs you is named.
export function threadsBar(list: DriveFix[]): { name: string; count: string; tone: "asks" | "still" | "" } {
  const live = liveThreads(list), by = (state: ThreadState) => live.filter((fix) => threadState(fix) === state).length;
  const you = by("you"), failed = by("failed"), ready = by("ready"), work = by("work") + by("waits"), need = you + failed;
  const name = need === 1 ? `${live[0]!.title} ${you ? "asks you" : "stopped"}` : need ? `${threads(need)} need you` : work ? `${threads(work)} working` : `${threads(ready)} ready to merge`;
  const count = [need && work ? `${work} working` : "", (need || work) && ready ? `${ready} ready` : ""].filter(Boolean).join(" · ");
  return { name, count, tone: need ? "asks" : work ? "" : "still" };
}

/// The one next step a line ends in: Answer, Merge, or Open for a thread that stopped.
function threadNext(view: ThreadsView, fix: DriveFix): string {
  const state = threadState(fix);
  if (state === "ready") return button("thread-merge", view.busy === fix.id ? "Merging…" : "Merge", { id: fix.id }, "tr-next ready", Boolean(view.busy));
  if (state === "you") return button("thread-answer", "Answer", { id: fix.id }, "tr-next you");
  if (state === "failed" && fix.sessionId) return button("select-session", "Open", { id: fix.sessionId }, "tr-next failed");
  return "";
}

const SEGMENT: Record<ThreadState, string> = { work: "n", you: "y", failed: "r", ready: "d", waits: "p", merged: "d" };
const minutes = (fix: DriveFix) => fix.startedAt ? `${Math.max(1, Math.round((Date.now() - Date.parse(fix.startedAt)) / 60_000))}m` : "";

/// How a ready thread was checked, in a few words.
function threadChecked(fix: DriveFix): string {
  const checks = fix.checks ?? [], passed = checks.length > 0 && checks.every((check) => check.passed);
  const check = !checks.length ? "" : !passed ? `<span class="red">a check failed</span>` : checks.length === 1 && checks[0]!.command.length <= 28 ? `${esc(checks[0]!.command)} passed` : "checks passed";
  return [fix.review?.checked ? "Stayed in its files" : "", check, !fix.review?.checked && fix.review?.note && !/check failed/.test(fix.review.note) ? esc(fix.review.note) : ""].filter(Boolean).join(" · ") || esc(fix.branch);
}

/// One changed file: its name and counts; opened, its diff.
function changedFile(file: DriveFixChange, open: boolean): string {
  const lines = !open ? "" : `<div class="tr-diff">${file.patch.split("\n").map((line) => `<div class="${line.startsWith("@@") ? "h" : line.startsWith("+") ? "a" : line.startsWith("-") ? "d" : ""}">${esc(line) || " "}</div>`).join("")}${file.cut ? `<div class="h">… the rest of this file is in its chat</div>` : ""}</div>`;
  return `<button type="button" class="tr-file" data-action="thread-file" data-args="${esc(JSON.stringify({ path: file.path }))}" aria-expanded="${open}"${file.patch ? "" : " disabled"}>${chevron("chev")}<span class="path">${esc(file.path)}</span><span class="counts">${counts(file.additions, file.deletions)}</span></button>${lines}`;
}

/// What opening a line shows: the thread's last words and steps while it
/// works, what it changed once it is back.
function threadPeekHTML(view: ThreadsView, look: ThreadsLook, fix: DriveFix): string {
  const state = threadState(fix), peek = look.peek?.of === fix.id ? look.peek : null;
  const chat = fix.sessionId ? button("select-session", "Open its chat", { id: fix.sessionId }, "tr-link") : "";
  // A thread with work on its branch asks once more before it is deleted.
  const armed = look.armed === fix.id;
  const remove = button(armed ? "thread-delete" : "thread-delete-arm", armed ? "Delete it and its branch" : "Delete", { id: fix.id }, `tr-link${armed ? " armed" : ""}`, Boolean(view.busy));
  const note = (words: string, end = "") => `<div class="tr-note"><span>${words}</span><span class="sp"></span>${remove}${chat}${end}</div>`;
  const say = (text: string | null | undefined, className = "") => text?.trim() ? `<p class="tr-say${className}">${esc(text.trim())}</p>` : "";
  const steps = peek?.steps ? `<div class="steps">${peek.steps}</div>` : "";
  if (state === "waits") return `<div class="tr-peek">${say(fix.thread?.brief)}${note(`Starts once ${esc(view.list.find((item) => item.id === fix.thread?.after)?.title ?? "the thread it's built on")} is back`)}</div>`;
  if (state === "failed") return `<div class="tr-peek">${say(fix.error ?? "It stopped before it finished.")}${steps}${note("Nothing on your branch was touched")}</div>`;
  if (state === "you") return `<div class="tr-peek">${say(peek?.say || fix.thread?.brief)}${steps}${note(look.asking === fix.id ? "Its question is waiting at the end of this chat" : "It waits for your go-ahead in its chat")}</div>`;
  if (state === "work") return `<div class="tr-peek">${say(peek?.say || fix.thread?.brief)}${steps}${note(esc(fix.branch))}</div>`;
  const changes = view.changes?.id === fix.id ? view.changes : null;
  const files = changes
    ? `${changes.files.map((file) => changedFile(file, look.file === file.path)).join("")}${changes.more ? `<div class="tr-more">and ${changes.more} more file${changes.more === 1 ? "" : "s"}</div>` : ""}`
    : (fix.diff?.paths ?? []).slice(0, 12).map((path) => `<div class="tr-file"><span class="path">${esc(path)}</span></div>`).join("");
  const merge = button("thread-merge", view.busy === fix.id ? "Merging…" : "Merge", { id: fix.id }, "tr-go", Boolean(view.busy));
  return `<div class="tr-peek">${say(fix.summary)}${files ? `<div class="tr-files">${files}</div>` : ""}${note(threadChecked(fix), merge)}</div>`;
}

/// The threads ribbon: the checklist ribbon's shape, one per chat. The bar
/// says how every live thread stands, with one fine segment each; opened,
/// one line per thread. Nothing when no thread is live.
export function threadsRibbonHTML(view: ThreadsView, look: ThreadsLook): string {
  const live = liveThreads(view.list);
  if (!live.length) return "";
  const bar = threadsBar(view.list);
  const segments = live.map((fix) => `<i class="${SEGMENT[threadState(fix)]}"><b></b></i>`).join("");
  const rows = live.map((fix) => {
    const state = threadState(fix), open = view.open === fix.id;
    const time = state === "work" ? minutes(fix) : "";
    return `<div class="tr-item ${state}${open ? " open" : ""}" data-thread="${esc(fix.id)}"><div class="tr-head"><button type="button" class="tr-row" data-action="${open ? "thread-close" : "thread-open"}" data-args="${esc(JSON.stringify({ id: fix.id }))}" aria-expanded="${open}" title="${esc(threadTip(fix))}">${ring(fix)}<span class="tr-name">${esc(fix.title)}</span><span class="tr-words">${threadLine(fix, view.list)}</span>${time ? `<span class="tr-end">${time}</span>` : ""}${chevron("tr-chev")}</button>${threadNext(view, fix)}</div>${open ? threadPeekHTML(view, look, fix) : ""}</div>`;
  }).join("");
  // Merge all, only once every live thread is ready: nothing waits for the rest, each still merges on its own line.
  const ready = live.filter((fix) => threadState(fix) === "ready");
  const total = ready.reduce((sum, fix) => ({ additions: sum.additions + (fix.diff?.additions ?? 0), deletions: sum.deletions + (fix.diff?.deletions ?? 0), files: sum.files + (fix.diff?.files ?? 0) }), { additions: 0, deletions: 0, files: 0 });
  const checked = ready.every((fix) => fix.review?.checked || (fix.checks?.length && fix.checks.every((check) => check.passed)));
  const foot = ready.length > 1 && ready.length === live.length
    ? `<div class="tr-foot"><span>${counts(total.additions, total.deletions)} in ${total.files} file${total.files === 1 ? "" : "s"}${checked ? " · each one checked" : ""}</span><span class="sp"></span>${button("threads-merge", view.busy === "merge" ? "Merging…" : `Merge all ${ready.length}`, {}, "tr-go", Boolean(view.busy))}</div>` : "";
  const open = !look.folded;
  return `<div class="plan-ribbon tr${open ? " open" : ""}${bar.tone ? ` ${bar.tone}` : ""}"><div class="pr-card"><button type="button" class="pr-bar" data-action="threads-fold" aria-expanded="${open}" aria-label="Threads: ${esc(bar.name)}"><span class="pr-ok"></span><span class="pr-cur"><span class="pr-name">${esc(bar.name)}</span></span><span class="pr-ct">${esc(bar.count)}</span><span class="pr-segs">${segments}</span></button><div class="pr-fold"${open ? "" : " inert"}><div><div class="pr-list" role="group" aria-label="Threads">${rows}${foot}</div></div></div></div></div>`;
}

/// The thread a reply started, among the chat's threads: by name, and by
/// when it started when two share a name.
function begun(list: DriveFix[], title: string, at: number): DriveFix | null {
  const named = list.filter((fix) => fix.title.toLowerCase() === title.toLowerCase());
  return named.sort((a, b) => Math.abs(Date.parse(a.startedAt ?? "") - at) - Math.abs(Date.parse(b.startedAt ?? "") - at))[0] ?? null;
}

/// What resting on a started thread's name says: how it stands, and what a click does.
function begunTip(fix: DriveFix): string {
  if (fix.status !== "applied") return `${fix.title}\n${fix.branch} · show it in the threads bar`;
  return [fix.title, fix.mergedElsewhere === "github" ? "Its pull request was merged on GitHub. Pull to bring it into this checkout." : fix.mergedElsewhere ? "Merged outside Demesne: your branch already holds its work." : "Merged onto your branch", "Open its chat"].join("\n");
}

/// Under the reply that started threads: one quiet line of what it started.
/// The ring stays live and turns into a tick once merged. A name opens that
/// thread's line in the ribbon, or its chat once it is merged.
export function threadsBegunHTML(view: ThreadsView, titles: string[], at = 0): string {
  const found = titles.map((title) => ({ title, fix: begun(view.list, title, at) }));
  if (!found.length) return "";
  // A deleted thread keeps its name here, and no ring.
  const known = found.flatMap(({ fix }) => fix ? [fix] : []), merged = known.length > 0 && known.every((fix) => fix.status === "applied");
  return `<span class="tr-word">${merged ? "Merged" : "Started"}</span>${found.map(({ title, fix }) => !fix ? `<span class="tr-gone">${esc(title)}</span>`
    : button("thread-jump", `${ring(fix)}<span>${esc(fix.title)}</span>`, { id: fix.id, chat: fix.sessionId }, "").replace("<button ", `<button title="${esc(begunTip(fix))}" `)).join("")}`;
}

/// Above the composer: what a merge or a delete just did, or why it didn't.
export function threadsMessageHTML(view: ThreadsView): string {
  return view.message ? `<p class="th-msg ${view.message.tone}"><span>${esc(view.message.text)}</span>${button("threads-message-close", "×", {}, "th-x")}</p>` : "";
}

/// At the top of a thread's own chat, in place of the long prompt it was
/// started with: whose thread it is (the way back), its brief and its files.
export function threadBriefHTML(fix: DriveFix | null, prompt: string, from: { id: string; title: string } | null = null): string {
  const brief = fix?.thread?.brief ?? /\nYour job: [^\n]*\n([^\n]+)/.exec(prompt)?.[1] ?? "";
  const files = fix?.thread?.files ?? [];
  const whose = from ? `A thread of ${button("select-session", esc(from.title || "its chat"), { id: from.id }, "")}` : "A thread";
  return `<div class="tr-brief">${whose} · <b>${esc(brief || prompt.slice(0, 400))}</b>${files.length ? ` · Only touches ${files.map((file) => `<code>${esc(file)}</code>`).join(" ")}` : ""}</div>`;
}

/// A thread reporting back, as one quiet line in the orchestrator's chat.
export function threadReportHTML(report: ThreadReport, time: string): string {
  const failed = report.status === "failed";
  const what = failed ? "stopped" : ["finished", report.diff ? `${report.diff.files} file${report.diff.files === 1 ? "" : "s"}` : "", report.review?.checked ? "checked" : report.checks?.length ? report.checks.every((check) => check.passed) ? "checks passed" : "a check failed" : "",
    report.review?.sentBack ? `sent back ${report.review.sentBack === 1 ? "once" : `${report.review.sentBack} times`}` : ""].filter(Boolean).join(" · ");
  return `<div class="request thread-report${failed ? " failed" : ""}" title="${esc(report.summary)}">${button("thread-jump", `<span class="tr-mark">${failed ? "×" : CHECK}</span><b>${esc(report.title)}</b><span class="tr-what">${esc(what)}</span>`, { id: report.fix, chat: report.chat }, "tr-line")}<span class="request-meta"><time>${esc(time)}</time></span></div>`;
}
