import { compactedConversation } from "./compacted-conversation.ts";
import { SidebarProjectOrder } from "./sidebar-project-order.ts";
import { markdown, MarkdownView } from "./markdown.ts";
import { splitNextPrompt } from "../../../packages/protocol/src/next-prompt.ts";
import { parseMailTurn } from "../../../packages/protocol/src/heartbeat-mail.ts";
import { StateReceiver, type StateUpdate } from "./state-wire.ts";
import { codeDiff } from "@demesne/workbench/change-diff.ts";
import { driveSince, driveStepLine, driveTaskList } from "@demesne/drive/drive-timeline.ts";
import { subagentPhrase } from "@demesne/workbench/subagent-phrases.ts";
import { noteKey, notesMessage, reviewRows, type DiffNote } from "./turn-review.ts";
import type { WorkspaceHost } from "./host.ts";
import type { WorkspaceRun } from "./session-model.ts";
import type {
  ToolEntry,
  WorkbenchEntry,
} from "@demesne/workbench/entries.ts";
import type {
  ModelDescriptor,
  ModelScore,
  ModelScoreboardResponse,
  DriveState,
} from "@demesne/protocol";

type Snapshot = ReturnType<WorkspaceHost["snapshot"]>;
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
  disabled = false,
) =>
  `<button type="button"${disabled ? " disabled" : ""} class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;
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
const active = (run: WorkspaceRun) =>
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
  })[tool.name] ?? (tool.name === "heartbeat" ? HEARTBEAT_VERBS[String(tool.input.action)] ?? "Heartbeat" : tool.name.replaceAll("_", " "));
/// The heartbeat tool's actions, as the step rows name them.
const HEARTBEAT_VERBS: Record<string, string> = { send: "Send", inbox: "Inbox", agents: "Agents", approve: "Approve pairing", deny: "Deny pairing" };
const tools = (run: WorkspaceRun) =>
  run.entries.filter((entry): entry is ToolEntry => entry.type === "tool");
let state: Snapshot | null = null;
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
      run?: WorkspaceRun;
      views: Map<number, MarkdownView>;
    }
  >();
/// The briefing line's unfolded parts above the composer (on the start
/// screen, Drive's ideas under it); turns whose steps are open.
let driveShown = false,
  ideasShown = false;
let driveMissionDraft = "", driveContinuous = false, driveActionPending = "", driveActionError = "";
/// Drive's page fills the main column in place of the conversation.
let drivePageOpen = false, drivePageSignature = "";
const stepsOpen = new Set<string>();
/// Steps whose diff or output is unfolded in place, keyed run:tool.
const stepOpen = new Set<string>();
/// Review in the turn: the receipt's "N files changed" unfolds the turn's
/// diffs under the answer. A note on a line rides with the next message.
interface ReviewFile { path: string; rows: ReturnType<typeof codeDiff>["rows"]; added: number; removed: number; created: boolean }
const reviewOpen = new Set<string>(), reviewFiles = new Map<string, ReviewFile[] | { error: string } | "loading">();
const diffNotes = new Map<string, DiffNote>();
let noteEditing: { runId: string; path: string; side: "old" | "new"; line: number } | null = null, noteDraft = "", reviewVersion = 0;
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
/// The chat whose title is being renamed in place, in the sidebar.
let renaming: string | null = null;
/// Initially show six chats per project; Show more and search reveal the rest.
const SIDEBAR_ROWS = 6;
const expandedProjectChats = new Set<string>();
const projectOrder = new SidebarProjectOrder(
  document.getElementById("sidebar-sessions"),
  () => state ? [document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace, ...JSON.parse(document.getElementById("sidebar-sessions")?.dataset.projects ?? "[]")] : [],
  renderSidebar,
);
const projectDisclosure: Record<string, boolean> = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("demesne-project-disclosure") ?? "{}");
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch { return {}; }
})();
/// Conversations deleted from the sidebar, hidden at once while the daemon
/// archives them.
const deletedSessions = new Set<string>();
const ICON_BRANCH = '<svg class="ico sidebar-branch" viewBox="0 0 24 24" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
const ICON_TRASH = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';
/// Project groups hold their chats; worktree chats remain with their parent.
function renderSidebar() {
  const list = document.getElementById("sidebar-sessions");
  if (!state || !list || projectOrder.dragging) return;
  // While a title is being renamed, the list holds still under the cursor.
  if (renaming && list.querySelector(".sidebar-rename")) return;
  const query = (document.getElementById("sidebar-search") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  // A chat Drive runs on its own branch (a worktree) joins the list with a
  // branch mark; its branch is in the tooltip.
  const branches = new Map([state.breakage.fix, ...state.breakage.inbox].filter((job): job is NonNullable<typeof job> => Boolean(job?.sessionId)).map((job) => [job.sessionId!, job.branch] as const));
  const sessions = state.sessions.filter(item => !deletedSessions.has(item.id));
  const projectWorkspace = list.dataset.workspace || state.workspace;
  const projectPaths = projectOrder.paths();
  // Worktree chats stay with their parent project, alongside its review actions.
  const projectFor = (item: typeof sessions[number]) => branches.has(item.id) || item.id === state!.session?.id ? projectWorkspace : item.workspace;
  const review = reviewJobs(), pinned = pinnedMission(), run = worktreeRun(), word = driveWord();
  const ideas = state.driveNext.proposals.length;
  const waiting = state.approvals.length ? "approval" : state.questions.length ? "answer" : "";
  const signature = JSON.stringify([sessions, projectPaths, projectDisclosure, [...expandedProjectChats], [...deletedSessions], state.session?.id, state.session?.title, state.connection, state.activeTurnId, query, waiting, review.map((job) => [job.id, job.status, job.title, job.diff]), pinned && [pinned.status, pinned.mission, driveProgress(pinned)], run.fix?.status, run.away?.status, word, ideas, state.session?.workspace?.gitBranch, inSession(), [...branches], renaming, Math.floor(Date.now() / 60_000)]);
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;
  const current = state.session;
  const dot = (tone: string) => `<span class="sidebar-session-mark ${tone}" aria-hidden="true"></span>`;
  const focusedControl = document.activeElement instanceof HTMLButtonElement && list.contains(document.activeElement)
    ? { action: document.activeElement.dataset.action, args: document.activeElement.dataset.args } : null;
  const focusedRow = document.activeElement?.closest(".sidebar-item")?.querySelector(".sidebar-session");
  const focused = focusedRow ? [...list.querySelectorAll(".sidebar-session")].indexOf(focusedRow) : -1;
  // One line per chat: a dot for its state, its title, its time. The dot is
  // amber when the chat needs you, a spinner while it works, blue for a
  // branch of Drive's that waits for review (those sit on the Branches row).
  // The tooltip and the accessible name say in words what the dot shows.
  const row = (tone: string, title: string, selected: boolean, age: string, id: string, updatedAt: string) => {
    const about = STATE_WORDS[tone] ?? "", branch = branches.get(id);
    const tip = [title, about || fullTime(updatedAt), branch && `on ${branch}`].filter(Boolean).join(" · ");
    const mark = branch ? ICON_BRANCH : "";
    const project = projectFor(sessions.find(item => item.id === id)!);
    return btn(project === projectWorkspace ? "select-session" : "project-session", `${dot(tone)}<span class="sidebar-session-name">${h(title)}</span>${mark}${age ? `<span class="sidebar-session-age">${h(age)}</span>` : ""}`, { id, path: project }, `sidebar-session${selected ? " selected" : ""}`)
      .replace("<button ", `<button title="${h(tip)}" aria-label="${h(about ? `${title}, ${about}` : title)}"${project === projectWorkspace ? ' aria-keyshortcuts="Delete"' : ""}${selected ? ' aria-current="page"' : ""} `);
  };
  const groups: string[] = [];
  for (const [index, path] of projectPaths.entries()) {
    const name = path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path;
    const projectMatches = Boolean(query) && path.toLowerCase().includes(query);
    const projectSessions = sessions.filter(item => projectFor(item) === path);
    const matching = projectSessions.filter(item => projectMatches || item.title.toLowerCase().includes(query));
    if (query && !projectMatches && !matching.length) continue;
    const expanded = Boolean(query) || (projectDisclosure[path] ?? path === projectWorkspace);
    const rows: string[] = [];
    let shown = 0, more = 0;
    // Search reveals every match; each project can also expand its full history.
    const limit = query || expandedProjectChats.has(path) ? Infinity : SIDEBAR_ROWS;
    for (const item of matching) {
      if (shown >= limit) { if (item.turns) more++; continue; }
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
      const remove = working || path !== projectWorkspace ? "" : btn("delete-session", ICON_TRASH, { id: item.id }, "sidebar-delete").replace("<button ", `<button title="Delete" aria-label="Delete ${h(title)}" tabindex="-1" `);
      if (renaming === item.id) {
        rows.push(`<div class="sidebar-item"><form class="sidebar-rename" data-id="${h(item.id)}">${dot(tone)}<input name="title" value="${h(title)}" maxlength="200" aria-label="Rename ${h(title)}" autocomplete="off"></form></div>`);
        shown++;
        continue;
      }
      rows.push(`<div class="sidebar-item">${row(tone, title, selected, tone || (selected && !inSession()) ? "" : shortAge(item.updatedAt), item.id, item.updatedAt)}${remove}</div>`);
      shown++;
    }
    if (more && !query) rows.push(btn("project-more", `Show ${more} more`, { path }, "sidebar-more"));
    else if (!query && expandedProjectChats.has(path) && shown > SIDEBAR_ROWS) rows.push(btn("project-more", "Show fewer", { path }, "sidebar-more"));
    const toggle = btn("project-toggle", '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>', { path }, "sidebar-project-toggle")
      .replace("<button ", `<button aria-label="${h(`${expanded ? "Collapse" : "Expand"} ${name}`)}" aria-expanded="${expanded}" aria-controls="project-chats-${index}"${query ? " disabled" : ""} `);
    const label = btn("project-open", `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/></svg><span>${h(name)}</span>`, { path }, "sidebar-project-name")
      .replace("<button ", `<button draggable="true" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="${h(path)} · Drag to reorder (Alt+↑/↓)"${path === projectWorkspace ? ' aria-current="location"' : ""} `);
    groups.push(`<section class="sidebar-project${path === projectWorkspace ? " active" : ""}" data-project="${h(path)}"><div class="sidebar-project-header">${toggle}${label}</div><div class="sidebar-project-chats" id="project-chats-${index}"${expanded ? "" : " hidden"}>${rows.length ? rows.join("") : '<p class="sidebar-empty">No chats yet</p>'}</div></section>`);
  }
  list.innerHTML = groups.length ? groups.join("") : '<p class="sidebar-empty">No matching conversations or projects</p>';
  const editing = list.querySelector<HTMLInputElement>(".sidebar-rename input");
  if (editing && document.activeElement !== editing) { editing.focus(); editing.select(); }
  // A redraw keeps keyboard focus where it was, or on the row that moved up.
  if (focusedControl && !editing) {
    const sameControl = [...list.querySelectorAll<HTMLButtonElement>("button")].find(button =>
      button.dataset.action === focusedControl.action && button.dataset.args === focusedControl.args && !button.closest("[hidden]"));
    const buttons = [...list.querySelectorAll<HTMLElement>(".sidebar-session")].filter(button => !button.closest("[hidden]"));
    (sameControl ?? (focused >= 0 ? buttons[Math.min(focused, buttons.length - 1)] : null) ?? document.getElementById("sidebar-search"))?.focus({ preventScroll: true });
  }
  const title = document.getElementById("workspace-title");
  if (title) { title.textContent = drivePageOpen ? "Drive" : inSession() ? current?.title ?? "Conversation" : "New chat"; title.title = title.textContent; }
  // Under the project's name: its folder and branch, and the connection
  // only when it is not there.
  const sub = document.getElementById("desktop-project-sub");
  if (sub) {
    const branch = state.session?.workspace?.gitBranch ?? "";
    const link = state.connection === "online" ? "" : state.connection === "connecting" ? "connecting…" : "offline";
    sub.textContent = [state.workspace.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~"), branch, link].filter(Boolean).join(" · ");
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
  // Chats that need you: the rail's chats icon wears the amber ring, and
  // the Dock icon counts them.
  const needsYou = sessions.filter((item) => item.id === current?.id ? Boolean(waiting) : item.waiting).length;
  if (badge) badge.hidden = !needsYou;
  document.dispatchEvent(new CustomEvent("demesne:needs-you", { detail: needsYou }));
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
  const rows = [...document.querySelectorAll<HTMLElement>("#sidebar-sessions .sidebar-session")].filter(row => !row.closest("[hidden]"));
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
  const ids = [...document.querySelectorAll<HTMLElement>('#sidebar-sessions .sidebar-session[data-action="select-session"]')].filter(row => !row.closest("[hidden]")).map((row) => JSON.parse(row.dataset.args ?? "{}").id as string).filter(Boolean);
  if (!ids.length) return undefined;
  const at = ids.indexOf(state?.session?.id ?? "");
  return ids[at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length];
}
// Double-click a title to rename it in place: Enter or leaving the field
// keeps it, Escape puts it back.
// The first click opens the chat and redraws the row, so the second click
// may not complete on the same element: the second press starts the rename.
document.getElementById("sidebar-sessions")?.addEventListener("mousedown", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>(".sidebar-session");
  if (!button || button.dataset.action !== "select-session" || event.detail < 2 || event.button !== 0) return;
  event.preventDefault();
  renaming = JSON.parse(button.dataset.args ?? "{}").id ?? null;
  renderSidebar();
}, true);
function endRename(save: boolean) {
  const form = document.querySelector<HTMLFormElement>(".sidebar-rename");
  const id = renaming, title = form?.querySelector("input")?.value.trim() ?? "";
  renaming = null;
  sidebarSignature = "";
  renderSidebar();
  const was = state?.sessions.find((item) => item.id === id)?.title;
  if (save && id && title && title !== was) void act(() => api("rename", { id, title }));
}
document.getElementById("sidebar-sessions")?.addEventListener("submit", (event) => { event.preventDefault(); endRename(true); });
// A press anywhere else keeps the new title. Focus taken by the app itself
// (the composer, as the chat opens) goes back to the field.
document.addEventListener("pointerdown", (event) => {
  if (renaming && !(event.target as HTMLElement).closest(".sidebar-rename")) endRename(true);
}, true);
document.getElementById("sidebar-sessions")?.addEventListener("focusout", (event) => {
  const form = (event.target as HTMLElement).closest(".sidebar-rename");
  if (!form || !renaming) return;
  const next = (event as FocusEvent).relatedTarget as HTMLElement | null;
  if (next?.matches("textarea")) setTimeout(() => { if (renaming && form.isConnected) form.querySelector("input")?.focus(); });
  else if (next) endRename(true);
});
document.getElementById("sidebar-sessions")?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (event.target as HTMLElement).closest(".sidebar-rename")) { event.preventDefault(); event.stopPropagation(); endRename(false); }
}, true);
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
/// What changed since the last commit, from the workspace file list.
function workingChanges() {
  const files = state?.files.filter((file) => file.status) ?? [];
  return { files: files.length, added: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), removed: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) };
}
/// The top bar's branch, with what changed since the last commit. With
/// changes it is a button: one click asks for a commit and a PR, as a turn.
function branchChip() {
  const branch = state?.session?.workspace?.gitBranch;
  if (!branch) return "";
  const changes = workingChanges();
  if (!changes.files) return `<span class="chip">⎇ ${h(branch)}</span>`;
  const tip = `${changes.files === 1 ? "1 file" : `${changes.files} files`} changed · click to commit and open a PR`;
  return `<button type="button" class="chip ship" data-action="ship" title="${h(tip)}">⎇ ${h(branch)}<span class="plus">+${changes.added}</span><span class="minus">−${changes.removed}</span></button>`;
}
const SHIP_PROMPT = "Commit these changes, push the branch, and open a pull request. If this is the default branch, make a new branch for them first.";
/// The context ring's breakdown, unfolded above it until Esc or a click away.
let contextCardOpen = false;
function renderContextCard() {
  const card = el("context-card"), ring = el("composer-context");
  const c = context(), plan = state?.provider?.contextPlan;
  const open = contextCardOpen && inSession() && c.percentage != null;
  ring.setAttribute("aria-expanded", String(open));
  ring.classList.toggle("on", open);
  card.hidden = !open;
  if (!open) return;
  const capacity = c.capacity ?? 0;
  const parts = plan
    ? [
        { name: "Conversation", tokens: plan.estimatedMessageTokens, tone: "a" },
        { name: "Tools", tokens: plan.estimatedToolDefinitionTokens, tone: "b" },
        { name: "Kept free for replies", tokens: plan.reserves.totalTokens ?? 0, tone: "c" },
      ]
    : [{ name: "Conversation", tokens: c.used ?? 0, tone: "a" }];
  const free = Math.max(0, capacity - parts.reduce((sum, part) => sum + part.tokens, 0));
  const share = (tokens: number) => (capacity ? (tokens / capacity) * 100 : 0);
  card.innerHTML = `<div class="context-head"><span>Context</span><span>${c.percentage}% · ${c.estimated ? "~" : ""}${tokensShort(c.used ?? 0)} of ${capacity ? tokensShort(capacity) : "—"}</span></div><div class="context-bar">${parts.map((part) => `<i class="tone-${part.tone}" style="width:${share(part.tokens).toFixed(2)}%"></i>`).join("")}</div><div class="context-legend">${[...parts, { name: "Free", tokens: free, tone: "free" }].filter((part) => part.tokens > 0).map((part) => `<u class="tone-${part.tone}"></u><span>${part.name}</span><em>${tokensShort(part.tokens)}</em>`).join("")}</div>${btn("compact", state!.activeTurnId ? "Compact after this turn" : "Compact now", {}, "link context-compact")}`;
}
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
    workingChanges(),
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
  el("composer-model").innerHTML = `${h(state.model.displayName ?? state.model.id) || "Choose a model"}${state.reasoning ? `<span class="composer-effort">${h(state.reasoning[0]!.toUpperCase() + state.reasoning.slice(1))}</span>` : ""}`;
  el("composer-context").innerHTML = c2;
  el("composer-context").title = c.percentage == null ? "" : `${num(c.used)} of ${num(c.capacity)} · ${c.percentage}% of the context used`;
  el("composer-context").hidden = !inSession() || !c2;
  renderContextCard();
  el("status").innerHTML =
    `${working ? `<span class="state">${spinner()}</span>` : phase === "ready" ? "" : `<span class="state ${phase === "failed" ? "danger" : phase === "approval" || phase === "waiting" ? "amber" : ""}"><img src="assets/${phase === "approval" || phase === "waiting" ? "activity-dot" : "ready-dot"}.svg" width="8" height="8" alt="">${h(phase)}</span>`}<span>${h((state.model.displayName ?? state.model.id) || "Connecting…")}${state.reasoning ? `<span class="muted"> · ${h(state.reasoning)}</span>` : ""}</span><div class="spacer"></div><div class="context">${c.percentage == null ? "<span>ctx —</span>" : `<div class="meter"><i style="--usage:${Math.min(100, c.percentage)}%"></i></div><span>${num(c.used)} · ${c.percentage}%</span>`}</div>${inSession() ? "" : btn("overlay", `${k("Tab")} settings`, { name: "settings" }, "key-action") + btn("insert-command", `${k("Ctrl+K")} commands`, {}, "key-action")}`;
  // The top bar carries the session's branch and ⋯, which opens the
  // session's own view (rename, compact, history). The sidebar shows what
  // needs you; Drive lives in its footer.
  el("header").innerHTML =
    `<div class="header-state">${branchChip()}</div>${inSession() ? btn("overlay", "⋯", { name: "session" }, `header-more${overlay === "session" ? " active" : ""}`).replace("<button ", '<button title="This conversation" aria-label="This conversation" ') : ""}`;
}
function totals(run: WorkspaceRun, tool: ToolEntry) {
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
function toolTarget(run: WorkspaceRun, tool: ToolEntry) {
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
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
const stepIcon = (tool: ToolEntry) => {
  const kind = tool.name === "run_command" ? "run"
    : tool.phase === "change" ? "edit"
    : tool.name === "search_files" ? "search"
    : tool.name === "list_files" ? "list"
    : tool.name === "subagent" ? "agent"
    : tool.name === "ask_user" ? "ask"
    : tool.name === "heartbeat" ? "mail"
    : ["read_file", "read_files", "view_image", "git_diff", "git_status", "git_history"].includes(tool.name) ? "read"
    : "other";
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${STEP_ICONS[kind]}</svg>`;
};
const ICON_SPARK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';
const ICON_COPY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_UNDO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const CHEVRON = '<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
/// Whether a step has something to unfold: an edit's diff, a command's output.
const foldable = (tool: ToolEntry) =>
  (tool.phase === "change" && tool.state !== "running" && !tool.drafting && (Boolean(tool.changes?.length) || Boolean(tool.diff))) ||
  (tool.name === "run_command" && !tool.waiting && !tool.drafting && Boolean(tool.toolCallId));
