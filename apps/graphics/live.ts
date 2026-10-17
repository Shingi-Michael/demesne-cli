import { compactedConversation } from "./compacted-conversation.ts";
import { markdown, MarkdownView } from "./markdown.ts";
import { splitNextPrompt } from "../../packages/protocol/src/next-prompt.ts";
import { StateReceiver, type StateUpdate } from "./state-wire.ts";
import { codeDiff } from "../cli/src/workbench/change-diff.ts";
import { driveSince, driveStepLine, driveTaskList } from "../cli/src/workbench/drive-timeline.ts";
import { subagentPhrase } from "../cli/src/workbench/subagent-phrases.ts";
import type { GraphicsHost } from "./host.ts";
import type { GraphicsRun } from "./session-model.ts";
import type {
  ToolEntry,
  WorkbenchEntry,
} from "../cli/src/workbench/entries.ts";
import type {
  ModelDescriptor,
  ModelScore,
  ModelScoreboardResponse,
  DriveState,
  DriveObservation,
  CommandRecord,
} from "@demesne/protocol";

type Snapshot = ReturnType<GraphicsHost["snapshot"]>;
type OverlayName =
  | "settings"
  | "models"
  | "themes"
  | "providers"
  | "cleanup"
  | "sessions"
  | "rename"
  | "session"
  | "confirm-archive"
  | "confirm-undo"
  | "help";
declare global {
  interface Window {
    demesne: {
      mode?: "desktop";
      request<T = unknown>(
        method: string,
        args?: Record<string, unknown>,
      ): Promise<T>;
      subscribe(callback: (update: StateUpdate) => void): () => void;
      commands(
        callback: (
          command: import("./drive-controller.ts").GraphicsUICommand,
        ) => void,
      ): () => void;
      ready(): void;
    };
    demesneInspect?: () => unknown;
  }
}
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
const h = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const shortcut = (key: string) => /Mac/i.test(navigator.platform) ? key.replace(/^Ctrl\+/, "⌘") : key;
const k = (key: string) => `<kbd>${h(shortcut(key))}</kbd>`;
/// A session view, not the start screen: it has turns, or Drive is working
/// it (Drive plans before its first turn).
const inSession = (snapshot: Snapshot | null = state) =>
  Boolean(snapshot && (snapshot.runs.length || (snapshot.drive && snapshot.drive.homeSessionId === snapshot.session?.id)));
/// The thinking level each /model row would switch to: picked with ←→,
/// else the current choice for the current model, else the model's default.
const modelLevels = new Map<string, string>();
function modelLevel(model: ModelDescriptor): string | undefined {
  const levels = model.reasoningLevels;
  if (!levels?.length) return undefined;
  return modelLevels.get(model.id) ?? (model.id === state?.model.id ? state.reasoning : undefined) ?? model.defaultReasoningLevel ?? levels[0];
}
/// Thinking reads as Markdown (ChatGPT's summaries are "**Checking the
/// bound**" sections; local models write math), except a very long trace,
/// which stays plain text so streaming it never reparses a novel.
function thinkingBody(raw: string) {
  return raw.length > 24_000 ? `<pre>${h(raw)}</pre>` : `<div class="markdown thinking-text">${markdown(raw)}</div>`;
}
/// A provider with more models than this (OpenRouter) collapses in /model.
const LARGE_CATALOG = 25;
/// Menus draw at most this many rows; the filter narrows the rest.
const MAX_MENU_ROWS = 60;
const btn = (
  action: string,
  label: string,
  data: Record<string, unknown> = {},
  className = "",
  drive = false,
  disabled = false,
) =>
  `<button type="button"${disabled ? " disabled" : ""} class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}"${drive ? ` data-drive="${h(action + JSON.stringify(data))}"` : ""}>${label}</button>`;
const num = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)}m`
      : value >= 1000
        ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
        : String(value);
const duration = (ms: number | null | undefined) =>
  ms == null || !Number.isFinite(ms)
    ? "—"
    : ms < 1000
      ? `${Math.round(ms)}ms`
      : ms < 100000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
const clock = (value: string | number | undefined) =>
  value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const age = (date: string) => {
  const ms = Date.now() - Date.parse(date);
  return ms < 60000
    ? "just now"
    : ms < 3600000
      ? `${Math.floor(ms / 60000)}m ago`
      : ms < 86400000
        ? `${Math.floor(ms / 3600000)}h ago`
        : ms < 172800000
          ? "yesterday"
          : new Date(date).toLocaleDateString([], {
              month: "short",
              day: "numeric",
            });
};
const pathHTML = (path: string) => {
  const slash = path.lastIndexOf("/");
  return `<span class="folder">${h(path.slice(0, slash + 1))}</span>${h(path.slice(slash + 1))}`;
};
const active = (run: GraphicsRun) =>
  run.status === "running" || run.status === "queued";
const mark = (status: string) =>
  status === "done" || status === "completed"
    ? "✓"
    : status === "failed" || status === "denied"
      ? "×"
      : status === "stopped" ||
          status === "cancelled" ||
          status === "interrupted"
        ? "■"
        : "◌";
const tone = (status: string) =>
  status === "done" || status === "completed"
    ? "success"
    : status === "failed" || status === "denied"
      ? "danger"
      : status === "running" || status === "queued"
        ? "amber"
        : "muted";
const verb = (tool: ToolEntry) =>
  ({
    run_command: "Run",
    ask_user: "Ask",
    compact_session: "Compact",
    apply_theme: "Apply theme",
    view_image: "View",
    read_file: "Read",
    read_files: "Read",
    write_file: "Write",
    edit_file: "Edit",
    search_files: "Search",
    list_files: "List",
    move_path: "Move",
    delete_path: "Delete",
    git_diff: "Diff",
    git_status: "Git",
    git_history: "History",
    session_tools: "Tool",
    subagent: "Agent",
  })[tool.name] ?? tool.name.replaceAll("_", " ");
const tools = (run: GraphicsRun) =>
  run.entries.filter((entry): entry is ToolEntry => entry.type === "tool");
let state: Snapshot | null = null,
  paneTurn = "";
/// What Drive is inspecting in the conversation (its diff, checks or log),
/// and which check; the observation names that surface.
let inspectSurface: "diff" | "review" | "log" | null = null,
  inspectItem = "";
let overlay: OverlayName | null = null,
  overlayQuery = "",
  overlayIndex = 0,
  models: ModelDescriptor[] = [],
  /// The model scoreboard, by provider and model id.
  modelScores = new Map<string, ModelScore>(),
  modelsLoading = false,
  /// The model picker opens on the current model once the list arrives.
  modelIndexPending = false,
  overlayRows: {
    label: string;
    value: string;
    action: string;
    data: Record<string, unknown>;
    group?: string;
    hint?: string;
    description?: string;
  }[] = [];
let completionItems: {
    label: string;
    description: string;
    hint: string;
    group: string;
    value: string;
    kind: "command" | "mention";
  }[] = [],
  completionIndex = 0,
  completionDismissed = false;
let follow = true,
  readingHeld = false,
  driveNavigating = false,
  stopArmed = 0,
  draftTimer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  lastDraftVersion = -1,
  lastSession = "";
const expanded = new Set<string>(),
  detailsOpen = new Set<string>(),
  detailsClosed = new Set<string>(),
  runNodes = new Map<
    string,
    {
      signature: string;
      node: HTMLElement;
      run?: GraphicsRun;
      views: Map<number, MarkdownView>;
    }
  >();
/// The briefing line's unfolded parts above the composer (on the start
/// screen, Drive's ideas under it); turns whose steps are open.
let driveShown = false,
  ideasShown = false;
const stepsOpen = new Set<string>();
/// Steps whose diff or output is unfolded in place, keyed run:tool.
const stepOpen = new Set<string>();
/// The turn whose changes the undo confirmation reverts.
let undoTurnId: string | null = null;
const expandedCompactions = new Set<string>();
let compactionCard: HTMLElement | null = null;
let compactionCardSignature = "";
let overlaySignature = "",
  approvalSignature = "",
  questionSignature = "",
  heroSignature = "";
const diffCache = new Map<string, { added: number; removed: number }>();
/// The last few requests and how they ended, for demesneInspect.
const recentRequests: { method: string; at: number; outcome: string }[] = [];
async function api<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const entry = { method, at: Date.now(), outcome: "pending" };
  if (recentRequests.push(entry) > 20) recentRequests.shift();
  try {
    const result = await window.demesne.request<T>(method, {
      ...args,
      ...(["drive", "drive-control"].includes(method)
        ? { observation: observeUI() }
        : {}),
      sessionId: state?.session?.id,
    });
    entry.outcome = "ok";
    return result;
  } catch (error) {
    entry.outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}
function notice(message: string) {
  el("notice").textContent = message;
  el("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el("notice").hidden = true), 4000);
}
async function act(task: () => Promise<unknown>) {
  try {
    return await task();
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error));
    return null;
  }
}
function context() {
  const plan = state?.provider?.contextPlan,
    usage = state?.provider?.usage;
  const used =
    plan?.estimatedInputTokens ??
    usage?.totalTokens ??
    (state?.runs.length === 0 ? 0 : null);
  const capacity = plan?.capacityTokens ?? state?.model.contextWindow ?? null;
  return {
    used,
    capacity,
    estimated: plan?.estimatedInputTokens != null,
    percentage:
      used != null && capacity ? Math.round((used / capacity) * 100) : null,
  };
}
let sidebarSignature = "";
/// A day bucket for the inbox: today's rows carry no heading.
const dayGroup = (date: string) => {
  const ms = Date.now() - Date.parse(date);
  return ms < 86_400_000 ? "" : ms < 172_800_000 ? "Yesterday" : ms < 7 * 86_400_000 ? "This week" : "Earlier";
};
/// "2h", "yesterday", "Oct 3": the quiet time beside a settled session.
const shortAge = (date: string) => {
  const ms = Date.now() - Date.parse(date);
  return ms < 60_000 ? "now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : ms < 172_800_000 ? "yesterday" : ms < 7 * 86_400_000 ? `${Math.floor(ms / 86_400_000)}d` : new Date(date).toLocaleDateString([], { month: "short", day: "numeric" });
};
/// The full time, for a row's tooltip.
const fullTime = (date: string) => new Date(date).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/// When each chat was last looked at (its updatedAt then): a chat that has
/// moved on since, while you were elsewhere, gets the blue "new reply" dot.
const SEEN_KEY = "demesne.sidebar.seen";
const seenChats: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") ?? {}; } catch { return {}; }
})();
function markSeen(id: string, updatedAt: string) {
  if (seenChats[id] === updatedAt) return;
  seenChats[id] = updatedAt;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenChats)); } catch { /* storage may be off */ }
}
/// What a row's dot means, in words: for its tooltip and screen readers.
const STATE_WORDS: Record<string, string> = { warn: "needs you", working: "working", bad: "failed", acc: "new reply" };
/// Chats deleted from the sidebar a moment ago: they leave the list at once
/// and are archived after UNDO_MS, so ⌘Z can bring the last one back.
const UNDO_MS = 5_000;
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
/// How many conversations the sidebar lists. Deleting one moves the next up;
/// search finds the older ones.
const SIDEBAR_ROWS = 6;
/// Conversations deleted from the sidebar, hidden at once while the daemon
/// archives them.
const deletedSessions = new Set<string>();
const ICON_TRASH = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';
/// The sidebar: the project's pulse, one inbox-style list of sessions (a
/// session that needs you gets a second, coloured line; a settled one is a
/// single quiet line with its time), Drive as a short footer, and the rail's
/// dots when the sidebar is folded.
function renderSidebar() {
  const list = document.getElementById("sidebar-sessions");
  if (!state || !list) return;
  const query = (document.getElementById("sidebar-search") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  const sessions = state.sessions.filter(item => (item.workspace === state!.workspace || item.id === state!.session?.id) && !deletedSessions.has(item.id));
  const review = reviewJobs(), pinned = pinnedMission(), run = worktreeRun(), word = driveWord();
  const ideas = state.driveNext.proposals.length;
  const waiting = state.approvals.length ? "approval" : state.questions.length ? "answer" : "";
  const signature = JSON.stringify([sessions, [...deletedSessions], state.session?.id, state.session?.title, state.connection, state.activeTurnId, query, waiting, review.map((job) => [job.id, job.status, job.title, job.diff]), pinned && [pinned.status, pinned.mission, driveProgress(pinned)], run.fix?.status, run.away?.status, word, ideas, state.session?.workspace?.gitBranch, inSession(), Math.floor(Date.now() / 60_000)]);
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;
  const current = state.session;
  const dot = (tone: string) => `<span class="sidebar-session-mark ${tone}" aria-hidden="true"></span>`;
  const focused = (document.activeElement as HTMLElement | null)?.closest?.("#sidebar-sessions") ? [...list.querySelectorAll(".sidebar-session")].indexOf(document.activeElement as Element) : -1;
  // One line per chat: a dot for its state, its title, its time. The dot is
  // amber when the chat needs you, a spinner while it works, blue for a
  // branch of Drive's that waits for review (those sit on the Branches row).
  // The tooltip and the accessible name say in words what the dot shows.
  const row = (tone: string, title: string, selected: boolean, age: string, id: string, updatedAt: string) => {
    const about = STATE_WORDS[tone] ?? "";
    const tip = [title, about || fullTime(updatedAt)].join(" · ");
    return btn("select-session", `${dot(tone)}<span class="sidebar-session-name">${h(title)}</span>${age ? `<span class="sidebar-session-age">${h(age)}</span>` : ""}`, { id }, `sidebar-session${selected ? " selected" : ""}`)
      .replace("<button ", `<button title="${h(tip)}" aria-label="${h(about ? `${title}, ${about}` : title)}" aria-keyshortcuts="Delete"${selected ? ' aria-current="page"' : ""} `);
  };
  const matching = sessions.filter(item => item.title.toLowerCase().includes(query));
  const rows: string[] = [];
  let shown = 0;
  for (const item of matching) {
    if (shown >= SIDEBAR_ROWS) break;
    const selected = item.id === current?.id;
    const title = selected ? inSession() ? current!.title : "New chat" : item.turns ? item.title : "New chat";
    const asks = selected ? Boolean(waiting) : Boolean(item.waiting);
    const working = selected ? Boolean(state.activeTurnId) && !waiting : !asks && (item.status === "running" || item.status === "queued");
    // Looking at a chat marks it seen; one that has moved on since, while
    // you were elsewhere, carries the blue dot until you open it.
    if (selected || !(item.id in seenChats)) markSeen(item.id, item.updatedAt);
    const fresh = !selected && item.status === "completed" && seenChats[item.id] !== item.updatedAt;
    const tone = asks ? "warn" : working ? "working" : item.status === "failed" ? "bad" : fresh ? "acc" : "";
    // An empty chat is the composer itself, and the New chat row above
    // already names it; it joins the list once it has a turn.
    if (title === "New chat" && !working && !waiting) continue;
    // Each row carries its own delete, shown on hover: no menu, no dialog.
    // The keyboard deletes with Delete on the row itself, so the trash
    // stays out of the tab order.
    const remove = working ? "" : btn("delete-session", ICON_TRASH, { id: item.id }, "sidebar-delete").replace("<button ", `<button title="Delete" aria-label="Delete ${h(title)}" tabindex="-1" `);
    rows.push(`<div class="sidebar-item">${row(tone, title, selected, tone || (selected && !inSession()) ? "" : shortAge(item.updatedAt), item.id, item.updatedAt)}${remove}</div>`);
    shown++;
  }
  list.innerHTML = rows.length ? rows.join("") : `<p class="sidebar-empty">${query ? "No matching conversations" : "Your conversations will appear here."}</p>`;
  // A redraw keeps keyboard focus where it was, or on the row that moved up.
  if (focused >= 0) {
    const buttons = list.querySelectorAll<HTMLElement>(".sidebar-session");
    (buttons[Math.min(focused, buttons.length - 1)] ?? document.getElementById("sidebar-search"))?.focus({ preventScroll: true });
  }
  const title = document.getElementById("workspace-title");
  if (title) { title.textContent = inSession() ? current?.title ?? "Conversation" : "New chat"; title.title = title.textContent; }
  // Under the project: its branch, then what most needs you in it.
  const pulse = document.getElementById("desktop-project-pulse")?.querySelector("span");
  if (pulse) {
    const branch = state.session?.workspace?.gitBranch ?? "";
    const needs = (waiting ? 1 : 0) + review.length;
    const about = needs ? `${needs} waiting` : word.live ? "Drive working" : state.connection === "online" ? "clean" : state.connection === "connecting" ? "connecting…" : "offline";
    pulse.textContent = [branch, about].filter(Boolean).join(" · ");
  }
  // Drive and Branches are two fixed rows: a dot on Drive when it has
  // something for you, a count on Branches when its work waits for review.
  const driveRow = document.getElementById("sidebar-drive"), pip = document.getElementById("sidebar-drive-pip");
  if (driveRow && pip) {
    const blocked = pinned?.status === "blocked";
    pip.hidden = !(pinned || run.fix || run.away || ideas);
    pip.className = `sidebar-pip${blocked ? " warn" : ""}`;
    driveRow.title = blocked ? "Drive needs you" : pinned ? `Drive: ${missionTitle(pinned)}` : run.fix ? `Drive: ${run.fix.title}` : run.away ? "Drive is running the away list" : ideas ? `Drive has ${ideas} idea${ideas === 1 ? "" : "s"}` : "Drive";
  }
  const branchesRow = document.getElementById("sidebar-branches"), count = document.getElementById("sidebar-branches-count");
  if (branchesRow && count) {
    branchesRow.hidden = !review.length;
    count.textContent = String(review.length);
  }
  // The rail: a dot where something waits, a ring for Drive's progress.
  const badge = document.getElementById("rail-sessions-badge"), ring = document.getElementById("rail-drive"), branchButton = document.getElementById("rail-review");
  if (badge) badge.hidden = !waiting;
  if (branchButton) branchButton.hidden = !review.length;
  if (ring) {
    const steps = pinned ? driveTaskList(pinned) : [];
    ring.hidden = !pinned && !run.fix && !run.away;
    ring.style.setProperty("--progress", `${steps.length ? Math.round(steps.filter((step) => step.mark === "✓").length / steps.length * 100) : run.fix || run.away ? 34 : 0}%`);
  }
}
document.getElementById("sidebar-search")?.addEventListener("input", renderSidebar);
// The list moves with the arrow keys, Home and End; Delete or Backspace
// deletes the focused chat, and ⌘Z brings the last one back.
document.getElementById("sidebar-sessions")?.addEventListener("keydown", (event) => {
  const rows = [...document.querySelectorAll<HTMLElement>("#sidebar-sessions .sidebar-session")];
  const index = rows.indexOf(event.target as HTMLElement);
  if (index < 0 || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;
  if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
    event.preventDefault();
    const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (key === "ArrowUp" ? -1 : 1)));
    rows[next]?.focus({ preventScroll: true });
    return;
  }
  if (key === "Delete" || key === "Backspace") {
    const remove = rows[index]!.parentElement?.querySelector<HTMLElement>(".sidebar-delete");
    if (!remove) return;
    event.preventDefault();
    remove.click();
  }
});
/// The chat above or below the open one in the list, for Ctrl+Tab.
function neighbourChat(step: number) {
  const ids = [...document.querySelectorAll<HTMLElement>("#sidebar-sessions .sidebar-session")].map((row) => JSON.parse(row.dataset.args ?? "{}").id as string).filter(Boolean);
  if (!ids.length) return undefined;
  const at = ids.indexOf(state?.session?.id ?? "");
  return ids[at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length];
}
/// Brings back the chat deleted last, while it still waits to be archived.
function undoDelete() {
  const id = [...pendingDeletes.keys()].at(-1);
  if (!id) return false;
  clearTimeout(pendingDeletes.get(id));
  pendingDeletes.delete(id);
  deletedSessions.delete(id);
  renderSidebar();
  return true;
}
let statusSignature = "";
function renderStatus() {
  if (!state) return;
  renderSidebar();
  const c = context(),
    last = state.runs.at(-1),
    phase = state.approvals.length
      ? "approval"
      : state.questions.length
        ? "waiting"
        : state.activeTurnId
          ? "running"
          : state.processes.some(
                (command) =>
                  command.check &&
                  ["running", "stopping"].includes(command.status),
              )
            ? "checking"
            : last?.status === "failed"
              ? "failed"
              : last && ["cancelled", "interrupted"].includes(last.status)
                ? "stopped"
                : state.connection === "online"
                  ? "ready"
                  : state.connection;
  const signature = JSON.stringify([
    phase,
    state.model.id,
    // The footer shows the thinking level next to the model.
    state.reasoning,
    c,
    last?.receipt?.tokensPerSecond,
    state.provider?.usage,
    state.provider?.metrics,
    state.workspace,
    state.session?.title,
    state.session?.autoApprove,
    state.session?.workspace?.gitBranch,
    state.runs.length,
    inSession(),
    driveWord(),
  ]);
  if (signature === statusSignature) return;
  statusSignature = signature;
  // A quiet footer: a spinner while working, a word only when the state
  // needs attention (failed, approval, offline…). "ready" says nothing.
  const working = Boolean(state.activeTurnId) && !["approval", "waiting", "failed"].includes(phase);
  // The composer names the model and the context used, and a session's top
  // bar carries its live state, so a session has no status bar.
  el("status").dataset.quiet = String(phase === "ready");
  el("status").hidden = inSession();
  // The context used, as a small ring; the numbers wait in its tooltip.
  const c2 = c.percentage == null ? "" : `<span class="ring" style="--usage:${Math.min(100, c.percentage)}%"></span>`;
  el("composer-model").innerHTML = `${h(state.model.displayName ?? state.model.id) || "Choose a model"}${CHEVRON}`;
  el("composer-context").innerHTML = c2;
  el("composer-context").title = c.percentage == null ? "" : `${num(c.used)} of ${num(c.capacity)} · ${c.percentage}% of the context used`;
  el("composer-context").hidden = !inSession() || !c2;
  el("status").innerHTML =
    `${working ? `<span class="state">${spinner()}</span>` : phase === "ready" ? "" : `<span class="state ${phase === "failed" ? "danger" : phase === "approval" || phase === "waiting" ? "amber" : ""}"><img src="assets/${phase === "approval" || phase === "waiting" ? "activity-dot" : "ready-dot"}.svg" width="8" height="8" alt="">${h(phase)}</span>`}<span>${h((state.model.displayName ?? state.model.id) || "Connecting…")}${state.reasoning ? `<span class="muted"> · ${h(state.reasoning)}</span>` : ""}</span><div class="spacer"></div><div class="context">${c.percentage == null ? "<span>ctx —</span>" : `<div class="meter"><i style="--usage:${Math.min(100, c.percentage)}%"></i></div><span>${num(c.used)} · ${c.percentage}%</span>`}</div>${inSession() ? "" : btn("overlay", `${k("Tab")} settings`, { name: "settings" }, "key-action") + btn("insert-command", `${k("Ctrl+K")} commands`, {}, "key-action")}`;
  // The top bar carries the session's branch and ⋯, which opens the
  // session's own view (rename, compact, history). The sidebar shows what
  // needs you; Drive lives in its footer.
  el("header").innerHTML =
    `<div class="header-state">${state.session?.workspace?.gitBranch ? `<span class="chip">⎇ ${h(state.session.workspace.gitBranch)}</span>` : ""}${state.session?.autoApprove ? btn("overlay", "Auto-approve", { name: "settings" }, "chip auto-approve") : ""}</div>${inSession() ? btn("overlay", "⋯", { name: "session" }, `header-more${overlay === "session" ? " active" : ""}`, true).replace("<button ", '<button title="This conversation" aria-label="This conversation" ') : ""}`;
}
function totals(run: GraphicsRun, tool: ToolEntry) {
  const key = `${run.id}:${tool.id}:${tool.state}:${tool.draftArguments?.length ?? 0}:${tool.changes?.length ?? 0}`;
  let total = diffCache.get(key);
  if (!total) {
    total = { added: 0, removed: 0 };
    for (const change of tool.changes ?? []) {
      const diff = codeDiff(change.before ?? "", change.after ?? "");
      total.added += diff.added;
      total.removed += diff.removed;
    }
    if (!tool.changes?.length && tool.diff) {
      const diff = codeDiff(tool.diff.oldText, tool.diff.newText);
      total = { added: diff.added, removed: diff.removed };
    }
    if (diffCache.size >= 512) diffCache.delete(diffCache.keys().next().value!);
    diffCache.set(key, total);
  }
  return total;
}
const counts = (value: { added: number; removed: number }) =>
  `<span class="counts"><span class="plus">+${value.added}</span><span class="minus">−${value.removed}</span></span>`;
/// Drive's best idea, as the start screen's ghost text; Tab takes it.
function driveSuggestion(): string | null {
  return !inSession() && state ? state.driveNext.proposals[0]?.title ?? null : null;
}
/// The next prompt the model suggested at the end of the last finished turn.
function nextSuggestion(): string | null {
  if (pendingQuestion()) return null;
  const run = state?.runs.at(-1);
  if (!run || run.status !== "completed" || state!.activeTurnId) return null;
  const answer = run.entries.findLast((entry) => entry.type === "assistant");
  return answer?.type === "assistant" ? splitNextPrompt(answer.raw).next : null;
}
/// The same braille spinner as the terminal's thinking presence. Spans are
/// advanced in place by one timer, so only the glyphs repaint.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinnerFrame = () => SPINNER[Math.floor(Date.now() / 90) % SPINNER.length]!;
const spinner = () => `<span class="spin" aria-hidden="true">${spinnerFrame()}</span>`;
/// A running sub-agent's target: its task and a phrase that cycles the whole
/// time it runs (updated in place by a timer); its steps count on the right.
function toolTarget(run: GraphicsRun, tool: ToolEntry) {
  if (tool.name === "run_command" && tool.waiting) return "command";
  const base = (tool.detail ?? tool.name).replace(/^\$\s*/, "");
  if (tool.name !== "subagent" || tool.state !== "running") return h(base);
  // Still being written by the model: not running yet.
  if (tool.drafting) return `${h(base || "…")}<span class="muted"> · writing</span>`;
  const slot = run.entries.filter((entry) => entry.type === "tool" && entry.name === "subagent").indexOf(tool);
  const model = /^([^·]+) · /.exec(tool.trace?.find((segment) => segment.kind === "step")?.text ?? "")?.[1]?.trim() ?? state!.model.id;
  const phrase = matchMedia("(prefers-reduced-motion: reduce)").matches ? "thinking" : subagentPhrase(slot, Date.now(), model);
  return `${h(base)}<span class="muted"> · </span><span class="phrase" data-subagent-phrase data-slot="${slot}" data-model="${h(model)}">${h(phrase)}</span>`;
}
/// "3 steps": a running sub-agent's progress, quietly on its row.
function subagentSteps(tool: ToolEntry) {
  const steps = tool.name === "subagent" ? (tool.trace ?? []).filter((segment) => segment.kind === "step").length : 0;
  return steps ? `${steps} step${steps === 1 ? "" : "s"}` : "";
}
/// One quiet line per step: an icon for the kind of work, the verb, the
/// target in mono, and what came of it on the right. An edit or a command
/// carries a chevron and unfolds its diff or output under the row.
const STEP_ICONS: Record<string, string> = {
  read: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  run: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  list: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  agent: '<path d="M12 3v2"/><path d="m5.6 5.6 1.4 1.4"/><path d="M3 12h2"/><path d="m18.4 5.6-1.4 1.4"/><path d="M21 12h-2"/><circle cx="12" cy="13" r="5"/><path d="M12 18v3"/>',
  ask: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
};
const stepIcon = (tool: ToolEntry) => {
  const kind = tool.name === "run_command" ? "run"
    : tool.phase === "change" ? "edit"
    : tool.name === "search_files" ? "search"
    : tool.name === "list_files" ? "list"
    : tool.name === "subagent" ? "agent"
    : tool.name === "ask_user" ? "ask"
    : ["read_file", "read_files", "view_image", "git_diff", "git_status", "git_history"].includes(tool.name) ? "read"
    : "other";
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${STEP_ICONS[kind]}</svg>`;
};
const ICON_SPARK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';
const ICON_SHIELD = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
const ICON_COPY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_UNDO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const CHEVRON = '<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
/// Whether a step has something to unfold: an edit's diff, a command's output.
const foldable = (tool: ToolEntry) =>
  (tool.phase === "change" && tool.state !== "running" && !tool.drafting && (Boolean(tool.changes?.length) || Boolean(tool.diff))) ||
  (tool.name === "run_command" && !tool.waiting && !tool.drafting && Boolean(tool.toolCallId));