function toolRow(run: WorkspaceRun, tool: ToolEntry) {
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
  ).replace("<button ", `<button aria-expanded="${canFold ? open : "false"}" `);
  return row + (open && canFold ? stepFold(run, tool) : "");
}
/// What unfolds under a step: the edit's diff with a little context, or
/// the command's recorded output (its tail), loaded when first opened.
function stepFold(run: WorkspaceRun, tool: ToolEntry) {
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
function subagentTrace(run: WorkspaceRun, tool: ToolEntry, key: string) {
  if (tool.name !== "subagent" || !tool.trace?.length) return "";
  const live = tool.state === "running";
  const steps = tool.trace.filter((segment) => segment.kind === "step").length;
  const body = tool.trace.map((segment) => segment.kind === "step"
    ? `<div class="muted">→ ${h(segment.text)}</div>`
    : `<p>${h(segment.text.trim())}</p>`).join("");
  return `<details class="thinking ${live ? "live" : ""}" data-detail="${key}:trace"${(live && !detailsClosed.has(`${key}:trace`)) || detailsOpen.has(`${key}:trace`) ? " open" : ""}><summary>◇ Sub-agent trace · ${steps} step${steps === 1 ? "" : "s"}</summary><div>${body}</div></details>`;
}
function runHTML(run: WorkspaceRun, index: number) {
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
  // Completed traces fold into the receipt. While streaming, show the full
  // latest trace unless the reader explicitly collapses it.
  const live = active(run), fold = run.status === "completed" && !stepsOpen.has(run.id);
  let body = "", steps = "";
  const flush = () => { if (steps) { body += `<div class="steps">${steps}</div>`; steps = ""; } };
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i]!,
      key = `${run.id}:${entry.id}`;
    if (entry.type === "assistant") {
      flush();
      body += `<div class="answer"><span class="answer-mark" aria-hidden="true">d.</span><div class="markdown" data-answer="${h(run.id)}" data-entry="${entry.id}"></div></div>`;
    }
    if (fold && (entry.type === "reasoning" || entry.type === "tool")) continue;
    if (entry.type === "reasoning") {
      flush();
      const live = active(run) && i === run.entries.length - 1;
      const open = detailsOpen.has(key) || (live && !detailsClosed.has(key));
      body += `<div class="thinking thinking-main ${live ? "live" : ""}"><button type="button" class="thinking-toggle" data-action="toggle-thinking" data-args="${h(JSON.stringify({id:key}))}" aria-expanded="${open}" aria-controls="thinking-body-${h(key)}">${live ? spinner() : CHEVRON}${live ? "Thinking" : `Thought for ${duration(entry.durationMs)}`}<span class="thinking-disclosure">${open ? "Collapse" : "Show trace"}</span></button><div class="thinking-content" id="thinking-body-${h(key)}"${open ? "" : " hidden"}>${thinkingBody(entry.raw)}</div></div>`;
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
      files ? btn("review-turn", `${files === 1 ? "1 file changed" : `${files} files changed`} ${counts(total)}${CHEVRON}`, { id: run.id }, `receipt-files${reviewOpen.has(run.id) ? " open" : ""}`).replace("<button ", `<button aria-expanded="${reviewOpen.has(run.id)}" title="${h(paths.join("\n"))}" `) : "",
      checks.length ? `<span class="receipt-checks ${passed ? "success" : failed ? "danger" : ""}" title="${h(checks.map((check) => check.detail ?? check.name).join("\n"))}">${passed ? "checks passed" : failed ? "checks failed" : stopped ? "checks stopped" : "checks unknown"}</span>` : "",
      run.status === "completed" && (steps || thought)
        ? btn("toggle-steps", fold ? (steps ? `${steps} step${steps === 1 ? "" : "s"}` : "thinking") : "hide steps", { id: run.id }, "receipt-steps")
        : "",
      receipt?.mode === "Plan" || run.planOnly ? "plan" : "",
      mailReply(run),
    ].filter(Boolean);
    const answered = run.entries.some((e) => e.type === "assistant");
    const actions = [
      answered ? btn("copy-answer", `${ICON_COPY}Copy`, { id: run.id }, "receipt-action copy-answer") : "",
      files && !state!.activeTurnId ? btn("undo-turn", `${ICON_UNDO}Undo changes`, { id: run.id }, "receipt-action") : "",
    ].filter(Boolean).join("");
    // A turn that only answered needs no receipt: its time is on the ask.
    const bare = run.status === "completed" && !files && !checks.length && !steps && !thought && !(receipt?.mode === "Plan" || run.planOnly) && !model && !mailReply(run);
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
  const attached = run.attachments?.length
    ? `<div class="request-att">${run.attachments.map((image) => attachmentPreviews.has(image.id)
      ? `<img src="${attachmentPreviews.get(image.id)}" alt="${h(image.filename)}" title="${h(image.filename)}">`
      : `<span class="att-name" title="${h(`${image.width}×${image.height}`)}">${h(image.filename)}</span>`).join("")}</div>` : "";
  const request = mailRequest(run) ?? `${attached}<div class="request"><span class="text">${h(run.content)}</span><span class="request-meta">${asks}<time>${clock(run.createdAt).slice(0, 5)}</time></span></div>`;
  const review = reviewOpen.has(run.id) && !live ? reviewHTML(run.id) : "";
  return `${request}<div class="response ${live ? "running" : run.status === "failed" ? "failed" : ""}">${body}${trail}${footer}${review}${activity}</div>${queued}`;
}
/// The turn's changed files under its receipt: a header line per file, its
/// changes with a little context, and the notes left on its lines.
function reviewHTML(runId: string) {
  const files = reviewFiles.get(runId);
  if (!files || files === "loading") return '<div class="turn-review"><p class="rv-status">Loading the changes…</p></div>';
  if (!Array.isArray(files)) return `<div class="turn-review"><p class="rv-status danger">Couldn’t load the changes: ${h(files.error)}</p></div>`;
  if (!files.length) return '<div class="turn-review"><p class="rv-status">These changes are no longer in the files.</p></div>';
  const blocks = files.map((file) => {
    const lines = reviewRows(file.rows).map((row) => {
      if (row.kind === "gap") return `<div class="rv-gap">${h(row.text)}</div>`;
      const side = row.kind === "removed" ? "old" : "new", line = (side === "old" ? row.old : row.next) ?? 0;
      const key = noteKey(file.path, side, line), note = diffNotes.get(key);
      const editing = noteEditing?.runId === runId && noteKey(noteEditing.path, noteEditing.side, noteEditing.line) === key;
      const args = { id: runId, path: file.path, side, line };
      const mark = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : "";
      const cell = btn("note-line", `<span class="no">${line}</span><span class="mk">${mark}</span><span class="code">${h(row.text) || " "}</span>`, args, `rv-l ${row.kind === "added" ? "ad" : row.kind === "removed" ? "rm" : ""}${note ? " noted" : ""}`).replace("<button ", `<button title="Leave a note on line ${line}" `);
      const noteRow = editing
        ? `<div class="rv-note editing"><input id="rv-note-input" value="${h(noteDraft)}" aria-label="Note on line ${line}" placeholder="Note on line ${line} · Enter to keep, Esc to drop" autocomplete="off" spellcheck="true"></div>`
        : note ? btn("note-line", h(note.text), args, "rv-note").replace("<button ", '<button title="Edit this note" ') : "";
      return cell + noteRow;
    }).join("");
    return `<div class="rv-file"><div class="rv-head"><code>${h(file.path)}</code>${file.added ? `<span class="add">+${file.added}</span>` : ""}${file.removed ? `<span class="del">−${file.removed}</span>` : ""}${file.created ? '<span class="rv-new">new</span>' : ""}</div><div class="rv-diff">${lines || '<div class="rv-gap">no change</div>'}</div></div>`;
  });
  return `<div class="turn-review">${blocks.join("")}</div>`;
}
async function toggleReview(runId: string) {
  if (reviewOpen.delete(runId)) {
    if (noteEditing?.runId === runId) noteEditing = null;
    reviewVersion++;
    return renderConversation();
  }
  reviewOpen.add(runId);
  reviewFiles.set(runId, "loading");
  reviewVersion++;
  renderConversation();
  try {
    const review = await api("changes", { scope: "turn", turnId: runId }) as { files: { path: string; rows: ReviewFile["rows"]; added: number; removed: number; beforeExists?: boolean }[] };
    reviewFiles.set(runId, review.files.map((file) => ({ path: file.path, rows: file.rows, added: file.added, removed: file.removed, created: file.beforeExists === false })));
  } catch (error) {
    reviewFiles.set(runId, { error: error instanceof Error ? error.message : String(error) });
  }
  reviewVersion++;
  renderConversation();
}
function editNote(runId: string, path: string, side: "old" | "new", line: number) {
  if (noteEditing) saveNote();
  noteEditing = { runId, path, side, line };
  noteDraft = diffNotes.get(noteKey(path, side, line))?.text ?? "";
  reviewVersion++;
  renderConversation();
  const input = document.getElementById("rv-note-input") as HTMLInputElement | null;
  input?.focus({ preventScroll: true });
  input?.setSelectionRange(input.value.length, input.value.length);
}
/// Enter or leaving the field keeps the note; an empty note removes it.
function saveNote(keep = true) {
  if (!noteEditing) return;
  const { path, side, line } = noteEditing, key = noteKey(path, side, line);
  noteEditing = null;
  if (keep && noteDraft.trim()) diffNotes.set(key, { path, side, line, text: noteDraft.trim() });
  else if (keep) diffNotes.delete(key);
  noteDraft = "";
  reviewVersion++;
  renderConversation();
  renderComposer();
}
const ICON_MAIL = '<svg class="ico mail-mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
/// Mail from another agent sits where a typed ask sits, since it is one, but
/// its bubble takes the accent surface and opens with who sent it and what
/// kind of message it is, so a scroll never mistakes it for your words. It
/// has no edit or retry: the words are the sender's.
function mailRequest(run: WorkspaceRun): string | null {
  const mail = parseMailTurn(run.content);
  if (!mail) return null;
  const senders = mail.messages.map((message) => message.from.replace(/^[^@]*@/, "")).filter(Boolean);
  const lines = mail.messages.map((message) =>
    `<span class="mail-from">${ICON_MAIL}<code class="mail-address" title="${h(message.from || "unknown sender")}">${h(message.from || "unknown sender")}</code><span class="mail-kind" title="${message.authority === "owner" ? "relayed by your own agent" : "from another agent"}">${h(message.performative)}${message.authority === "owner" ? " · owner" : ""}</span></span><span class="text">${h(message.text)}</span>`);
  for (const pair of mail.pairRequests) lines.push(`<span class="mail-from">${ICON_MAIL}<code class="mail-address">${h(pair.requester)}</code><span class="mail-kind">pairing</span></span><span class="text">${h(pair.node)} asks to pair with this machine.</span>`);
  return `<div class="request mail" title="Heartbeat mail to ${h(mail.address)}">${lines.join("")}<span class="request-meta"><time>${clock(run.createdAt).slice(0, 5)}</time></span></div>`;
}
/// "replied to claude@macbook": where a mail turn's answer went, for its
/// receipt. A send that answers nobody in particular still counts.
function mailReply(run: WorkspaceRun): string {
  const sent = run.entries.filter((entry): entry is ToolEntry => entry.type === "tool" && entry.name === "heartbeat" && entry.input.action === "send" && entry.state === "done");
  const to = [...new Set(sent.map((tool) => String(tool.input.to ?? "").replace(/\/[^/]*$/, "")).filter(Boolean))];
  return to.length ? `replied to <span class="mail-address">${h(to.join(", "))}</span>` : "";
}
/** Whole seconds since a moment, for clocks that tick in place. */
const elapsed = (since: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
/// A running turn's steps as one line: the last few, what runs now, and how
/// long the turn has run; the step count opens the full rows.
function stepTrail(run: WorkspaceRun, items: ToolEntry[]) {
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
  run: WorkspaceRun,
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
      reviewOpen.has(run.id) ? reviewVersion : 0,
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
    ? `<p>${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review ›`, {}, "link")}<span class="muted"> · ${away && away.status !== "running" ? "Drive ran them while you were away" : "each in its own worktree"}</span></p>`
    : "";
  // A greeting and the composer, nothing else: Drive's best idea is the
  // composer's ghost text (Tab takes it); the rest of its ideas unfold from
  // one quiet line under the composer.
  const day = new Date().toLocaleDateString(undefined, { weekday: "long" }),
    when = `${day} ${hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}`,
    where = branch ? `${h(name)} on ${h(branch)}` : h(name);
  const ideas = next.proposals.length;
  const drive = ideas || driveBusy
    ? `<p class="hero-drive">${ICON_SPARK}<b>Drive</b>${driveBusy ? " is working" : ` has ${ideas} idea${ideas === 1 ? "" : "s"}`}${ideas ? ` <span class="muted">·</span> ${btn("ideas-show", ideasShown ? "hide" : "show ›", {}, "link")}` : ""}${ideas > 1 && !driveBusy ? ` <span class="muted">·</span> ${btn("next-away", `Run ${ideas === 2 ? "both" : `all ${Math.min(3, ideas)}`} overnight ›`, { count: Math.min(3, ideas) }, "link")}` : ""}</p>${ideas && ideasShown ? `<div class="hero-ideas">${proposalRows(next.proposals)}<p class="proposals-footer">${btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", next.loading)}${next.generatedAt ? `<span class="muted"> · looked ${age(next.generatedAt)}</span>` : ""}</p></div>` : ""}`
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
      return `<div class="proposal-row" title="${h(why)}"><span class="next-kind kind-${item.kind}">${item.kind.toUpperCase()}</span><b>${h(item.title)}</b><small>~${minutes(item.expectedMinutes ?? item.minutes)}</small>${btn("next-run", "Run", { id: item.id }, "primary", Boolean(driveActionPending))}${btn("next-plan", "Plan", { id: item.id }, "", Boolean(driveActionPending))}${btn("next-snooze", "Not now", { id: item.id }, "quiet proposal-snooze", Boolean(driveActionPending))}</div>`;
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
/// Images for the next message: previews stay here, the host holds the
/// uploaded artifacts.
const attachmentPreviews = new Map<string, string>();
const ATTACHABLE = ["image/png", "image/jpeg", "image/webp"];
async function attachFiles(files: File[]) {
  const images = files.filter((file) => ATTACHABLE.includes(file.type));
  if (images.length < files.length) notice("Only PNG, JPEG and WebP images can be attached.");
  for (const file of images) {
    if (file.size > 20 * 1024 * 1024) { notice(`${file.name} is over 20 MB.`); continue; }
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const image = await api("attach", { name: file.name || "pasted-image.png", mimeType: file.type, data: url.slice(url.indexOf(",") + 1) }) as { id: string } | undefined;
    if (image?.id) { attachmentPreviews.set(image.id, url); composerSignature = ""; renderComposer(); renderConversation(); }
  }
}
type Mode = "ask" | "edits" | "plan" | "auto";
const MODES: Record<Mode, string> = { ask: "Ask", edits: "Accept edits", plan: "Plan", auto: "Auto" };
const MODE_HELP: Record<Mode, string> = {
  ask: "Every edit and command asks first",
  edits: "File edits run without asking; commands and deletes still ask",
  plan: "Reads and proposes a plan; changes nothing",
  auto: "Edits and commands run without asking",
};
function currentMode(): Mode {
  return state?.planOnly ? "plan" : state?.session?.autoApprove ? "auto" : state?.session?.acceptEdits ? "edits" : "ask";
}
let modeHintTimer: ReturnType<typeof setTimeout> | undefined;
/** Steps to the next mode and names all four for a moment above the composer. */
async function cycleMode(step = 1) {
  const order = Object.keys(MODES) as Mode[];
  const next = order[(order.indexOf(currentMode()) + step + order.length) % order.length]!;
  const hint = el("mode-hint");
  hint.innerHTML = order.map((mode) => mode === next ? `<b class="mode-${mode}">${MODES[mode]}</b>` : MODES[mode]).join(" · ");
  hint.hidden = false;
  clearTimeout(modeHintTimer);
  modeHintTimer = setTimeout(() => { hint.hidden = true; }, 1600);
  if (state?.session) await api("permission-mode", { mode: next });
  else await api("mode", { planOnly: next === "plan" });
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
    state.session?.acceptEdits,
    state.planOnly,
    answeringQuestion,
    driveSuggestion(),
    diffNotes.size,
    state.attachments.map((image) => image.id).join(),
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
  // The mode word says how this chat's edits and commands are gated; a
  // click or ⇧⇥ steps to the next mode.
  const mode = currentMode(), chip = el("composer-mode");
  chip.className = `cb mode-${mode}`;
  chip.innerHTML = `${MODES[mode]}<kbd>⇧⇥</kbd>`;
  chip.title = `${MODE_HELP[mode]}. Click or ⇧⇥ for the next mode.`;
  form.classList.toggle("mode-plan", mode === "plan");
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
  const draft = Boolean(editor.value.trim()) || diffNotes.size > 0 || state.attachments.length > 0, session = inSession();
  const attachRow = el("attach-row");
  attachRow.hidden = !state.attachments.length || Boolean(question);
  attachRow.innerHTML = state.attachments.map((image) => {
    const preview = attachmentPreviews.get(image.id);
    return `<span class="att" title="${h(`${image.filename} · ${image.width}×${image.height}`)}">${preview ? `<img src="${preview}" alt="${h(image.filename)}">` : `<span class="att-name">${h(image.filename)}</span>`}${btn("detach", "×", { id: image.id }, "att-x").replace("<button ", `<button aria-label="Remove ${h(image.filename)}" `)}</span>`;
  }).join("");
  // While a turn runs the send button is Stop; Enter queues what you type.
  el("send-label").innerHTML = question ? "answer" : state.activeTurnId
    ? armed ? `Press ${k("Esc")} again to stop` : `${draft ? `<span class="queue-hint">${k("Enter")} ${asking ? "send instead" : "queue"}</span>` : ""}<span class="stop-word">■ Stop</span>`
    : "send";
  // The send mark sits in the box's corner, faint until there is something
  // to send; while a turn runs it is Stop.
  const send = form.querySelector<HTMLButtonElement>(".send")!;
  send.hidden = Boolean(question) && !draft;
  send.setAttribute("aria-label", state.activeTurnId && !question ? "Stop" : "Send");
  form.classList.toggle("has-draft", draft);
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
  const notes = diffNotes.size && !question ? btn("notes-clear", `${diffNotes.size} note${diffNotes.size === 1 ? "" : "s"} on the changes ×`, {}, "chip notes-chip").replace("<button ", '<button title="Sent with your next message. Click to drop them." ') : "";
  el("mention-chips").innerHTML = notes + [...new Set(mentions)]
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
  const close = (action: string, label: string) => btn(action, "×", {}, "breakage-close").replace("<button ", `<button aria-label="${label}" `);
  const doing = (action: string, label: string, idle: string) => (busy === action ? label : idle);
  if (message) {
    cards.push(`<div class="breakage-card toast ${message.tone}"><div class="breakage-head"><span class="breakage-mark">${message.tone === "ok" ? "✓" : "!"}</span><span class="breakage-text">${h(message.text)}</span>${message.url ? btn("breakage-open", "Open ›", {}, "link") : ""}${close("breakage-close", "Dismiss")}</div></div>`);
  }
  if (signals.length) {
    const running = fix && ["starting", "running"].includes(fix.status);
    cards.push(`<div class="breakage-card alert"><div class="breakage-head"><span class="breakage-mark">✕</span><span class="breakage-text">${signals.length === 1 ? "Something just broke" : `${signals.length} things just broke`}</span>${close("breakage-dismiss", "Not now")}</div><ul class="breakage-list">${signals.map((signal) => `<li><b>${h(signal.title)}</b><span>${h(signal.detail.replace(/^Latest run exit (\S+) at \S+\.\s*/, "exit $1 · "))}</span></li>`).join("")}</ul><p class="breakage-note">${running ? `${fix.mission ? "A Drive mission is working in a worktree" : "A fix is already running"}; this one waits until it finishes.` : "Drive can fix it in a separate git worktree. Your files and this conversation stay as they are until you choose to apply it."}</p><div class="breakage-actions">${running ? "" : btn("breakage-fix", doing("fix", "Starting…", "▶ Fix in a worktree"), {}, "primary", Boolean(busy))}${btn("breakage-dismiss", "Not now", {}, "quiet")}${btn("breakage-never", "Never for this", {}, "quiet")}</div></div>`);
  }
  // A running mission shows on the briefing line; its card comes when it settles.
  const fixCard = (fix: NonNullable<Snapshot["breakage"]["fix"]>) => {
    const elapsed = duration((fix.finishedAt ? Date.parse(fix.finishedAt) : Date.now()) - Date.parse(fix.startedAt));
    const branch = `<code class="breakage-branch">${h(fix.branch)}</code>`;
    if (fix.status === "starting" || fix.status === "running") {
      if (!running || (fix.mission && driveTurnMission())) return;
      const activity = fix.activity ? `${fix.activity.steps} step${fix.activity.steps === 1 ? "" : "s"}${fix.activity.last ? ` · ${h(fix.activity.last)}` : ""}` : "Creating the worktree…";
      cards.push(`<div class="breakage-card running"><div class="breakage-head"><span class="breakage-mark breakage-pulse">◌</span><span class="breakage-text">${fix.proposal ? "Working in a worktree" : "Fixing in a worktree"}</span><small>${elapsed}</small></div><p class="breakage-title">${h(fix.title)}</p><div class="breakage-meta">${branch}<span>${activity}</span></div><div class="breakage-actions">${btn("breakage-discard", doing("discard", "Stopping…", "Stop and discard"), { id: fix.id }, "quiet", Boolean(busy))}</div></div>`);
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
      cards.push(`<div class="breakage-card ready compact"><div class="breakage-head"><span class="breakage-mark">✓</span><span class="breakage-text" title="${h(`${kind} on ${fix.branch}`)}">${h(fix.title)}</span><small${paths.length > 1 ? ` title="${h(paths.join("\n"))}"` : ""}>${where}</small></div><p class="breakage-summary">${fix.summary ? `${h(fix.summary)} ` : ""}${proof}</p><div class="breakage-actions">${btn("breakage-apply", doing("apply", "Applying…", "Apply"), { id: fix.id }, "primary", Boolean(busy)).replace("<button ", '<button title="Apply to my branch" ')}${btn("breakage-pr", doing("pr", "Opening…", "Open PR"), { id: fix.id }, "", Boolean(busy))}${btn("breakage-discard", doing("discard", "Discarding…", "discard"), { id: fix.id }, "quiet", Boolean(busy))}${fix.receipt ? btn("breakage-receipt", "copy receipt", { id: fix.id }, "quiet") : ""}${fix.sessionId ? btn("review-diff", "diff ›", { id: fix.sessionId }, "quiet breakage-diff") : ""}</div></div>`);
    } else if (fix.status === "failed") {
      cards.push(`<div class="breakage-card failed"><div class="breakage-head"><span class="breakage-mark">${(fix.proposal || fix.mission) && fix.unchanged ? "○" : "!"}</span><span class="breakage-text">${fix.proposal || fix.mission ? (fix.unchanged ? "Finished without changes" : "Couldn't finish it") : "Couldn't fix it"}</span><small>${elapsed}</small></div><p class="breakage-title">${h(fix.title)}</p><p class="breakage-summary">${h(fix.error ?? (fix.proposal || fix.mission ? "It failed." : "The fix failed."))}${fix.summary ? ` ${h(fix.summary)}` : ""}</p><div class="breakage-actions">${btn("breakage-discard", doing("discard", "Discarding…", "Discard the worktree"), { id: fix.id }, "quiet", Boolean(busy))}</div></div>`);
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
      ? `<div class="breakage-card away running"><div class="breakage-head"><span class="breakage-mark breakage-pulse">◌</span><span class="breakage-text">Working through Drive's list</span><small>${done} of ${away.items.length} done</small></div><ul class="away-list">${rows}</ul><div class="breakage-actions">${btn("breakage-away-stop", "Stop after this one", {}, "quiet", Boolean(busy))}</div></div>`
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
/// A strip along the top edge of the composer in a session: branches waiting
/// for review, and what Drive is doing or would do next. Its chevron grows
/// the box upward to show Drive's rows; closing folds them away again.
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
    driveShown, ideasShown, next.proposals, next.loading, next.generatedAt && age(next.generatedAt), driveActionPending,
  ]);
  if (signature === briefingSignature) return;
  briefingSignature = signature;
  const parts: string[] = [];
  const mark = (kind: "spin" | "idea" | "amber" | "ok") => kind === "spin" ? `<span class="bf-spin" aria-hidden="true"></span>` : `<span class="bf-dot ${kind}" aria-hidden="true"></span>`;
  let fold = "", toggle: { action: string; open: boolean } | null = null, progress: number | null = null;
  if (review.length) {
    const only = review.length === 1 ? review[0]! : null;
    const about = only && reviewShown ? "" : only ? `${only.title}${only.diff ? ` · +${only.diff.additions} −${only.diff.deletions}` : ""}` : away && away.status !== "running" ? "Drive ran them while you were away" : "";
    parts.push(`${mark("ok")}${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review`, {}, "bf-word")}${about ? `<span class="bf-about">${h(about)}</span>` : ""}`);
  }
  const label = (drive: NonNullable<Snapshot["drive"]>) => drive.status === "blocked" ? "Drive needs you" : drive.status === "paused" ? "Drive is paused" : "Drive is working";
  const driveMark = (drive: NonNullable<Snapshot["drive"]>) => mark(drive.status === "blocked" ? "amber" : drive.status === "paused" ? "idea" : "spin");
  if (pinned && driveTurnMission()) {
    // The mission is the conversation's newest turn; the strip only says how far it has got.
    const tasks = driveTaskList(pinned), done = tasks.filter((task) => task.mark === "✓").length;
    if (tasks.length > 1) progress = done / tasks.length;
    const about = driveProgress(pinned);
    parts.push(`${driveMark(pinned)}<b class="bf-word${pinned.status === "blocked" ? " amber" : ""}">${label(pinned)}</b>${about ? `<span class="bf-about">${h(about)}</span>` : ""}`);
  } else if (pinned) {
    const time = activeMinutes(pinned);
    parts.push(`${driveMark(pinned)}${btn("drive-show", label(pinned), {}, `bf-word${pinned.status === "blocked" ? " amber" : ""}`)}<span class="bf-about">${h(missionTitle(pinned))}${time ? ` · ${time}` : ""}</span>`);
    toggle = { action: "drive-show", open: driveShown };
    if (driveShown) fold = `<div class="drive-live">${pinnedCard(pinned)}</div>`;
  } else if (run.fix || run.away) {
    const about = run.fix ? run.fix.title : `Drive's list · ${run.away!.items.filter((item) => !["queued", "running"].includes(item.state)).length} of ${run.away!.items.length} done`;
    parts.push(`${mark("spin")}${btn("drive-show", "Drive is working", {}, "bf-word")}<span class="bf-about">${h(about)}</span>`);
  } else if (next.proposals.length) {
    const count = next.proposals.length;
    parts.push(`${mark("idea")}${btn("ideas-show", `Drive has ${count} idea${count === 1 ? "" : "s"}`, {}, "bf-word")}<span class="bf-about">for this project</span>`);
    toggle = { action: "ideas-show", open: ideasShown };
    if (ideasShown) {
      const words = ["", "it", "both", "all three"], overnight = Math.min(3, count);
      fold = `${ideaRows(next.proposals)}<p class="bf-foot">${[
        btn("next-away", `Run ${words[overnight]} overnight`, { count: overnight }, "link"),
        btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", next.loading),
        next.generatedAt ? `<span>looked ${age(next.generatedAt)}</span>` : "",
      ].filter(Boolean).join('<span class="bf-sep">·</span>')}</p>`;
    }
  }
  node.hidden = !inSession() || !parts.length;
  if (node.hidden) { node.innerHTML = ""; return; }
  const chevron = toggle ? btn(toggle.action, CHEVRON, {}, "bf-chev").replace("<button ", `<button aria-label="${toggle.open ? "Hide" : "Show"}" aria-expanded="${toggle.open}" `) : "";
  const strip = `<div class="bf-strip">${parts.map((part) => `<span class="bf-part">${part}</span>`).join('<span class="bf-sep">·</span>')}<span class="bf-sp"></span>${chevron}</div>${progress !== null ? `<div class="bf-progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ""}`;
  // The fold animates its height: opening renders it shut, then opens it on
  // the next frame; closing keeps what was showing until it has folded away.
  const open = Boolean(fold), previous = node.querySelector<HTMLElement>(".bf-fold"), wasOpen = Boolean(previous?.classList.contains("open"));
  if (!open && wasOpen && previous) {
    node.querySelector(".bf-head")!.innerHTML = strip;
    node.classList.remove("open");
    previous.classList.remove("open");
    setTimeout(() => { if (!previous.classList.contains("open")) previous.firstElementChild!.innerHTML = ""; }, 320);
    return;
  }
  node.innerHTML = `<div class="bf-head">${strip}</div><div class="bf-fold${open && wasOpen ? " open" : ""}"><div>${fold}</div></div>`;
  node.classList.toggle("open", open);
  if (open && !wasOpen) {
    const created = node.querySelector<HTMLElement>(".bf-fold")!;
    void created.offsetHeight;
    requestAnimationFrame(() => created.classList.add("open"));
  }
}
/// Drive's ideas as one line each: a hollow mark, the title, its time on the
/// right, which gives way to Run, Plan and Not now when you point at it.
function ideaRows(items: Snapshot["driveNext"]["proposals"]) {
  const signal = new Map(state!.driveNext.signals.map((item) => [item.id, item]));
  const minutes = (value: number) => (value < 60 ? `${value} min` : `${Math.round(value / 6) / 10} h`);
  return `<div class="bf-rows">${items.map((item) => {
    const evidence = item.evidence.map((id) => signal.get(id)?.title).find(Boolean);
    const why = [item.why, evidence && `Evidence: ${evidence}`].filter(Boolean).join("\n");
    const pending = Boolean(driveActionPending);
    return `<div class="bf-row" title="${h(why)}"><span class="bf-dot hollow" aria-hidden="true"></span><span class="bf-title">${h(item.title)}</span><span class="bf-r">~${minutes(item.expectedMinutes ?? item.minutes)}</span><span class="bf-act">${btn("next-run", "Run", { id: item.id }, "primary", pending)}${btn("next-plan", "Plan", { id: item.id }, "", pending)}${btn("next-snooze", "Not now", { id: item.id }, "", pending)}</span></div>`;
  }).join("")}</div>`;
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
  if (name === "settings") {
    void act(() => api("providers-refresh"));
    if (window.demesne.mode === "desktop")
      void api<{ zoom?: number }>("desktop-zoom").then((result) => {
        zoomLevel = typeof result?.zoom === "number" ? result.zoom : null;
        overlaySignature = "";
        renderOverlay();
      }, () => {});
  }
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
          `menu-row model-row ${selected ? "selected" : ""}`).replace("<button ", row.value ? `<button title="${h(row.value)}" ` : "<button ")
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
/// Settings is one sheet: sections down the left, under a search that finds
/// any setting, and the chosen section's rows on the right. Each row says
/// what it changes and carries its own control, so nothing opens a menu.
type SettingsRow = { title: string; description: string; control: string; keywords?: string };
const SETTINGS_SECTIONS: { id: string; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>' },
  { id: "appearance", label: "Appearance", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor"/>' },
  { id: "models", label: "Models", icon: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>' },
  { id: "providers", label: "Providers", icon: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8Z"/>' },
  { id: "conversations", label: "Conversations", icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>' },
];
let settingsSection = "general",
  /// The window's zoom, read from the desktop shell when Settings opens.
  zoomLevel: number | null = null;
const TEXT_SIZES: [string, number][] = [["Small", 0.9], ["Default", 1], ["Large", 1.1]];
function settingsToggle(on: boolean, action: string, data: Record<string, unknown>, label: string) {
  return `<button type="button" class="settings-toggle${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${h(label)}" data-action="${action}" data-args="${h(JSON.stringify(data))}"><i></i></button>`;
}
function settingsSegments(options: [string, boolean, string, Record<string, unknown>][], label: string) {
  return `<div class="settings-segments" role="group" aria-label="${h(label)}">${options.map(([text, on, action, data]) => `<button type="button" class="${on ? "on" : ""}" aria-pressed="${on}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${h(text)}</button>`).join("")}</div>`;
}
function settingsRows(section: string): SettingsRow[] {
  const s = state!;
  if (section === "general")
    return [
      {
        title: "Mode",
        description: "Plan reads and proposes without changing files. Build may edit. Applies to this conversation.",
        control: settingsSegments([["Build", !s.planOnly, "settings-set", { method: "mode", args: { planOnly: false } }], ["Plan", s.planOnly, "settings-set", { method: "mode", args: { planOnly: true } }]], "Mode"),
        keywords: "plan build read only edits",
      },
      ...(s.session
        ? [{
            title: "Auto-approve",
            description: "Skip permission prompts for edits, commands, deletions and publishing in this conversation. Plan stays read only.",
            control: settingsToggle(!!s.session.autoApprove, "settings-set", { method: "auto-approve", args: { autoApprove: !s.session.autoApprove } }, "Auto-approve"),
            keywords: "approvals permissions ask before edits",
          }]
        : []),
    ];
  if (section === "appearance") {
    const groups: [string, typeof s.themeOptions][] = [["Your themes", []], ["Dark", []], ["Light", []]];
    for (const name of s.themes) {
      const option = s.themeOptions.find((item) => item.name === name) ?? { name, label: name };
      const group = name.startsWith("custom-") ? 0 : /light|latte/.test(name) ? 2 : 1;
      groups[group]![1].push(option as (typeof s.themeOptions)[number]);
    }
    const select = `<div class="settings-select"><select id="settings-theme" aria-label="Theme">${groups.filter(([, items]) => items.length).map(([label, items]) => `<optgroup label="${h(label)}">${items.map((item) => `<option value="${h(item.name)}"${item.name === s.theme ? " selected" : ""}>${h(item.label ?? item.name)}</option>`).join("")}</optgroup>`).join("")}</select></div>`;
    return [
      {
        title: "Theme",
        description: "The palette for the whole app, saved on this device.",
        control: (s.themeCanUndo ? btn("settings-set", "Undo", { method: "theme-undo", args: {} }, "settings-link") : "") + select,
        keywords: "colour color dark light palette",
      },
      {
        title: "Make a theme",
        description: "Answer a few questions and Demesne builds a palette from your answers.",
        control: btn("settings-command", "Start", { text: "/themefy " }, "settings-button"),
        keywords: "themefy custom palette",
      },
      ...(window.demesne.mode === "desktop"
        ? [{
            title: "Text size",
            description: "The size of everything in the window. ⌘+ and ⌘− step through more sizes.",
            control: settingsSegments(TEXT_SIZES.map(([label, zoom]) => [label, zoomLevel === zoom, "settings-set", { method: "desktop-zoom", args: { zoom } }] as [string, boolean, string, Record<string, unknown>]), "Text size"),
            keywords: "zoom font scale",
          }]
        : []),
    ];
  }
  if (section === "models")
    return [
      {
        title: "Model",
        description: `${s.model.displayName ?? s.model.id}${s.model.provider ? ` from ${s.model.provider}` : ""}${s.reasoning ? `, ${s.reasoning} thinking` : ""}. This conversation uses it.`,
        control: btn("overlay", "Change", { name: "models" }, "settings-button"),
        keywords: "reasoning thinking effort",
      },
      ...(s.model.provider === "ChatGPT"
        ? [{
            title: "ChatGPT plan",
            description: `Usage counts against ${s.chatgptAccount?.email ?? s.chatgptAccount?.label ?? "your"} plan.`,
            control: btn("open-link", "Manage ↗", { url: "https://chatgpt.com/settings/usage" }, "settings-button"),
            keywords: "usage billing account",
          }]
        : []),
    ];
  if (section === "providers")
    return [
      ...s.providers.items.map((item) => {
        const signing = s.providers.signingIn === item.key;
        const action = signing ? "provider-cancel" : item.status === "signed-in" ? "provider-signout" : item.status === "signed-out" ? "provider-signin" : "";
        return {
          title: item.label,
          description: signing ? "Waiting for your browser…" : `${item.active ? "In use. " : ""}${item.detail}`,
          control: action ? btn(action, signing ? "Cancel" : item.status === "signed-in" ? "Sign out" : "Sign in", { key: item.key }, "settings-button") : "",
          keywords: "sign in account api key local",
        };
      }),
      {
        title: "Provider setup",
        description: s.providers.message ?? "Add a local model server, an API key, or an account.",
        control: btn("setup", "Open", {}, "settings-button"),
        keywords: "add provider configure",
      },
    ];
  const others = s.sessions.filter((item) => item.id !== s.session?.id).length;
  return [
    {
      title: "All conversations",
      description: `${s.sessions.length} in this project${others ? `, ${others} besides this one` : ""}.`,
      control: btn("overlay", "Show", { name: "sessions" }, "settings-button"),
      keywords: "sessions history chats",
    },
    {
      title: "Clean up",
      description: "Delete empty, quick and old conversations. You choose which before anything is deleted.",
      control: btn("overlay", "Review", { name: "cleanup" }, "settings-button"),
      keywords: "delete archive sessions",
    },
  ];
}
function renderSettings() {
  const query = overlayQuery.trim().toLowerCase();
  const rowHtml = (row: SettingsRow) => `<div class="settings-row"><div><b>${h(row.title)}</b><p>${h(row.description)}</p></div>${row.control ? `<div class="settings-control">${row.control}</div>` : ""}</div>`;
  const sections = query
    ? SETTINGS_SECTIONS.map((section) => ({ section, rows: settingsRows(section.id).filter((row) => `${section.label} ${row.title} ${row.description} ${row.keywords ?? ""}`.toLowerCase().includes(query)) })).filter((item) => item.rows.length)
    : [{ section: SETTINGS_SECTIONS.find((item) => item.id === settingsSection) ?? SETTINGS_SECTIONS[0]!, rows: settingsRows(settingsSection) }];
  const nav = SETTINGS_SECTIONS.map((section) => `<button type="button" class="settings-nav-item${!query && section.id === settingsSection ? " on" : ""}" data-action="settings-section" data-args="${h(JSON.stringify({ id: section.id }))}"${!query && section.id === settingsSection ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${section.icon}</svg>${h(section.label)}</button>`).join("");
  const body = sections.length ? sections.map(({ section, rows }) => `<section><h2>${h(section.label)}</h2>${rows.map(rowHtml).join("")}</section>`).join("") : `<p class="settings-empty">No setting matches “${h(overlayQuery)}”.</p>`;
  el("overlay").innerHTML =
    `<nav class="settings-nav" aria-label="Settings sections"><div class="settings-search"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="chooser-filter" placeholder="Search" aria-label="Search settings" value="${h(overlayQuery)}" autocomplete="off"></div><div class="settings-group">Settings</div>${nav}</nav><div class="settings-body">${btn("close-overlay", "×", {}, "dialog-close").replace("<button ", '<button aria-label="Close dialog" ')}${body}</div>`;
}
/// Drive's page: the sidebar's Drive row (or Alt+J) turns the main column
/// into Drive, and choosing a chat turns it back. No panel, no popup: each
/// control sits on the row it acts on.
function setDrivePage(open: boolean) {
  if (open === drivePageOpen) return;
  drivePageOpen = open;
  drivePageSignature = sidebarSignature = "";
  renderDrivePage();
  renderSidebar();
  if (open) document.getElementById("drive-mission")?.focus({ preventScroll: true });
  else editor.focus({ preventScroll: true });
}
/// Drive takes one piece of work at a time.
const driveBusy = () => Boolean(pinnedMission() || worktreeRun().fix || worktreeRun().away);
const driveCanStart = () => Boolean(driveMissionDraft.trim()) && !driveBusy() && !driveActionPending && state?.connection === "online";
const DRIVE_STATUS: Record<string, string> = { running: "Working", waiting: "Working", paused: "Paused", blocked: "Needs you", completed: "Done", stopped: "Stopped", idle: "Idle" };
function renderDrivePage() {
  if (!state) return;
  const page = el("drive-page");
  document.body.classList.toggle("drive-page-open", drivePageOpen);
  page.hidden = !drivePageOpen;
  for (const id of ["sidebar-drive", "rail-drive"]) {
    const button = document.getElementById(id);
    button?.classList.toggle("on", drivePageOpen);
    if (drivePageOpen) button?.setAttribute("aria-current", "page");
    else button?.removeAttribute("aria-current");
  }
  const title = document.getElementById("workspace-title");
  if (title && drivePageOpen) title.textContent = title.title = "Drive";
  if (!drivePageOpen) {
    page.innerHTML = "";
    return;
  }
  const drive = state.drive, next = state.driveNext, pinned = pinnedMission(), run = worktreeRun(), review = reviewJobs();
  const busyWith = state.breakage.busy, pending = Boolean(driveActionPending), online = state.connection === "online";
  const signature = JSON.stringify([drive, next, state.breakage, online, driveContinuous, driveActionPending, driveActionError, state.model.id, Math.floor(Date.now() / 30_000)]);
  if (signature === drivePageSignature) return;
  drivePageSignature = signature;
  const active = page.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusId = active?.id, focusAction = active?.dataset.action, focusArgs = active?.dataset.args;
  const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = page.scrollTop;
  // One list, no labels: what is working, what is ready for you, then ideas.
  // Each row is one line; its actions replace the word on the right when
  // you point at it or tab into it.
  const row = (mark: string, title: string, right: string, actions = "", className = "") =>
    `<div class="drive-row${className ? ` ${className}` : ""}"><span class="drive-mk">${mark}</span>${title}<span class="drive-r">${right}</span>${actions ? `<span class="drive-act">${actions}</span>` : ""}</div>`;
  const plain = (text: string, tip = "") => `<span class="drive-title"${tip ? ` title="${h(tip)}"` : ""}>${h(text)}</span>`;
  const spin = '<span class="drive-spin" aria-hidden="true"></span>';
  const dot = (kind: string) => `<span class="drive-dot ${kind}" aria-hidden="true"></span>`;
  const rows: string[] = [];
  if (pinned) {
    const live = pinned.status === "running" || pinned.status === "waiting", blocked = pinned.status === "blocked";
    const reason = blocked ? (pinned.activity?.trim() || pinned.steps.at(-1)?.note || "Drive stopped without recording a reason.").split("\n")[0]! : "";
    const controls = [
      live ? btn("drive-control", "Pause", { control: "pause" }, "", pending) : btn("drive-control", "Resume", { control: "resume" }, "primary", pending || !online),
      btn("drive-control", "Stop", { control: "stop" }, "quiet", pending),
    ].join("");
    const title = btn("drive-conversation", h(missionTitle(pinned)), {}, "drive-title").replace("<button ", `<button title="${h(reason || "Open its conversation")}" `);
    rows.push(row(live ? spin : blocked ? dot("warn") : dot("paused"), title, `<span class="drive-status${blocked ? " warn" : ""}">${DRIVE_STATUS[pinned.status] ?? pinned.status}</span> · ${h(activeMinutes(pinned))}`, controls));
  }
  if (run.fix) {
    const activity = run.fix.activity ? `${run.fix.activity.steps} step${run.fix.activity.steps === 1 ? "" : "s"}` : "Starting";
    rows.push(row(spin, plain(run.fix.title, run.fix.activity?.last ?? ""), h(activity), btn("breakage-discard", busyWith === "discard" ? "Stopping…" : "Stop", { id: run.fix.id }, "quiet", Boolean(busyWith))));
  }
  if (run.away) {
    const finished = run.away.items.filter((item) => !["queued", "running"].includes(item.state)).length;
    rows.push(row(spin, plain("Working through Drive's ideas"), `${finished} of ${run.away.items.length}`, btn("breakage-away-stop", "Stop after this one", {}, "quiet", Boolean(busyWith))));
  }
  for (const job of review) {
    if (job.status === "failed") {
      rows.push(row(dot("bad"), plain(job.title, job.error ?? ""), job.unchanged ? "No changes" : "Couldn’t finish", btn("breakage-discard", busyWith === "discard" ? "Discarding…" : "Discard", { id: job.id }, "quiet", Boolean(busyWith))));
      continue;
    }
    const checks = job.checks ?? [], passed = checks.filter((check) => check.passed).length;
    const verdict = !checks.length ? "no checks ran" : passed === checks.length ? "checks passed" : `${checks.length - passed} of ${checks.length} checks failed`;
    const diff = job.diff ? `+${job.diff.additions} −${job.diff.deletions} in ${job.diff.files} file${job.diff.files === 1 ? "" : "s"}, ` : "";
    rows.push(row(dot("ok"), plain(job.title, [job.summary, `${diff}${verdict}`, `on ${job.branch}`].filter(Boolean).join("\n")), "Ready to review",
      `${btn("breakage-apply", busyWith === "apply" ? "Applying…" : "Apply", { id: job.id }, "primary", Boolean(busyWith)).replace("<button ", '<button title="Apply to my branch" ')}${btn("breakage-pr", busyWith === "pr" ? "Opening…" : "Open PR", { id: job.id }, "", Boolean(busyWith))}${btn("breakage-discard", busyWith === "discard" ? "Discarding…" : "Discard", { id: job.id }, "quiet", Boolean(busyWith))}`));
  }
  const look = (label: string) => btn("next-refresh", next.loading ? "Looking…" : label, {}, "link", next.loading || pending || !online);
  if (next.error) rows.push(row(dot("bad"), plain(`Couldn’t load ideas: ${next.error}`), "", look("Look again")));
  const signal = new Map(next.signals.map((item) => [item.id, item]));
  const minutes = (value: number) => (value < 60 ? `~${value}m` : `~${Math.round(value / 6) / 10}h`);
  for (const item of next.proposals) {
    const evidence = item.evidence.map((id) => signal.get(id)?.title).find(Boolean);
    rows.push(row(dot("idea"), plain(item.title, [item.why, evidence && `Evidence: ${evidence}`].filter(Boolean).join("\n")), minutes(item.expectedMinutes ?? item.minutes),
      `${btn("next-run", "Run", { id: item.id }, "primary", pending || !online)}${btn("next-plan", "Plan", { id: item.id }, "", pending || !online)}${btn("next-snooze", "Not now", { id: item.id }, "quiet", pending)}`));
  }
  if (drive && !pinned)
    rows.push(row(dot("done"), btn("drive-conversation", h(missionTitle(drive)), {}, "drive-title muted").replace("<button ", '<button title="Open its conversation" '), `<span class="drive-status">${DRIVE_STATUS[drive.status] ?? drive.status}</span>`, "", "past"));
  const model = (state.model.id ?? "").split("/").at(-1);
  const blocked = driveBusy() ? "Drive works on one thing at a time" : !online ? "Connect to the daemon to start work" : "Start (Ctrl+↵)";
  page.innerHTML = `<div class="drive-col${rows.length ? "" : " quiet"}">
    <form id="drive-mission-form" class="drive-compose">
      <div class="drive-box"><textarea id="drive-mission" rows="2" maxlength="8000" aria-label="What should Drive take on?" placeholder="Give Drive a goal…">${h(driveMissionDraft)}</textarea>
      <div class="drive-cbar">${btn("drive-mode", driveContinuous ? "Ongoing" : "One task", { continuous: !driveContinuous }, "drive-mode").replace("<button ", `<button title="${driveContinuous ? "Ongoing: keeps finding work in this project" : "One task: stops after a checked result"}" `)}<span class="sp"></span>${model ? `<span class="drive-model">${h(model)}</span>` : ""}<button type="submit" class="drive-go" aria-label="Start" title="${blocked}"${driveCanStart() ? "" : " disabled"}>${driveActionPending === "drive" ? spin : "↵"}</button></div></div>
      ${driveActionError ? `<p class="drive-error" role="alert">${h(driveActionError)}</p>` : ""}
    </form>
    ${rows.length ? `<div class="drive-list">${rows.join("")}</div>` : `<p class="drive-empty">${next.loading ? "Looking for work…" : `Nothing waiting · ${look("look now")}`}</p>`}
  </div>`;
  page.scrollTop = scroll;
  const replacement = focusId ? document.getElementById(focusId) : [...page.querySelectorAll<HTMLElement>("[data-action]")].find((node) => node.dataset.action === focusAction && node.dataset.args === focusArgs);
  if (active && replacement && !replacement.hasAttribute("disabled")) {
    replacement.focus({ preventScroll: true });
    if (selection && replacement instanceof HTMLTextAreaElement) replacement.setSelectionRange(selection[0]!, selection[1]!);
  }
}
async function driveAction(method: string, args: Record<string, unknown> = {}) {
  if (driveActionPending) return;
  driveActionPending = method;
  driveActionError = "";
  drivePageSignature = "";
  renderDrivePage();
  try {
    const result = await api(method, args);
    // Plan opens its conversation, where the plan is written.
    if (method === "next-plan") setDrivePage(false);
    return result;
  } catch (error) {
    driveActionError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    driveActionPending = "";
    drivePageSignature = "";
    renderDrivePage();
  }
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
    state.themeOptions,
    state.themeCanUndo,
    settingsSection,
    zoomLevel,
  ]);
  if (signature === overlaySignature) return;
  overlaySignature = signature;
  if (overlay === "settings") return renderSettings();
  overlayRows = [];
  let title = "",
    subtitle = "",
    noun = "",
    filter = true,
    footerNote = "";
  if (overlay === "models") {
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
          ? `<div class="section-label">${h(row.group)}<span>${overlay === "models" ? models.filter((model) => model.provider.toUpperCase() === row.group).length : overlayRows.filter((item) => item.group === row.group).length}</span></div>`
          : "";
      lastGroup = row.group ?? "";
      return (
        group +
        btn(
          "choose-row",
          `<span class="name">${h(row.label)}</span><span class="value">${h(row.value)}</span><span class="hint">${h(row.hint ?? "")}${index === overlayIndex ? ` ${k("↵")}` : ""}</span>`,
          { index },
          `menu-row ${index === overlayIndex ? "selected" : ""}`,
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
          `menu-row ${index === completionIndex ? "selected" : ""}`)
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
    return;
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
  if (!state) return;
  // Notes on the diff open the next message; a message may be only notes.
  const notes = !pendingQuestion() && !value.startsWith("/") ? notesMessage([...diffNotes.values()]) : "";
  if (!value.trim() && !notes && !state.attachments.length) return;
  if (notes) {
    value = value.trim() ? `${notes}\n\n${value}` : notes;
    diffNotes.clear();
    reviewVersion++;
    renderConversation();
  }
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
  const stage = el("stage");
  stage.scrollTop = stage.scrollHeight;
}
async function dispatch(
  action: string,
  args: Record<string, any>,
  target?: HTMLElement,
) {
  if (action === "project-toggle" || action === "project-more") {
    const path = String(args.path);
    if (action === "project-toggle") {
      projectDisclosure[path] = !(projectDisclosure[path] ?? path === (document.getElementById("sidebar-sessions")?.dataset.workspace || state?.workspace));
      try { localStorage.setItem("demesne-project-disclosure", JSON.stringify(projectDisclosure)); } catch {}
    } else if (expandedProjectChats.has(path)) expandedProjectChats.delete(path);
    else expandedProjectChats.add(path);
    renderSidebar();
    // Rendering replaces the control: keep keyboard focus on its replacement.
    document.querySelectorAll<HTMLButtonElement>(`#sidebar-sessions [data-action="${action}"]`).forEach(button => {
      if (JSON.parse(button.dataset.args ?? "{}").path === path) button.focus({ preventScroll: true });
    });
    return;
  }
  if (action === "project-open" || action === "project-session") {
    document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path: args.path, ...(action === "project-session" ? { sessionId: args.id } : {}) } }));
    return;
  }
  if (action === "cycle-mode") return cycleMode();
  if (action === "attach-pick") { el<HTMLInputElement>("attach-input").click(); return; }
  if (action === "detach") return api("detach", { id: args.id });
  if (action === "context-card") {
    contextCardOpen = !contextCardOpen;
    renderContextCard();
    return;
  }
  if (contextCardOpen) {
    contextCardOpen = false;
    renderContextCard();
  }
  if (action === "ship") return submitText(SHIP_PROMPT);
  if (action === "toggle-compacted-history" && state?.checkpoint) {
    const id = state.checkpoint.id;
    if (expandedCompactions.has(id)) expandedCompactions.delete(id); else expandedCompactions.add(id);
    follow = false;
    renderConversation();
    compactionCard?.querySelector<HTMLButtonElement>(".compaction-toggle")?.focus({ preventScroll: true });
    return;
  }
  if(action === "toggle-thinking") {
    const content=document.getElementById(`thinking-body-${args.id}`), toggle=content?.previousElementSibling;
    if(!content || !(toggle instanceof HTMLButtonElement))return;
    const open=toggle.getAttribute("aria-expanded") === "true";
    if(open){detailsOpen.delete(args.id);detailsClosed.add(args.id);}
    else{detailsClosed.delete(args.id);detailsOpen.add(args.id);}
    content.hidden=open;toggle.setAttribute("aria-expanded",String(!open));
    const label=toggle.querySelector(".thinking-disclosure");
    if(label)label.textContent=open ? "Show trace" : "Collapse";
    return;
  }
  if (action === "question-control") return questionAction(args.action);
  if (action === "new-session") {
    setDrivePage(false);
    return api("new-session", {});
  }
  if (["next-refresh", "next-run", "next-plan", "next-snooze", "next-never", "next-away", "drive-control"].includes(action)) return driveAction(action, args);
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
  if (action === "drive-open") return setDrivePage(args.toggle ? !drivePageOpen : true);
  if (action === "drive-mode") {
    driveContinuous = Boolean(args.continuous);
    drivePageSignature = "";
    return renderDrivePage();
  }
  if (action === "drive-conversation") {
    setDrivePage(false);
    const home = state?.drive?.homeSessionId;
    if (home && home !== state?.session?.id) await dispatch("select-session", { id: home });
    else document.getElementById("drive-turn")?.scrollIntoView({ block: "start" });
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
  if (action === "review-turn") return toggleReview(String(args.id));
  if (action === "note-line") return editNote(String(args.id), String(args.path), args.side === "old" ? "old" : "new", Number(args.line));
  if (action === "notes-clear") {
    diffNotes.clear();
    reviewVersion++;
    renderConversation();
    return renderComposer();
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
  if (action === "settings-section") {
    settingsSection = String(args.id);
    overlayQuery = "";
    return renderOverlay();
  }
  // A setting changes in place; the sheet stays open to show it took.
  if (action === "settings-set") {
    const result = await api<{ zoom?: number } | null>(String(args.method), args.args ?? {});
    if (args.method === "desktop-zoom" && typeof result?.zoom === "number") zoomLevel = result.zoom;
    overlaySignature = "";
    return renderOverlay();
  }
  if (action === "settings-command") {
    overlay = null;
    renderOverlay();
    return setDraft(String(args.text));
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
    if (action === "select-session") setDrivePage(false);
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
  if (action === "setup" && overlay === "settings") {
    overlay = null;
    renderOverlay();
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
function changedPaths(run: WorkspaceRun) {
  return [...new Set(tools(run).filter((t) => t.phase === "change" && t.state === "done").flatMap((t) => t.changes?.map((c) => c.path) ?? [String(t.input.path ?? t.detail ?? "")]))];
}
/// Opens a turn's steps and unfolds the ones asked for (its edits, its
/// checks, or every step), loading a command's recorded output as a click
/// on its row would; then scrolls the turn into view.
async function unfoldTurn(run: WorkspaceRun, phase: "change" | "verify" | "all", only?: ToolEntry, path?: string) {
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
    reviewOpen.clear(); reviewFiles.clear(); diffNotes.clear(); noteEditing = null;
    follow = true;
    overlay = null;
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
  renderDrivePage();
  renderCompletion();
  renderSetup();
  if (
    !editor.disabled &&
    !overlay &&
    !drivePageOpen &&
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
  if (contextCardOpen && !target && !(event.target as Element).closest("#context-card")) {
    contextCardOpen = false;
    renderContextCard();
  }
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
// Clicking another line while writing a note moves straight to it: the
// field keeps focus until the click lands, so the redraw can't swallow it.
document.addEventListener("mousedown", (event) => {
  if (noteEditing && (event.target as Element).closest?.(".rv-l, .rv-note:not(.editing)")) event.preventDefault();
});
document.addEventListener("focusout", (event) => {
  if ((event.target as HTMLElement).id === "rv-note-input" && noteEditing) saveNote();
});
document.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "rv-note-input") {
    noteDraft = input.value;
    return;
  }
  if (input.id === "drive-mission") {
    driveMissionDraft = input.value;
    // Start lights up as soon as there is a goal; the page itself doesn't redraw.
    const start = document.querySelector<HTMLButtonElement>("#drive-mission-form .drive-go");
    if (start) start.disabled = !driveCanStart();
    return;
  }
  if (input === (editor as unknown as HTMLInputElement)) {
    changedDraft();
    return;
  }
  if (
    input.closest("#overlay") &&
    input.tagName === "INPUT" &&
    overlay &&
    !["rename", "confirm-archive", "confirm-undo"].includes(overlay)
  ) {
    overlayQuery = input.value;
    overlayIndex = 0;
    renderOverlay();
  }
  if (input.closest("#setup")) setupInput(input);
});
document.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "settings-theme") void act(() => dispatch("settings-set", { method: "theme", args: { name: target.value } }));
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  void act(async () => {
    if (form.id === "drive-mission-form") {
      if (driveActionPending) return;
      const mission = driveMissionDraft.trim();
      if (!mission) return;
      await driveAction("drive", { text: `${driveContinuous ? "--continuous" : "--bounded"} ${mission}` });
      driveMissionDraft = "";
      drivePageSignature = "";
      renderDrivePage();
    }
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
    follow = false;
  },
  { passive: true },
);
el("stage").addEventListener("scroll", () => {
  const stage = el("stage");
  if (stage.scrollHeight - stage.clientHeight - stage.scrollTop < 48) follow = true;
  else if (stage.scrollTop < lastStageTop - 2) follow = false;
  lastStageTop = stage.scrollTop;
});
document.addEventListener("demesne:open-settings", () => {
  if (state && !state.setup) void act(() => openOverlay("settings"));
});
// Images reach the composer by +, paste or a drop anywhere in the window.
el<HTMLInputElement>("attach-input").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement, files = [...input.files ?? []];
  input.value = "";
  if (files.length) void act(() => attachFiles(files));
});
editor.addEventListener("paste", (event) => {
  const files = [...event.clipboardData?.files ?? []].filter((file) => file.type.startsWith("image/"));
  if (!files.length || !state?.session) return;
  event.preventDefault();
  void act(() => attachFiles(files));
});
let dragDepth = 0;
const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
document.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event) || !state?.session) return;
  dragDepth++;
  el("drop-zone").hidden = false;
});
document.addEventListener("dragleave", (event) => {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el("drop-zone").hidden = true;
});
document.addEventListener("dragover", (event) => { if (carriesFiles(event)) event.preventDefault(); });
document.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  el("drop-zone").hidden = true;
  const files = [...event.dataTransfer?.files ?? []];
  if (files.length && state?.session) void act(() => attachFiles(files));
});
document.addEventListener("keydown", (event) => {
  if (!state || event.isComposing) return;
  const field =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement;
  const key = event.key.toLowerCase(),
    ctrl = event.ctrlKey || event.metaKey;
  // Native details and buttons keep Enter and Space.
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
  if ((event.target as HTMLElement).id === "rv-note-input" && (key === "enter" || key === "escape")) {
    event.preventDefault();
    saveNote(key === "enter");
    editor.focus({ preventScroll: true });
    return;
  }
  if (key === "escape") {
    run(() => {
      if (contextCardOpen) {
        contextCardOpen = false;
        renderContextCard();
        return;
      }
      if (overlay) {
        overlay = null;
        renderOverlay();
        editor.focus();
        return;
      }
      if (drivePageOpen) return setDrivePage(false);
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
  if (drivePageOpen && !overlay && ctrl && key === "enter" && (event.target as HTMLElement).id === "drive-mission") {
    event.preventDefault();
    document.querySelector<HTMLFormElement>("#drive-mission-form")?.requestSubmit();
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
    // ↑↓ step through Settings' sections while its search is empty.
    if (overlay === "settings" && (key === "arrowdown" || key === "arrowup") && !overlayQuery && !(event.target instanceof HTMLSelectElement)) {
      const at = SETTINGS_SECTIONS.findIndex((section) => section.id === settingsSection);
      run(() => dispatch("settings-section", { id: SETTINGS_SECTIONS[(at + (key === "arrowdown" ? 1 : -1) + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]!.id }));
      return;
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
  if (key === "tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.target === editor) {
    run(() => cycleMode());
    return;
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
  mode: currentMode(),
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