function toolRow(run: GraphicsRun, tool: ToolEntry) {
  const key = `${run.id}:${tool.id}`, open = stepOpen.has(key), canFold = foldable(tool);
  const now = tool.state === "running" || tool.drafting;
  const meta = tool.waiting
    ? `<span class="amber">${tool.name === "ask_user" || state?.questions.some((q) => q.toolCallId === tool.toolCallId) ? "waiting for your answer" : "waiting for you"}</span>`
    : tool.phase === "change"
      ? tool.drafting ? "writing…" : tool.state === "done" ? counts(totals(run, tool)) : `<span class="${tone(tool.state)}">${h(tool.state)}</span>`
      : tool.name === "run_command" && tool.input.background === true && tool.state === "done"
        ? "background"
        : now
          ? subagentSteps(tool) || ""
          : tool.state === "done"
            ? `<span class="success">✓</span> ${tool.exitCode != null && tool.exitCode !== 0 ? `exit ${tool.exitCode} · ` : ""}${duration(tool.durationMs)}`
            : tool.state === "failed" || tool.state === "denied"
              ? `<span class="danger">×</span> ${tool.exitCode != null ? `exit ${tool.exitCode}` : h(tool.state)}`
              : `<span class="muted">${h(mark(tool.state))}</span> ${h(tool.state)}`;
  const row = btn(
    canFold ? "step" : "tool",
    `${now ? spinner() : stepIcon(tool)}<span class="verb">${h(verb(tool))}</span><code class="target" title="${h(tool.detail ?? tool.name)}">${toolTarget(run, tool)}</code>${canFold ? CHEVRON : ""}<span class="sp"></span><small class="meta">${meta}</small>`,
    { runId: run.id, id: tool.id },
    `tool-row ${tool.state === "failed" ? "failed" : ""} ${tool.waiting ? "waiting" : ""} ${open ? "open" : ""}`,
    true,
  ).replace("<button ", `<button aria-expanded="${canFold ? open : "false"}" `);
  return row + (open && canFold ? stepFold(run, tool) : "");
}
/// What unfolds under a step: the edit's diff with a little context, or
/// the command's recorded output (its tail), loaded when first opened.
function stepFold(run: GraphicsRun, tool: ToolEntry) {
  if (tool.phase === "change") {
    const files = tool.changes?.length ? tool.changes.map((change) => ({ path: change.path, before: change.before ?? "", after: change.after ?? "" })) : tool.diff ? [{ path: String(tool.input.path ?? tool.detail ?? ""), before: tool.diff.oldText, after: tool.diff.newText }] : [];
    const blocks = files.map((file) => {
      const rows = codeDiff(file.before, file.after).rows, keep = new Set<number>();
      rows.forEach((row, index) => { if (row.kind !== "context") for (let i = Math.max(0, index - 2); i <= Math.min(rows.length - 1, index + 2); i++) keep.add(i); });
      let out = "", last = -1, shown = 0;
      for (let i = 0; i < rows.length && shown < 80; i++) {
        if (!keep.has(i)) continue;
        if (last >= 0 && i !== last + 1) out += '<div class="gap"><span></span><span>⋯</span><span></span></div>';
        const row = rows[i]!;
        out += `<div class="${row.kind === "added" ? "ad" : row.kind === "removed" ? "rm" : ""}"><span>${row.old ?? row.next ?? ""}</span><span>${row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}</span><span>${h(row.text)}</span></div>`;
        last = i; shown++;
      }
      if (shown >= 80) out += '<div class="gap"><span></span><span>⋯</span><span>longer diff folded</span></div>';
      return `${files.length > 1 ? `<div class="fold-path">${h(file.path)}</div>` : ""}<div class="diff">${out || '<div><span></span><span></span><span class="muted">no change</span></div>'}</div>`;
    });
    return `<div class="step-fold">${blocks.join("")}</div>`;
  }
  const record = state!.processes.find((command) => command.toolCallId === tool.toolCallId);
  const text = record ? `${record.stdout}${record.stderr ? `\n${record.stderr}` : ""}`.trim().split("\n").slice(-40).join("\n") : "";
  const body = text ? `<pre class="out">${h(text)}</pre>` : `<div class="out muted">${record?.outputLoaded === false ? "Loading output…" : record ? "No output." : "Output not recorded."}</div>`;
  return `<div class="step-fold"><div class="fold-cmd">$ ${h(String(tool.detail ?? "").replace(/^\$\s*/, ""))}</div>${body}</div>`;
}
/// A sub-agent's thinking and steps under its row: open while it works,
/// collapsible like a thinking block afterwards.
function subagentTrace(run: GraphicsRun, tool: ToolEntry, key: string) {
  if (tool.name !== "subagent" || !tool.trace?.length) return "";
  const live = tool.state === "running";
  const steps = tool.trace.filter((segment) => segment.kind === "step").length;
  const body = tool.trace.map((segment) => segment.kind === "step"
    ? `<div class="muted">→ ${h(segment.text)}</div>`
    : `<p>${h(segment.text.trim())}</p>`).join("");
  return `<details class="thinking ${live ? "live" : ""}" data-detail="${key}:trace"${(live && !detailsClosed.has(`${key}:trace`)) || detailsOpen.has(`${key}:trace`) ? " open" : ""}><summary>◇ Sub-agent trace · ${steps} step${steps === 1 ? "" : "s"}</summary><div>${body}</div></details>`;
}
function runHTML(run: GraphicsRun, index: number) {
  const items = tools(run),
    files = new Set(
      items
        .filter((t) => t.phase === "change" && t.state === "done")
        .flatMap(
          (t) =>
            t.changes?.map((c) => c.path) ?? [
              String(t.input.path ?? t.detail ?? ""),
            ],
        ),
    ).size;
  // A finished turn reads as its answer: thinking and tool steps fold into
  // the receipt line under it, and open from there. A running turn folds its
  // steps into one trail line and its thinking into one streaming line.
  // A finished turn folds its steps behind the receipt; a running one lists
  // them as they happen, each a quiet line on the guide.
  const live = active(run),
    fold = run.status === "completed" && !stepsOpen.has(run.id);
  const lastThought = run.entries.findLast((e) => e.type === "reasoning");
  let body = "", steps = "";
  const flush = () => { if (steps) { body += `<div class="steps">${steps}</div>`; steps = ""; } };
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i]!,
      key = `${run.id}:${entry.id}`;
    if (entry.type === "assistant") {
      flush();
      body += `<div class="answer"><span class="answer-mark" aria-hidden="true">d.</span><div class="markdown" data-answer="${h(run.id)}" data-entry="${entry.id}"></div></div>`;
    }
    if (live && entry === lastThought && i === run.entries.length - 1) {
      flush();
      const open = detailsOpen.has(key), text = entry.raw.trim().split(/\n+/).at(-1) ?? "";
      body += `<div class="thinking thinking-line"><div class="thinking-content" id="thinking-body-${h(key)}"${open ? "" : " hidden"}>${thinkingBody(entry.raw)}</div><button type="button" class="thinking-line-toggle" data-action="toggle-thinking" data-args="${h(JSON.stringify({ id: key }))}" aria-expanded="${open}" aria-controls="thinking-body-${h(key)}">◇ thinking <i>${h(text.slice(-240))}</i></button></div>`;
      continue;
    }
    if (fold && (entry.type === "reasoning" || entry.type === "tool")) continue;
    if (entry.type === "reasoning") {
      flush();
      const live = active(run) && i === run.entries.length - 1;
      // Keep reasoning out of the conversation until the reader asks for it.
      // Explicit expansion survives streaming updates and completion.
      const open = detailsOpen.has(key);
      body += `<div class="thinking thinking-main ${live ? "live" : ""}"><button type="button" class="thinking-toggle" data-action="toggle-thinking" data-args="${h(JSON.stringify({id:key}))}" aria-expanded="${open}" aria-controls="thinking-body-${h(key)}">${live ? spinner() : CHEVRON}${live ? "Thinking" : `Thought for ${duration(entry.durationMs)}`}</button><div class="thinking-content" id="thinking-body-${h(key)}"${open ? "" : " hidden"}>${thinkingBody(entry.raw)}</div></div>`;
    }
    if (entry.type === "tool") {
      const group: ToolEntry[] = [entry];
      let j = i + 1;
      // A sub-agent stands alone: its card carries a report and a trace.
      if (entry.phase === "inspect" && entry.state === "done" && !entry.waiting && entry.name !== "subagent")
        while (j < run.entries.length) {
          const next = run.entries[j];
          if (
            next?.type !== "tool" ||
            next.phase !== "inspect" ||
            next.state !== "done" ||
            next.waiting ||
            next.name === "subagent"
          )
            break;
          group.push(next);
          j++;
        }
      if (group.length >= 3) {
        const sum = group.reduce((n, t) => n + (t.durationMs ?? 0), 0);
        const summary=run.kind === "themefy" ? `Theme interview · ${group.filter(tool=>tool.name === "ask_user").length} questions${group.some(tool=>tool.name === "apply_theme" && tool.state === "done")?" · palette applied":""}` : `Explored · ${group.length} reads`;
        steps += `<details class="explored" data-detail="${key}"${detailsOpen.has(key) ? " open" : ""}><summary>${stepIcon(group[0]!)}<span class="verb">${h(summary)}</span><span class="sp"></span><small class="meta">${duration(sum)}</small></summary><div>${group.map((tool) => toolRow(run, tool)).join("")}</div></details>`;
        i = j - 1;
      } else steps += toolRow(run, entry) + subagentTrace(run, entry, key);
    }
    if (entry.type === "notice" && !entry.closesTurn) {
      flush();
      body += `<div class="system-band"><b>system</b><span>${h(entry.text)}</span></div>`;
    }
  }
  flush();
  const receipt = run.receipt,
    checks = items.filter(
      (tool) =>
        tool.phase === "verify" &&
        tool.name === "run_command" &&
        tool.input.background !== true,
    ),
    passed =
      checks.length > 0 &&
      checks.every((tool) => tool.state === "done" && tool.exitCode === 0),
    failed = checks.some(
      (tool) => tool.state === "failed" || tool.state === "denied",
    ),
    stopped = checks.some((tool) => tool.state === "stopped");
  // One receipt line: what changed, the checks, the steps behind it, the
  // time, and the model only when it isn't the one in the composer.
  let footer = "";
  if (!active(run)) {
    const closed = run.entries.findLast(
      (e) => e.type === "notice" && e.closesTurn,
    );
    const error =
      run.status === "failed"
        ? `${closed?.type === "notice" ? closed.text : "Failed"}${run.entries.some((e) => e.type === "assistant") ? "" : " · no final response"}`
        : ["cancelled", "interrupted"].includes(run.status)
          ? `Stopped by you · ${items.filter((t) => t.state === "stopped").length} command${items.filter((t) => t.state === "stopped").length === 1 ? "" : "s"} interrupted`
          : "";
    const changed = items.filter((t) => t.phase === "change" && t.state === "done");
    const paths = [...new Set(changed.flatMap((t) => t.changes?.map((c) => c.path) ?? [String(t.input.path ?? t.detail ?? "")]))];
    const total = changed.reduce((sum, t) => { const each = totals(run, t); return { added: sum.added + each.added, removed: sum.removed + each.removed }; }, { added: 0, removed: 0 });
    const steps = items.length, thought = run.entries.some((e) => e.type === "reasoning");
    const model = (receipt?.model ?? "").split("/").at(-1) ?? "";
    const speed = receipt?.tokensPerSecond ? `${Math.round(receipt.tokensPerSecond)} tok/s` : "";
    // "model · 1.7s · 38 tok/s", then what changed, the checks, the steps.
    const parts = [
      error ? `<span class="${run.status === "failed" ? "danger" : ""}">${h(error)}</span>` : "",
      [model ? h(model) : "", receipt?.durationMs != null ? duration(receipt.durationMs) : "", speed].filter(Boolean).join(" · "),
      files ? `<span class="receipt-files" title="${h(paths.join(", "))}">${files === 1 ? "1 file changed" : `${files} files changed`} ${counts(total)}</span>` : "",
      checks.length ? `<span class="receipt-checks ${passed ? "success" : failed ? "danger" : ""}" title="${h(checks.map((check) => check.detail ?? check.name).join("\n"))}">${passed ? "checks passed" : failed ? "checks failed" : stopped ? "checks stopped" : "checks unknown"}</span>` : "",
      run.status === "completed" && (steps || thought)
        ? btn("toggle-steps", fold ? (steps ? `${steps} step${steps === 1 ? "" : "s"}` : "thinking") : "hide steps", { id: run.id }, "receipt-steps")
        : "",
      receipt?.mode === "Plan" || run.planOnly ? "plan" : "",
    ].filter(Boolean);
    const answered = run.entries.some((e) => e.type === "assistant");
    const actions = [
      answered ? btn("copy-answer", `${ICON_COPY}Copy`, { id: run.id }, "receipt-action copy-answer") : "",
      files && !state!.activeTurnId ? btn("undo-turn", `${ICON_UNDO}Undo changes`, { id: run.id }, "receipt-action") : "",
    ].filter(Boolean).join("");
    // A turn that only answered needs no receipt: its time is on the ask.
    const bare = run.status === "completed" && !files && !checks.length && !steps && !thought && !(receipt?.mode === "Plan" || run.planOnly) && !model;
    footer = bare ? "" : `<div class="turn-receipt">${parts.map((part) => `<span>${part}</span>`).join("")}${actions ? `<span class="receipt-actions">${actions}</span>` : ""}</div>`;
  }
  const latestTool = items.findLast(
      (tool) => tool.state === "running" || tool.waiting,
    ),
    phase = state!.questions.length
      ? "Waiting for your answer · "
      : latestTool?.waiting
        ? latestTool.name === "run_command" ? "Waiting for your approval" : "Waiting for your approval · "
        : latestTool?.drafting
          // A command still being written isn't typed out here: its row
          // shows it once it's complete.
          ? "Writing a command…"
          : latestTool
            ? latestTool.name === "run_command" ? "Running command" : `${verb(latestTool)} `
            : "Thinking";
  // The live thinking row already says "Thinking"; don't repeat it here.
  const thinkingLive = run.entries.at(-1)?.type === "reasoning" && !latestTool && !state!.questions.length;
  const trail = "";
  const activity = live && !thinkingLive && !(latestTool && !latestTool.drafting)
    ? `<div class="live-activity">${spinner()}${h(phase + (latestTool?.drafting || latestTool?.name === "run_command" ? "" : latestTool?.detail ?? "") + (latestTool?.name === "subagent" && latestTool.trace?.findLast((segment) => segment.kind === "step") ? ` · ${latestTool.trace.findLast((segment) => segment.kind === "step")!.text}` : "") + "…")}</div>`
    : "";
  const answered = run.entries.some((e) => e.type === "assistant");
  const asks = `<span class="ask-actions">${btn("edit-ask", "edit", { id: run.id })}${live || state!.activeTurnId ? "" : btn("retry-ask", "retry", { id: run.id })}</span>`;
  const queued = live && state!.queue.trim() ? `<div class="next-line"><span class="next-label">NEXT</span><span class="next-text">${h(state!.queue.trim())}</span>${btn("queue-action", "edit", { action: "edit" })}${btn("queue-action", "send now", { action: "now" })}${btn("queue-action", "×", { action: "drop" }, "next-drop")}</div>` : "";
  return `<div class="request"><span class="text">${h(run.content)}</span><span class="request-meta">${asks}<time>${clock(run.createdAt).slice(0, 5)}</time></span></div><div class="response ${live ? "running" : run.status === "failed" ? "failed" : ""}">${body}${trail}${footer}${activity}</div>${queued}`;
}
/** Whole seconds since a moment, for clocks that tick in place. */
const elapsed = (since: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
/// A running turn's steps as one line: the last few, what runs now, and how
/// long the turn has run; the step count opens the full rows.
function stepTrail(run: GraphicsRun, items: ToolEntry[]) {
  if (!items.length) return "";
  const shown = items.slice(-4), earlier = items.length - shown.length;
  const name = (tool: ToolEntry) => {
    const detail = tool.name === "run_command" ? String(tool.detail ?? "").replace(/^\$\s*/, "") : String(tool.input.path ?? tool.detail ?? "").split(/[\\/]/).at(-1) ?? "";
    return `${verb(tool).toLowerCase()} ${detail}`.trim();
  };
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const step = (tool: ToolEntry) => {
    const now = tool.state === "running" || tool.waiting || tool.drafting;
    const sign = now ? spinner() : `<span class="${tone(tool.state)}">${mark(tool.state)}</span>`;
    const added = tool.phase === "change" && tool.state === "done" ? totals(run, tool).added : 0;
    return `<span class="trail-step ${now ? "now" : ""}">${sign} ${h(tool.waiting ? `waiting for you · ${name(tool)}` : clip(name(tool), 48))}${added ? ` <span class="success">+${added}</span>` : ""}</span>`;
  };
  return `<div class="step-trail">${earlier ? `<span class="muted">${earlier} earlier ·</span>` : ""}${shown.map(step).join("")}<span class="trail-meta">${btn("toggle-steps", `${items.length} step${items.length === 1 ? "" : "s"}`, { id: run.id }, "receipt-steps")} · <span data-since="${h(run.createdAt)}">${elapsed(run.createdAt)}</span></span></div>`;
}
/** Text deltas keep the response shell, tool rows and finished Markdown blocks.
 * Structural transitions (tools, fold/unfold, receipts) rebuild only the shell
 * and move the existing Markdown nodes into it. */
function patchStream(
  saved: NonNullable<ReturnType<typeof runNodes.get>>,
  run: GraphicsRun,
): boolean {
  const before = saved.run;
  if (
    !before ||
    before.status !== run.status ||
    before.content !== run.content ||
    before.entries.length !== run.entries.length ||
    before.receipt !== run.receipt
  )
    return false;
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i]!,
      previous = before.entries[i]!;
    if (entry === previous) continue;
    if (
      entry.type !== "assistant" ||
      previous.type !== "assistant" ||
      entry.id !== previous.id ||
      entry.at !== previous.at ||
      entry.streaming !== previous.streaming ||
      entry.receipt !== previous.receipt ||
      !saved.views.has(entry.id)
    )
      return false;
  }
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i]!;
    if (entry !== before.entries[i] && entry.type === "assistant")
      saved.views.get(entry.id)!.update(splitNextPrompt(entry.raw).text);
  }
  return true;
}
function revealCompactedTurn(id: string) {
  if (!state?.checkpoint) return;
  const compacted = compactedConversation(state.runs, state.checkpoint);
  if (compacted && (compacted.hiddenIds.has(id) || state.checkpoint.turnId === id))
    expandedCompactions.add(state.checkpoint.id);
}
function renderConversation() {
  if (!state) return;
  const root = el("conversation"),
    stage = el("stage"),
    top = stage.scrollTop,
    liveBefore = follow;
  const ids = new Set<string>();
  let changed = false;
  const checkpoint = state.checkpoint;
  const compacted = compactedConversation(state.runs, checkpoint);
  const historyOpen = checkpoint ? expandedCompactions.has(checkpoint.id) : false;
  if (compacted && checkpoint) {
    if (!compactionCard) {
      compactionCard = document.createElement("section");
      compactionCard.className = "compaction-card";
      compactionCard.setAttribute("aria-label", "Conversation summary");
      root.prepend(compactionCard);
    }
    const signature = JSON.stringify([checkpoint.id, historyOpen, compacted.summary, compacted.count]);
    if (signature !== compactionCardSignature) {
      compactionCard.innerHTML = `<div class="compaction-heading"><strong>Conversation summary</strong><span class="muted">${compacted.count} earlier turns ${historyOpen ? "expanded" : "collapsed"}</span></div><div class="compaction-summary">${markdown(compacted.summary)}</div><button type="button" data-action="toggle-compacted-history" aria-expanded="${historyOpen}" class="compaction-toggle">${historyOpen ? "Collapse older conversation" : "Expand full history"}</button>`;
      compactionCardSignature = signature;
      changed = true;
    }
  } else if (compactionCard) {
    compactionCard.remove(); compactionCard = null; compactionCardSignature = ""; changed = true;
  }
  let position = compactionCard ? 1 : 0;
  for (const [index, run] of state.runs.entries()) {
    if (compacted && !historyOpen && (compacted.hiddenIds.has(run.id) || run.id === checkpoint!.turnId)) continue;
    ids.add(run.id);
    const signature = JSON.stringify([
      index === state.runs.length - 1,
      expanded.has(run.id),
      stepsOpen.has(run.id),
      // Unfolded steps, and the recorded output a command's fold shows.
      [...stepOpen].filter((key) => key.startsWith(`${run.id}:`)).map((key) => {
        const tool = run.entries.find((entry) => entry.type === "tool" && String(entry.id) === key.slice(run.id.length + 1));
        const record = tool?.type === "tool" && tool.name === "run_command" ? state!.processes.find((command) => command.toolCallId === tool.toolCallId) : null;
        return record ? `${key}:${record.outputLoaded}:${record.stdout.length}:${record.stderr.length}` : key;
      }),
      state.questions.length > 0,
      active(run) ? state.queue : "",
      state.activeTurnId,
    ]);
    let saved = runNodes.get(run.id);
    if (!saved) {
      const node = document.createElement("article");
      node.className = "turn";
      node.id = `turn-${run.id}`;
      root.append(node);
      saved = { node, signature: "", views: new Map() };
      runNodes.set(run.id, saved);
    }
    // Expanding inserts earlier turns before the retained turns already mounted.
    if (root.children[position] !== saved.node) root.insertBefore(saved.node, root.children[position] ?? null);
    position++;
    if (saved.signature === signature && saved.run === run) continue;
    if (saved.signature !== signature || !patchStream(saved, run)) {
      const template = document.createElement("template");
      template.innerHTML = runHTML(run, index);
      for (const slot of template.content.querySelectorAll<HTMLElement>(
        "[data-entry]",
      )) {
        const id = Number(slot.dataset.entry),
          entry = run.entries.find((entry) => entry.id === id);
        if (entry?.type !== "assistant") continue;
        let view = saved.views.get(id);
        if (!view) {
          view = new MarkdownView();
          saved.views.set(id, view);
        }
        view.element.dataset.answer = run.id;
        view.element.dataset.entry = String(id);
        view.update(splitNextPrompt(entry.raw).text);
        slot.replaceWith(view.element);
      }
      saved.node.replaceChildren(template.content);
      const retained = new Set(
        [...saved.node.querySelectorAll<HTMLElement>("[data-entry]")].map(
          (node) => Number(node.dataset.entry),
        ),
      );
      for (const id of saved.views.keys())
        if (!retained.has(id)) saved.views.delete(id);
    }
    saved.signature = signature;
    saved.run = run;
    changed = true;
  }
  for (const [id, saved] of runNodes)
    if (!ids.has(id)) {
      saved.node.remove();
      runNodes.delete(id);
      changed = true;
    }
  if (changed) {
    if (liveBefore) stage.scrollTop = stage.scrollHeight;
    else stage.scrollTop = top;
  }
}
/// Finished worktree branches waiting for a decision. On the start screen
/// they are one line under the project name; their cards open from it.
const reviewJobs = () =>
  state ? [state.breakage.fix, ...state.breakage.inbox].filter((job): job is NonNullable<typeof job> => Boolean(job) && (job!.status === "ready" || job!.status === "failed")) : [];
let reviewShown = false;
function renderHero() {
  if (!state) return;
  const review = reviewJobs(),
    next = state.driveNext,
    away = state.breakage.away,
    driveBusy = Boolean(state.breakage.fix && (state.breakage.fix.status === "starting" || state.breakage.fix.status === "running")) || away?.status === "running",
    user = document.body.dataset.user ?? "",
    branch = state.session?.workspace?.gitBranch ?? "",
    hour = new Date().getHours(),
    signature = JSON.stringify([state.workspace, review.map((job) => job.id), away?.status, driveBusy, reviewShown, ideasShown, next.proposals, next.loading, next.signals.length, user, branch, hour]);
  if (signature === heroSignature) return;
  heroSignature = signature;
  const composer = el("composer-slot");
  composer.remove();
  const name = state.workspace.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || state.workspace;
  const waiting = review.length
    ? `<p>${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review ›`, {}, "link", true)}<span class="muted"> · ${away && away.status !== "running" ? "Drive ran them while you were away" : "each in its own worktree"}</span></p>`
    : "";
  // A greeting and the composer, nothing else: Drive's best idea is the
  // composer's ghost text (Tab takes it); the rest of its ideas unfold from
  // one quiet line under the composer.
  const day = new Date().toLocaleDateString(undefined, { weekday: "long" }),
    when = `${day} ${hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}`,
    where = branch ? `${h(name)} on ${h(branch)}` : h(name);
  const ideas = next.proposals.length;
  const drive = ideas || driveBusy
    ? `<p class="hero-drive">${ICON_SPARK}<b>Drive</b>${driveBusy ? " is working" : ` has ${ideas} idea${ideas === 1 ? "" : "s"}`}${ideas ? ` <span class="muted">·</span> ${btn("ideas-show", ideasShown ? "hide" : "show ›", {}, "link", true)}` : ""}${ideas > 1 && !driveBusy ? ` <span class="muted">·</span> ${btn("next-away", `Run ${ideas === 2 ? "both" : `all ${Math.min(3, ideas)}`} overnight ›`, { count: Math.min(3, ideas) }, "link", true)}` : ""}</p>${ideas && ideasShown ? `<div class="hero-ideas">${proposalRows(next.proposals)}<p class="proposals-footer">${btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", false, next.loading)}${next.generatedAt ? `<span class="muted"> · looked ${age(next.generatedAt)}</span>` : ""}</p></div>` : ""}`
    : "";
  el("hero").innerHTML =
    `<div class="intro"><span class="hero-eyebrow">${ICON_SPARK}${h(when)} · ${where}</span><h1>What are we building${user ? `, ${h(user)}` : ""}?</h1>${waiting}</div><div id="hero-composer"></div>${drive}`;
  // The composer is detached while the hero is rebuilt.
  el("hero-composer").append(composer);
}
/// Drive's proposals as rows: kind, title and estimate, with Run and Plan. The
/// reason and the evidence it rests on show on hover. The start screen shows three; a session's briefing
/// line unfolds them in place.
function proposalRows(items: Snapshot["driveNext"]["proposals"]) {
  const signal = new Map(state!.driveNext.signals.map((item) => [item.id, item]));
  const minutes = (value: number) => (value < 60 ? `${value} min` : `${Math.round(value / 6) / 10} h`);
  return `<div class="proposal-list">${items
    .map((item) => {
      const evidence = item.evidence.map((id) => signal.get(id)?.title).find(Boolean);
      const why = [item.why, evidence && `Evidence: ${evidence}`].filter(Boolean).join("\n");
      return `<div class="proposal-row" title="${h(why)}"><span class="next-kind kind-${item.kind}">${item.kind.toUpperCase()}</span><b>${h(item.title)}</b><small>~${minutes(item.expectedMinutes ?? item.minutes)}</small>${btn("next-run", "Run", { id: item.id }, "primary", true)}${btn("next-plan", "Plan", { id: item.id })}${btn("next-snooze", "Not now", { id: item.id }, "quiet proposal-snooze")}</div>`;
    })
    .join("")}</div>`;
}
let composerSignature = "",
  composerFiles: Snapshot["files"] | null = null,
  composerWidth = 0;
let composerSlot = "chat", questionDraftVersion = 0;
let answeringQuestion = false;
let composerSession: string | null = null, heldChatDraft: string | null = null;
function pendingQuestion() { return state?.questions[0]; }
function questionIndex() { return pendingQuestion()?.answers?.length ?? 0; }
function replyCacheKey(id: string,index: number) { return `demesne-question-draft:${id}:${index}`; }
function cachedReply(id: string,index: number): {text:string;version:number} | null {
  try {
    const value=JSON.parse(localStorage.getItem(replyCacheKey(id,index)) ?? "null");
    return value && typeof value.text === "string" && value.text.length <= 2000 && Number.isSafeInteger(value.version) && value.version>=0 ? value : null;
  } catch { return null; }
}
function clearReply(id: string,index: number) { try { localStorage.removeItem(replyCacheKey(id,index)); } catch {} }
async function questionAction(action: "pause" | "resume" | "cancel") {
  const q=pendingQuestion(); if(!q)return;
  const index=q.answers?.length ?? 0;
  clearTimeout(draftTimer);
  const result=await api("question-action",{id:q.id,action:{action,revision:q.revision ?? 0}});
  if(action === "cancel")clearReply(q.id,index);
  return result;
}
async function answerQuestion(value: string) {
  const q=pendingQuestion(); if(!q || !value.trim() || answeringQuestion)return;
  clearTimeout(draftTimer);
  const key=`${q.id}:${questionIndex()}`;
  answeringQuestion=true;renderComposer();
  try {
    await api("question-action",{id:q.id,action:{action:"answer",index:questionIndex(),revision:q.revision ?? 0,
      answer:{source:"typed",answer:value.trim()}}});
    clearReply(q.id,q.answers?.length ?? 0);
    if (composerSlot===key) editor.value="";
  } finally { answeringQuestion=false;renderComposer(); }
}
function renderComposer() {
  if (!state) return;
  const width = editor.clientWidth;
  const signature = JSON.stringify([
    editor.value,
    Boolean(state.activeTurnId),
    state.queue,
    state.restored,
    Date.now() < stopArmed,
    inSession(),
    state.connection,
    state.busy,
    state.approvals.length,
    state.questions.length,
    state.session?.autoApprove,
    state.planOnly,
    answeringQuestion,
    driveSuggestion(),
  ]);
  if (
    signature === composerSignature &&
    composerFiles === state.files &&
    composerWidth === width
  )
    return;
  composerSignature = signature;
  composerFiles = state.files;
  composerWidth = width;
  const form = el("composer"),
    question = pendingQuestion(),
    answered = question && (question.answers?.length ?? 0) >= question.questions.length,
    queued = false;
  // The approval chip says how edits and commands are gated; it opens Settings.
  const chip = el("composer-approval");
  chip.classList.toggle("auto", Boolean(state.session?.autoApprove));
  chip.innerHTML = `${ICON_SHIELD}${state.session?.autoApprove ? (state.planOnly ? "Auto-approve · plan only" : "Auto-approve") : "Ask before edits"}${CHEVRON}`;
  chip.title = state.session?.autoApprove ? "Edits and commands run without asking this session. Change in Settings." : "Each edit and command asks first. Change in Settings.";
  form.classList.toggle("queued", queued);
  form.classList.toggle("restored", state.restored && !question);
  form.classList.toggle("stop-armed", Date.now() < stopArmed);
  form.classList.toggle("stopping", Boolean(state.activeTurnId) && !question);
  el("queue-label").hidden = Boolean(question) || !queued && !state.restored;
  el("queue-label").innerHTML =
    `<span>${queued ? 'Queued <span class="muted">sends when this turn completes</span>' : 'Restored · not sent <span class="muted">the turn did not finish</span>'}</span>${btn("clear-queue", "Clear ×")}`;
  const suggestion = nextSuggestion();
  const asking = state.approvals.length > 0 && !question;
  editor.placeholder = asking
    ? "Or tell demesne what to do instead…"
    : question
    ? answered ? "Your answers are saved. Choose Resume to continue." : question.status === "paused" ? "Type your answer to resume the interview…" : "Type your answer here…"
    : inSession()
    ? state.activeTurnId
      ? state.queue.trim() ? "Queue another follow-up…" : "Queue a follow-up…"
      : suggestion ? `${suggestion}   ⇥ Tab` : "Continue the conversation…"
    : driveSuggestion() ? `Drive suggests: ${driveSuggestion()}   ⇥ Tab` : "Describe a change, paste an error, or drop a file…";
  editor.disabled =
    state.connection !== "online" ||
    state.busy ||
    answeringQuestion ||
    Boolean(answered);
  // Like the terminal: no stop hint while running (Esc Esc still stops; only
  // the armed confirmation shows). In a session, an empty composer shows
  // / and @, and a draft shows ↵ send instead. The start screen keeps / and
  // @ and adds ↵ once there is something to send.
  const armed = Date.now() < stopArmed;
  const draft = Boolean(editor.value.trim()), session = inSession();
  // While a turn runs the send button is Stop; Enter queues what you type.
  el("send-label").innerHTML = question ? "answer" : state.activeTurnId
    ? armed ? `Press ${k("Esc")} again to stop` : `${draft ? `<span class="queue-hint">${k("Enter")} ${asking ? "send instead" : "queue"}</span>` : ""}<span class="stop-word">■ Stop</span>`
    : "send";
  // In a session the send square is always there (it reads Stop while a
  // turn runs); the start screen shows it once there is something to send.
  form.querySelector<HTMLElement>(".send")!.hidden = question ? !draft : state.activeTurnId || session ? false : !draft;
  form.querySelector<HTMLElement>(".hints")!.hidden = Boolean(state.activeTurnId) || (session && draft);
  (form.querySelector(".send") as HTMLButtonElement).disabled =
    state.connection !== "online" || state.busy || answeringQuestion;
  form.querySelector<HTMLElement>(".send>kbd")!.hidden = Boolean(
    state.activeTurnId && !question,
  );
  el("tokens").textContent =
    `~${num(Math.ceil(new TextEncoder().encode(editor.value).length / 3))} tok`;
  editor.style.height = "20px";
  editor.style.height = `${Math.min(132, Math.max(20, editor.scrollHeight))}px`;
  const mentions = [...editor.value.matchAll(/(?:^|\s)@([^\s]+)/g)]
    .map((match) => match[1]!)
    .filter((path) => state!.files.some((file) => file.path === path));
  el("mention-chips").innerHTML = [...new Set(mentions)]
    .map((path) => btn("remove-mention", `${h(path)} ×`, { path }, "chip"))
    .join("");
}
/// An approval is one amber row above the composer: what the model wants
/// ("Run bun run check", "Edit hello.ts"), a short note, then Allow /
/// Always / Deny. "command" or "diff" unfolds the whole thing under the row.
/// Typing in the composer says what to do instead.
const APPROVAL_ICONS = {
  command: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  edit: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  other: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
};
/// Whether the row's command or diff is unfolded (folds again per approval).
let approvalOpen = false;
function renderApproval() {
  if (!state) return;
  const approval = state.approvals[0],
    signature = JSON.stringify([approval, state.workspace, approvalOpen]);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const slot = el("approval");
  el("composer").classList.toggle("asking", Boolean(approval));
  slot.hidden = !approval;
  if (!approval) {
    slot.innerHTML = "";
    approvalOpen = false;
    return;
  }
  const input = approval.input as Record<string, unknown>,
    isCommand = approval.name === "run_command",
    relative = (path: unknown) => {
      const text = String(path ?? "");
      return text.startsWith(`${state!.workspace}/`) ? text.slice(state!.workspace.length + 1) : text;
    },
    folder = relative(input.cwd ?? "") || state.workspace.split("/").pop() || "";
  const command = Array.isArray(input.argv) ? input.argv.join(" ") : String(input.command ?? ""),
    // The program by name on the row; the full path waits in the fold.
    short = Array.isArray(input.argv) && input.argv.length ? [String(input.argv[0]).split("/").at(-1), ...input.argv.slice(1)].join(" ") : command;
  // An edit's hunks as removed and added lines; anything else shows its input.
  const hunks = approval.name === "edit_file"
    ? (Array.isArray(input.edits) ? (input.edits as { oldText?: string; newText?: string }[]) : [{ oldText: String(input.oldText ?? ""), newText: String(input.newText ?? "") }])
    : null;
  const lines = (text: string | undefined) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const removed = hunks ? hunks.reduce((n, hunk) => n + lines(hunk.oldText).length, 0) : 0,
    added = hunks ? hunks.reduce((n, hunk) => n + lines(hunk.newText).length, 0) : 0;
  const preview = isCommand
    ? `<pre>$ ${h(command)}</pre><small>in ${h(folder)}${approval.summary && approval.summary !== command && !approval.summary.startsWith("host command") ? ` · ${h(approval.summary)}` : ""}</small>`
    : hunks
      ? `<pre class="approval-diff">${hunks.map((hunk) => [...lines(hunk.oldText).map((line) => `<span class="del">- ${h(line)}</span>`), ...lines(hunk.newText).map((line) => `<span class="add">+ ${h(line)}</span>`)].join("")).join('<span class="muted">⋯</span>')}</pre>`
      : `<pre>${h(JSON.stringify(input, null, 2))}</pre>`;
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const verb = isCommand ? "Run" : hunks ? (input.mode === "append" ? "Append to" : "Edit") : (approval.summary || approval.name).replace(/^./, (c) => c.toUpperCase()),
    target = isCommand ? clip(short, 64) : hunks ? relative(input.path) : "",
    note = isCommand ? `in ${h(folder)} · not sandboxed` : hunks ? counts({ added, removed }) : h(approval.name),
    icon = isCommand ? APPROVAL_ICONS.command : hunks ? APPROVAL_ICONS.edit : APPROVAL_ICONS.other;
  // The always-allow scope in words: the exact command, or the folder.
  const rule = approval.rule ? approval.rule.slice(approval.rule.indexOf(":") + 1).replace(/ \*$/, " …") : "";
  const scope = isCommand
    ? `Always allow ${command && rule.startsWith(command) ? short + rule.slice(command.length) : rule}`
    : hunks ? `Always allow edits to ${rule && rule !== "." ? relative(rule) : "this project"}` : "Always allow";
  slot.innerHTML =
    `<div class="approval-row" role="group" aria-label="Approval">${icon}<span class="approval-verb">${h(verb)}</span>${target ? `<code>${h(target)}</code>` : ""}<span class="approval-note">· ${note}</span><span class="approval-space"></span>` +
    btn("approval-show", approvalOpen ? "hide" : isCommand ? "command" : hunks ? "diff" : "details", {}, `approval-show${approvalOpen ? " open" : ""}`) +
    btn("permission", `Allow ${k("↵")}`, { id: approval.id, decision: "allow_once" }, "allow") +
    (approval.rule ? btn("permission", "Always", { id: approval.id, decision: "allow_always" }, "always").replace("<button ", `<button title="${h(scope)} · saved to your config (${h(approval.rule)})" `) : "") +
    btn("permission", `Deny ${k("Esc")}`, { id: approval.id, decision: "deny" }, "deny") +
    `</div><div class="approval-fold command-inset"${approvalOpen ? "" : " hidden"}>${preview}</div>`;
}
/// Enter with text during an approval: deny, then stop the turn and send what
/// you typed as the next message.
async function denyInstead(text: string) {
  const approval = state?.approvals[0];
  if (!approval) return;
  clearTimeout(draftTimer);
  editor.value = "";
  renderComposer();
  await api("permission", { id: approval.id, decision: "deny" });
  await api("submit", { text });
  await api("queue-action", { action: "now" });
}
/// Breakage alerts: a card over the conversation when something newly
/// breaks, then the worktree fix as it runs and when it's ready to review.
let breakageSignature = "";
/// The away-run branch whose full card is open (one at a time).
let awayOpen: string | null = null;
function renderBreakage() {
  if (!state) return;
  const { signals, fix, busy, message } = state.breakage;
  // Finished branches are one line (under the project name on the start
  // screen, above the composer in a session); their cards show once you open
  // it. In a session, work still running folds behind "Drive is working".
  const folding = !reviewShown, running = !inSession() || driveShown;
  const signature = JSON.stringify([folding, running, signals, fix, state.breakage.inbox, state.breakage.away, awayOpen, busy, message, fix?.status === "running" && !fix.mission ? Math.floor(Date.now() / 1000) : 0, Boolean(driveTurnMission())]);
  if (signature === breakageSignature) return;
  breakageSignature = signature;
  // Never let a missing #breakage stop the rest of the render.
  const node = document.getElementById("breakage");
  if (!node) return;
  const cards: string[] = [];
  const close = (action: string, label: string) => btn(action, "×", {}, "breakage-close", true).replace("<button ", `<button aria-label="${label}" `);
  const doing = (action: string, label: string, idle: string) => (busy === action ? label : idle);
  if (message) {
    cards.push(`<div class="breakage-card toast ${message.tone}"><div class="breakage-head"><span class="breakage-mark">${message.tone === "ok" ? "✓" : "!"}</span><span class="breakage-text">${h(message.text)}</span>${message.url ? btn("breakage-open", "Open ›", {}, "link", true) : ""}${close("breakage-close", "Dismiss")}</div></div>`);
  }
  if (signals.length) {
    const running = fix && ["starting", "running"].includes(fix.status);
    cards.push(`<div class="breakage-card alert"><div class="breakage-head"><span class="breakage-mark">✕</span><span class="breakage-text">${signals.length === 1 ? "Something just broke" : `${signals.length} things just broke`}</span>${close("breakage-dismiss", "Not now")}</div><ul class="breakage-list">${signals.map((signal) => `<li><b>${h(signal.title)}</b><span>${h(signal.detail.replace(/^Latest run exit (\S+) at \S+\.\s*/, "exit $1 · "))}</span></li>`).join("")}</ul><p class="breakage-note">${running ? `${fix.mission ? "A Drive mission is working in a worktree" : "A fix is already running"}; this one waits until it finishes.` : "Drive can fix it in a separate git worktree. Your files and this conversation stay as they are until you choose to apply it."}</p><div class="breakage-actions">${running ? "" : btn("breakage-fix", doing("fix", "Starting…", "▶ Fix in a worktree"), {}, "primary", true, Boolean(busy))}${btn("breakage-dismiss", "Not now", {}, "quiet", true)}${btn("breakage-never", "Never for this", {}, "quiet", true)}</div></div>`);
  }
  // A running mission shows on the briefing line; its card comes when it settles.
  const fixCard = (fix: NonNullable<Snapshot["breakage"]["fix"]>) => {
    const elapsed = duration((fix.finishedAt ? Date.parse(fix.finishedAt) : Date.now()) - Date.parse(fix.startedAt));
    const branch = `<code class="breakage-branch">${h(fix.branch)}</code>`;
    if (fix.status === "starting" || fix.status === "running") {
      if (!running || (fix.mission && driveTurnMission())) return;
      const activity = fix.activity ? `${fix.activity.steps} step${fix.activity.steps === 1 ? "" : "s"}${fix.activity.last ? ` · ${h(fix.activity.last)}` : ""}` : "Creating the worktree…";
      cards.push(`<div class="breakage-card running"><div class="breakage-head"><span class="breakage-mark breakage-pulse">◌</span><span class="breakage-text">${fix.proposal ? "Working in a worktree" : "Fixing in a worktree"}</span><small>${elapsed}</small></div><p class="breakage-title">${h(fix.title)}</p><div class="breakage-meta">${branch}<span>${activity}</span></div><div class="breakage-actions">${btn("breakage-discard", doing("discard", "Stopping…", "Stop and discard"), { id: fix.id }, "quiet", true, Boolean(busy))}</div></div>`);
    } else if (fix.status === "ready") {
      // Three lines: what changed, what it says it did and how its checks
      // went, and what to do. The branch and file list are on hover.
      const paths = fix.diff?.paths ?? [];
      const where = fix.diff ? `<span class="add">+${fix.diff.additions}</span> <span class="del">−${fix.diff.deletions}</span> · ${paths.length === 1 ? h(paths[0]!.split("/").at(-1)!) : `${fix.diff.files} file${fix.diff.files === 1 ? "" : "s"}`}` : "";
      // A workflow mission counts its steps, each with the check Drive ran for it.
      const run = state!.drive?.workflow && state!.drive.homeSessionId === fix.sessionId ? state!.drive.workflow : null;
      const rows = run
        ? run.steps.map((step, index) => ({ ok: index < run.current && (!step.check || Boolean(step.result?.ok)), text: `${step.title}${step.check ? ` · ${step.check.command}${step.check.expect === "fail" ? " failed as expected" : ""}` : ""}` }))
        : (fix.checks ?? []).map((check) => ({ ok: check.passed, text: check.command }));
      const passed = rows.filter((row) => row.ok).length;
      const verdict = !rows.length ? "No checks ran."
        : run ? `${passed} of ${rows.length} steps passed.`
        : passed === rows.length ? `${rows.length === 1 ? "Its check" : `All ${rows.length} checks`} passed.` : `${rows.length - passed} of ${rows.length} checks failed.`;
      const proof = rows.length ? `<span class="${passed === rows.length ? "pass" : "fail"}" title="${h(rows.map((row) => `${row.ok ? "✓" : "✕"} ${row.text}`).join("\n"))}">${h(verdict)}</span>` : `<span class="muted">${verdict}</span>`;
      const kind = fix.mission ? "Mission" : fix.proposal ? "Proposal" : "Fix";
      cards.push(`<div class="breakage-card ready compact"><div class="breakage-head"><span class="breakage-mark">✓</span><span class="breakage-text" title="${h(`${kind} on ${fix.branch}`)}">${h(fix.title)}</span><small${paths.length > 1 ? ` title="${h(paths.join("\n"))}"` : ""}>${where}</small></div><p class="breakage-summary">${fix.summary ? `${h(fix.summary)} ` : ""}${proof}</p><div class="breakage-actions">${btn("breakage-apply", doing("apply", "Applying…", "Apply"), { id: fix.id }, "primary", true, Boolean(busy)).replace("<button ", '<button title="Apply to my branch" ')}${btn("breakage-pr", doing("pr", "Opening…", "Open PR"), { id: fix.id }, "", true, Boolean(busy))}${btn("breakage-discard", doing("discard", "Discarding…", "discard"), { id: fix.id }, "quiet", true, Boolean(busy))}${fix.receipt ? btn("breakage-receipt", "copy receipt", { id: fix.id }, "quiet", true) : ""}${fix.sessionId ? btn("review-diff", "diff ›", { id: fix.sessionId }, "quiet breakage-diff") : ""}</div></div>`);
    } else if (fix.status === "failed") {
      cards.push(`<div class="breakage-card failed"><div class="breakage-head"><span class="breakage-mark">${(fix.proposal || fix.mission) && fix.unchanged ? "○" : "!"}</span><span class="breakage-text">${fix.proposal || fix.mission ? (fix.unchanged ? "Finished without changes" : "Couldn't finish it") : "Couldn't fix it"}</span><small>${elapsed}</small></div><p class="breakage-title">${h(fix.title)}</p><p class="breakage-summary">${h(fix.error ?? (fix.proposal || fix.mission ? "It failed." : "The fix failed."))}${fix.summary ? ` ${h(fix.summary)}` : ""}</p><div class="breakage-actions">${btn("breakage-discard", doing("discard", "Discarding…", "Discard the worktree"), { id: fix.id }, "quiet", true, Boolean(busy))}</div></div>`);
    }
  };
  // An away run is one card: a line per proposal, and a finished branch opens
  // its full card only when you pick it, so at most one card covers the
  // conversation.
  const away = state.breakage.away;
  const open = new Map([fix, ...state.breakage.inbox].filter((item): item is NonNullable<typeof fix> => Boolean(item)).map((item) => [item.id, item]));
  const folded = new Set(away ? away.items.flatMap((item) => (item.fixId ? [item.fixId] : [])) : []);
  if (away && !(folding && away.status !== "running") && !(away.status === "running" && !running)) {
    const done = away.items.filter((item) => !["queued", "running"].includes(item.state)).length;
    const waiting = away.items.filter((item) => item.fixId && open.has(item.fixId) && ["ready", "unchanged", "failed"].includes(item.state)).length;
    const rows = away.items.map((item) => {
      const job = item.fixId ? open.get(item.fixId) : undefined;
      const mark = ({ queued: "○", running: "◌", ready: "✓", unchanged: "–", failed: "!", skipped: "·" } as Record<string, string>)[item.state];
      const detail = item.state === "running" && job?.activity ? `${job.activity.steps} step${job.activity.steps === 1 ? "" : "s"}${job.activity.last ? ` · ${h(job.activity.last)}` : ""}`
        : item.state === "ready" && job?.diff ? `<span class="add">+${job.diff.additions}</span> <span class="del">−${job.diff.deletions}</span> · ${job.diff.files} file${job.diff.files === 1 ? "" : "s"}`
        : item.state === "ready" && !job ? "handled" : item.note ? h(item.note.split("\n")[0]!.slice(0, 160)) : item.state === "skipped" ? "didn't start" : "";
      const title = job && !["queued", "running"].includes(item.state)
        ? btn("away-open", h(item.proposal.title), { id: job.id }, `away-title${awayOpen === job.id ? " open" : ""}`)
        : `<span class="away-title">${h(item.proposal.title)}</span>`;
      return `<li class="away-${item.state}"><span class="away-mark">${mark}</span>${title}${detail ? `<small>${detail}</small>` : ""}</li>`;
    }).join("");
    cards.push(away.status === "running"
      ? `<div class="breakage-card away running"><div class="breakage-head"><span class="breakage-mark breakage-pulse">◌</span><span class="breakage-text">Working through Drive's list</span><small>${done} of ${away.items.length} done</small></div><ul class="away-list">${rows}</ul><div class="breakage-actions">${btn("breakage-away-stop", "Stop after this one", {}, "quiet", true, Boolean(busy))}</div></div>`
      : `<div class="breakage-card away"><div class="breakage-head"><span class="breakage-mark">✓</span><span class="breakage-text">While you were away</span><small>${waiting ? `${waiting} to review` : ""}</small>${close("breakage-away-close", "Dismiss")}</div><ul class="away-list">${rows}</ul>${away.reason ? `<p class="breakage-note">${h(away.reason)}</p>` : ""}</div>`);
  }
  for (const item of [fix, ...state.breakage.inbox]) {
    if (!item || (item.mission && (item.status === "starting" || item.status === "running"))) continue;
    if (folded.has(item.id) && item.id !== awayOpen) continue;
    if (folding && (item.status === "ready" || item.status === "failed")) continue;
    fixCard(item);
  }
  node.innerHTML = cards.join("");
  node.hidden = !cards.length;
}
function renderQuestion() {
  if (!state) return;
  const question = state.questions[0],
    signature = JSON.stringify(question);
  if (signature === questionSignature) return;
  questionSignature = signature;
  const index=question?.answers?.length ?? 0, answered=question && index>=question.questions.length,
    item=question?.questions[Math.min(index,question.questions.length-1)];
  el("question").innerHTML = question && item
    ? `<section class="question-card"><div class="approval-title"><span class="amber">?</span> ${question.mode === "interview" ? "Interview" : "A question before continuing"}<small>${question.questions.length > 1 ? `${Math.min(index+1,question.questions.length)} of ${question.questions.length}` : ""}</small></div><p class="user-question">${h(item.question)}</p>${item.reason ? `<p class="muted">${h(item.reason)}</p>` : ""}${answered ? `<p>${h(question.answers?.at(-1)?.answer ?? "Explicitly skipped")}</p>` : ""}<p class="muted">${answered ? "Your answers are saved. Resume to continue from them." : question.interrupted ? "Saved after interruption. Your answer continues the interview." : question.status === "paused" ? "Paused. Your draft is saved; answering resumes the interview." : "Type your answer in the composer below."}</p><div class="approval-actions">${btn("question-control",question.status === "paused" || answered ? "Resume" : "Pause",{action:question.status === "paused" || answered ? "resume" : "pause"})}${btn("question-control","Cancel interview",{action:"cancel"},"quiet")}</div></section>`
    : "";
}
function selectedRun() {
  return state?.runs.find((run) => run.id === paneTurn) ?? state?.runs.at(-1);
}
/// Stops the host polling command output that an unfolded check started.
const unwatchOutput = () => void api("panel-watch", { panel: null }).catch(() => {});
/// Drive has no panel. Its mission is a turn in the conversation it started
/// from (or unfolds on the briefing line), and its ideas unfold under the
/// composer, each a row with Run, Plan and Not now.
const DRIVE_PINNED = ["running", "waiting", "paused", "blocked"];
const missionTitle = (drive: NonNullable<Snapshot["drive"]>) => drive.mission.split("\n")[0]!.replace(/^--(bounded|continuous)\s+/, "");
/// A mission still in play: running, waiting on its coder, paused or
/// blocked (a mission stopped at a limit is finished unless it asks for you).
function pinnedMission() {
  const drive = state?.drive;
  return drive && DRIVE_PINNED.includes(drive.status) && (!drive.protection?.trip || drive.status === "blocked") ? drive : null;
}
/// A worktree run that isn't a mission: a fix, one proposal, or the away list.
function worktreeRun() {
  const fix = state?.breakage.fix, away = state?.breakage.away;
  return {
    fix: fix && !fix.mission && (fix.status === "starting" || fix.status === "running") ? fix : null,
    away: away?.status === "running" ? away : null,
  };
}
const activeMinutes = (drive: NonNullable<Snapshot["drive"]>) => {
  const ms = drive.protection?.used.activeMs;
  return ms == null ? "" : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
};
/// What waits on you from Drive, most pressing first: a blocked mission, its
/// finished branches, and blockers it recorded in the last day.
function needsYou() {
  if (!state) return [];
  const rows: { mark: string; tone: string; title: string; detail: string; action: string }[] = [];
  const pinned = pinnedMission();
  if (pinned?.status === "blocked")
    rows.push({ mark: "◌", tone: "thinking", title: missionTitle(pinned), detail: (pinned.activity?.trim() || pinned.steps.at(-1)?.note || "").split("\n")[0]!, action: btn("drive-control", "resume", { control: "resume" }, "link") });
  for (const job of reviewJobs())
    rows.push(job.status === "ready"
      ? { mark: "✓", tone: "citron", title: job.title, detail: job.diff ? `+${job.diff.additions} −${job.diff.deletions}` : "", action: btn("review-open", "review ›", { show: true }, "link") }
      : { mark: "!", tone: "signal", title: job.title, detail: job.unchanged ? "no changes" : "couldn't finish", action: btn("review-open", "open ›", { show: true }, "link") });
  const blocked = pinned ? missionTitle(pinned).toLowerCase() : "", day = Date.now() - 86_400_000;
  for (const entry of [...state.driveMemory].reverse())
    if (entry.source === "drive" && entry.kind === "blocker" && Date.parse(entry.at) > day && !(blocked && entry.text.toLowerCase().startsWith(blocked)) && rows.length < 5)
      rows.push({ mark: "◌", tone: "thinking", title: entry.text, detail: age(entry.at), action: "" });
  return rows;
}
/// The top bar's Drive word: a count of what needs you, or a dot while it works.
function driveWord() {
  const run = worktreeRun(), pinned = pinnedMission();
  return { needs: needsYou().length, live: Boolean(run.fix || run.away || (pinned && pinned.status !== "paused" && pinned.status !== "blocked")) };
}
/// One line above the composer in a session: branches waiting for review,
/// and what Drive is doing or would do next. Each part unfolds in place.
let briefingSignature = "";
function renderBriefing() {
  if (!state) return;
  const node = el("briefing");
  const review = reviewJobs(), pinned = pinnedMission(), run = worktreeRun(), away = state.breakage.away, next = state.driveNext;
  if (!review.length) reviewShown = false;
  const signature = JSON.stringify([
    inSession(), review.map((job) => [job.id, job.status, job.title, job.diff]), reviewShown, away?.status,
    pinned && (driveShown && !driveTurnMission() ? [pinned, detailsOpen.has("drive-details"), Math.floor(Date.now() / 10_000)] : [pinned.status, pinned.mission, driveTurnMission() ? driveProgress(pinned) : activeMinutes(pinned)]),
    run.fix && [run.fix.title, run.fix.status], run.away && run.away.items.map((item) => item.state),
    driveShown, ideasShown, next.proposals, next.loading, next.generatedAt && age(next.generatedAt),
  ]);
  if (signature === briefingSignature) return;
  briefingSignature = signature;
  const parts: string[] = [];
  let unfolded = "";
  if (review.length) {
    const only = review.length === 1 ? review[0]! : null;
    const about = only && reviewShown ? "" : only ? `${only.title}${only.diff ? ` · +${only.diff.additions} −${only.diff.deletions}` : ""}` : away && away.status !== "running" ? "Drive ran them while you were away" : "";
    parts.push(`${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review ${reviewShown ? "⌄" : "›"}`, {}, "link", true)}${about ? `<span class="muted">${h(about)}</span>` : ""}`);
  }
  if (pinned && driveTurnMission()) {
    // The mission is the conversation's newest turn; this line only says how far it has got.
    const label = pinned.status === "blocked" ? "Drive needs you" : pinned.status === "paused" ? "Drive is paused" : "Drive is working";
    const progress = driveProgress(pinned);
    parts.push(`<span class="briefing-label${pinned.status === "blocked" ? " amber" : ""}">${label}</span>${progress ? `<span class="muted sep">·</span><span class="muted">${h(progress)}</span>` : ""}`);
  } else if (pinned) {
    const label = pinned.status === "blocked" ? "Drive needs you" : pinned.status === "paused" ? "Drive is paused" : "Drive is working";
    const time = activeMinutes(pinned);
    parts.push(`${btn("drive-show", `${label} ${driveShown ? "⌄" : "›"}`, {}, `link${pinned.status === "blocked" ? " amber" : ""}`)}<span class="muted">${h(missionTitle(pinned))}${time ? ` · ${time}` : ""}</span>`);
    if (driveShown) unfolded = `<div class="drive-live">${pinnedCard(pinned)}</div>`;
  } else if (run.fix || run.away) {
    const about = run.fix ? run.fix.title : `Drive's list · ${run.away!.items.filter((item) => !["queued", "running"].includes(item.state)).length} of ${run.away!.items.length} done`;
    parts.push(`${btn("drive-show", `Drive is working ${driveShown ? "⌄" : "›"}`, {}, "link")}<span class="muted">${h(about)}</span>`);
  } else if (next.proposals.length) {
    const count = next.proposals.length;
    parts.push(btn("ideas-show", `Drive has ${count} idea${count === 1 ? "" : "s"} ${ideasShown ? "⌄" : "›"}`, {}, "link"));
    if (ideasShown) {
      const top = next.proposals, words = ["", "it", "both", "all three"];
      const away = Math.min(3, top.length);
      unfolded = `<div class="briefing-ideas">${proposalRows(top)}<p class="proposals-footer">${[
        btn("next-away", `Run ${words[away]} overnight ›`, { count: away }, "link", true),
        btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", false, next.loading),
        next.generatedAt ? `<span class="muted">looked ${age(next.generatedAt)}</span>` : "",
      ].filter(Boolean).join('<span class="muted"> · </span>')}</p></div>`;
    }
  }
  node.innerHTML = parts.length ? `<p class="briefing-line">${parts.map((part) => `<span class="pill">${part}</span>`).join("")}</p>${unfolded}` : "";
  node.hidden = !inSession() || !parts.length;
}
/// One model's scoreboard line in the model picker: how it has done on your
/// own recorded work over the last 30 days.
function scoreLine(score: ModelScore) {
  const ended = score.finished + score.failed;
  return [
    `${score.turns} turn${score.turns === 1 ? "" : "s"}${ended ? ` · ${score.failed ? `${Math.round((100 * score.finished) / ended)}% finished` : "all finished"}` : ""}`,
    score.toolCalls ? (score.toolErrors ? `${Math.round((100 * (score.toolCalls - score.toolErrors)) / score.toolCalls)}% tool calls ok` : "tool calls ok") : "",
    score.tokensPerSecond !== null ? `${Math.round(score.tokensPerSecond)} tok/s` : "",
    score.firstTokenMs !== null ? `first token ${score.firstTokenMs < 1000 ? `${score.firstTokenMs} ms` : `${(score.firstTokenMs / 1000).toFixed(1)} s`}` : "",
    score.checkedTurns ? `checks ${score.passingTurns}/${score.checkedTurns}` : "",
    score.driveRuns ? `Drive runs kept ${score.driveLanded}/${score.driveRuns}` : "",
  ].filter(Boolean).join(" · ");
}
/// The mission's status line, steps, tasks, stats and Details, for the
/// pinned card.
function missionParts(drive: NonNullable<Snapshot["drive"]>) {
  const now = Date.now(), trace = drive.traces?.at(-1);
  const deciding = Boolean(trace && ["queued", "thinking", "drafting", "acting"].includes(trace.status));
  const [mark, label, tone] = drive.recovery && drive.recovery.retryAt > now
    ? ["↻", `Retrying in ${Math.ceil((drive.recovery.retryAt - now) / 1000)}s`, "thinking"]
    : drive.protection?.trip ? ["■", "Stopped at a limit", "signal"]
    : drive.status === "paused" ? ["‖", "Paused", "secondary"]
    : drive.status === "blocked" ? ["×", "Blocked · needs you", "signal"]
    : drive.status === "completed" ? ["✓", "Mission complete", "citron"]
    : drive.status === "waiting" ? ["◌", "Coder is working", "secondary"]
    : drive.status === "stopped" ? ["■", "Stopped", "secondary"]
    : drive.status === "idle" ? ["·", "Idle · nothing worthwhile left", "secondary"]
    : deciding ? ["◇", "Deciding…", "thinking"] : ["●", "Live", "citron"];
  const summary = drive.protection?.trip?.reason ?? drive.steps.at(-1)?.note ?? drive.activity;
  const steps = drive.steps.slice(-5).map((step) => ({ ...driveStepLine(step), when: driveSince(step.at, now) }));
  if (deciding) steps.push({ mark: "◇", text: "Deciding the next step", tone: "thinking", when: "now" });
  else if (drive.status === "waiting") steps.push({ mark: "◌", text: "Waiting for the coder", tone: "thinking", when: "now" });
  const tasks = driveTaskList(drive);
  const used = drive.protection?.used;
  const active = used ? (used.activeMs < 3_600_000 ? `${Math.round(used.activeMs / 60_000)}m` : `${Math.floor(used.activeMs / 3_600_000)}h ${Math.round((used.activeMs % 3_600_000) / 60_000)}m`) : "";
  const planner = trace?.source === "controller" ? "Local controller" : (drive.model ?? state!.model.id).split("/").at(-1)!.trim();
  const stats = [drive.workflow ? `${drive.workflow.name} · step ${Math.min(drive.workflow.current + 1, drive.workflow.steps.length)} of ${drive.workflow.steps.length}` : `step ${drive.step}`, active, used ? `${num(used.planningTokens + used.workerTokens)} tokens` : "", drive.mode === "continuous" ? "continuous" : "bounded", planner].filter(Boolean).join(" · ");
  const ledger = Array.isArray(drive.ledger?.tasks) ? drive.ledger.tasks.filter((task) => task && typeof task.id === "string") : [];
  const section = (title: string, body: string) => body ? `<div class="drive-heading">${title}</div>${body}` : "";
  const details = [
    drive.answer ? section("ANSWER", `<p>${h(drive.answer)}</p>`) : section("NOTE", `<p>${h(summary)}</p>`),
    steps.length ? section("TIMELINE", `<ol class="drive-timeline">${steps.map((step) => `<li class="tone-${step.tone}"><span>${h(step.mark)}</span><span class="drive-step">${h(step.text)}</span><time>${h(step.when)}</time></li>`).join("")}</ol>`) : "",
    section("REASONING", trace?.reasoning ? `<pre>${h(trace.reasoning)}</pre>` : `<p class="muted">No reasoning recorded.</p>`),
    trace?.text || trace?.action ? section("OUTPUT", `<pre>${h(trace.text || trace.action)}</pre>`) : "",
    section("MISSION", `<p>${h(drive.mission)}</p><p class="muted">${drive.workflow ? `Workflow ${h(drive.workflow.name)}: each step's check must pass before the next step starts.` : drive.mode === "continuous" ? "Continuous: finishes each task, chooses worthwhile next work, then goes idle." : "Bounded: finishes after one verified task."}</p>`),
    drive.notes ? section("NOTES", `<pre>${h(drive.notes)}</pre>`) : "",
    drive.protection ? section("BUDGET", `<p class="muted">${Math.floor(drive.protection.used.activeMs / 60_000)}/${drive.protection.limits.maxActiveMinutes} active min · ${drive.protection.used.cycles}/${drive.protection.limits.maxCycles} cycles · ${drive.protection.used.workerRequests}/${drive.protection.limits.maxWorkerRequests} coder requests</p>`) : "",
    ledger.some((task) => task.status === "completed") ? `<p class="muted">Reopen a finished task: /drive reopen &lt;task-id&gt; &lt;reason&gt;<br>${ledger.filter((task) => task.status === "completed").slice(-4).map((task) => `${h(task.id.slice(0, 8))} · ${h(task.title)}`).join("<br>")}</p>` : "",
  ].join("");
  const title = missionTitle(drive);
  return {
    mark, label, tone, summary, title, stats,
    tasks: tasks.length ? `<ul class="drive-tasks">${tasks.map((task) => `<li class="tone-${task.tone}">${h(task.mark)} ${h(task.text)}</li>`).join("")}</ul>` : "",
    detailsBody: details,
    details: `<details data-detail="drive-details"${detailsOpen.has("drive-details") ? " open" : ""}><summary>Details</summary><div class="drive-details">${details}</div></details>`,
  };
}
/// A blocked mission says why, what led there, and what to do about it,
/// in full rather than squeezed into the status line.
function blockedCard(drive: NonNullable<Snapshot["drive"]>) {
  const parts = missionParts(drive), now = Date.now();
  const reason = drive.activity?.trim() || drive.steps.at(-1)?.note || "Drive stopped without recording a reason.";
  const trip = drive.protection?.trip;
  const hint = trip
    ? "It reached a mission limit. Resume keeps the same limits; to continue with fresh limits, start a new mission with /drive."
    : /^Could not save Drive progress/.test(reason)
      ? "Drive couldn't save its progress to disk. Check free space and permissions for the demesne data folder, then Resume."
      : drive.feedback?.startsWith("Last rejected decision")
        ? "Drive's planner kept choosing actions it couldn't carry out. Resume retries once; if it blocks again, rephrase the mission or switch the model."
        : /approv|permission|denied/i.test(reason)
          ? "A command needed your approval and didn't get it (publishing always asks, and unanswered prompts are denied after 5 minutes). Approve it when asked, or tell Drive to skip it, then Resume."
          : "Answer the question or give direction in the composer, then press Resume. Resume retries the blocked step once.";
  const steps = drive.steps.slice(-4).map((step) => ({ ...driveStepLine(step), when: driveSince(step.at, now) }));
  const evidence = (drive.evidence ?? []).slice(-2).filter((item) => item.quote?.trim());
  const section = (title: string, body: string) => body ? `<div class="drive-heading">${title}</div>${body}` : "";
  return `<section class="drive-pinned drive-blocked tone-border-signal" aria-label="Blocked mission"><div class="drive-pinned-title">${h(parts.title)}</div><strong class="tone-signal">× Blocked · needs you</strong>${
    section("WHY", `<p class="drive-why">${h(reason)}</p>`)}${
    steps.length ? section("WHAT LED HERE", `<ol class="drive-timeline">${steps.map((step) => `<li class="tone-${step.tone}"><span>${h(step.mark)}</span><span class="drive-step">${h(step.text)}</span><time>${h(step.when)}</time></li>`).join("")}</ol>`) : ""}${
    evidence.length ? section("EVIDENCE", evidence.map((item) => `<blockquote class="drive-quote">${h(item.quote.length > 400 ? `${item.quote.slice(0, 399)}…` : item.quote)}</blockquote>`).join("")) : ""}${
    section("WHAT YOU CAN DO", `<p class="drive-hint">${h(hint)}</p>`)}${parts.tasks}<div class="drive-meta">${h(parts.stats)}</div><div class="next-actions">${btn("drive-control", "Resume", { control: "resume" }, "primary")}${btn("drive-control", "Stop", { control: "stop" }, "danger")}</div>${parts.details}</section>`;
}
/// The live (or paused, or blocked) mission's card: in the Drive panel, and
/// unfolded from the briefing line above the composer.
function pinnedCard(pinned: NonNullable<Snapshot["drive"]>) {
  if (pinned.status === "blocked") return blockedCard(pinned);
  const parts = missionParts(pinned), live = pinned.status === "running" || pinned.status === "waiting";
  return `<section class="drive-pinned tone-border-${parts.tone}" aria-label="Live mission"><div class="drive-pinned-title">${h(parts.title)}</div><div class="drive-status"><strong class="tone-${parts.tone}">${parts.mark} ${h(parts.label)}</strong>${parts.summary ? `<span class="drive-summary">${h(parts.summary)}</span>` : ""}</div>${parts.tasks}<div class="drive-meta">${h(parts.stats)}</div><div class="next-actions">${btn("drive-control", live ? "Pause" : "Resume", { control: live ? "pause" : "resume" })}${btn("drive-control", "Stop", { control: "stop" }, "danger")}</div>${parts.details}</section>`;
}
/// The mission homed in this session, which reads as its newest turn.
const driveTurnMission = () => {
  const pinned = pinnedMission();
  return pinned && pinned.homeSessionId === state?.session?.id ? pinned : null;
};
/// How far the mission has got, for the briefing line: "step 2 of 3 · 1 min".
function driveProgress(drive: NonNullable<Snapshot["drive"]>) {
  const tasks = driveTaskList(drive), done = tasks.filter((task) => task.mark === "✓").length, time = activeMinutes(drive);
  return [tasks.length > 1 ? `step ${Math.min(done + 1, tasks.length)} of ${tasks.length}` : "", time].filter(Boolean).join(" · ");
}
/// A mission homed in this session is a turn at the end of the conversation:
/// what it was asked, its steps (a workflow's, or its tasks) with the one
/// running now, and quiet pause, stop and details links.
let driveTurnSignature = "";
function renderDriveTurn() {
  if (!state) return;
  const node = document.getElementById("drive-turn");
  if (!node) return;
  const drive = inSession() ? driveTurnMission() : null, now = Date.now();
  const fix = state.breakage.fix, worktree = Boolean(drive && fix?.mission && ["starting", "running"].includes(fix.status));
  const retry = drive?.recovery && drive.recovery.retryAt > now ? Math.ceil((drive.recovery.retryAt - now) / 1000) : 0;
  const signature = JSON.stringify([drive, worktree, retry, detailsOpen.has("drive-details"), drive ? Math.floor(now / 10_000) : 0]);
  if (signature === driveTurnSignature) return;
  driveTurnSignature = signature;
  el("conversation").classList.toggle("driving", Boolean(drive));
  node.hidden = !drive;
  if (!drive) {
    node.innerHTML = "";
    return;
  }
  const parts = missionParts(drive), live = drive.status === "running" || drive.status === "waiting";
  // A workflow's mission reads as you typed it: "/fix-bug Handle an empty name".
  const name = drive.workflow ? `<span class="tone-electric">/${h(drive.workflow.name)}</span> ` : "";
  const prefix = drive.workflow ? `${drive.workflow.name} · ` : "", title = prefix && parts.title.startsWith(prefix) ? parts.title.slice(prefix.length) : parts.title;
  const ask = `<div class="request"><span class="text">${name}${h(title)}</span><span class="drive-turn-where">Drive${worktree ? " · in a worktree" : ""}</span></div>`;
  if (drive.status === "blocked") {
    node.innerHTML = `${ask}<div class="response">${blockedCard(drive)}</div>`;
    if (follow) el("stage").scrollTop = el("stage").scrollHeight;
    return;
  }
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const tasks = driveTaskList(drive);
  const doing = clip((drive.activity ?? "").split("\n")[0]!.trim(), 64);
  const rows = tasks.length
    ? tasks.map((task) => {
        const [what, ...rest] = task.text.split(" · "), current = task.mark === "◌";
        const detail = current && live && !drive.workflow && doing ? doing : rest.join(" · ");
        const sign = current && live ? spinner() : h(task.mark === "·" ? "○" : task.mark);
        return `<li class="tone-${task.tone}${current ? " now" : ""}"><span class="drive-trail-mark">${sign}</span><span class="drive-trail-what">${h(what!)}</span>${detail ? `<span class="drive-trail-detail">${h(detail)}</span>` : ""}</li>`;
      }).join("")
    : `<li class="now"><span class="drive-trail-mark">${live ? spinner() : "○"}</span><span class="drive-trail-what">${live ? "Choosing the first step" : "Not started"}</span></li>`;
  const used = drive.protection?.used;
  const meta = [
    drive.status === "paused" ? '<span class="tone-secondary">paused</span>' : "",
    retry ? `<span class="tone-thinking">retrying in ${retry}s</span>` : "",
    used ? `${num(used.planningTokens + used.workerTokens)} tokens` : "",
    drive.recovery?.attempt && !retry ? `retried ${drive.recovery.attempt === 1 ? "once" : `${drive.recovery.attempt} times`}` : "",
  ].filter(Boolean).join('<span class="sep"> · </span>');
  const open = detailsOpen.has("drive-details");
  const actions = [
    btn("drive-control", live ? "pause" : "resume", { control: live ? "pause" : "resume" }, "link"),
    btn("drive-control", "stop", { control: "stop" }, "link danger"),
    btn("drive-details", open ? "hide details" : "details ›", {}, "link"),
  ].join("");
  const stage = el("stage"), bottom = follow;
  node.innerHTML = `${ask}<div class="response${live ? " running" : ""}"><ol class="drive-trail">${rows}</ol><div class="drive-turn-foot"><span class="drive-turn-meta">${meta}</span><span class="drive-turn-actions">${actions}</span></div>${open ? `<div class="drive-details">${parts.detailsBody}</div>` : ""}</div>`;
  if (bottom) stage.scrollTop = stage.scrollHeight;
}
function verificationChecks(turnId = "") {
  if (!state) return [];
  const records = state.processes.filter(
    (command) => command.check && (!turnId || command.turnId === turnId),
  );
  const keys = new Set<string>();
  const checks: CommandRecord[] = [];
  for (const command of records) {
    const key = JSON.stringify([command.argv, command.cwd]);
    if (keys.has(key)) continue;
    keys.add(key);
    checks.push(command);
  }
  for (const run of state.runs.filter(
    (run) => !turnId || run.id === turnId,
  ))
    for (const tool of tools(run).filter(
      (tool) =>
        tool.phase === "verify" &&
        tool.name === "run_command" &&
        tool.input.background !== true,
    )) {
      const argv = Array.isArray(tool.input.argv)
        ? tool.input.argv.map(String)
        : [tool.detail ?? tool.name];
      if (
        records.some((command) => command.toolCallId === tool.toolCallId) ||
        checks.some(
          (command) => JSON.stringify(command.argv) === JSON.stringify(argv),
        )
      )
        continue;
      checks.push({
        id: `legacy:${run.id}:${tool.id}`,
        sessionId: state.session!.id,
        turnId: run.id,
        toolCallId: tool.toolCallId,
        rerunOf: null,
        argv,
        cwd: String(tool.input.cwd ?? state.workspace),
        background: false,
        check: true,
        pid: null,
        status:
          tool.state === "running"
            ? "running"
            : tool.state === "done"
              ? "completed"
              : tool.state === "stopped"
                ? "stopped"
                : "failed",
        startedAt: new Date(tool.startedAt).toISOString(),
        completedAt: run.completedAt,
        lastOutputAt: null,
        exitCode: tool.exitCode ?? null,
        timedOut: false,
        stdout: tool.message ?? "",
        stderr: "",
        truncated: false,
        fingerprint: null,
        freshness: "unknown",
        freshnessReason:
          "This older result has no source fingerprint. Run the check again with the updated daemon.",
      });
    }
  return checks;
}
async function openOverlay(name: OverlayName, query = "") {
  overlay = name;
  overlayQuery = query;
  overlayIndex = 0;
  overlaySignature = "";
  completionDismissed = true;
  el("completion").hidden = true;
  renderOverlay();
  if (name === "providers") {
    void act(() => api("providers-refresh"));
    return;
  }
  if (name === "cleanup") void act(() => api("cleanup-scan"));
  if (name === "models") {
    modelLevels.clear();
    modelIndexPending = true;
    // Opens at once with the last list; the host answers from its cache.
    modelsLoading = true;
    const [result, scores] = await Promise.all([act(() => api<ModelDescriptor[]>("models")), api<ModelScoreboardResponse>("model-scores").catch(() => null)]);
    modelsLoading = false;
    if (Array.isArray(result)) models = result;
    if (scores) modelScores = new Map(scores.models.map((score) => [`${score.provider}\u0000${score.model}`, score]));
    overlaySignature = "";
    if (overlay === "models") renderOverlay();
  }
  const input = el("overlay").querySelector<HTMLInputElement>("input");
  if (input) input.focus();
  else {
    el("overlay").tabIndex = 0;
    el("overlay").focus();
  }
  reportObservation();
}
/// "262k": context sizes in the picker, rounded the way people say them.
function tokensShort(value: number) {
  return value >= 1e6 ? `${+(value / 1e6).toFixed(1)}m` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}
/// The model picker opens just above the composer's model chip, as a small
/// popover; every other overlay is a centred sheet. Without a visible chip
/// the picker falls back to the sheet.
function placeOverlay() {
  const box = el("overlay"),
    chip = document.getElementById("composer-model"),
    more = document.querySelector<HTMLElement>(".header-more"),
    anchor = overlay === "models" && chip && chip.offsetParent ? chip.getBoundingClientRect() : null,
    below = overlay === "session" && more && more.offsetParent ? more.getBoundingClientRect() : null;
  box.classList.toggle("anchored", !!anchor);
  box.classList.toggle("dropped", !!below);
  box.classList.toggle("sheet", !!overlay && !anchor && !below);
  box.style.left = box.style.right = box.style.top = box.style.bottom = box.style.maxHeight = "";
  const main = el("main").getBoundingClientRect();
  if (below) {
    // The ⋯ menu hangs from its button, at the right edge of the conversation.
    box.style.right = `${Math.max(12, main.right - below.right)}px`;
    box.style.top = `${below.bottom - main.top + 6}px`;
    box.style.maxHeight = `${Math.max(160, main.bottom - below.bottom - 24)}px`;
    return;
  }
  if (!anchor) return;
  const width = Math.min(440, main.width - 24);
  box.style.left = `${Math.max(12, Math.min(anchor.left - main.left - 10, main.width - width - 12))}px`;
  box.style.bottom = `${main.bottom - anchor.top + 8}px`;
  box.style.maxHeight = `${Math.max(160, anchor.top - main.top - 20)}px`;
}
function renderModelPopover(hidden: number) {
  const groups = new Set(overlayRows.map((row) => row.group));
  let lastGroup = "";
  const rows = overlayRows
    .map((row, index) => {
      const label = groups.size > 1 && row.group && row.group !== lastGroup ? `<div class="section-label">${h(row.group)}</div>` : "";
      lastGroup = row.group ?? "";
      const selected = index === overlayIndex;
      return (
        label +
        btn(
          "choose-row",
          `<span class="name">${h(row.label)}</span><span class="hint">${h(row.hint ?? "")}</span>${selected && row.description ? `<small class="model-stats">${row.description.split(" · ").map((part) => h(part).replaceAll(" ", "&nbsp;")).join(" · ")}</small>` : ""}`,
          { index },
          `menu-row model-row ${selected ? "selected" : ""}`,
        ).replace("<button ", row.value ? `<button title="${h(row.value)}" ` : "<button ")
      );
    })
    .join("");
  const row = overlayRows[overlayIndex],
    model = row?.action === "model" ? models.find((item) => item.id === row.data.id) : undefined,
    levels = model?.reasoningLevels ?? [],
    level = model ? modelLevel(model) : undefined;
  const thinking = model && levels.length
    ? `<div class="model-thinking"><span class="section-label">THINKING</span><span class="levels">${levels.map((item) => btn("model", h(item), { id: model.id, reasoning: item }, item === level ? "on" : "")).join('<span class="muted">·</span>')}</span><span class="muted keys">←→</span></div>`
    : "";
  el("overlay").innerHTML =
    `<div class="model-picker-heading"><strong>Choose a model</strong><span>For this conversation</span></div><div class="filter-wrap"><input id="chooser-filter" placeholder="Search models…" aria-label="Filter models" value="${h(overlayQuery)}" autocomplete="off"></div><div class="menu-list">${rows || `<div class="empty">${modelsLoading && !models.length ? "Loading models…" : "No matches."}</div>`}${hidden ? `<div class="empty">${hidden} more · keep typing to narrow</div>` : ""}</div>${thinking}<div class="menu-footer">${k("↑↓")} select ${k("↵")} switch ${btn("close-overlay", `${k("Esc")} close`)}<span class="right">${overlayQuery ? `${overlayRows.length} of ` : ""}${models.length || ""}${models.length ? " models" : ""}</span></div>`;
  el("overlay").querySelector(".menu-row.selected")?.scrollIntoView({ block: "nearest" });
}
function renderOverlay() {
  if (!state) return;
  el("overlay").hidden = !overlay;
  el("overlay").dataset.screen = overlay ?? "";
  el("overlay").setAttribute("role", "dialog");
  el("overlay").setAttribute("aria-label", overlay === "models" ? "Choose a model" : overlay ?? "Dialog");
  placeOverlay();
  if (!overlay) return;
  const focused = el("overlay").querySelector<HTMLInputElement>("input"),
    hasFocus = focused === document.activeElement,
    selection = focused?.selectionStart;
  const signature = JSON.stringify([
    overlay,
    overlayQuery,
    overlayIndex,
    state.model,
    state.theme,
    state.planOnly,
    state.session?.autoApprove,
    state.sessions,
    models,
    state.providers,
    state.cleanup,
  ]);
  if (signature === overlaySignature) return;
  overlaySignature = signature;
  overlayRows = [];
  let title = "",
    subtitle = "",
    noun = "",
    filter = true,
    footerNote = "";
  if (overlay === "settings") {
    // The model lives in the composer; the rest of the old list is one
    // command away, so Settings keeps only what you change here.
    title = "Settings";
    subtitle = "Make this workspace yours";
    filter = false;
    footerNote = "model is in the composer · all commands /";
    const signedIn = state.providers.items.filter((item) => item.status === "signed-in").map((item) => item.label);
    overlayRows = [
      {
        label: "Mode",
        group: "Session behavior",
        value: state.planOnly ? "Plan · read only" : "Build · edits allowed",
        action: "mode",
        data: { planOnly: !state.planOnly },
        hint: `to ${state.planOnly ? "Build" : "Plan"} ↵`,
        description: "Plan reads and proposes without changing files; Build may edit.",
      },
      {
        label: "Approvals",
        group: "Session behavior",
        value: state.session?.autoApprove ? "Auto-approve all" : "Ask first",
        action: "auto-approve",
        data: { autoApprove: !state.session?.autoApprove },
        hint: state.session?.autoApprove ? "turn off ↵" : "turn on ↵",
        description: "Auto-approve all skips prompts for edits, commands, deletions and publishing. Plan stays read only.",
      },
      {
        label: "Theme",
        group: "Appearance",
        value: state.theme,
        action: "overlay",
        data: { name: "themes" },
        hint: "/theme",
      },
      {
        label: "Providers",
        group: "Connections",
        value: signedIn.length ? `${signedIn.join(", ")} · signed in` : state.providers.items.length ? "none signed in" : "sign in · sign out",
        action: "overlay",
        data: { name: "providers" },
        hint: "/providers",
      },
      {
        label: "Sessions",
        group: "History",
        value: `${state.sessions.filter((item) => item.turns > 0 && item.id !== state!.session?.id).slice(0, 3).length} recent · ${state.sessions.length} total`,
        action: "overlay",
        data: { name: "sessions" },
        hint: "/sessions",
      },
      // The ChatGPT plan lives here, not in the status bar.
      ...(state.model.provider === "ChatGPT"
        ? [
            {
              label: "ChatGPT plan",
              value: state.chatgptAccount?.email ?? state.chatgptAccount?.label ?? "signed in",
              action: "open-link",
              data: { url: "https://chatgpt.com/settings/usage" },
              hint: "manage usage ↗",
            },
          ]
        : []),
    ];
  } else if (overlay === "models") {
    title = "Switch model";
    noun = "models";
    const scoreOf = (model: ModelDescriptor) => modelScores.get(`${model.provider}\u0000${model.id}`);
    // Models you have used come first in each provider, most used first.
    const all = [...models]
      .sort((a, b) => a.provider.localeCompare(b.provider) || (scoreOf(b)?.turns ?? 0) - (scoreOf(a)?.turns ?? 0))
      .map((model) => {
        const level = modelLevel(model);
        const score = scoreOf(model);
        const current = model.id === state!.model.id && (level ?? "") === (state!.reasoning ?? model.defaultReasoningLevel ?? level ?? "");
        return {
        label: model.displayName ?? model.id,
        value: [model.contextWindow ? `${tokensShort(model.contextWindow)} context` : "", model.maxOutputTokens ? `${tokensShort(model.maxOutputTokens)} out` : ""].filter(Boolean).join(" · "),
        group: model.provider.toUpperCase(),
        action: "model",
        data: { id: model.id, ...(level ? { reasoning: level } : {}) },
        hint: [model.contextWindow ? tokensShort(model.contextWindow) : "", current ? "● current" : ""].filter(Boolean).join(" "),
        ...(score ? { description: scoreLine(score) } : {}),
        };
      });
    // A large catalog (OpenRouter's hundreds) collapses to one row until a
    // filter searches it; your own providers' models stay listed.
    const sizes = new Map<string, number>();
    for (const model of models) sizes.set(model.provider, (sizes.get(model.provider) ?? 0) + 1);
    const large = [...sizes].filter(([, size]) => size > LARGE_CATALOG).map(([provider]) => provider.toUpperCase());
    overlayRows = overlayQuery ? all : all.filter((row) => !large.includes(row.group!) || row.data.id === state!.model.id);
    if (!overlayQuery)
      for (const group of large)
        overlayRows.push({ label: `All ${sizes.get(models.find((model) => model.provider.toUpperCase() === group)!.provider)} models`, value: "type to search", group, action: "focus-filter", data: {}, hint: "" });
    if (modelIndexPending && !overlayQuery) {
      // Opens on the model you are using, so ←→ changes its thinking.
      const at = overlayRows.findIndex((row) => row.data.id === state!.model.id);
      if (at >= 0) overlayIndex = at;
      if (models.length) modelIndexPending = false;
    }
  } else if (overlay === "providers") {
    title = "Providers";
    subtitle = state.providers.loading ? "checking…" : `using ${state.model.provider}`;
    noun = "providers";
    filter = false;
    footerNote = state.providers.message ?? "Enter signs in or out · ChatGPT uses your plan, OpenRouter uses hosted models";
    overlayRows = state.providers.items.map((item) => {
      const signing = state!.providers.signingIn === item.key;
      return {
        label: `${item.label}${item.active ? " ●" : ""}`,
        value: signing ? "Waiting for your browser…" : item.detail,
        group: item.kind === "local" ? "LOCAL" : item.kind === "api-key" ? "API KEY" : "ACCOUNTS",
        action: signing ? "provider-cancel" : item.status === "signed-in" ? "provider-signout" : item.status === "signed-out" ? "provider-signin" : "",
        data: { key: item.key },
        hint: signing ? "cancel ↵" : item.status === "signed-in" ? "sign out ↵" : item.status === "signed-out" ? "sign in ↗" : "",
      };
    });
    overlayRows.push({ label: "Provider setup", value: state.model.provider, group: "SETUP", action: "setup", data: {}, hint: "setup ↵" });
  } else if (overlay === "cleanup") {
    const { candidates, selected, loading, armed, message, staleDays } = state.cleanup;
    const chosen = new Set(selected);
    title = "Clean up sessions";
    subtitle = loading ? "looking…" : `${chosen.size} of ${candidates.length} selected`;
    filter = false;
    footerNote = message ?? "Deleting can't be undone · the open session and running ones are never listed";
    const GROUPS: Record<string, string> = { empty: "EMPTY", missing: "FOLDER GONE", archived: "ARCHIVED", unfinished: "NEVER FINISHED", quick: "QUICK QUESTIONS", stale: `NOT USED IN ${staleDays}+ DAYS` };
    const order = Object.keys(GROUPS);
    const here = state.workspace;
    overlayRows = candidates.length
      ? [
          {
            label: armed ? `Delete ${chosen.size} session${chosen.size === 1 ? "" : "s"} for good?` : chosen.size ? `Delete ${chosen.size} selected` : "Nothing selected",
            value: armed ? "press ↵ again to delete · Esc to cancel" : "",
            action: chosen.size ? "cleanup-delete" : "",
            data: {},
            hint: armed ? "confirm" : "",
          },
          { label: chosen.size === candidates.length ? "Select none" : "Select all", value: "", action: "cleanup-toggle", data: { id: "*" }, hint: "" },
          ...[...candidates]
            .sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))
            .map((item) => ({
              label: `${chosen.has(item.id) ? "☒" : "☐"} ${item.title}`,
              value: `${item.detail} · ${age(item.updatedAt)}${item.workspace && item.workspace !== here ? ` · ${item.workspace.split("/").pop()}` : ""}`,
              group: GROUPS[item.reason],
              action: "cleanup-toggle",
              data: { id: item.id },
              hint: chosen.has(item.id) ? "delete" : "keep",
            })),
        ]
      : [];
    if (!candidates.length) footerNote = message ?? (loading ? "" : "Nothing to clean up.");
  } else if (overlay === "themes") {
    title = "Theme";
    subtitle = "saved on this device";
    noun = "themes";
    overlayRows = [...(state.themeCanUndo ? [{label:"Undo last theme change",value:"restore previous palette",action:"theme-undo",data:{},group:"ACTIONS"}] : []),...state.themes.map((name) => ({
      label: state!.themeOptions.find(t=>t.name === name)?.label ?? name,
      value: name === state!.theme ? "current" : "",
      action: "theme",
      data: { name },
      group:
        name.startsWith("custom-") ? "YOUR THEMES" : name.includes("light") ||
        name.includes("latte") ||
        name === "github-light"
          ? "LIGHT"
          : "DARK",
    })).sort((a,b)=>["YOUR THEMES","DARK","LIGHT"].indexOf(a.group)-["YOUR THEMES","DARK","LIGHT"].indexOf(b.group))];
  } else if (overlay === "sessions") {
    title = "Sessions";
    noun = "sessions";
    overlayRows = state.sessions.map((session) => ({
      label: session.title,
      value: `${session.turns} turns · ${age(session.updatedAt)}`,
      action: "select-session",
      data: { id: session.id },
      hint: session.id === state!.session?.id ? "● current" : "",
    }));
    // Cleanup sits at the end of the list it tidies.
    if (!overlayQuery) overlayRows.push({ label: "Clean up sessions", value: "delete empty, quick and old ones", action: "overlay", data: { name: "cleanup" }, hint: "/cleanup" });
  } else if (overlay === "session") {
    title = "This conversation";
    subtitle = state.session?.title ?? "";
    filter = false;
    const c = context();
    overlayRows = [
      { label: "Rename", value: "", action: "overlay", data: { name: "rename" } },
      { label: "Compact", value: `${c.estimated ? "~" : ""}${num(c.used)} of ${c.capacity ? tokensShort(c.capacity) : "—"} context used${c.percentage == null ? "" : ` · ${c.percentage}%`}`, action: "compact", data: {}, hint: state.activeTurnId ? "after this turn" : "" },
      { label: "New chat", value: "", action: "new-session", data: {}, hint: "⌘N" },
      { label: "Settings", value: "", action: "overlay", data: { name: "settings" }, hint: "⌘," },
    ];
  } else if (overlay === "rename") {
    el("overlay").innerHTML =
      `<div class="modal-title">Rename session</div><form id="rename-form"><div class="filter-wrap"><input name="title" aria-label="Session title" value="${h(overlayQuery || state.session?.title)}" maxlength="200"></div><div class="menu-footer"><button type="submit">${k("Enter")} save</button>${btn("close-overlay", `${k("Esc")} cancel`)}</div></form>`;
    return;
  } else if (overlay === "confirm-archive" || overlay === "confirm-undo") {
    title =
      overlay === "confirm-archive"
        ? "Archive this session?"
        : undoTurnId && state!.runs.find((run) => run.id === undoTurnId) ? `Undo turn ${state!.runs.find((run) => run.id === undoTurnId)!.number}’s changes?` : "Undo the last turn’s changes?";
    el("overlay").innerHTML =
      `<div class="modal-title">${title}</div><p class="empty">${overlay === "confirm-archive" ? "The session remains recoverable in the daemon archive." : "This reverts the file changes recorded for that turn. Changes made separately on disk may prevent a revert."}</p><div class="menu-footer">${btn(overlay === "confirm-archive" ? "archive" : "undo", "Confirm", overlay === "confirm-undo" && undoTurnId ? { turnId: undoTurnId } : {}, "danger")}${btn("close-overlay", `${k("Esc")} cancel`)}</div>`;
    return;
  } else {
    title = "Commands";
    filter = false;
    overlayRows = state.commands.map((command) => ({
      label: command.name,
      value: command.description,
      action: "complete-command",
      data: { name: command.name },
      group: command.section.toUpperCase(),
    }));
  }
  const allCount = overlay === "models" ? models.length : overlayRows.length;
  if (overlayQuery)
    overlayRows = overlayRows.filter((row) =>
      `${row.label} ${row.value} ${row.group ?? ""} ${row.action === "model" ? row.data.id : ""}`
        .toLowerCase()
        .includes(overlayQuery.toLowerCase()),
    );
  // Never draw hundreds of rows: the filter narrows the rest.
  const hidden = Math.max(0, overlayRows.length - MAX_MENU_ROWS);
  if (hidden) overlayRows = overlayRows.slice(0, MAX_MENU_ROWS);
  overlayIndex = Math.min(overlayIndex, Math.max(0, overlayRows.length - 1));
  let lastGroup = "";
  const rows = overlayRows
    .map((row, index) => {
      const group =
        row.group && row.group !== lastGroup
          ? `<div class="section-label">${h(row.group)}${overlay !== "settings" ? `<span>${overlay === "models" ? models.filter((model) => model.provider.toUpperCase() === row.group).length : overlayRows.filter((item) => item.group === row.group).length}</span>` : ""}</div>`
          : "";
      lastGroup = row.group ?? "";
      return (
        group +
        btn(
          "choose-row",
          `<span class="name">${h(row.label)}</span><span class="value">${h(row.value)}</span><span class="hint">${h(row.hint ?? "")}${index === overlayIndex && overlay !== "settings" ? ` ${k("↵")}` : ""}</span>${overlay === "settings" && row.description ? `<small class="setting-description">${h(row.description)}</small>` : ""}`,
          { index },
          `menu-row ${index === overlayIndex ? "selected" : ""}`,
          overlay === "sessions",
        ).replace("<button ", row.description ? `<button title="${h(row.description)}" ` : "<button ")
      );
    })
    .join("");
  if (overlay === "models") renderModelPopover(hidden);
  else el("overlay").innerHTML =
    `<div class="modal-title">${title} <span>${h(subtitle)}</span>${btn("close-overlay", "×", {}, "dialog-close").replace("<button ", '<button aria-label="Close dialog" ')}${noun ? `<small>${overlayQuery ? `${overlayRows.length} of ` : ""}${allCount} ${noun}</small>` : ""}</div>${filter ? `<div class="filter-wrap"><input id="chooser-filter" placeholder="filter" aria-label="Filter ${title}" value="${h(overlayQuery)}" autocomplete="off"></div>` : ""}<div class="menu-list">${rows || `<div class="empty">No matches.</div>`}${hidden ? `<div class="empty">${hidden} more · keep typing to narrow</div>` : ""}</div><div class="menu-footer">${k("↑↓")} select ${k("↵")} change ${btn("close-overlay", `${k("Esc")} close`)}<span class="right">${footerNote}</span></div>`;
  if (hasFocus) {
    const input = el("overlay").querySelector<HTMLInputElement>("input");
    input?.focus({ preventScroll: true });
    if (selection != null) input?.setSelectionRange(selection, selection);
  }
  el("overlay")
    .querySelector(".menu-row.selected")
    ?.scrollIntoView({ block: "nearest" });
}
/// Slash commands you ran lately, newest first, kept in this browser only.
let completionAll = false, completionMore = 0;
const RECENT_KEY = "demesne.recentCommands";
function recentCommands(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
function rememberCommand(name: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recentCommands().filter((item) => item !== name)].slice(0, 8))); } catch { /* storage may be off */ }
}
function renderCompletion() {
  if (pendingQuestion()) { el("completion").hidden=true;completionItems=[];return; }
  if (
    !state ||
    overlay ||
    state.approvals.length ||
    state.activeTurnId ||
    completionDismissed
  ) {
    el("completion").hidden = true;
    return;
  }
  const value = editor.value,
    caret = editor.selectionStart;
  const mention = /(?:^|\s)@([^\s]*)$/.exec(value.slice(0, caret));
  const command = value.startsWith("/") && !/\s/.test(value.slice(1));
  completionItems = [];
  if (mention) {
    const query = mention[1]!.toLowerCase();
    completionItems = state.files
      .filter(
        (file) =>
          !/[\s]/.test(file.path) && file.path.toLowerCase().includes(query),
      )
      .slice(0, 100)
      .map((file) => ({
        label: file.path.split("/").at(-1)!,
        description: file.path.includes("/")
          ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
          : "",
        hint: "",
        group: "FILES",
        value: file.path,
        kind: "mention",
      }));
  } else if (command) {
    const row = (item: Snapshot["commands"][number], group = item.section.toUpperCase()) => ({
      label: item.name,
      description: item.description,
      hint: item.detail ?? item.aliases.join(" "),
      group,
      value: item.name,
      kind: "command" as const,
    });
    const all = state.commands.filter((item) =>
      [item.name, ...item.aliases].some((name) => name.startsWith(value)),
    );
    // A bare "/" leads with your workflows and commands, then the ones you
    // used lately; the rest wait behind "N more" or a letter typed.
    const yours = value === "/" && !completionAll ? all.filter((item) => item.id.startsWith("workflow:") || item.id.startsWith("custom:")) : [];
    const recent = value === "/" && !completionAll ? recentCommands().map((name) => all.find((item) => item.name === name)).filter((item): item is (typeof all)[number] => Boolean(item) && !yours.includes(item!)).slice(0, 4) : [];
    if (yours.length || recent.length) {
      completionItems = [
        ...yours.map((item) => row(item, item.id.startsWith("workflow:") ? "YOUR WORKFLOWS" : "YOUR COMMANDS")),
        ...recent.map((item) => row(item, "RECENT")),
      ];
      completionMore = all.length - completionItems.length;
    } else {
      completionItems = all.map((item) => row(item));
      completionMore = 0;
    }
  }
  el("completion").hidden = !completionItems.length;
  if (!completionItems.length) return;
  completionIndex = Math.min(completionIndex, completionItems.length - 1);
  let group = "";
  const needle = mention?.[1] ?? "",
    highlight = (label: string) => {
      const index = label.toLowerCase().indexOf(needle.toLowerCase());
      return needle && index >= 0
        ? h(label.slice(0, index)) +
            `<span class="match">${h(label.slice(index, index + needle.length))}</span>` +
            h(label.slice(index + needle.length))
        : h(label);
    };
  const rows = completionItems
    .map((item, index) => {
      const heading =
        group !== item.group
          ? `<div class="section-label">${item.group}<span>${mention ? `${completionItems.length} match${completionItems.length === 1 ? "" : "es"} “${h(needle)}”` : completionMore ? "" : completionItems.filter((row) => row.group === item.group).length}</span></div>`
          : "";
      group = item.group;
      const definition = state!.commands.find(
        (command) => command.name === item.value,
      );
      const argument =
        definition?.argument !== "none" && definition?.argumentLabel
          ? `<span class="args"> ${definition.argument === "required" ? "&lt;" : "["}${h(definition.argumentLabel)}${definition.argument === "required" ? "&gt;" : "]"}</span>`
          : "";
      return (
        heading +
        btn(
          "completion",
          `<span class="name">${highlight(item.label)}${argument}</span><span class="value">${h(item.description)}</span><span class="hint">${h(item.hint)} ${index === completionIndex ? k(mention ? "Tab" : "↵") : ""}</span>`,
          { index },
          `menu-row ${index === completionIndex ? "selected" : ""}`,
        )
      );
    })
    .join("");
  el("completion").innerHTML =
    `<div class="menu-list">${rows}</div><div class="menu-footer">${k("↑↓")} select ${k("↵")} ${mention ? "insert" : "run"} ${!mention ? `${k("Tab")} complete` : ""} ${k("Esc")} close <span class="right">${mention ? "files with spaces are skipped" : completionMore ? `${btn("completion-more", `${completionMore} more ›`, {}, "completion-more")}<span class="muted"> · type to filter</span>` : h(state!.commands.find((command) => command.name === completionItems[completionIndex]?.value)?.preview ?? `${completionItems.length} commands`)}</span></div>`;
  el("completion")
    .querySelector(".selected")
    ?.scrollIntoView({ block: "nearest" });
}
function changedDraft() {
  const question=pendingQuestion();
  if (question) {
    completionDismissed=true;el("completion").hidden=true;renderComposer();
    clearTimeout(draftTimer);
    const text=editor.value,index=questionIndex(),revision=question.revision ?? 0,version=++questionDraftVersion;
    try { localStorage.setItem(replyCacheKey(question.id,index),JSON.stringify({text,version})); } catch {}
    draftTimer=setTimeout(()=>void api("question-action",{id:question.id,action:{action:"draft",text,index,revision,draftVersion:version}})
      .catch(()=>{}),60);
    reportObservation();return;
  }
  // Typing leaves Drive running (a "/" to look at commands is not a
  // takeover); sending the message is what takes over, in the host.
  completionDismissed = false;
  completionAll = false;
  completionIndex = 0;
  renderComposer();
  renderCompletion();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(
    () => void act(() => api("draft", { text: editor.value })),
    60,
  );
  reportObservation();
}
function setDraft(text: string) {
  editor.value = text;
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(text.length, text.length);
  changedDraft();
}
async function chooseCompletion(index = completionIndex) {
  const item = completionItems[index];
  if (!item) return;
  if (item.kind === "mention") {
    const caret = editor.selectionStart,
      match = /(?:^|\s)@([^\s]*)$/.exec(editor.value.slice(0, caret));
    if (!match) return;
    const start = caret - match[1]!.length - 1;
    editor.setRangeText(`@${item.value} `, start, caret, "end");
    editor.focus();
    changedDraft();
  } else {
    const command = state!.commands.find(
      (command) => command.name === item.value,
    )!;
    // Enter runs a command whose argument is optional (/model opens its
    // menu); one that needs an argument completes so it can be typed. Tab
    // always completes.
    if (command.argument !== "required") {
      editor.value = "";
      completionDismissed = true;
      el("completion").hidden = true;
      await submitText(item.value);
    } else setDraft(`${item.value} `);
  }
}
async function submitText(value = editor.value) {
  if (!state || !value.trim()) return;
  if (pendingQuestion()) return answerQuestion(value);
  if (state.activeTurnId) {
    // Enter while a turn runs queues the message as the next one.
    if (value.startsWith("/")) return;
    clearTimeout(draftTimer);
    editor.value = "";
    renderComposer();
    await api("submit", { text: value });
    return;
  }
  clearTimeout(draftTimer);
  completionDismissed = true;
  el("completion").hidden = true;
  if (value.startsWith("/")) {
    const [name, ...parts] = value.trim().split(/\s+/),
      argument = parts.join(" ");
    const id = state.commands.find(
      (command) =>
        command.name === name || command.aliases.includes(name as never),
    )?.id;
    if (!id) {
      notice(`Unknown command: ${name}`);
      return;
    }
    const known = state.commands.find((command) => command.id === id);
    if (known) rememberCommand(known.name);
    if (id.startsWith("workflow:")) {
      // A workflow runs as a Drive mission and unfolds on the briefing line.
      driveShown = true;
      await api("drive", { text: argument, workflow: id.slice("workflow:".length) });
      editor.value = "";
      void api("draft", { text: "" });
      renderComposer();
      return;
    }
    if (id.startsWith("custom:")) {
      followLatest();
      await api("custom-command", { name: id.slice("custom:".length), argument });
      editor.value = "";
      void api("draft", { text: "" });
      renderComposer();
      return;
    }
    const clear = () => {
      editor.value = "";
      void api("draft", { text: "" });
      renderComposer();
    };
    if (id === "new") {
      await api("new-session", { title: argument || undefined });
      clear();
      return;
    }
    if (id === "sessions" || id === "resume") {
      if (id === "resume" && argument) {
        const matches = state.sessions.filter(
          (session) =>
            session.id === argument ||
            session.id.startsWith(argument) ||
            session.title === argument,
        );
        if (matches.length === 1)
          await api("select-session", { id: matches[0]!.id });
        else await openOverlay("sessions", argument);
      } else await openOverlay("sessions", argument);
      clear();
      return;
    }
    if (id === "model") {
      if (argument) await api("model", { id: argument });
      else await openOverlay("models");
      clear();
      return;
    }
    if (id === "providers") {
      await openOverlay("providers");
      clear();
      return;
    }
    if (id === "cleanup") {
      await openOverlay("cleanup");
      clear();
      return;
    }
    if (id === "theme") {
      if (argument) await api("theme", { name: argument });
      else await openOverlay("themes");
      clear();
      return;
    }
    if (id === "themefy") {
      if(argument === "undo")await api("theme-undo");
      else await api("themefy",{preferences:argument});
      clear();return;
    }
    if (id === "rename") {
      if (argument) await api("rename", { title: argument });
      else await openOverlay("rename");
      clear();
      return;
    }
    if (id === "delete") {
      await openOverlay("confirm-archive");
      clear();
      return;
    }
    if (id === "diff") {
      // The latest turn's edits unfold in place.
      const run = [...state!.runs].reverse().find((run) => tools(run).some((tool) => tool.phase === "change"));
      if (run) void unfoldTurn(run, "change");
      else notice("No edits in this conversation yet");
      clear();
      return;
    }
    if (id === "context" || id === "status") {
      const c = context();
      notice(`${c.estimated ? "~" : ""}${num(c.used)} of ${c.capacity ? tokensShort(c.capacity) : "—"} context used${c.percentage == null ? "" : ` · ${c.percentage}%`} · ${state!.model.displayName ?? state!.model.id}`);
      clear();
      return;
    }
    if (id === "drive") {
      // A new mission unfolds on the briefing line; /drive alone shows what
      // Drive is doing, or its ideas.
      if (argument) {
        driveShown = true;
        await api("drive", { text: argument });
      } else await dispatch("drive-open", {});
      clear();
      return;
    }
    if (id === "plan") {
      if (!argument) {
        notice("Usage: /plan <prompt>");
        return;
      }
      followLatest();
      await api("plan-submit", { text: argument });
      clear();
      return;
    }
    if (id === "compact") {
      await api("compact", { instructions: argument });
      clear();
      return;
    }
    if (id === "undo") {
      await openOverlay("confirm-undo");
      clear();
      return;
    }
    if (id === "export") {
      const result = await api<{ path: string }>("export", {
        format: argument === "json" ? "json" : "md",
      });
      notice(`Saved ${result.path}`);
      clear();
      return;
    }
    if (id === "help") {
      await openOverlay("help");
      clear();
      return;
    }
    if (id === "clear") {
      follow = true;
      renderConversation();
      clear();
      return;
    }
    if (id === "exit") {
      await api("quit");
      return;
    }
  }
  followLatest();
  await api("submit", { text: value });
}
/// Sending a message follows its reply from the bottom, even after the
/// reader scrolled up earlier in the session.
function followLatest() {
  follow = true;
  readingHeld = false;
  const stage = el("stage");
  stage.scrollTop = stage.scrollHeight;
}
async function dispatch(
  action: string,
  args: Record<string, any>,
  target?: HTMLElement,
) {
  if (action === "toggle-compacted-history" && state?.checkpoint) {
    const id = state.checkpoint.id;
    if (expandedCompactions.has(id)) expandedCompactions.delete(id); else expandedCompactions.add(id);
    follow = false; readingHeld = true;
    renderConversation();
    compactionCard?.querySelector<HTMLButtonElement>(".compaction-toggle")?.focus({ preventScroll: true });
    reportObservation(); return;
  }
  if(action === "toggle-thinking") {
    const content=document.getElementById(`thinking-body-${args.id}`), toggle=content?.nextElementSibling;
    if(!content || !(toggle instanceof HTMLButtonElement))return;
    const open=toggle.getAttribute("aria-expanded") === "true";
    if(open){detailsOpen.delete(args.id);detailsClosed.add(args.id);}
    else{detailsClosed.delete(args.id);detailsOpen.add(args.id);}
    content.hidden=open;toggle.setAttribute("aria-expanded",String(!open));reportObservation();return;
  }
  if (action === "question-control") return questionAction(args.action);
  if (action === "auto-approve" && driveNavigating)
    throw new Error("Only you can change session approvals.");
  if (action === "new-session") return api("new-session", {});
  if (["next-refresh", "next-run", "next-plan", "next-snooze", "next-never"].includes(action)) return api(action, args);
  if (action === "next-away") return act(() => api(action, args));
  if (action.startsWith("breakage-")) return act(() => api(action, args));
  if (["provider-signin", "provider-signout", "provider-cancel"].includes(action)) return act(() => api(action, args));
  if (["cleanup-toggle", "cleanup-delete"].includes(action)) return act(() => api(action, args));
  if (action === "drive-forget") return api("drive", { text: `forget ${args.id}` });
  // The opener toggles: a second click on the model chip closes its picker.
  if (action === "overlay" && overlay === args.name && !args.query) return dispatch("close-overlay", {});
  if (action === "overlay") return openOverlay(args.name, args.query ?? "");
  if (action === "close-overlay") {
    overlay = null;
    renderOverlay();
    editor.focus({ preventScroll: true });
    return;
  }
  if (action === "follow") {
    follow = true;
    readingHeld = false;
    paneTurn = "";
    inspectSurface = null;
    inspectItem = "";
    unwatchOutput();
    overlay = null;
    renderOverlay();
    renderConversation();
    el("stage").scrollTop = el("stage").scrollHeight;
    editor.focus({ preventScroll: true });
    return;
  }
  if (action === "review-open") {
    reviewShown = args.show ? true : !reviewShown;
    heroSignature = breakageSignature = "";
    if (inSession()) renderBriefing();
    else renderHero();
    renderBreakage();
    return;
  }
  if (action === "drive-details") {
    if (detailsOpen.has("drive-details")) detailsOpen.delete("drive-details");
    else detailsOpen.add("drive-details");
    renderDriveTurn();
    return;
  }
  if (action === "drive-show" || action === "ideas-show") {
    if (action === "drive-show") driveShown = !driveShown;
    else ideasShown = !ideasShown;
    if (inSession()) renderBriefing();
    else {
      heroSignature = "";
      renderHero();
    }
    renderBreakage();
    return;
  }
  if (action === "drive-open") {
    // Drive in place: its mission's conversation, the mission unfolded on
    // the briefing line, or its ideas under the composer. A toggle (Alt+J)
    // folds it again.
    const pinned = pinnedMission(), run = worktreeRun(), home = pinned?.homeSessionId;
    if (home && home !== state!.session?.id) return dispatch("select-session", { id: home });
    if (pinned && driveTurnMission()) {
      follow = false;
      document.getElementById("drive-turn")?.scrollIntoView({ block: "start" });
      return;
    }
    const drive = inSession() && Boolean(pinned || run.fix || run.away);
    if (drive) driveShown = args.toggle ? !driveShown : true;
    else ideasShown = args.toggle ? !ideasShown : true;
    if (inSession()) renderBriefing();
    else {
      heroSignature = "";
      renderHero();
    }
    renderBreakage();
    return;
  }
  if (action === "step") {
    const key = `${args.runId}:${args.id}`;
    stepOpen.has(key) ? stepOpen.delete(key) : stepOpen.add(key);
    follow = false;
    renderConversation();
    // A command's recorded output loads when its row first opens.
    const run = state!.runs.find((run) => run.id === args.runId),
      tool = run?.entries.find((entry) => entry.id === args.id);
    if (stepOpen.has(key) && tool?.type === "tool" && tool.name === "run_command") {
      const record = state!.processes.find((command) => command.toolCallId === tool.toolCallId);
      if (record?.outputLoaded === false) {
        await api("panel-watch", { panel: "log", command: record.id });
        await api("processes");
      }
    }
    return;
  }
  if (action === "delete-session") {
    // Gone from the list at once; the next conversation moves up.
    deletedSessions.add(args.id);
    renderSidebar();
    // Another chat waits a moment before it is archived, so ⌘Z can undo it;
    // the open one is replaced by a new chat, so it goes now.
    if (args.id !== state?.session?.id) {
      pendingDeletes.set(args.id, setTimeout(() => {
        pendingDeletes.delete(args.id);
        void act(async () => {
          try { await api("archive", { id: args.id }); } catch (error) { deletedSessions.delete(args.id); renderSidebar(); throw error; }
        });
      }, UNDO_MS));
      return;
    }
    try {
      await api("archive", { id: args.id });
    } catch (error) {
      deletedSessions.delete(args.id);
      renderSidebar();
      throw error;
    }
    return;
  }
  if (action === "undo-turn") {
    undoTurnId = args.id;
    return openOverlay("confirm-undo");
  }
  if (action === "approval-show") {
    approvalOpen = !approvalOpen;
    renderApproval();
    return;
  }
  if (action === "toggle-steps") {
    stepsOpen.has(args.id) ? stepsOpen.delete(args.id) : stepsOpen.add(args.id);
    follow = false;
    renderConversation();
    return;
  }
  if (action === "away-open") {
    awayOpen = awayOpen === args.id ? null : args.id;
    breakageSignature = "";
    renderBreakage();
    return;
  }
  if (action === "expand-turn") {
    expanded.has(args.id) ? expanded.delete(args.id) : expanded.add(args.id);
    follow = false;
    renderConversation();
    return;
  }
  if (action === "jump-turn") {
    revealCompactedTurn(args.id);
    expanded.add(args.id);
    paneTurn = args.id;
    if (!driveNavigating) readingHeld = true;
    follow = false;
    renderConversation();
    document
      .getElementById(`turn-${args.id}`)
      ?.scrollIntoView({ block: "start" });
    return;
  }
  if (action === "insert-command") {
    overlay = null;
    renderOverlay();
    return setDraft("/");
  }
  if (action === "insert-mention") {
    editor.focus();
    editor.setRangeText(
      `${editor.selectionStart && editor.value[editor.selectionStart - 1] !== " " ? " " : ""}@`,
      editor.selectionStart,
      editor.selectionEnd,
      "end",
    );
    return changedDraft();
  }
  if (action === "newline") {
    editor.setRangeText(
      "\n",
      editor.selectionStart,
      editor.selectionEnd,
      "end",
    );
    editor.focus();
    return changedDraft();
  }
  if (action === "remove-mention") {
    editor.value = editor.value.replace(`@${args.path}`, "");
    return changedDraft();
  }
  if (action === "completion") return chooseCompletion(args.index);
  if (action === "completion-more") {
    completionAll = true;
    renderCompletion();
    editor.focus();
    return;
  }
  if (action === "choose-row") {
    const row = overlayRows[args.index];
    if (row?.action === "focus-filter") {
      el("overlay").querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    // Providers and cleanup stay open, so the result shows.
    if (row && (overlay === "providers" || overlay === "cleanup" || row.action === "auto-approve")) {
      if (row.action) await dispatch(row.action, row.data);
      return;
    }
    if (row) {
      overlay = null;
      renderOverlay();
      return dispatch(row.action, row.data);
    }
  }
  if (action === "complete-command") return setDraft(`${args.name} `);
  if (action === "insert-file") {
    if (/\s/.test(args.path)) {
      notice(
        "This path contains spaces. Use Attach lines to include its contents.",
      );
      return;
    }
    return setDraft(
      editor.value +
        `${editor.value.endsWith(" ") || !editor.value ? "" : " "}@${args.path} `,
    );
  }
  if (action === "copy-code") {
    const text =
      target?.closest("pre")?.querySelector("code")?.textContent ?? "";
    await api("copy", { text });
    if (target) {
      target.textContent = "copied";
      setTimeout(() => (target.textContent = "copy"), 1500);
    }
    return;
  }
  if (action === "edit-ask" || action === "retry-ask") {
    const run = state!.runs.find((run) => run.id === args.id);
    if (!run) return;
    if (action === "edit-ask") return setDraft(run.content);
    if (state!.activeTurnId) return;
    return submitText(run.content);
  }
  if (action === "queue-action") return api("queue-action", { action: args.action });
  if (action === "copy-answer") {
    const run = state!.runs.find((run) => run.id === args.id);
    await api("copy", {
      text:
        run?.entries
          .filter((e) => e.type === "assistant")
          .map((e) => splitNextPrompt((e as any).raw).text)
          .join("\n\n") ?? "",
    });
    notice("Copied");
    return;
  }
  if (
    action === "mode" ||
    action === "model" ||
    action === "theme" ||
    action === "theme-undo" ||
    action === "select-session" ||
    action === "archive" ||
    action === "undo"
  ) {
    overlay = null;
    renderOverlay();
    return api(action, args);
  }
  if (action === "clear-queue") {
    clearTimeout(draftTimer);
    editor.value = "";
    renderComposer();
    return api("clear-queue");
  }
  if (action === "setup" || action === "setup-action") return api(action, args);
  if (action === "open-link") return api("open-link", { url: args.url });
  if (
    [
      "permission",
      "auto-approve",
      "cancel",
      "clear-queue",
      "compact",
      "connect",
      "start-daemon",
      "trust-workspace",
      "quit",
      "drive-control",
    ].includes(action)
  )
    return api(action, args);
}

/// The paths a turn's completed edits touched.
function changedPaths(run: GraphicsRun) {
  return [...new Set(tools(run).filter((t) => t.phase === "change" && t.state === "done").flatMap((t) => t.changes?.map((c) => c.path) ?? [String(t.input.path ?? t.detail ?? "")]))];
}
/// Opens a turn's steps and unfolds the ones asked for (its edits, its
/// checks, or every step), loading a command's recorded output as a click
/// on its row would; then scrolls the turn into view.
async function unfoldTurn(run: GraphicsRun, phase: "change" | "verify" | "all", only?: ToolEntry, path?: string) {
  revealCompactedTurn(run.id);
  expanded.add(run.id);
  stepsOpen.add(run.id);
  follow = false;
  const chosen = only ? [only] : tools(run).filter((tool) =>
    (phase === "all" || tool.phase === phase) &&
    (!path || (tool.changes?.some((c) => c.path === path) ?? String(tool.input.path ?? tool.detail ?? "") === path)));
  const loads: Promise<unknown>[] = [];
  for (const tool of chosen) {
    if (!foldable(tool)) continue;
    stepOpen.add(`${run.id}:${tool.id}`);
    const record = tool.name === "run_command" ? state!.processes.find((command) => command.toolCallId === tool.toolCallId) : undefined;
    if (record?.outputLoaded === false)
      loads.push(api("panel-watch", { panel: "log", command: record.id }).then(() => api("processes")).catch(() => {}));
  }
  await Promise.all(loads);
  renderConversation();
  document.getElementById(`turn-${run.id}`)?.scrollIntoView({ block: "start" });
}

let renderedPalette: Snapshot["palette"] | null = null,
  bannerSignature = "";
function renderState(next: Snapshot) {
  if (state && next.revision < state.revision) return;
  const wasStart = !state?.runs.length;
  const editorFocused = document.activeElement === editor;
  state = next;
  if (lastSession !== next.session?.id) {
    lastSession = next.session?.id ?? "";
    follow = true;
    readingHeld = false;
    overlay = null;
    inspectSurface = null;
    inspectItem = "";
    driveShown = ideasShown = false;
    unwatchOutput();
    expanded.clear();
    expandedCompactions.clear();
    compactionCard?.remove(); compactionCard = null; compactionCardSignature = "";
    runNodes.forEach((item) => item.node.remove());
    runNodes.clear();
    heroSignature = overlaySignature = sidebarSignature = "";
  }
  const question=next.questions[0], slot=question ? `${question.id}:${question.answers?.length ?? 0}` : "chat";
  if (slot !== composerSlot) {
    const sameSession=composerSession===(next.session?.id ?? null);
    if(question && composerSlot==="chat" && sameSession) {
      heldChatDraft=editor.value;
      if(heldChatDraft!==next.draft)void api("draft",{text:heldChatDraft}).catch(()=>{});
    }
    const restored=!question && sameSession ? heldChatDraft : null;
    clearTimeout(draftTimer);composerSlot=slot;
    editor.value=question?.draft ?? restored ?? next.draft;
    if(!question || !sameSession)heldChatDraft=null;
    questionDraftVersion=question?.draftVersion ?? 0;
    if (question) {
      const cached=cachedReply(question.id,question.answers?.length ?? 0);
      if(cached && cached.version>questionDraftVersion){editor.value=cached.text;questionDraftVersion=cached.version;}
    }
    lastDraftVersion=next.draftVersion;
  } else if (!question && lastDraftVersion !== next.draftVersion) {
    lastDraftVersion = next.draftVersion;
    editor.value = next.draft;
  }
  composerSession=next.session?.id ?? null;
  if (renderedPalette !== next.palette) {
    for (const [name, color] of Object.entries(next.palette))
      document.documentElement.style.setProperty(`--${name}`, color);
    // The desktop restyles its own themes by name (desktop.css).
    document.documentElement.dataset.theme = next.theme;
    renderedPalette = next.palette;
  }
  // Drive working this session is a session, even before its first turn:
  // its mission is the conversation's turn.
  const start = !inSession(next);
  el("app").classList.toggle("start", start);
  el("hero").hidden = !start;
  el("conversation").hidden = start;
  if (start) renderHero();
  else if (wasStart) el("input-area").append(el("composer-slot"));
  renderStatus();
  renderConversation();
  renderDriveTurn();
  renderComposer();
  renderApproval();
  renderQuestion();
  renderBriefing();
  renderBreakage();
  renderOverlay();
  renderCompletion();
  renderSetup();
  if (
    !editor.disabled &&
    !overlay &&
    !next.setup &&
    (editorFocused || document.activeElement === document.body)
  )
    editor.focus({ preventScroll: true });
  const trust = next.untrustedWorkspace;
  const message = trust
    ? `Do you trust the files in ${trust}? Demesne will follow its instructions and may run commands there.`
    : next.error ??
      (next.connection === "connecting" ? "Connecting to the daemon…" : "");
  const bannerKey = JSON.stringify([message, next.connection, trust]);
  if (bannerKey !== bannerSignature) {
    bannerSignature = bannerKey;
    el("banner").hidden = !message;
    const actions = trust
      ? ` ${btn("trust-workspace", "Trust folder")} ${btn("quit", "Quit")}`
      : next.connection === "offline"
        ? ` ${btn("connect", "Retry")} ${btn("start-daemon", "Start daemon")} ${btn("setup", "Setup")}`
        : "";
    el("banner").innerHTML = `${h(message)}${actions}`;
  }
  reportObservation();
}
new ResizeObserver(() => renderComposer()).observe(editor);
document.addEventListener("click", (event) => {
  const summary = (event.target as Element).closest("summary");
  const detail = summary?.parentElement as HTMLDetailsElement | undefined;
  if (detail?.dataset.detail) {
    const id = detail.dataset.detail;
    if (detail.open) {
      detailsOpen.delete(id);
      detailsClosed.add(id);
    } else {
      detailsClosed.delete(id);
      detailsOpen.add(id);
    }
  }
  const target = (event.target as Element).closest<HTMLElement>(
    "[data-action]",
  );
  if (target) {
    event.preventDefault();
    void act(() =>
      dispatch(
        target.dataset.action!,
        JSON.parse(target.dataset.args ?? "{}"),
        target,
      ),
    );
    return;
  }
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    void act(() => api("open-link", { url: link.href }));
  }
});
document.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input === (editor as unknown as HTMLInputElement)) {
    changedDraft();
    return;
  }
  if (
    input.closest("#overlay") &&
    overlay &&
    !["rename", "confirm-archive", "confirm-undo"].includes(overlay)
  ) {
    overlayQuery = input.value;
    overlayIndex = 0;
    renderOverlay();
  }
  if (input.closest("#setup")) setupInput(input);
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  void act(async () => {
    if (form.id === "composer") {
      if (pendingQuestion()) await submitText();
      else if (state?.activeTurnId) {
        if ((event as SubmitEvent).submitter) await api("cancel");
        else await submitText();
      } else await submitText();
    }
    if (form.id === "rename-form") {
      await api("rename", {
        title: (form.elements.namedItem("title") as HTMLInputElement).value,
      });
      overlay = null;
      renderOverlay();
    }
    if (form.id === "setup-form") await setupAction({ key: "return" });
  });
});
document.addEventListener(
  "toggle",
  (event) => {
    const detail = event.target as HTMLDetailsElement;
    if (detail.dataset.detail) {
      reportObservation();
    }
  },
  true,
);
// Following the newest text is sticky: only the reader scrolling UP stops
// it (wheel, keys, scrollbar), and reaching the bottom by any means resumes
// it. Content growing, wheel ticks that land at the bottom, and the app's own
// jumps to the bottom never turn it off.
let lastStageTop = 0;
el("stage").addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY >= 0) return;
    readingHeld = true;
    follow = false;
  },
  { passive: true },
);
el("stage").addEventListener("scroll", () => {
  const stage = el("stage");
  if (!driveNavigating) {
    if (stage.scrollHeight - stage.clientHeight - stage.scrollTop < 48) {
      follow = true;
      readingHeld = false;
    } else if (stage.scrollTop < lastStageTop - 2) follow = false;
  }
  lastStageTop = stage.scrollTop;
  reportObservation();
});
document.addEventListener("scroll", () => reportObservation(), true);
document.addEventListener("demesne:open-settings", () => {
  if (state && !state.setup) void act(() => openOverlay("settings"));
});
document.addEventListener("keydown", (event) => {
  if (!state || event.isComposing) return;
  const field =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement;
  const key = event.key.toLowerCase(),
    ctrl = event.ctrlKey || event.metaKey;
  // Native details and buttons must keep Enter/Space when a side panel is open.
  if (!ctrl && !event.altKey && (key === "enter" || key === " ") && event.target instanceof Element) {
    const control = event.target.closest<HTMLElement>(".approval-row button, .thinking-toggle");
    if (control) { event.preventDefault(); control.click(); return; }
  }
  const run = (task: () => Promise<unknown> | void) => {
    event.preventDefault();
    void act(async () => task());
  };
  if (state.setup) {
    handleSetupKey(event);
    return;
  }
  if (key === "escape") {
    run(() => {
      if (overlay) {
        overlay = null;
        renderOverlay();
        editor.focus();
        return;
      }
      if (!el("completion").hidden) {
        completionDismissed = true;
        renderCompletion();
        return;
      }
      if (state!.approvals.length && !pendingQuestion())
        return api("permission", { id: state!.approvals[0]!.id, decision: "deny" });
      if (state!.activeTurnId) {
        if (Date.now() < stopArmed) {
          stopArmed = 0;
          return api("cancel");
        }
        stopArmed = Date.now() + 1500;
        renderComposer();
        setTimeout(renderComposer, 1510);
      }
    });
    return;
  }
  if (ctrl && key === "k") {
    run(() => openOverlay("settings"));
    return;
  }
  // Ctrl+Tab and Ctrl+Shift+Tab step through the chats in the sidebar.
  if (event.ctrlKey && !event.metaKey && !event.altKey && key === "tab") {
    const id = neighbourChat(event.shiftKey ? -1 : 1);
    if (id && id !== state.session?.id) run(() => dispatch("select-session", { id }));
    else event.preventDefault();
    return;
  }
  if (ctrl && !event.shiftKey && !event.altKey && key === "z" && !field && pendingDeletes.size) {
    event.preventDefault();
    undoDelete();
    return;
  }
  if (ctrl && key === "g") {
    run(() => dispatch("follow", {}));
    return;
  }
  if (event.altKey && key === "j") {
    run(() => dispatch("drive-open", { toggle: true }));
    return;
  }
  if (state.approvals.length && !field && !ctrl && !event.altKey) {
    const choice = {
      y: "allow_once",
      n: "deny",
      a: "allow_session",
      s: "allow_always",
    }[key];
    if (choice) {
      run(() =>
        api("permission", { id: state!.approvals[0]!.id, decision: choice }),
      );
      return;
    }
  }
  if (overlay) {
    // ←→ choose the highlighted model's thinking level (while the filter is
    // empty; with text they move the caret).
    if (overlay === "models" && (key === "arrowleft" || key === "arrowright") && !overlayQuery) {
      const row = overlayRows[overlayIndex];
      const model = row?.action === "model" ? models.find((item) => item.id === row.data.id) : undefined;
      const levels = model?.reasoningLevels;
      if (model && levels?.length) {
        event.preventDefault();
        const at = Math.max(0, levels.indexOf(modelLevel(model) ?? levels[0]!));
        modelLevels.set(model.id, levels[(at + (key === "arrowright" ? 1 : -1) + levels.length) % levels.length]!);
        overlaySignature = "";
        renderOverlay();
        return;
      }
    }
    if (key === "arrowdown" || key === "arrowup") {
      run(() => {
        overlayIndex =
          (overlayIndex + (key === "arrowdown" ? 1 : -1) + overlayRows.length) %
          Math.max(1, overlayRows.length);
        renderOverlay();
        el("overlay")
          .querySelector(".selected")
          ?.scrollIntoView({ block: "nearest" });
      });
      return;
    }
    if (key === "enter" && overlayRows.length) {
      run(() => dispatch("choose-row", { index: overlayIndex }));
      return;
    }
    if (key === "enter" && event.target instanceof HTMLInputElement) {
      const form = event.target.form;
      if (form) run(() => form.requestSubmit());
    }
    return;
  }
  if (event.target === editor && !el("completion").hidden) {
    if (key === "arrowdown" || key === "arrowup") {
      run(() => {
        completionIndex =
          (completionIndex +
            (key === "arrowdown" ? 1 : -1) +
            completionItems.length) %
          completionItems.length;
        renderCompletion();
      });
      return;
    }
    if (key === "tab" || key === "enter") {
      run(() =>
        key === "tab" && completionItems[completionIndex]?.kind === "command"
          ? setDraft(`${completionItems[completionIndex]!.value} `)
          : chooseCompletion(),
      );
      return;
    }
  }
  if (event.target === editor && key === "enter" && !event.shiftKey) {
    // During an approval Enter allows; with text it denies and says why.
    const approval = !pendingQuestion() ? state.approvals[0] : undefined;
    if (approval) run(() => (editor.value.trim() ? denyInstead(editor.value) : api("permission", { id: approval.id, decision: "allow_once" })));
    else run(() => submitText());
    return;
  }
  if (
    key === "tab" &&
    !event.shiftKey &&
    event.target === editor &&
    !editor.value
  ) {
    // The model's suggested next prompt, or Drive's idea on the start
    // screen, when one shows; else Settings.
    const suggestion = nextSuggestion() ?? driveSuggestion();
    run(() => (suggestion ? setDraft(suggestion) : openOverlay("settings")));
    return;
  }
  if (key === "enter" && event.target instanceof HTMLInputElement) {
    const form = event.target.form;
    if (form) {
      run(() => form.requestSubmit());
      return;
    }
  }
});
window.demesneInspect = () => ({
  // What the host last published: the session, its turn, queue and draft.
  host: { session: state?.session?.id, active: state?.activeTurnId, busy: state?.busy, queue: state?.queue, draft: state?.draft, restored: state?.restored, connection: state?.connection, notice: el("notice").hidden ? "" : el("notice").textContent, requests: recentRequests.map((entry) => `${entry.method} ${entry.outcome}`) },
  // Whether the conversation follows new text, and where it is scrolled.
  stage: { follow, top: Math.round(el("stage").scrollTop), bottom: Math.round(el("stage").scrollHeight - el("stage").clientHeight) },
  selection: getSelection()?.toString() ?? "",
  thinking: [...document.querySelectorAll<HTMLElement>("#conversation .thinking-main")].map(trace=>{
    const toggle=trace.querySelector(".thinking-toggle")!, body=trace.querySelector(".thinking-content")!;
    const row=toggle.getBoundingClientRect(), content=body.getBoundingClientRect();
    return {open:toggle.getAttribute("aria-expanded") === "true",live:trace.classList.contains("live"),summary:toggle.textContent,body:body.textContent?.slice(-2000),
      x:row.x+row.width/2,y:row.y+row.height/2,statusTop:row.top,bodyBottom:content.bottom};
  }),
  requests: [...document.querySelectorAll<HTMLElement>(".request .text")].map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent, x: r.x, y: r.y, width: r.width, height: r.height }; }),
  controls: [
    ...document.querySelectorAll<HTMLElement>(
      "button,input,textarea,summary",
    ),
  ]
    .filter(
      (e) =>
        e.getBoundingClientRect().width > 0 &&
        e.getBoundingClientRect().height > 0,
    )
    .map((e) => {
      const r = e.getBoundingClientRect();
      return {
        tag: e.tagName,
        id: e.id,
        value:
          e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement
            ? e.value
            : undefined,
        hit: (() => {
          const top = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          return top === e || Boolean(top && e.contains(top));
        })(),

        name: e.getAttribute("name"),
        disabled: e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLButtonElement ? e.disabled : undefined,
        placeholder: e.getAttribute("placeholder") ?? undefined,
        label:
          e.innerText ||
          e.getAttribute("aria-label") ||
          e.getAttribute("placeholder"),
        action:
          e.dataset.action ??
          (e.dataset.fileAction ? `file-${e.dataset.fileAction}` : undefined),
        args: e.dataset.args,
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        width: r.width,
        height: r.height,
      };
    }),
  processes: state?.processes.map((c) => ({
    id: c.id,
    status: c.status,
    freshness: c.freshness,
    check: c.check,
    background: c.background,
    stdout: c.stdout.slice(-2000),
    stderr: c.stderr.slice(-1000),
  })),
  inspectSurface,
  openSteps: [...stepOpen],
  connection: state?.connection,
  theme: state?.theme,
  sessionId: state?.session?.id,
  activeTurnId: state?.activeTurnId,
  runs: state?.runs.map((run) => ({
    id: run.id,
    status: run.status,
    entries: run.entries.length,
  })),
  approvals: state?.approvals.length,
  autoApprove: state?.session?.autoApprove === true,
  approvalText: el("approval").innerText,
  approvalDetailsOpen: !(el("approval").querySelector<HTMLElement>(".approval-fold")?.hidden ?? true),
  questions: state?.questions.length,
  queue: state?.queue,
  overlay,
  setup: state?.setup,
  drive: state?.drive?.status,
  driveMode: state?.drive?.mode,
  drivePhase: state?.drive?.autonomy?.phase,
  driveMemory: state?.driveMemory,
  driveNext: state?.driveNext,
  cleanup: state?.cleanup,
  breakage: state?.breakage,
  driveTasks: state?.drive?.ledger?.tasks.map((task) => ({
    id: task.id,
    status: task.status,
    criteria: task.criteria,
    completions: task.completions.length,
  })),
  driveActivity: state?.drive?.activity,
  assets: [...document.images].map((img) => ({
    src: img.getAttribute("src")?.startsWith("data:")
      ? "inline-image"
      : img.getAttribute("src"),
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    width: img.width,
    height: img.height,
    visible: Boolean(img.getBoundingClientRect().width),
  })),
  text: document.body.innerText,
});
const stateReceiver = new StateReceiver();
let resyncing = false;
function resyncState() {
  if (resyncing) return;
  resyncing = true;
  let received = false;
  void window.demesne
    .request<Snapshot>("bootstrap")
    .then((snapshot) => {
      received = true;
      const next = stateReceiver.seed(snapshot);
      if (next) renderState(next);
    })
    .catch((error) => notice(String(error)))
    .finally(() => {
      resyncing = false;
      if (received && stateReceiver.needsReset) resyncState();
    });
}
window.demesne.subscribe((update) => {
  const next = stateReceiver.apply(update);
  if (next) renderState(next);
  if (stateReceiver.needsReset) resyncState();
});
void window.demesne
  .request<Snapshot>("bootstrap")
  .then((snapshot) => {
    const next = stateReceiver.seed(snapshot);
    if (next) renderState(next);
    if (stateReceiver.needsReset) resyncState();
    editor.focus({ preventScroll: true });
    window.demesne.ready();
  })
  .catch((error) => {
    notice(String(error));
    window.demesne.ready();
  });
// Spinners and thinking sub-agents' phrases advance in place; the DOM (and
// so the terminal's tiles) only changes when a glyph or phrase does.
setInterval(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const frame = spinnerFrame();
  for (const span of document.querySelectorAll<HTMLElement>(".spin")) if (span.textContent !== frame) span.textContent = frame;
}, 90);
setInterval(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const span of document.querySelectorAll<HTMLElement>("[data-subagent-phrase]")) {
    const next = subagentPhrase(Number(span.dataset.slot), Date.now(), span.dataset.model ?? "");
    if (span.textContent !== next) span.textContent = next;
  }
}, 300);
setInterval(() => {
  if (state?.activeTurnId) renderStatus();
  renderDriveTurn();
  for (const span of document.querySelectorAll<HTMLElement>("[data-since]")) {
    const next = elapsed(span.dataset.since!);
    if (span.textContent !== next) span.textContent = next;
  }
  if (state?.setup?.step === "auth") updateSetupTimer();
}, 1000);

let setupSignature = "",
  setupTimer: ReturnType<typeof setTimeout> | undefined;
const setupRoot = document.createElement("section");
setupRoot.id = "setup";
setupRoot.hidden = true;
el("app").append(setupRoot);
async function setupAction(args: Record<string, unknown>) {
  clearTimeout(setupTimer);
  await api("setup-action", args);
}
function setupInput(input: HTMLInputElement) {
  clearTimeout(setupTimer);
  const field = input.name,
    value = input.value;
  setupTimer = setTimeout(
    () => void act(() => setupAction({ field, value })),
    40,
  );
}
function updateSetupTimer() {
  const auth = state?.setup?.auth,
    element = document.getElementById("auth-timer");
  if (element && auth?.expiresAt) {
    const seconds = Math.max(
      0,
      Math.ceil((auth.expiresAt - Date.now()) / 1000),
    );
    element.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining`;
  }
}
function handleSetupKey(event: KeyboardEvent) {
  const names: Record<string, string> = {
    ArrowUp: "up",
    ArrowDown: "down",
    Enter: "return",
    Escape: "escape",
    Backspace: "backspace",
  };
  const field = event.target instanceof HTMLInputElement;
  if (field && !["Enter", "Escape"].includes(event.key)) return;
  const name = names[event.key] ?? event.key.toLowerCase();
  if (
    ![
      "up",
      "down",
      "return",
      "escape",
      "backspace",
      "r",
      "c",
      "o",
      "e",
      "q",
      "s",
    ].includes(name)
  )
    return;
  event.preventDefault();
  void act(async () => {
    if (field) {
      const input = event.target as HTMLInputElement;
      await setupAction({ field: input.name, value: input.value });
    }
    await setupAction({ key: name });
  });
}
function renderSetup() {
  const setup = state?.setup;
  setupRoot.hidden = !setup;
  el("workspace").hidden = Boolean(setup);
  // A session has no status bar; the composer and top bar carry its state.
  el("status").hidden = Boolean(setup) || inSession();
  if (!setup) {
    setupSignature = "";
    return;
  }
  const signature = JSON.stringify(setup);
  if (signature === setupSignature) return;
  setupSignature = signature;
  const focused = setupRoot.querySelector<HTMLInputElement>("input:focus"),
    field = focused?.name,
    selection = focused?.selectionStart;
  const step = setup.step,
    model = setup.provider?.models.length
      ? (setup.provider.models[setup.modelIndex]?.id ?? "")
      : setup.modelText;
  const stepIndex = ["provider", "custom", "auth", "accounts", "plan"].includes(step)
    ? 0
    : step === "model"
      ? 1
      : step === "review"
        ? 2
        : 3;
  const button = (
    key: string,
    label: string,
    data: Record<string, unknown> = {},
    className = "",
  ) => btn("setup-action", label, { key, ...data }, className);
  const list = (rows: string[]) =>
    `<div class="setup-list">${rows.join("")}</div>`;
  const row = (
    index: number,
    label: string,
    description: string,
    right: string,
    selected: boolean,
  ) =>
    button(
      "",
      `<span class="choice">${selected ? "›" : " "}</span><span><strong>${label}</strong><small>${description}</small></span><span class="right">${right}</span>`,
      { index },
      `setup-option ${selected ? "selected" : ""}`,
    );
  let body = "",
    left = "",
    right = button("return", `Continue ${k("Enter")}`);
  if (step === "provider") {
    const probes = setup.probes ?? [],
      options = [
        ...probes.filter((p) => p.reachable),
        ...probes.filter((p) => !p.reachable),
        "openrouter",
        "chatgpt",
        "custom",
      ] as const;
    body = `<h1>Where should demesne run its model?</h1><p>${probes.filter((p) => p.reachable).length ? `Found ${probes.filter((p) => p.reachable).length} local server${probes.filter((p) => p.reachable).length === 1 ? "" : "s"}.` : "No local servers detected."} You can change this later in Settings.</p>${list(options.map((option, index) => (typeof option === "string" ? row(index, option === "chatgpt" ? "Continue with ChatGPT" : option === "openrouter" ? "OpenRouter" : "Custom URL", option === "chatgpt" ? "Use your ChatGPT plan · browser sign-in" : option === "openrouter" ? "Hosted models · sign in with your browser" : "Any OpenAI-compatible endpoint", "", index === setup.providerIndex) : row(index, h(option.target.label), `${h(option.target.url)} · ${option.reachable ? `${option.models.length} models` : "not reachable"}`, option.reachable ? '<span class="muted">detected</span>' : "", index === setup.providerIndex))))}<p class="setup-note">${setup.probes === null ? "Checking local servers…" : "Unreachable servers stay listed so you can start them and press r to rescan."}</p>`;
    left = `${k("↑↓")} choose ${button("r", `${k("r")} rescan`)} ${button("escape", `${k("Esc")} quit`)}`;
  }
  if (step === "model") {
    const models = setup.provider?.models ?? [],
      largest = Math.max(...models.map((m) => m.contextWindow ?? 0)),
      recommended = setup.provider?.target.id === "ChatGPT" ? -1 : models.findIndex((m) => (m.contextWindow ?? 0) === largest),
      order = [
        recommended,
        ...models.map((_, i) => i).filter((i) => i !== recommended),
      ].filter((i) => i >= 0);
    body = `<h1>Choose a model</h1><p>${h(setup.provider?.target.label)} · ${h(setup.provider?.target.url)}</p>${models.length ? list(order.map((index) => row(index, h(models[index]!.displayName ?? models[index]!.id), `${num(models[index]!.contextWindow)} context${models[index]!.maxOutputTokens ? ` · ${num(models[index]!.maxOutputTokens)} max output` : ""}`, index === recommended ? '<span class="success">recommended</span>' : "", index === setup.modelIndex))) : `<form id="setup-form"><label>MODEL ID<input name="model" value="${h(setup.modelText)}" placeholder="Enter a model id" autofocus></label></form>`}<p class="setup-note">${models.length ? "Models reported by your provider. Context size is checked in Review." : "The server did not list models. Enter the exact id it expects."}</p>`;
    left = `${k("↑↓")} choose ${button("escape", `${k("Esc")} back`)}`;
  }
  if (step === "custom") {
    const result = setup.customResult;
    body = `<h1>Enter your server address</h1><p>Any OpenAI-compatible endpoint: vLLM, llama.cpp, LM Studio, Ollama, or a hosted gateway.</p><form id="setup-form"><label>Base URL<input name="url" type="url" value="${h(setup.custom.text)}" placeholder="http://127.0.0.1:8000/v1" autocomplete="off"></label></form><div class="probe-result ${setup.custom.checking ? "amber" : result?.reachable ? "success" : result ? "amber" : "muted"}">${setup.custom.checking ? "◌ Checking the server…" : result?.reachable ? `✓ Reachable · OpenAI-compatible · ${result.models.length} models` : result ? "○ Server did not respond · you can continue and enter a model id" : "The server is checked as you type."}</div>${setup.custom.error ? `<p class="danger">${h(setup.custom.error)}</p>` : ""}<p class="setup-note">Needs an API key? Add it in ~/.demesne/config.toml after setup; it is never typed here.</p>`;
    left = button("escape", `${k("Esc")} back`);
  }
  if (step === "accounts") {
    body = `<h1>Choose a ChatGPT account</h1><p>Each account and workspace has its own connection.</p>${setup.accounts ? list([...setup.accounts, null].map((account, index) => row(index, h(account?.label ?? "Continue with ChatGPT"), account ? account.planEnabled ? "Using ChatGPT plan" : "Sign in again" : "Add another account or workspace", "", index === (setup.accountIndex ?? 0)))) : "<p>Loading accounts…</p>"}`;
    left = `${k("↑↓")} choose ${button("s", "Sign out")} ${button("escape", `${k("Esc")} back`)}`;
  }
  if (step === "plan") {
    body = `<h1>You’re using your ChatGPT plan</h1><p>Eligible requests from Demesne count toward your ChatGPT plan usage and available credits.</p><div class="auth-card"><strong>${h(setup.chatgptAccount?.label)}</strong><p>Your account is connected to Demesne.</p></div>`;
    left = button("o", "Manage usage") + button("escape", `${k("Esc")} back`);
    right = button("return", `Got it ${k("Enter")}`);
  }
  if (step === "auth") {
    const auth = setup.auth;
    body = `<h1>${setup.authProvider === "chatgpt" ? "Continue with ChatGPT" : "Sign in to OpenRouter"}</h1><p>Your browser opens a secure sign-in page.</p><div class="auth-card ${auth.status === "failed" ? "failed" : ""}"><div><strong>${auth.status === "failed" ? "× Sign-in failed" : auth.status === "loading" ? "Connected · loading models" : "Waiting for sign-in"}</strong>${auth.status === "waiting" ? '<img src="assets/auth-dots.svg" alt=""><span id="auth-timer" class="right"></span>' : ""}</div><p>${h(auth.message)}</p></div>${auth.url ? `<div class="auth-link">${button("o", h(auth.url))}</div>` : ""}${setup.authProvider === "chatgpt" ? `<p class="setup-note">A one-time loopback callback receives your sign-in. Tokens are stored in Demesne’s protected local credentials file and kept out of this interface. Review applies the provider configuration.</p>` : `<p class="setup-note">A one-time localhost callback receives your sign-in. Your credential is saved only when you write the config in Review.</p><p class="setup-note">Already have a key? Set <code>OPENROUTER_API_KEY</code> before starting setup.</p>`}`;
    left = `${auth.url ? button("c", `${k("c")} ${auth.copied ? "copied" : "copy link"}`) + button("o", `${k("o")} reopen browser`) : ""}${button("r", `${k("r")} retry`)}${button("escape", `${k("Esc")} back`)}`;
    right =
      auth.status === "failed" ? button("return", `Retry ${k("Enter")}`) : "";
  }
  if (step === "review") {
    const rows = [
      ["Provider", setup.provider?.target.label ?? "", ""],
      ["Model", model, ""],
      [
        "Context window",
        setup.review.contextWindow.toLocaleString(),
        setup.review.detected ? "detected" : "manual",
      ],
      [
        setup.provider?.target.id === "ChatGPT" ? "Output reserve" : "Max output",
        setup.review.maxOutputTokens.toLocaleString(),
        setup.provider?.target.id === "ChatGPT" ? "context planning · not an API cap" : "tokens per request",
      ],
      [
        "Theme",
        setup.review.theme,
        setup.review.theme === "auto" ? "follows your system appearance" : "",
      ],
    ];
    body = `<h1>Ready to write your config</h1><p>Detected values are filled in. Select a line and press e to change it.</p>${list(rows.map(([label, value, note], index) => (setup.editing && index === setup.reviewIndex ? `<form id="setup-form" class="setup-review-row selected"><span>${label}</span><input name="review" inputmode="numeric" value="${h(setup.editing.text)}"><button type="submit">Save ${k("Enter")}</button></form>` : button("", `<span>${label}</span><strong>${h(value)}</strong><small>${h(note)}</small>${index >= 2 && index === setup.reviewIndex ? `<span data-action="setup-action" data-args="{&quot;key&quot;:&quot;e&quot;}">e edit</span>` : ""}`, { index }, `setup-review-row ${index === setup.reviewIndex ? "selected" : ""}`))))}${setup.editing?.error ? `<p class="danger">${h(setup.editing.error)}</p>` : ""}<p class="setup-note">Writes ${h(setup.configPath)} · an existing file is backed up first.</p>`;
    left = setup.editing
      ? button("escape", `${k("Esc")} cancel edit`)
      : `${k("↑↓")} select ${button("e", `${k("e")} edit`)} ${button("backspace", `${k("⌫")} back`)} ${button("escape", `${k("Esc")} quit`)}`;
    right = button(
      "return",
      `${setup.saving ? "Saving…" : setup.editing ? "Save" : "Write config"} ${k("Enter")}`,
    );
  }
  if (step === "done") {
    body = `<h1><span class="success">✓</span> demesne is ready</h1><p>Connected to ${h(setup.provider?.target.label)} · ${h(model)} · ${num(setup.review.contextWindow)} context</p><div class="saved"><span class="success">Saved</span><span>${h(setup.configPath)}</span>${setup.saved?.backup ? `<small>previous file → ${h(setup.saved.backup.split("/").at(-1))}</small>` : ""}</div><div class="setup-next"><div class="muted">NEXT</div>${[
      ["Open project", "start a session in your selected project"],
      ["Settings", "change your provider, model, or theme"],
    ]
      .map(
        ([cmd, description]) =>
          `<div><code>${cmd}</code><span>${description}</span></div>`,
      )
      .join("")}</div>`;
    left = button("q", `${k("q")} close`);
    right = button("return", `Open project ${k("Enter")}`);
  }
  setupRoot.innerHTML = `<header><span><b>demesne</b> <span class="muted">setup</span></span><div class="setup-steps">${["Provider", "Model", "Review"].map((label, index) => `<span class="${index < stepIndex ? "success" : index === stepIndex ? "electric" : "muted"}">${index < stepIndex ? "✓" : index + 1} ${label}</span>`).join('<span class="muted">──</span>')}</div></header><div class="setup-body"><div class="setup-column">${body}${setup.error ? `<p class="danger">× ${h(setup.error)}</p>` : ""}</div></div><footer><div>${left}</div><span class="right">${right}</span></footer>`;
  const input = setupRoot.querySelector<HTMLInputElement>("input");
  if (input && (field === input.name || !field)) {
    input.focus({ preventScroll: true });
    if (selection != null && input.type !== "number")
      input.setSelectionRange(selection, selection);
  }
  updateSetupTimer();
}

const driveControls = new Map<string, HTMLElement>();
const driveAllowed = new Set([
  "expand-turn",
  "jump-turn",
  "toggle-steps",
  "step",
  "follow",
]);
const fingerprint = (text: string) => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
};
function clipRect(element: Element) {
  let rect = element.getBoundingClientRect(),
    left = Math.max(0, rect.left),
    top = Math.max(0, rect.top),
    right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  if (!rect.width || !rect.height) return null;
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") return null;
    if (/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) {
      const r = parent.getBoundingClientRect();
      left = Math.max(left, r.left);
      top = Math.max(top, r.top);
      right = Math.min(right, r.right);
      bottom = Math.min(bottom, r.bottom);
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}
/** Read visible text ranges after layout. Offscreen paragraphs, hidden details,
 * and the controller's own notes cannot become evidence for its next decision. */
function observeUI(): DriveObservation {
  const cw = Math.max(8, innerWidth / 500),
    ch = Math.max(18, innerHeight / 250),
    width = Math.min(500, Math.ceil(innerWidth / cw)),
    height = Math.min(250, Math.ceil(innerHeight / ch));
  const rows = Array.from({ length: height }, () =>
      Array<string>(width).fill(" "),
    ),
    answer = rows.map((row) => row.map(() => " ")),
    latest = rows.map((row) => row.map(() => " "));
  let characters = 0;
  const walker = document.createTreeWalker(
      el("workspace"),
      NodeFilter.SHOW_TEXT,
    ),
    range = document.createRange();
  let node: Node | null;
  while ((node = walker.nextNode()) && characters < 24000) {
    const parent = node.parentElement;
    if (
      !parent ||
      !node.textContent?.trim() ||
      parent.closest(
        "#status,header,.drive-live,#drive-turn,#overlay[hidden],#completion[hidden],time,script,style,textarea",
      )
    )
      continue;
    const clip = clipRect(parent);
    if (!clip) continue;
    const answerId =
        parent.closest<HTMLElement>("[data-answer]")?.dataset.answer,
      run = state?.runs.find((item) => item.id === answerId),
      completed = run?.status === "completed",
      isLatest = run?.id === state?.runs.at(-1)?.id;
    for (const match of node.textContent.matchAll(/\S+/g)) {
      range.setStart(node, match.index!);
      range.setEnd(node, match.index! + match[0].length);
      const rects = range.getClientRects();
      // Words wrapping at the viewport edge are split into their visible glyphs.
      const pieces =
        rects.length <= 1
          ? [{ text: match[0], rect: rects[0] }]
          : [...match[0]].map((text, i) => {
              range.setStart(node!, match.index! + i);
              range.setEnd(node!, match.index! + i + 1);
              return { text, rect: range.getBoundingClientRect() };
            });
      for (const { text, rect } of pieces) {
        if (
          !rect ||
          rect.bottom <= clip.top ||
          rect.top >= clip.bottom ||
          rect.left >= clip.right ||
          rect.right <= clip.left
        )
          continue;
        const row = Math.max(
            0,
            Math.min(height - 1, Math.floor((rect.top + rect.height / 2) / ch)),
          ),
          column = Math.max(0, Math.floor(rect.left / cw));
        for (let i = 0; i < text.length && column + i < width; i++) {
          if (
            rect.left + (i * rect.width) / text.length < clip.left ||
            rect.left + (i * rect.width) / text.length >= clip.right
          )
            continue;
          rows[row]![column + i] = text[i]!;
          if (completed) {
            answer[row]![column + i] = text[i]!;
            if (isLatest) latest[row]![column + i] = text[i]!;
          }
        }
        characters += text.length;
      }
    }
  }
  const geometry = (element: Element) => {
    const rect = clipRect(element);
    if (!rect) return null;
    const row = Math.min(height - 1, Math.floor(rect.top / ch)),
      column = Math.min(width - 1, Math.floor(rect.left / cw));
    return {
      row,
      column,
      width: Math.max(
        1,
        Math.min(width - column, Math.ceil((rect.right - rect.left) / cw)),
      ),
      height: Math.max(
        1,
        Math.min(height - row, Math.ceil((rect.bottom - rect.top) / ch)),
      ),
    };
  };
  const controls: DriveObservation["controls"] = [];
  driveControls.clear();
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-drive][data-action]",
  )) {
    if (
      !driveAllowed.has(element.dataset.action!) ||
      element.closest(".drive-live, #drive-turn")
    )
      continue;
    const box = geometry(element);
    if (!box) continue;
    const id = `c-${fingerprint(element.dataset.drive! + element.dataset.args)}`;
    driveControls.set(id, element);
    controls.push({
      id,
      label: (
        element.innerText ||
        element.getAttribute("aria-label") ||
        ""
      ).slice(0, 1000),
      row: box.row,
      column: box.column,
      width: box.width,
    });
    if (controls.length >= 160) break;
  }
  const run = selectedRun(),
    checks = run ? verificationChecks(run.id) : [],
    surface = inspectSurface ?? "response";
  // Diffs, checks and logs unfold inside the conversation, so an inspection
  // reads the stage under that surface's name.
  const panes: NonNullable<DriveObservation["panes"]> = [],
    scrollRegions: NonNullable<DriveObservation["scrollRegions"]> = [];
  for (const [element, name, scrollName] of [
    [el("stage"), "response", "response"],
    ...(inspectSurface
      ? [[el("stage"), inspectSurface, inspectSurface === "diff" ? "diff-code" : inspectSurface]]
      : []),
  ] as [HTMLElement, string, string][]) {
    if (!element) continue;
    const box = geometry(element);
    if (box) {
      panes.push({ surface: name, ...box });
      scrollRegions.push({
        surface: scrollName,
        ...box,
        offset: Math.round(element.scrollTop),
        maximum: Math.max(0, element.scrollHeight - element.clientHeight),
      });
    }
  }
  const mode =
    state?.approvals.length || state?.questions.length
      ? "approval"
      : overlay || state?.setup
        ? "dialog"
        : state?.activeTurnId
          ? "streaming"
          : "input";
  const textRows = rows.map((row) => row.join("").trimEnd()),
    answerRows = answer.map((row) => row.join("").trimEnd()).filter(Boolean),
    latestAnswerRows = latest
      .map((row) => row.join("").trimEnd())
      .filter(Boolean);
  const observation: DriveObservation = {
    id: "",
    sessionId: state?.session?.id ?? "none",
    workspace: state?.workspace ?? "",
    title: state?.session?.title ?? "",
    mode,
    ready: mode === "input" && state?.connection === "online" && !state.busy,
    draft: editor.value,
    surface,
    width,
    height,
    rows: textRows,
    evidenceRows: textRows,
    answerRows,
    latestAnswerRows,
    controls,
    panes,
    scrollRegions,
    focus: overlay
      ? "dialog"
      : document.activeElement === editor
        ? "composer"
        : "content",
    navigation: {
      document: `${state?.session?.id ?? "none"}:${run?.id ?? "start"}`,
      turn: run?.id ?? "start",
      latest: run?.id === state?.runs.at(-1)?.id,
      answer: Boolean(
        run?.status === "completed" &&
          run.entries.some((e) => e.type === "assistant"),
      ),
      readingHeld,
      files: (run ? changedPaths(run) : []).slice(0, 128),
      checks: checks.map((c) => String(c.id)).slice(0, 128),
      ...(inspectItem ? { item: inspectItem } : {}),
    },
  };
  observation.id = fingerprint(JSON.stringify(observation));
  return observation;
}
let observationTimer: ReturnType<typeof setTimeout> | undefined,
  lastObservation = "";
function reportObservation() {
  const needed = () =>
    Boolean(
      state?.session &&
        state.drive &&
        ["running", "waiting"].includes(state.drive.status),
    );
  if (!needed()) {
    clearTimeout(observationTimer);
    observationTimer = undefined;
    lastObservation = "";
    return;
  }
  if (observationTimer) return;
  observationTimer = setTimeout(() => {
    observationTimer = undefined;
    if (!needed()) return;
    const observed = observeUI();
    if (observed.id === lastObservation) return;
    lastObservation = observed.id;
    void api("observe", { observation: observed }).catch(() => {});
  }, 180);
}
window.demesne.commands(async (command) => {
  driveNavigating = true;
  try {
    const observation = observeUI(),
      action = command.action;
    if (
      observation.id !== command.observationId ||
      observation.mode !== "input" ||
      !observation.ready
    )
      throw new Error("UI changed; observe again.");
    let result = "UI action finished.";
    if (action.kind === "compose") {
      if (editor.value)
        throw new Error("Input changed; existing draft left untouched.");
      editor.value = action.text;
      editor.focus({ preventScroll: true });
      renderComposer();
      const plan = /^\/plan\s+/.test(action.text);
      if (action.text.startsWith("/") && !plan)
        throw new Error(
          "Only requests or /plan prompts can be composed by Drive.",
        );
      followLatest();
      await api(plan ? "plan-submit" : "submit", {
        text: action.text,
        driveCommand: command.id,
      });
      result = `Sent through the visible composer: ${action.text.slice(0, 500)}`;
    } else if (action.kind === "click") {
      const target = driveControls.get(action.target);
      if (!target) throw new Error("Control moved; observe again.");
      await dispatch(
        target.dataset.action!,
        JSON.parse(target.dataset.args ?? "{}"),
        target,
      );
    } else if (action.kind === "inspect") {
      const current = selectedRun();
      if (!current) throw new Error("No turn to inspect");
      if (action.target === "answer") {
        revealCompactedTurn(current.id);
        expanded.add(current.id);
        follow = false;
        readingHeld = false;
        renderConversation();
        const response = document
          .getElementById(`turn-${current.id}`)
          ?.querySelector<HTMLElement>("[data-answer]");
        if (response) {
          const stage = el("stage");
          stage.scrollTop +=
            response.getBoundingClientRect().top -
            stage.getBoundingClientRect().top;
        }
        el("stage").focus();
      } else {
        // The diff, checks or log unfold under the turn's steps; the
        // observation then reads the stage as that surface.
        inspectSurface = action.target === "checks" ? "review" : action.target;
        inspectItem = "";
        let only: ToolEntry | undefined;
        if (action.target === "checks") {
          const checks = verificationChecks(current.id),
            check = (action.item && checks.find((check) => check.id === action.item)) || checks[0];
          if (check) {
            inspectItem = check.id;
            only = tools(current).find((tool) => tool.toolCallId === check.toolCallId);
            if (!check.id.startsWith("legacy:")) {
              await api("panel-watch", { panel: "log", command: check.id });
              await api("processes");
              const deadline = performance.now() + 3000;
              while (
                state?.session?.id === observation.sessionId &&
                state.processes.find((record) => record.id === check.id)?.outputLoaded === false &&
                performance.now() < deadline
              )
                await new Promise((resolve) => setTimeout(resolve, 16));
              const loaded = state?.processes.find((record) => record.id === check.id);
              if (!loaded || loaded.outputLoaded === false || state?.processesError)
                throw new Error(state?.processesError ?? "Check output has not loaded. Inspect this check again.");
            }
          }
        } else if (action.target === "diff" && action.item) inspectItem = action.item;
        await unfoldTurn(current, action.target === "diff" ? "change" : action.target === "checks" ? "verify" : "all", only, action.target === "diff" ? action.item : undefined);
      }
      const scroll = el("stage");
      if (action.position === "end") scroll.scrollTop = scroll.scrollHeight;
      else if (action.position !== "continue") scroll.scrollTop = 0;
    } else if (action.kind === "scroll") {
      const region = observation.scrollRegions?.findLast(
        (r) =>
          action.row >= r.row &&
          action.row < r.row + r.height &&
          action.column >= r.column &&
          action.column < r.column + r.width,
      );
      if (!region)
        throw new Error("Scroll did not move; no scroll region here");
      const scroll = el("stage");
      const before = scroll.scrollTop;
      scroll.scrollTop += action.amount * 18;
      result =
        before === scroll.scrollTop
          ? "Scroll did not move; boundary reached."
          : "Scrolled the visible view.";
    } else if (action.kind === "key") {
      const scroll = el("stage");
      if (
        ["up", "down", "pageup", "pagedown", "home", "end"].includes(action.key)
      ) {
        const before = scroll.scrollTop;
        scroll.scrollTop =
          action.key === "home"
            ? 0
            : action.key === "end"
              ? scroll.scrollHeight
              : scroll.scrollTop +
                (action.key === "up"
                  ? -22
                  : action.key === "down"
                    ? 22
                    : action.key === "pageup"
                      ? -scroll.clientHeight + 22
                      : scroll.clientHeight - 22);
        result =
          before === scroll.scrollTop
            ? "Scroll did not move; boundary reached."
            : "Scrolled the visible view.";
      } else if (action.key === "escape") {
        inspectSurface = null;
        inspectItem = "";
      }
      else if (action.key === "ctrl+g") await dispatch("follow", {});
      else if (["ctrl+b", "alt+d", "alt+v", "alt+h", "alt+enter"].includes(action.key))
        throw new Error(
          "There are no side panels; inspect with target diff, checks or log to unfold the turn's result in the conversation.",
        );
      else
        throw new Error(
          `Key ${action.key} is unavailable here; use a visible control.`,
        );
    } else throw new Error("This action is handled by the Drive controller.");
    // Force layout before acknowledging so the next decision sees the result.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await api("ui-result", {
      id: command.id,
      result,
      observation: observeUI(),
    });
  } catch (error) {
    await api("ui-result", {
      id: command.id,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  } finally {
    driveNavigating = false;
  }
});

window.addEventListener("resize", () => {
  if (overlay) placeOverlay();
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  // A click outside the open picker or sheet closes it.
  if (overlay && target.isConnected && !target.closest("#overlay, [data-action='overlay']")) {
    overlay = null;
    renderOverlay();
  }
});
