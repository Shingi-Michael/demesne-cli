import { compactedConversation } from "./compacted-conversation.ts";
import { SidebarProjectOrder } from "./sidebar-project-order.ts";
import { markdown, MarkdownView } from "./markdown.ts";
import { splitNextPrompt } from "../../../packages/protocol/src/next-prompt.ts";
import { parseMailTurn } from "../../../packages/protocol/src/heartbeat-mail.ts";
import { parseDriveReport } from "../../../packages/protocol/src/drive-report.ts";
import { agentPlace, projectSlug, type NearbyAgent } from "../../../packages/protocol/src/agents-nearby.ts";
import { advance, cubeSvg, moving, restingCube } from "./working-cube.ts";
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
/// How many models the picker lists before "More models".
const SHORT_MODELS = 4;
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
    ask_user: "Asked",
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
  /// The picker's "More models" column is open.
  modelsMore = false,
  modelsQuery = "",
  overlayRows: {
    label: string;
    value: string;
    action: string;
    data: Record<string, unknown>;
    group?: string;
    hint?: string;
    description?: string;
    /// The model picker's rows: the short list, its "More models" row, the rest.
    kind?: "short" | "more" | "rest";
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
  ideasShown = false,
  brokeShown = false,
  /// The "Tell Drive…" box under Drive's line, and the note it last sent.
  tellOpen = false,
  tellSent = "";
let driveActionPending = "";
/// Each mission chat and the chat it was started from.
function missionLinks() {
  const jobs = state ? [state.breakage.fix, ...state.breakage.inbox] : [];
  return new Map(jobs.filter((job): job is NonNullable<typeof job> => Boolean(job?.sessionId && job.from)).map((job) => [job.sessionId!, job.from!] as const));
}
const chatTitle = (id: string) => state?.sessions.find((item) => item.id === id)?.title || "your chat";
/// Your notes to a mission, as Drive received them.
function toldNotes(drive: NonNullable<Snapshot["drive"]>) {
  const notes = drive.told ?? [], from = missionLinks().get(drive.homeSessionId);
  if (!notes.length) return "";
  return `<ul class="drive-told">${notes.slice(-3).map((note) => `<li title="${h(fullTime(note.at))}"><small>From ${h(from ? chatTitle(from) : "your chat")}</small>${h(note.text)}</li>`).join("")}</ul>`;
}
/// Drive's page fills the main column in place of the conversation.
const stepsOpen = new Set<string>();
/// Steps whose diff or output is unfolded in place, keyed run:tool.
const stepOpen = new Set<string>();
/// Live previews: the page a running dev server serves unfolds under the
/// step that started it. Phone width and "show output" are per step.
const previewPhone = new Set<string>(), previewOutput = new Set<string>(), previewSeen = new Set<string>();
const serving = (tool: ToolEntry) => tool.name === "run_command" ? state?.processes.find((command) => command.toolCallId === tool.toolCallId && command.serves) ?? null : null;
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
/// The same model, whether or not either id carries its provider prefix.
const sameModel = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b) && (a === b || a!.split("/").at(-1) === b!.split("/").at(-1));
function context() {
  const plan = state?.provider?.contextPlan,
    usage = state?.provider?.usage;
  const used =
    plan?.estimatedInputTokens ??
    usage?.totalTokens ??
    (state?.runs.length === 0 ? 0 : null);
  // The last request's plan was sized for the model it ran on. After you
  // switch models, the size is the chosen model's until its first request.
  const fresh = Boolean(plan) && sameModel(state?.provider?.model, state?.model.id);
  const capacity = (fresh ? plan!.capacityTokens : null) ?? state?.model.contextWindow ?? null;
  return {
    used,
    capacity,
    fresh,
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
/// Projects are an accordion: one is open at a time. Until you pick one,
/// the project you are working in is the open one; switching projects
/// opens the new one. An empty string means every project is closed.
let openProjectPath: string | undefined = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("demesne-project-open") ?? "null");
    return typeof saved?.path === "string" ? saved.path : undefined;
  } catch { return undefined; }
})();
let openProjectFor: string | undefined;
/// Projects whose agents are unfolded under their line.
const agentsShown = new Set<string>();
/// An agent's mark: its client's initial on a tone of its own.
const agentMark = (agent: NearbyAgent) => `<span class="agent-mark" data-provider="${h(agent.provider)}" aria-hidden="true">${h((agent.provider === "codex" ? "x" : agent.name[0] ?? "?"))}</span>`;
/// The project just opened from its line unfolds once, not on every redraw.
let unfoldingProject = "";
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
  if (openProjectFor !== undefined && openProjectFor !== projectWorkspace) {
    openProjectPath = undefined;
    try { localStorage.removeItem("demesne-project-open"); } catch {}
  }
  openProjectFor = projectWorkspace;
  const openPath = openProjectPath ?? projectWorkspace;
  const agents = state.agents ?? [];
  // A mission's chat sits under the chat it was started from.
  const parentOf = missionLinks();
  const signature = JSON.stringify([[...parentOf], sessions, projectPaths, openPath, agents, [...agentsShown], [...expandedProjectChats], [...deletedSessions], state.session?.id, state.session?.title, state.connection, state.activeTurnId, query, waiting, review.map((job) => [job.id, job.status, job.title, job.diff]), pinned && [pinned.status, pinned.mission, driveProgress(pinned)], run.fix?.status, run.away?.status, word, ideas, state.session?.workspace?.gitBranch, inSession(), [...branches], renaming, Math.floor(Date.now() / 60_000)]);
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;
  const current = state.session;
  // One cube on screen at most: it turns in the conversation, and a working
  // chat is a small breathing dot here.
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
    const found = projectSessions.filter(item => projectMatches || item.title.toLowerCase().includes(query));
    const nested = (item: typeof found[number]) => found.some(parent => parent.id === parentOf.get(item.id));
    const matching = found.filter(item => !nested(item));
    for (const child of found.filter(nested)) matching.splice(matching.findIndex(parent => parent.id === parentOf.get(child.id)) + 1, 0, child);
    if (query && !projectMatches && !matching.length) continue;
    const expanded = Boolean(query) || path === openPath;
    const rows: string[] = [];
    let shown = 0, more = 0;
    // Search reveals every match; each project can also expand its full history.
    const limit = query || expandedProjectChats.has(path) ? Infinity : SIDEBAR_ROWS;
    for (const item of matching) {
      if (shown >= limit) { if (item.turns) more++; continue; }
      const selected = item.id === current?.id;
      // Drive's own chats stay off the list: its work unfolds from its line in
      // your chat and lands as a branch to review. One you open shows while open.
      if (branches.has(item.id) && !selected) continue;
      const title = selected ? inSession() ? current!.title : "New chat" : item.turns ? item.title : "New chat";
      const asks = selected ? Boolean(waiting) : Boolean(item.waiting);
      // A mission's chat keeps its cube while Drive plans between turns.
      const driving = Boolean(pinned && pinned.homeSessionId === item.id && ["running", "waiting"].includes(pinned.status));
      const working = selected ? (Boolean(state.activeTurnId) || driving) && !waiting : !asks && (item.status === "running" || item.status === "queued" || driving);
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
        rows.push(`<div class="sidebar-item${nested(item) ? " kid" : ""}"><form class="sidebar-rename" data-id="${h(item.id)}">${dot(tone)}<input name="title" value="${h(title)}" maxlength="200" aria-label="Rename ${h(title)}" autocomplete="off"></form></div>`);
        shown++;
        continue;
      }
      rows.push(`<div class="sidebar-item${nested(item) ? " kid" : ""}">${row(tone, title, selected, tone || (selected && !inSession()) ? "" : shortAge(item.updatedAt), item.id, item.updatedAt)}${remove}</div>`);
      shown++;
    }
    if (more && !query) rows.push(btn("project-more", `Show ${more} more`, { path }, "sidebar-more"));
    else if (!query && expandedProjectChats.has(path) && shown > SIDEBAR_ROWS) rows.push(btn("project-more", "Show fewer", { path }, "sidebar-more"));
    const toggle = btn("project-toggle", '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>', { path }, "sidebar-project-toggle")
      .replace("<button ", `<button aria-label="${h(`${expanded ? "Collapse" : "Expand"} ${name}`)}" aria-expanded="${expanded}" aria-controls="project-chats-${index}"${query ? " disabled" : ""} `);
    const label = btn("project-open", `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/></svg><span>${h(name)}</span>`, { path }, "sidebar-project-name")
      .replace("<button ", `<button draggable="true" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="${h(path)} · Drag to reorder (Alt+↑/↓)"${path === projectWorkspace ? ' aria-current="location"' : ""} `);
    // Each project's line says its state on the right, so a closed project
    // still shows what it needs: branches to review, a chat waiting on you,
    // work in progress, or when it last moved.
    const active = path === projectWorkspace;
    const asking = projectSessions.some(item => item.id === current?.id ? Boolean(waiting) : item.waiting);
    const busy = projectSessions.some(item => item.id === current?.id ? Boolean(state!.activeTurnId) : item.status === "running" || item.status === "queued");
    const latest = projectSessions.reduce((max, item) => item.turns && item.updatedAt > max ? item.updatedAt : max, "");
    const link = active && state.connection !== "online" ? state.connection === "connecting" ? "connecting…" : "offline" : "";
    // Other agents at work here (Heartbeat): their marks lead the state, and
    // clicking them unfolds who they are, with Message.
    const here = agents.filter(agent => agent.project === projectSlug(path));
    const showing = here.length > 0 && agentsShown.has(path);
    const marks = here.length ? btn("agents-toggle", here.slice(0, 3).map(agentMark).join(""), { path }, "sidebar-agents")
      .replace("<button ", `<button title="${h(here.map(agent => `${agent.name} ${agentPlace(agent)}`).join(" · "))}" aria-label="${h(`${here.length} ${here.length === 1 ? "agent" : "agents"} working in ${name}`)}" aria-expanded="${showing}" `) : "";
    const status = link ? `<span class="sidebar-project-state">${link}</span>`
      : active && review.length ? btn("review-open", `${ICON_BRANCH}${review.length}`, { show: true }, "sidebar-project-review").replace("<button ", `<button title="${review.length} ${review.length === 1 ? "branch" : "branches"} to review" `)
      : asking ? `<span class="sidebar-project-state" title="A chat needs you">${dot("warn")}</span>`
      // An open project's rows already show the work; a folded one says so.
      : busy && !expanded ? `<span class="sidebar-project-state" title="Working">${dot("working")}</span>`
      : !expanded && latest && !here.length ? `<span class="sidebar-project-state" title="${h(fullTime(latest))}">${h(shortAge(latest))}</span>` : "";
    const agentRows = showing ? `<div class="sidebar-agent-rows">${here.map(agent => `<div class="sidebar-agent-row" title="${h(agent.address)}">${agentMark(agent)}<span>${h(agent.name)} · ${h(agentPlace(agent).replace(/^on /, ""))}</span>${btn("agent-message", "Message", { address: agent.address, name: agent.name }, "sidebar-agent-message")}</div>`).join("")}</div>` : "";
    if (active && review.length && !query) rows.push(btn("review-open", `Review ${review.length} ${review.length === 1 ? "branch" : "branches"} ›`, { show: true }, "sidebar-more sidebar-review"));
    groups.push(`<section class="sidebar-project${active ? " active" : ""}" data-project="${h(path)}"><div class="sidebar-project-header">${toggle}${label}${marks}${status}</div>${agentRows}<div class="sidebar-project-chats${path === unfoldingProject && expanded ? " unfolding" : ""}" id="project-chats-${index}"${expanded ? "" : " hidden"}>${rows.length ? rows.join("") : '<p class="sidebar-empty">No chats yet</p>'}</div></section>`);
  }
  list.innerHTML = groups.length ? groups.join("") : '<p class="sidebar-empty">No matching conversations or projects</p>';
  unfoldingProject = "";
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
  if (title) { title.textContent = inSession() ? current?.title ?? "Conversation" : "New chat"; title.title = title.textContent; }
  // A mission's chat says where it came from, and goes back there.
  const crumb = document.getElementById("workspace-from"), from = current && inSession() ? parentOf.get(current.id) : undefined;
  if (crumb) {
    crumb.hidden = !from;
    crumb.innerHTML = from ? `from ${btn("select-session", h(chatTitle(from)), { id: from }, "workspace-from-link")}` : "";
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
// Compacting a mostly empty context frees little and loses detail, so the
// link waits until the chat is half full; /compact works at any size.
function worthCompacting(percentage: number | null | undefined) {
  return (percentage ?? 0) >= 50;
}

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
        // What is kept free depends on the model; a new one's comes with its first request.
        ...(c.fresh ? [{ name: "Kept free for replies", tokens: plan.reserves.totalTokens ?? 0, tone: "c" }] : []),
      ]
    : [{ name: "Conversation", tokens: c.used ?? 0, tone: "a" }];
  const free = Math.max(0, capacity - parts.reduce((sum, part) => sum + part.tokens, 0));
  const share = (tokens: number) => (capacity ? (tokens / capacity) * 100 : 0);
  card.innerHTML = `<div class="context-head"><span>Context</span><span>${c.percentage}% · ${c.estimated ? "~" : ""}${tokensShort(c.used ?? 0)} of ${capacity ? tokensShort(capacity) : "—"}</span></div><div class="context-bar">${parts.map((part) => `<i class="tone-${part.tone}" style="width:${share(part.tokens).toFixed(2)}%"></i>`).join("")}</div><div class="context-legend">${[...parts, { name: "Free", tokens: free, tone: "free" }].filter((part) => part.tokens > 0).map((part) => `<u class="tone-${part.tone}"></u><span>${part.name}</span><em>${tokensShort(part.tokens)}</em>`).join("")}</div>${worthCompacting(c.percentage) ? btn("compact", state!.activeTurnId ? "Compact after this turn" : "Compact now", {}, "link context-compact") : ""}`;
}
/// The cards on the right: where this chat works, how full its context is,
/// what changed, and whatever else is live (agents, a preview,
/// connectors). A card shows only when it has something to say; its header
/// folds it to one line.
const ICON_PANEL = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></svg>';
const ICON_COMPUTER = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICON_FOLDER = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_PULSE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>';
const ICON_CHEVRON = '<svg class="ico card-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
let cardsOn = (() => { try { return localStorage.getItem("demesne-cards") !== "off"; } catch { return true; } })();
const cardsFolded = new Set<string>((() => { try { return JSON.parse(localStorage.getItem("demesne-cards-folded") ?? "[]") as string[]; } catch { return []; } })());
let cardsSignature = "";
/// The card whose body is unfolding now; only it animates.
let cardUnfolding = "";
function card(name: string, title: string, summary: string, body: string) {
  const folded = cardsFolded.has(name);
  return `<section class="card${folded ? " folded" : ""}" data-card="${name}"><button type="button" class="card-head" data-action="card-fold" data-args='${JSON.stringify({ name })}' aria-expanded="${!folded}"><span class="card-title">${title}</span>${ICON_CHEVRON}<span class="card-sum">${summary}</span></button>${folded ? "" : `<div class="card-body">${body}</div>`}</section>`;
}
function renderCards() {
  const shown = Boolean(state) && cardsOn && inSession();
  el("app").classList.toggle("cards-on", shown);
  const aside = el("cards");
  aside.hidden = !shown;
  if (!shown) { cardsSignature = ""; return; }
  const s = state!, root = s.workspace ?? "", branch = s.session?.workspace?.gitBranch;
  const c = context(), plan = s.provider?.contextPlan, changes = workingChanges();
  const files = s.files.filter((file) => file.status);
  const here = root ? s.agents.filter((agent) => agent.project === projectSlug(root)) : [];
  const previews = s.processes.filter((command) => command.serves && command.status === "running");
  const servers = s.connectors.servers;
  const signature = JSON.stringify([root, branch, c, plan?.estimatedMessageTokens, plan?.estimatedToolDefinitionTokens, plan?.reserves.totalTokens, files, here, previews.map((command) => command.serves), s.connectors, Boolean(s.activeTurnId), [...cardsFolded]]);
  if (signature === cardsSignature) return;
  cardsSignature = signature;
  const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
  const parent = root.slice(0, Math.max(0, root.length - name.length - 1)).replace(/^\/(Users|home)\/[^/]+/, "~");
  const row = (icon: string, label: string, right = "", title = "") => `<div class="card-row"${title ? ` title="${h(title)}"` : ""}>${icon}<span class="card-label">${label}</span>${right ? `<span class="card-right">${right}</span>` : ""}</div>`;
  const out: string[] = [];
  out.push(card("environment", "Environment", h(branch ? `${name} · ${branch}` : name),
    row(ICON_COMPUTER, "This computer") +
    row(ICON_FOLDER, `${h(name)}${parent ? `<em> · ${h(parent)}</em>` : ""}`, "", root) +
    (branch ? row(ICON_BRANCH.replace("sidebar-branch", ""), h(branch)) : "") +
    // The pulse beats while Heartbeat is running.
    row(s.connectors.heartbeat ? ICON_PULSE.replace('class="ico"', 'class="ico beat"') : ICON_PULSE, "Heartbeat", s.connectors.heartbeat ? '<span class="card-on">On</span>' : "Off")));
  if (c.percentage != null) {
    const capacity = c.capacity ?? 0;
    const parts = plan
      ? [{ name: "Chat", tokens: plan.estimatedMessageTokens, tone: "a" }, { name: "Tools", tokens: plan.estimatedToolDefinitionTokens, tone: "b" }, ...(c.fresh ? [{ name: "Kept free", tokens: plan.reserves.totalTokens ?? 0, tone: "c" }] : [])]
      : [{ name: "Chat", tokens: c.used ?? 0, tone: "a" }];
    const share = (tokens: number) => (capacity ? Math.min(100, (tokens / capacity) * 100) : 0);
    out.push(card("context", "Context", `${c.percentage}%<span class="card-meter"><i style="width:${Math.min(100, c.percentage)}%"></i></span>`,
      `<div class="context-bar">${parts.map((part) => `<i class="tone-${part.tone}" style="width:${share(part.tokens).toFixed(2)}%"></i>`).join("")}</div>` +
      `<div class="card-legend">${parts.filter((part) => part.tokens > 0).map((part) => `<span><u class="tone-${part.tone}"></u>${part.name} ${tokensShort(part.tokens)}</span>`).join("")}</div>` +
      `<div class="card-foot"><span>${c.estimated ? "~" : ""}${tokensShort(c.used ?? 0)} of ${capacity ? tokensShort(capacity) : "—"}</span>${worthCompacting(c.percentage) ? btn("compact", s.activeTurnId ? "Compact after this turn" : "Compact now", {}, "link") : ""}</div>`));
  }
  if (files.length) {
    const shownFiles = files.slice(0, 6);
    out.push(card("changes", "Changes", counts(changes),
      shownFiles.map((file) => row("", h(file.path.split("/").at(-1) ?? file.path), counts({ added: file.additions ?? 0, removed: file.deletions ?? 0 }), file.path)).join("") +
      `<div class="card-foot"><span>${files.length === 1 ? "1 file" : `${files.length} files`}${files.length > shownFiles.length ? ` · ${files.length - shownFiles.length} more` : ""} · not committed</span>${btn("ship", "Commit & PR", {}, "card-btn")}</div>`));
  }
  if (here.length)
    out.push(card("agents", "Agents", here.slice(0, 3).map(agentMark).join(""),
      here.map((agent) => `<div class="card-row card-hover" title="${h(agent.address)}">${agentMark(agent)}<span class="card-label">${h(agent.name)}<em> · ${h(agentPlace(agent).replace(/^on /, ""))}</em></span>${btn("agent-message", "Message", { address: agent.address, name: agent.name }, "card-act")}</div>`).join("")));
  if (previews.length)
    out.push(card("preview", "Preview", h(new URL(previews[0]!.serves!).host),
      previews.map((command) => `<div class="card-row"><span class="pv-live" aria-hidden="true"></span><span class="card-label">${h(new URL(command.serves!).host)}</span>${btn("open-link", "Open ↗", { url: command.serves }, "card-btn")}</div>`).join("")));
  if (servers.length)
    out.push(card("connectors", "Connectors", h(servers.map((server) => server.name).join(", ")),
      servers.map((server) => row(`<span class="card-dot ${server.state}" aria-hidden="true"></span>`, h(server.name), server.state === "ready" ? `${server.tools} tool${server.tools === 1 ? "" : "s"}` : server.state === "failed" ? "Didn’t start" : "Starting…")).join("")));
  // Only the cards that changed are replaced, so the others keep their
  // hover and never repaint while the chat streams.
  const next = new Map(out.map((html) => [/data-card="([a-z]+)"/.exec(html)![1]!, html]));
  for (const node of [...aside.children] as HTMLElement[]) if (!next.has(node.dataset.card ?? "")) node.remove();
  let index = 0;
  for (const [key, html] of next) {
    let node = aside.querySelector<HTMLElement>(`:scope > [data-card="${key}"]`);
    if (!node || node.dataset.html !== html) {
      const fresh = document.createElement("template");
      fresh.innerHTML = html;
      const replacement = fresh.content.firstElementChild as HTMLElement;
      replacement.dataset.html = html;
      if (key === cardUnfolding) {
        replacement.classList.add("unfolding");
        replacement.addEventListener("animationend", () => replacement.classList.remove("unfolding"), { once: true });
      }
      if (node) node.replaceWith(replacement);
      node = replacement;
    }
    const at = aside.children[index] ?? null;
    if (node !== at) aside.insertBefore(node, at);
    index++;
  }
  cardUnfolding = "";
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
    cardsOn,
  ]);
  renderCards();
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
    `<div class="header-state">${branchChip()}</div>${inSession() ? `<button type="button" class="header-cards${cardsOn ? " on" : ""}" data-action="cards-toggle" aria-label="Cards" aria-pressed="${cardsOn}" title="${cardsOn ? "Hide" : "Show"} cards">${ICON_PANEL}</button>` : ""}${inSession() ? btn("overlay", "⋯", { name: "session" }, `header-more${overlay === "session" ? " active" : ""}`).replace("<button ", '<button title="This conversation" aria-label="This conversation" ') : ""}`;
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
/// Work in progress: eight small cubes that make one. On each beat they
/// part, the whole turns a quarter on a random axis, and they close. One
/// timer turns every mark together, and a mark drawn mid-beat starts where
/// the others are, so repaints never restart it.
let cube = restingCube(performance.now());
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const spinner = () => `<span class="cube-mark" aria-hidden="true">${cubeSvg(cube, performance.now(), reducedMotion())}</span>`;
/// Words for work in progress, with a silver shine sweeping across them.
/// The delay keeps a repainted line in step with the sweep instead of
/// restarting it (3s each way).
const shine = (text: string) => `<span class="shine" style="animation-delay:-${Date.now() % 6000}ms">${h(text)}</span>`;
/// A running sub-agent's target: its task and a phrase that cycles the whole
/// time it runs (updated in place by a timer); its steps count on the right.
function toolTarget(run: WorkspaceRun, tool: ToolEntry) {
  if (tool.name === "ask_user") {
    const asked = Array.isArray(tool.input.questions) ? tool.input.questions as { question?: unknown }[] : [];
    const first = typeof asked[0]?.question === "string" ? asked[0].question : "";
    return first ? `${h(first)}${asked.length > 1 ? `<span class="muted"> · ${asked.length - 1} more</span>` : ""}` : "";
  }
  const base = (tool.detail ?? tool.name).replace(/^\$\s*/, "");
  // A command by its program's name: the full path is on hover.
  if (tool.name === "run_command") return h(base.replace(/^\S*\//, ""));
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
const ICON_SWITCH = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h12l-3-3"/><path d="M21 17H9l3 3"/><path d="M15 7a6 6 0 0 1 6 6"/></svg>';
const ICON_SPARK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';
const ICON_COPY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_UNDO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const CHEVRON = '<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
/// Whether a step has something to unfold: an edit's diff, a command's output.
const foldable = (tool: ToolEntry) =>
  (tool.phase === "change" && tool.state !== "running" && !tool.drafting && (Boolean(tool.changes?.length) || Boolean(tool.diff))) ||
  (tool.name === "run_command" && !tool.waiting && !tool.drafting && Boolean(tool.toolCallId));
function toolRow(run: WorkspaceRun, tool: ToolEntry) {
  // A question still waiting is asked at the end of the conversation, not as a step.
  if (tool.name === "ask_user" && (tool.state === "running" || tool.waiting || tool.drafting)) return "";
  const key = `${run.id}:${tool.id}`, open = stepOpen.has(key), canFold = foldable(tool);
  const now = tool.state === "running" || tool.drafting, served = serving(tool)?.serves;
  const meta = served ? `<span class="pv-live" aria-hidden="true"></span>${h(new URL(served).host)}` : tool.waiting
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
    // A running step keeps its own icon and only its words shine: the cube
    // means thinking or working overall, not one tool.
    `${stepIcon(tool)}<span class="verb">${now && !served ? shine(verb(tool)) : served ? "Serving" : h(verb(tool))}</span><code class="target" title="${h(tool.detail ?? tool.name)}">${toolTarget(run, tool)}</code>${canFold ? CHEVRON : ""}<span class="sp"></span><small class="meta">${meta}</small>`,
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
  const key = `${run.id}:${tool.id}`;
  if (record?.serves && !previewOutput.has(key)) {
    const url = record.serves, host = new URL(url).host, phone = previewPhone.has(key);
    const tab = (label: string, on: boolean, action: string, args: Record<string, unknown>) => btn(action, label, args, `pv-btn${on ? " on" : ""}`);
    return `<div class="step-fold pv" data-preview="${h(key)}"><div class="pv-bar"><span class="pv-live" aria-hidden="true"></span><span class="pv-url" title="${h(url)}">${h(host)}</span><span class="sp"></span>${tab("Desktop", !phone, "preview-width", { key, phone: false })}${tab("Phone", phone, "preview-width", { key, phone: true })}${tab("Reload", false, "preview-reload", { key })}${tab("Output", false, "preview-output", { key })}${tab("Open ↗", false, "open-link", { url })}</div><div class="pv-view${phone ? " phone" : ""}"><iframe src="${h(url)}" title="Preview of ${h(host)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" referrerpolicy="no-referrer"></iframe></div></div>`;
  }
  const text = record ? `${record.stdout}${record.stderr ? `\n${record.stderr}` : ""}`.trim().split("\n").slice(-40).join("\n") : "";
  const body = text ? `<pre class="out">${h(text)}</pre>` : `<div class="out muted">${record?.outputLoaded === false ? "Loading output…" : record ? "No output." : "Output not recorded."}</div>`;
  const back = record?.serves ? btn("preview-output", "Preview", { key }, "pv-btn pv-back") : "";
  return `<div class="step-fold"><div class="fold-cmd">$ ${h(String(tool.detail ?? "").replace(/^\$\s*/, ""))}${back}</div>${body}</div>`;
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
  // A step serving a live page keeps the trace open so its preview shows.
  const live = active(run), fold = run.status === "completed" && !stepsOpen.has(run.id) && !items.some((tool) => serving(tool));
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
      body += `<div class="thinking thinking-main ${live ? "live" : ""}"><button type="button" class="thinking-toggle" data-action="toggle-thinking" data-args="${h(JSON.stringify({id:key}))}" aria-expanded="${open}" aria-controls="thinking-body-${h(key)}">${live ? spinner() : CHEVRON}${live ? shine("Thinking") : `Thought for ${duration(entry.durationMs)}`}<span class="thinking-disclosure">${open ? "Collapse" : "Show trace"}</span></button><div class="thinking-content" id="thinking-body-${h(key)}"${open ? "" : " hidden"}>${thinkingBody(entry.raw)}</div></div>`;
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
        const summary=run.kind === "themefy" ? `Theme questions · ${group.filter(tool=>tool.name === "ask_user").length}${group.some(tool=>tool.name === "apply_theme" && tool.state === "done")?" · palette applied":""}` : `Explored · ${group.length} reads`;
        steps += `<details class="explored" data-detail="${key}"${detailsOpen.has(key) ? " open" : ""}><summary>${stepIcon(group[0]!)}<span class="verb">${h(summary)}</span><span class="sp"></span><small class="meta">${duration(sum)}</small></summary><div>${group.map((tool) => toolRow(run, tool)).join("")}</div></details>`;
        i = j - 1;
      } else steps += toolRow(run, entry) + subagentTrace(run, entry, key);
    }
    if (entry.type === "notice" && !entry.closesTurn) {
      if (entry.quiet) { steps += `<div class="tool-row switch">${ICON_SWITCH}<span class="verb">${h(entry.text)}</span></div>`; continue; }
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
    ? `<div class="live-activity">${spinner()}${shine(phase + (latestTool?.drafting || latestTool?.name === "run_command" ? "" : latestTool?.detail ?? "") + (latestTool?.name === "subagent" && latestTool.trace?.findLast((segment) => segment.kind === "step") ? ` · ${latestTool.trace.findLast((segment) => segment.kind === "step")!.text}` : "") + "…")}</div>`
    : "";
  const answered = run.entries.some((e) => e.type === "assistant");
  const asks = `<span class="ask-actions">${btn("edit-ask", "edit", { id: run.id })}${live || state!.activeTurnId ? "" : btn("retry-ask", "retry", { id: run.id })}</span>`;
  const queued = live && state!.queue.trim() ? `<div class="next-line"><span class="next-label">NEXT</span><span class="next-text">${h(state!.queue.trim())}</span>${btn("queue-action", "edit", { action: "edit" })}${btn("queue-action", "send now", { action: "now" })}${btn("queue-action", "×", { action: "drop" }, "next-drop")}</div>` : "";
  const attached = run.attachments?.length
    ? `<div class="request-att">${run.attachments.map((image) => attachmentPreviews.has(image.id)
      ? `<img src="${attachmentPreviews.get(image.id)}" alt="${h(image.filename)}" title="${h(image.filename)}">`
      : `<span class="att-name" title="${h(`${image.width}×${image.height}`)}">${h(image.filename)}</span>`).join("")}</div>` : "";
  const request = mailRequest(run) ?? driveReport(run) ?? driveAsked(run) ?? `${attached}<div class="request"><span class="text">${h(run.content)}</span><span class="request-meta">${asks}<time>${clock(run.createdAt).slice(0, 5)}</time></span></div>`;
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
/// A finished Drive mission's report sits where an ask sits, as a receipt
/// from Drive: what it did, what it changed, and the way to its branch and
/// its chat. The words under it are your chat's model taking it in.
function driveReport(run: WorkspaceRun): string | null {
  const report = parseDriveReport(run.content);
  if (!report) return null;
  const open = [state!.breakage.fix, ...state!.breakage.inbox].find((job) => job?.id === report.fix && job.status === "ready");
  const where = report.diff ? `<span class="add">+${report.diff.additions}</span> <span class="del">−${report.diff.deletions}</span> · ${report.diff.files} file${report.diff.files === 1 ? "" : "s"}` : "";
  const actions = [
    open ? btn("review-open", "Review", { show: true }, "link") : "",
    state!.sessions.some((item) => item.id === report.chat) ? btn("select-session", "Open its chat", { id: report.chat }, "link") : "",
  ].filter(Boolean).join('<span class="muted"> · </span>');
  return `<div class="request drive-report${report.status === "failed" ? " failed" : ""}" title="${h(`Drive's report, on ${report.branch}`)}"><span class="dr-head">${ICON_SPARK}<span>Drive ${report.status === "failed" ? "stopped" : "finished"}</span><b>${h(report.title)}</b></span>`
    + `${report.summary ? `<span class="text">${h(report.summary.length > 400 ? `${report.summary.slice(0, 399)}…` : report.summary)}</span>` : ""}`
    + `<span class="dr-meta">${where ? `<span title="${h(report.diff!.paths.join("\n"))}">${where}</span>` : ""}${report.headline ? `<span>${h(report.headline)}</span>` : ""}${actions ? `<span class="dr-actions">${actions}</span>` : ""}</span>`
    + `<span class="request-meta"><time>${clock(run.createdAt).slice(0, 5)}</time></span></div>`;
}
/// What Drive asked its coder is Drive's words, not yours: one quiet line on
/// the guide with its first sentence, unfolding to the whole request.
function driveAsked(run: WorkspaceRun): string | null {
  if (!run.fromDrive) return null;
  const said = run.content.trim(), key = `drive-asked:${run.id}`, open = detailsOpen.has(key);
  const first = said.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
  const line = `${run.planOnly ? "Drive asked the coder for a plan" : "Drive asked the coder"}: ${first.length > 96 ? `${first.slice(0, 95)}…` : first}`;
  const fold = btn("drive-asked", `${h(line)}${CHEVRON}`, { key }, `ds-what ds-fold${open ? " open" : ""}`).replace("<button ", `<button aria-expanded="${open}" `);
  return `<div class="drive-asked"><span class="ds-mark" aria-hidden="true">→</span>${fold}<time>${clock(run.createdAt).slice(0, 5)}</time></div>${open ? `<div class="ds-said">${h(said)}</div>` : ""}`;
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
    const sign = now ? stepIcon(tool) : `<span class="${tone(tool.state)}">${mark(tool.state)}</span>`;
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
  // A server that starts during the newest turn unfolds its page once.
  const newest = state.runs.at(-1);
  for (const entry of newest?.entries ?? []) {
    if (entry.type !== "tool" || !serving(entry)) continue;
    const key = `${newest!.id}:${entry.id}`;
    if (!previewSeen.has(key)) { previewSeen.add(key); stepOpen.add(key); }
  }
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
        return record ? `${key}:${record.outputLoaded}:${record.stdout.length}:${record.stderr.length}:${record.serves}:${previewOutput.has(key)}` : key;
      }),
      state.questions.length > 0,
      active(run) ? state.queue : "",
      state.activeTurnId,
      reviewOpen.has(run.id) ? reviewVersion : 0,
      detailsOpen.has(`drive-asked:${run.id}`),
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
    running = worktreeRun().fix,
    branchKeys = [...detailsOpen].filter((key) => key.startsWith("branch:")),
    signature = JSON.stringify([state.workspace, review.map((job) => [job.id, job.status, job.title, job.diff, job.summary, job.checks]), running && [running.id, running.title, running.activity], state.breakage.busy, state.breakage.message, branchKeys, driveShown, away?.status, driveBusy, reviewShown, ideasShown, next.proposals, next.loading, next.signals.length, user, branch, hour]);
  if (signature === heroSignature) return;
  heroSignature = signature;
  const composer = el("composer-slot");
  composer.remove();
  const name = state.workspace.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || state.workspace;
  // Drive's finished branches are one line; it unfolds a quiet row per
  // branch right under it, and what the last Apply or PR did follows them.
  const waiting = (review.length
    ? `<p>${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review ${reviewShown ? "⌄" : "›"}`, {}, "link")}<span class="muted"> · ${away && away.status !== "running" ? "Drive ran them while you were away" : "each in its own worktree"}</span></p>${reviewShown ? `<div class="hero-branches">${branchRows(review)}</div>` : ""}`
    : "") + branchNote();
  // A greeting and the composer, nothing else: Drive's best idea is the
  // composer's ghost text (Tab takes it); the rest of its ideas unfold from
  // one quiet line under the composer.
  const day = new Date().toLocaleDateString(undefined, { weekday: "long" }),
    when = `${day} ${hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}`,
    where = branch ? `${h(name)} on ${h(branch)}` : h(name);
  const ideas = next.proposals.length;
  const drive = ideas || driveBusy
    ? `<p class="hero-drive">${ICON_SPARK}<b>Drive</b>${driveBusy ? ` ${running ? btn("drive-show", `is working ${driveShown ? "⌄" : "›"}`, {}, "link") : "is working"}` : ` has ${ideas} idea${ideas === 1 ? "" : "s"}`}${ideas ? ` <span class="muted">·</span> ${btn("ideas-show", ideasShown ? "hide" : "show ›", {}, "link")}` : ""}</p>${ideas && ideasShown ? `<div class="hero-ideas">${proposalRows(next.proposals)}<p class="proposals-footer">${btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", next.loading)}${next.generatedAt ? `<span class="muted"> · looked ${age(next.generatedAt)}</span>` : ""}</p></div>` : ""}${running && driveShown ? `<div class="hero-branches">${branchRows([running])}</div>` : ""}`
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
async function answerQuestion(value: string | null, source: "typed" | "suggestion" | "skipped" = "typed") {
  const q=pendingQuestion(); if(!q || (source !== "skipped" && !value?.trim()) || answeringQuestion)return;
  clearTimeout(draftTimer);
  const key=`${q.id}:${questionIndex()}`;
  answeringQuestion=true;renderComposer();
  try {
    await api("question-action",{id:q.id,action:{action:"answer",index:questionIndex(),revision:q.revision ?? 0,
      answer:{source,answer:source === "skipped" ? null : value!.trim()}}});
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
  const saved: Mode = state?.planOnly ? "plan" : state?.session?.autoApprove ? "auto" : state?.session?.acceptEdits ? "edits" : "ask";
  // A step still on its way to the host wins, so quick presses keep stepping.
  if (pendingMode && pendingMode.mode !== saved && Date.now() < pendingMode.until) return pendingMode.mode;
  pendingMode = null;
  return saved;
}
let pendingMode: { mode: Mode; until: number } | null = null;
let modeHintTimer: ReturnType<typeof setTimeout> | undefined;
/** Steps to the next mode and opens the word into all four for a moment. */
async function cycleMode(step = 1) {
  const order = Object.keys(MODES) as Mode[];
  const next = order[(order.indexOf(currentMode()) + step + order.length) % order.length]!;
  // The word opens into all four modes where it sits, the new one lit, and
  // folds back to one word a moment later.
  pendingMode = { mode: next, until: Date.now() + 3_000 };
  const chip = el("composer-mode");
  for (const option of chip.querySelectorAll<HTMLElement>(".mode-opt")) option.classList.toggle("on", option.dataset.mode === next);
  chip.classList.add("open");
  clearTimeout(modeHintTimer);
  modeHintTimer = setTimeout(() => chip.classList.remove("open"), 1600);
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
  chip.className = `cb mode-${mode}${chip.classList.contains("open") ? " open" : ""}`;
  if (!chip.querySelector(".mode-opt")) chip.innerHTML = `<span class="mode-list">${(Object.keys(MODES) as Mode[]).map((item) => `<span class="mode-opt mode-${item}" data-mode="${item}">${MODES[item]}</span>`).join("")}</span><kbd>⇧⇥</kbd>`;
  for (const option of chip.querySelectorAll<HTMLElement>(".mode-opt")) option.classList.toggle("on", option.dataset.mode === mode);
  chip.setAttribute("aria-label", `Mode: ${MODES[mode]}`);
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
    ? answered ? "Your answers are saved. Choose Resume to continue." : question.status === "paused" ? "Type your answer to carry on…" : question.questions[questionIndex()]?.suggestions?.length ? "Answer, or pick one above…" : "Type your answer…"
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
  // Another agent changed the file since this chat read it: one amber line
  // that names the agent; asking it first is the default (Enter).
  if (approval.overlap) {
    const agent = approval.overlap.agents[0]!, others = approval.overlap.agents.length - 1;
    const file = approval.overlap.path.split("/").pop() ?? approval.overlap.path;
    slot.innerHTML = `<div class="approval-row overlap" role="group" aria-label="Another agent changed this file" title="${h(`${agent.name} ${agentPlace(agent)} · ${agent.address}`)}">${agentMark(agent)}<span class="approval-verb">${h(agent.name)}${others ? ` and ${others} more` : ""}</span><span class="approval-note">changed</span><code title="${h(approval.overlap.path)}">${h(file)}</code><span class="approval-note">since this chat read it</span><span class="approval-space"></span>`
      + btn("permission", `Ask it first ${k("↵")}`, { id: approval.id, decision: "deny" }, "allow")
      + btn("permission", "Change anyway", { id: approval.id, decision: "allow_once" }, "deny")
      + `</div>`;
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
  // A command is named on the row; where it runs and its full path are on
  // hover, so it has nothing to unfold. An edit unfolds its diff.
  const where = `${command}\nin ${folder} · not sandboxed${approval.summary && approval.summary !== command && !approval.summary.startsWith("host command") ? ` · ${approval.summary}` : ""}`;
  slot.innerHTML =
    `<div class="approval-row" role="group" aria-label="Approval">${icon}<span class="approval-verb">${h(verb)}</span>${target ? `<code${isCommand ? ` title="${h(where)}"` : ""}>${h(target)}</code>` : ""}${isCommand ? "" : `<span class="approval-note">· ${note}</span>`}<span class="approval-space"></span>` +
    (isCommand ? "" : btn("approval-show", approvalOpen ? "hide" : hunks ? "diff" : "details", {}, `approval-show${approvalOpen ? " open" : ""}`)) +
    btn("permission", `Allow ${k("↵")}`, { id: approval.id, decision: "allow_once" }, "allow") +
    (approval.rule ? btn("permission", "Always", { id: approval.id, decision: "allow_always" }, "always").replace("<button ", `<button title="${h(scope)} · saved to your config (${h(approval.rule)})" `) : "") +
    btn("permission", `Deny ${k("Esc")}`, { id: approval.id, decision: "deny" }, "deny") +
    `</div>${isCommand ? "" : `<div class="approval-fold command-inset"${approvalOpen ? "" : " hidden"}>${preview}</div>`}`;
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
/// Drive's worktree branches as one line each, like its ideas: a mark, the
/// title, what changed on the right, which gives way to Apply, PR, Discard
/// and diff when you point at it. Clicking a title unfolds what Drive says it
/// did and how its checks went, in words under the row.
function branchRows(jobs: NonNullable<Snapshot["breakage"]["fix"]>[]) {
  const busy = state!.breakage.busy, pending = Boolean(busy);
  const doing = (action: string, label: string, idle: string) => (busy === action ? label : idle);
  return `<div class="bf-rows">${jobs.map((job) => {
    const key = `branch:${job.id}`, open = detailsOpen.has(key);
    const kind = job.mission ? "Mission" : job.proposal ? "Proposal" : "Fix";
    const title = btn("branch-more", h(job.title), { key }, `bf-title${open ? " open" : ""}`).replace("<button ", `<button aria-expanded="${open}" title="${h(`${kind} on ${job.branch}`)}" `);
    if (job.status === "starting" || job.status === "running") {
      const activity = job.activity ? `${job.activity.steps} step${job.activity.steps === 1 ? "" : "s"}` : "starting";
      return `<div class="bf-row branch"><span class="bf-dot idea live" aria-hidden="true"></span>${title}<span class="bf-r">${activity}</span><span class="bf-act">${btn("breakage-discard", doing("discard", "Stopping…", "Stop"), { id: job.id }, "", pending)}</span></div>${open && job.activity?.last ? `<p class="bf-sum">${h(job.activity.last)}</p>` : ""}`;
    }
    if (job.status === "failed") {
      const why = job.unchanged ? "no changes" : "couldn't finish";
      return `<div class="bf-row branch"><span class="bf-dot ${job.unchanged ? "hollow" : "bad"}" aria-hidden="true"></span>${title}<span class="bf-r">${why}</span><span class="bf-act">${btn("breakage-discard", doing("discard", "Discarding…", "Discard"), { id: job.id }, "", pending)}</span></div>${open ? `<p class="bf-sum">${h([job.error, job.summary].filter(Boolean).join(" ") || "It failed.")}</p>` : ""}`;
    }
    const paths = job.diff?.paths ?? [];
    const where = job.diff ? `<span class="add">+${job.diff.additions}</span> <span class="del">−${job.diff.deletions}</span>` : "";
    // A workflow mission counts its steps, each with the check Drive ran for it.
    const run = state!.drive?.workflow && state!.drive.homeSessionId === job.sessionId ? state!.drive.workflow : null;
    const checks = run
      ? run.steps.map((step, index) => ({ ok: index < run.current && (!step.check || Boolean(step.result?.ok)), text: `${step.title}${step.check ? ` · ${step.check.command}` : ""}` }))
      : (job.checks ?? []).map((check) => ({ ok: check.passed, text: check.command }));
    const passed = checks.filter((row) => row.ok).length;
    const verdict = !checks.length ? "No checks ran."
      : run ? `${passed} of ${checks.length} steps passed.`
      : passed === checks.length ? `${checks.length === 1 ? "Its check" : `All ${checks.length} checks`} passed.` : `${checks.length - passed} of ${checks.length} checks failed.`;
    const proof = `<span class="${!checks.length ? "muted" : passed === checks.length ? "pass" : "fail"}"${checks.length ? ` title="${h(checks.map((row) => `${row.ok ? "✓" : "✕"} ${row.text}`).join("\n"))}"` : ""}>${h(verdict)}</span>`;
    const files = paths.length ? `<span class="muted"> ${h(paths.length === 1 ? paths[0]! : `${paths.length} files`)}</span>` : "";
    const receipt = job.receipt ? ` ${btn("breakage-receipt", "copy receipt", { id: job.id }, "link")}` : "";
    return `<div class="bf-row branch"><span class="bf-dot ok" aria-hidden="true"></span>${title}<span class="bf-r"${paths.length ? ` title="${h(paths.join("\n"))}"` : ""}>${where}</span><span class="bf-act">${btn("breakage-apply", doing("apply", "Applying…", "Apply"), { id: job.id }, "primary", pending).replace("<button ", '<button title="Apply to my branch" ')}${btn("breakage-pr", doing("pr", "Opening…", "PR"), { id: job.id }, "", pending).replace("<button ", '<button title="Open a pull request" ')}${btn("breakage-discard", doing("discard", "Discarding…", "Discard"), { id: job.id }, "", pending)}${job.sessionId ? btn("review-diff", "diff ›", { id: job.sessionId }, "") : ""}</span></div>${open ? `<p class="bf-sum">${job.summary ? `${h(job.summary)} ` : ""}${proof}${files}${receipt}</p>` : ""}`;
  }).join("")}</div>`;
}
/// What the last Apply, PR or Discard did, as one quiet line where the
/// branches were, with Open › for a PR and × to put it away.
function branchNote() {
  const message = state?.breakage.message;
  if (!message) return "";
  return `<p class="bf-msg ${message.tone}"><span class="bf-dot ${message.tone === "ok" ? "ok" : "bad"}" aria-hidden="true"></span><span>${h(message.text)}</span>${message.url ? btn("breakage-open", "Open ›", {}, "link") : ""}${btn("breakage-close", "×", {}, "bf-x").replace("<button ", '<button aria-label="Dismiss" ')}</p>`;
}
function renderQuestion() {
  if (!state) return;
  const question = state.questions[0],
    signature = JSON.stringify(question);
  if (signature === questionSignature) return;
  questionSignature = signature;
  const index=question?.answers?.length ?? 0, answered=question && index>=question.questions.length,
    item=question?.questions[Math.min(index,question.questions.length-1)];
  // The model asking you is its next line in the conversation: the amber
  // ring that means "needs you", the question, and its suggested answers.
  const paused = question?.status === "paused", choices = answered || !item ? [] : item.suggestions ?? [];
  const foot = answered || paused
    ? `<span>${answered ? "Answered" : "Paused"}</span>${btn("question-control", "Resume", { action: "resume" }, "ask-link")}`
    : btn("question-skip", "Skip this question", {}, "ask-link");
  el("question").innerHTML = question && item
    ? `<div class="ask-q"><span class="ask-mark" aria-hidden="true"></span><div class="ask-body"><p class="ask-text">${h(item.question)}${question.questions.length > 1 ? `<small>${Math.min(index + 1, question.questions.length)} of ${question.questions.length}</small>` : ""}</p>${item.reason ? `<p class="ask-why">${h(item.reason)}</p>` : ""}${answered ? `<p class="ask-why">${h(question.answers?.at(-1)?.answer ?? "Skipped")}</p>` : ""}${choices.length ? `<div class="ask-choices">${choices.map((choice, n) => btn("question-pick", `<kbd>${n + 1}</kbd>${h(choice)}`, { text: choice }, "ask-choice")).join("")}</div>` : ""}<div class="ask-foot">${foot}</div></div></div>`
    : "";
  // A new question scrolls into view, as a new answer would.
  if (question && question.id !== questionShown) el("stage").scrollTop = el("stage").scrollHeight;
  questionShown = question?.id ?? "";
}
let questionShown = "";
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
/// A quiet line where the conversation ends: branches waiting for review,
/// and what Drive is doing or would do next. Its chevron turns the line into
/// Drive's reply, unfolding the rows under it; closing folds them away again.
let briefingSignature = "";
function renderBriefing() {
  if (!state) return;
  const node = el("briefing");
  const review = reviewJobs(), pinned = pinnedMission(), run = worktreeRun(), away = state.breakage.away, next = state.driveNext;
  if (!review.length) reviewShown = false;
  const signature = JSON.stringify([
    inSession(), review.map((job) => [job.id, job.status, job.title, job.diff]), reviewShown, away?.status,
    pinned && (driveShown && !driveTurnMission() ? [pinned, detailsOpen.has("drive-details"), [...detailsOpen].filter((key) => key.startsWith("drive-step:")), Math.floor(Date.now() / 10_000)] : [pinned.status, pinned.mission, driveTurnMission() ? driveProgress(pinned) : activeMinutes(pinned)]),
    run.fix && [run.fix.title, run.fix.status], run.away && [run.away.auto, run.away.items.map((item) => item.state)], state.breakage.auto,
    // Whether the mission is this chat's own turn: switching between it and
    // the chat it came from changes the line even when nothing else does.
    Boolean(driveTurnMission()),
    state.breakage.signals, state.breakage.busy, state.breakage.message, inSession(), run.fix?.activity, [...detailsOpen].filter((key) => key.startsWith("branch:")), brokeShown, driveShown, ideasShown, tellOpen, tellSent, pinned?.told?.length, next.proposals, next.error, next.loading, next.generatedAt && age(next.generatedAt), driveActionPending,
  ]);
  if (signature === briefingSignature) return;
  briefingSignature = signature;
  const parts: string[] = [];
  // Something broke (CI on main, a failing check): the line says so first,
  // and unfolds with what failed and Drive's offer to fix it in a worktree.
  const signals = state.breakage.signals, fixing = Boolean(state.breakage.fix && ["starting", "running"].includes(state.breakage.fix.status));
  const broke = signals.length > 0 && !fixing;
  if (!broke) brokeShown = false;
  const mark = (kind: "spin" | "idea" | "amber" | "ok" | "bad" | "hollow") => kind === "spin" ? spinner() : `<span class="bf-dot ${kind}" aria-hidden="true"></span>`;
  let fold = "", toggle: { action: string; open: boolean } | null = null, progress: number | null = null;
  if (review.length && !broke) {
    const only = review.length === 1 ? review[0]! : null;
    const about = only && reviewShown ? "" : only ? `${only.title}${only.diff ? ` · +${only.diff.additions} −${only.diff.deletions}` : ""}` : away && away.status !== "running" ? "Drive ran them while you were away" : "";
    parts.push(`${mark("ok")}${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review`, {}, "bf-word")}${about ? `<span class="bf-about">${h(about)}</span>` : ""}`);
  }
  const label = (drive: NonNullable<Snapshot["drive"]>) => drive.status === "blocked" ? "Drive stopped" : drive.status === "paused" ? "Drive is paused" : "Drive is working";
  const driveMark = (drive: NonNullable<Snapshot["drive"]>) => mark(drive.status === "blocked" ? "amber" : drive.status === "paused" ? "idea" : "spin");
  if (broke) {
    const first = signals[0]!, ci = /CI failure on (\S+)/.exec(first.title);
    const word = signals.length > 1 ? `${signals.length} things broke` : ci ? `CI failed on ${ci[1]}` : first.source === "checks" ? "A check is failing" : first.title;
    const about = signals.length > 1 ? "" : first.detail.replace(/^Latest run exit (\S+) at \S+\.\s*/, "");
    parts.push(`${mark("bad")}${btn("broke-show", word, {}, "bf-word bad")}${about && !brokeShown ? `<span class="bf-about">${h(about)}</span>` : ""}`);
    toggle = { action: "broke-show", open: brokeShown };
    if (brokeShown) {
      const busy = state.breakage.busy;
      fold = `<div class="bf-rows">${signals.map((signal) => `<div class="bf-row broke"><span class="bf-dot bad" aria-hidden="true"></span><span class="bf-title">${h(signal.title)}</span><span class="bf-r">${h(signal.detail.replace(/^Latest run exit (\S+) at \S+\.\s*/, "exit $1 · "))}</span></div>`).join("")}</div><p class="bf-note">Drive can fix it in its own worktree. This chat and your files stay as they are until you apply it.</p><p class="bf-foot">${[
        btn("breakage-fix", busy === "fix" ? "Starting…" : "Fix in a worktree", {}, "primary", Boolean(busy)),
        btn("breakage-dismiss", "Not now", {}, "link"),
        btn("breakage-never", "Never for this", {}, "link"),
      ].join('<span class="bf-sep">·</span>')}</p>`;
    }
  } else if (pinned && driveTurnMission()) {
    // The mission is the conversation's newest turn; the strip only says how far it has got.
    const tasks = driveTaskList(pinned), done = tasks.filter((task) => task.mark === "✓").length;
    if (tasks.length > 1) progress = done / tasks.length;
    const about = driveProgress(pinned);
    parts.push(`${driveMark(pinned)}<b class="bf-word${pinned.status === "blocked" ? " amber" : ""}">${label(pinned)}</b>${about ? `<span class="bf-about">${h(about)}</span>` : ""}`);
  } else if (pinned) {
    const time = activeMinutes(pinned);
    // Working in its own chat: the line says what on, with the shine.
    const working = pinned.status === "running" || pinned.status === "waiting";
    const about = working ? time : `${missionTitle(pinned)}${time ? ` · ${time}` : ""}`;
    parts.push(`${driveMark(pinned)}${btn("drive-show", working ? shine(`Working on ${missionTitle(pinned)}`) : label(pinned), {}, `bf-word${pinned.status === "blocked" ? " amber" : ""}`)}${about ? `<span class="bf-about">${h(about)}</span>` : ""}`);
    // You can write to it from here; it reads your note before its next step.
    parts.push(btn("drive-tell-open", "Tell Drive", {}, `bf-tell${tellOpen ? " on" : ""}`));
    toggle = { action: "drive-show", open: driveShown };
    const tell = tellOpen ? `<form class="drive-tell" id="drive-tell-form"><input name="note" maxlength="2000" autocomplete="off" placeholder="${pinned.status === "blocked" ? "Answer Drive, and it goes again…" : "Tell Drive…"}" aria-label="Tell Drive"><kbd>↵</kbd></form>${tellSent ? '<p class="dt-sent">✓ Sent to Drive · read before its next step</p>' : ""}` : "";
    if (tellOpen || driveShown) fold = `${tell}${driveShown ? `<div class="drive-live">${pinnedCard(pinned)}</div>` : ""}`;
  } else if (run.fix || run.away) {
    const about = run.fix ? run.fix.title : `Drive's list · ${run.away!.items.filter((item) => !["queued", "running"].includes(item.state)).length} of ${run.away!.items.length} done`;
    parts.push(`${mark("spin")}${btn("drive-show", run.away?.auto ? "Drive is working on its own" : "Drive is working", {}, "bf-word")}<span class="bf-about">${h(about)}</span>`);
    if (run.fix) {
      toggle = { action: "drive-show", open: driveShown };
      if (driveShown) fold = `${branchRows([run.fix])}${run.away ? `<p class="bf-foot">${btn("breakage-away-stop", "Stop after this one", {}, "link", Boolean(state.breakage.busy))}</p>` : ""}`;
    }
  } else if (next.error && !next.proposals.length) {
    parts.push(`${mark("amber")}<span class="bf-word">Drive couldn't look for ideas</span>${btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", next.loading)}`);
  } else if (next.proposals.length) {
    const count = next.proposals.length, auto = state.breakage.auto;
    const title = `${count === 1 ? "One thing" : `${["", "", "Two", "Three", "Four", "Five"][count] ?? count} things`} I could do next`;
    const ideasWord = `${count} idea${count === 1 ? "" : "s"}`;
    if (auto && !auto.on) {
      // Off here: it only runs what you start.
      parts.push(`${mark("hollow")}<b class="bf-word">Drive is off here</b>`, btn("ideas-show", ideasShown ? title : ideasWord, {}, "bf-word"), btn("drive-auto", "Turn on", { on: true }, "link"));
    } else {
      parts.push(`${mark("idea")}${btn("ideas-show", ideasShown ? title : `Drive has ${ideasWord}`, {}, "bf-word")}`);
      // On by default: the line says what Drive will do before it does it.
      if (auto) {
        const limits = `Up to ${auto.perDay} runs a day in this project, one at a time. Each run is in its own worktree; it never pushes or opens a PR. ${auto.usedToday} of ${auto.perDay} used today.`;
        const when = auto.usedToday >= auto.perDay ? "done for today" : `starts the first after ${auto.quietMinutes} quiet minutes`;
        parts.push(`<span class="bf-about" title="${h(limits)}">${when}</span>`, btn("drive-auto", "Turn off", { on: false }, "link"));
      }
    }
    toggle = { action: "ideas-show", open: ideasShown };
    if (ideasShown) {
      fold = `${ideaRows(next.proposals)}<p class="bf-foot">${[
        btn("next-run", "Run the first now", { id: next.proposals[0]!.id }, "link"),
        btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", next.loading),
        next.generatedAt ? `<span>looked ${age(next.generatedAt)}</span>` : "",
      ].filter(Boolean).join('<span class="bf-sep">·</span>')}</p>`;
    }
  }
  // Finished branches unfold as rows under the line, whatever else it says.
  if (review.length && !broke) {
    toggle ??= { action: "review-open", open: reviewShown };
    if (reviewShown) { fold = branchRows(review); toggle = { action: "review-open", open: true }; }
  }
  // What the last Apply, PR or Discard did is its own quiet line in the
  // conversation, never part of Drive's line.
  const done = el("branch-done"), outcome = inSession() ? branchNote() : "";
  done.innerHTML = outcome;
  done.hidden = !outcome;
  node.hidden = !inSession() || !parts.length;
  if (node.hidden) { node.innerHTML = ""; el("drive-reply").hidden = true; el("drive-reply").classList.remove("open"); return; }
  const chevron = toggle ? btn(toggle.action, CHEVRON, {}, "bf-chev").replace("<button ", `<button aria-label="${toggle.open ? "Hide" : "Show"}" aria-expanded="${toggle.open}" `) : "";
  // The first part's mark sits in the conversation's mark column, like an answer's d.
  const lead = /^<span class="bf-(?:spin|dot)[^>]*><\/span>/.exec(parts[0]!)?.[0] ?? "";
  parts[0] = parts[0]!.slice(lead.length);
  const chip = `${parts.map((part) => `<span class="bf-part">${part}</span>`).join('<span class="bf-sep">·</span>')}${chevron}`;
  node.innerHTML = `<span class="bf-lead${fold ? " open" : ""}${broke ? " bad" : ""}">${fold && !broke ? ICON_SPARK : lead}</span><div class="bf-chip">${chip}</div>${progress !== null ? `<span class="bf-progress"><i style="width:${Math.round(progress * 100)}%"></i></span>` : ""}`;
  node.classList.toggle("open", Boolean(fold));
  // Opening turns the line into Drive speaking in the conversation: its rows
  // unfold under it and scroll with everything else, so nothing is covered.
  const reply = el("drive-reply"), open = Boolean(fold), shown = reply.classList.contains("open");
  if (!open && shown) {
    reply.classList.remove("open");
    setTimeout(() => { if (!reply.classList.contains("open")) { reply.hidden = true; reply.innerHTML = ""; } }, 320);
    return;
  }
  if (!open) return;
  // A note half typed survives Drive's own updates redrawing the reply.
  const typing = reply.querySelector<HTMLInputElement>("#drive-tell-form input"), kept = typing && { value: typing.value, focus: document.activeElement === typing };
  reply.innerHTML = `<div class="dr-fold"><div><div class="dr-body">${fold}</div></div></div>`;
  const note = reply.querySelector<HTMLInputElement>("#drive-tell-form input");
  if (note && kept) { note.value = kept.value; if (kept.focus) note.focus({ preventScroll: true }); }
  reply.hidden = false;
  if (shown) { reply.classList.add("open"); return; }
  void reply.offsetHeight;
  const stage = el("stage"), end = performance.now() + 340;
  requestAnimationFrame(() => reply.classList.add("open"));
  const follow = () => { stage.scrollTop = stage.scrollHeight; if (performance.now() < end) requestAnimationFrame(follow); };
  follow();
}
/// Folds Drive's reply away if it is open; true when it was.
function closeBriefingCard() {
  if (!el("briefing").classList.contains("open")) return false;
  driveShown = false;
  ideasShown = false;
  brokeShown = false;
  tellOpen = false;
  renderBriefing();
  return true;
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
/// "4 steps": how many things Drive has done on this mission.
const stepCount = (drive: NonNullable<Snapshot["drive"]>) => `${drive.steps.length} step${drive.steps.length === 1 ? "" : "s"}`;
/// The mission's limits in words, for the tokens tooltip.
function driveBudget(drive: NonNullable<Snapshot["drive"]>) {
  const guard = drive.protection;
  return guard ? `${Math.floor(guard.used.activeMs / 60_000)} of ${guard.limits.maxActiveMinutes} active minutes · ${guard.used.cycles} of ${guard.limits.maxCycles} cycles · ${guard.used.workerRequests} of ${guard.limits.maxWorkerRequests} coder requests` : "";
}
/// Drive's steps as quiet lines on the same thin guide as tool calls: what it
/// did and when. What it asked the coder unfolds under its line, in words.
function driveSteps(drive: NonNullable<Snapshot["drive"]>) {
  const now = Date.now(), trace = drive.traces?.at(-1);
  const rows = drive.steps.slice(-8).map((step) => {
    const line = driveStepLine(step);
    let action: { kind?: string; text?: string } = {};
    try { action = JSON.parse(step.action) as typeof action; } catch { /* an older journal */ }
    const said = ["compose", "redirect"].includes(action.kind ?? "") ? String(action.text ?? "").trim() : "";
    const key = `drive-step:${step.at}`, open = detailsOpen.has(key);
    const first = said.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
    const text = said ? `${action.kind === "redirect" ? "Redirected the coder" : "Asked the coder"}: ${first.length > 72 ? `${first.slice(0, 71)}…` : first}` : line.text;
    const what = said ? btn("drive-step", `${h(text)}${CHEVRON}`, { key }, `ds-what ds-fold${open ? " open" : ""}`).replace("<button ", `<button aria-expanded="${open}" `) : `<span class="ds-what">${h(text)}</span>`;
    return `<li class="ds tone-${line.tone}"><span class="ds-mark" aria-hidden="true">${h(line.mark === "·" ? "✓" : line.mark)}</span>${what}<time>${h(driveSince(step.at, now))}</time></li>${said && open ? `<li class="ds-said">${h(said)}</li>` : ""}`;
  });
  const deciding = Boolean(trace && ["queued", "thinking", "drafting", "acting"].includes(trace.status));
  if (deciding || drive.status === "waiting") rows.push(`<li class="ds now"><span class="ds-mark" aria-hidden="true">◌</span><span class="ds-what">${deciding ? "Deciding the next step" : "Waiting for the coder"}</span><time>now</time></li>`);
  return `<ol class="drive-steps">${rows.join("")}</ol>`;
}
function missionParts(drive: NonNullable<Snapshot["drive"]>) {
  const now = Date.now(), trace = drive.traces?.at(-1);
  const deciding = Boolean(trace && ["queued", "thinking", "drafting", "acting"].includes(trace.status));
  const [mark, label, tone] = drive.recovery && drive.recovery.retryAt > now
    ? ["↻", `Retrying in ${Math.ceil((drive.recovery.retryAt - now) / 1000)}s`, "thinking"]
    : drive.protection?.trip ? ["■", "Stopped at a limit", "signal"]
    : drive.status === "paused" ? ["‖", "Paused", "secondary"]
    : drive.status === "blocked" ? ["■", "Stopped", "signal"]
    : drive.status === "completed" ? ["✓", "Mission complete", "citron"]
    : drive.status === "waiting" ? ["◌", "Coder is working", "secondary"]
    : drive.status === "stopped" ? ["■", "Stopped", "secondary"]
    : drive.status === "idle" ? ["·", "Idle · nothing worthwhile left", "secondary"]
    : deciding ? ["◇", "Deciding…", "thinking"] : ["●", "Live", "citron"];
  const summary = drive.protection?.trip?.reason ?? drive.steps.at(-1)?.note ?? drive.activity;
  const tasks = driveTaskList(drive);
  const used = drive.protection?.used;
  const active = used ? (used.activeMs < 3_600_000 ? `${Math.round(used.activeMs / 60_000)}m` : `${Math.floor(used.activeMs / 3_600_000)}h ${Math.round((used.activeMs % 3_600_000) / 60_000)}m`) : "";
  const planner = trace?.source === "controller" ? "Local controller" : (drive.model ?? state!.model.id).split("/").at(-1)!.trim();
  const stats = [drive.workflow ? `${drive.workflow.name} · step ${Math.min(drive.workflow.current + 1, drive.workflow.steps.length)} of ${drive.workflow.steps.length}` : `step ${drive.step}`, active, used ? `${num(used.planningTokens + used.workerTokens)} tokens` : "", drive.mode === "continuous" ? "continuous" : "bounded", planner].filter(Boolean).join(" · ");
  const title = missionTitle(drive);
  return {
    mark, label, tone, summary, title, stats,
    tasks: tasks.length ? `<ul class="drive-tasks">${tasks.map((task) => `<li class="tone-${task.tone}">${h(task.mark)} ${h(task.text)}</li>`).join("")}</ul>` : "",
  };
}
/// Why a stopped mission stopped, and what Resume will do, in a sentence each.
function stoppedWords(drive: NonNullable<Snapshot["drive"]>) {
  const reason = drive.activity?.trim() || drive.steps.at(-1)?.note || "Drive stopped without recording a reason.";
  const hint = drive.protection?.trip
    ? "Resume keeps going with the same limits; a new /drive mission starts fresh ones."
    : /^Could not save Drive progress/.test(reason)
      ? "Drive couldn't save its progress. Check free space for the demesne data folder, then Resume."
      : drive.feedback?.startsWith("Last rejected decision")
        ? "Its planner kept choosing steps it couldn't carry out. Resume retries once; if it stops again, reword the mission or switch the model."
        : "Resume retries the step it stopped on. Tell Drive anything it should know first.";
  return { reason: drive.protection?.trip?.reason ?? reason, hint };
}
/// The live (or paused, or blocked) mission's card: in the Drive panel, and
/// unfolded from the briefing line above the composer.
function pinnedCard(pinned: NonNullable<Snapshot["drive"]>) {
  // Drive speaking, like an answer: what it is doing now, its steps on the
  // same thin guide as tool calls, and one quiet line of facts and words.
  const parts = missionParts(pinned), live = pinned.status === "running" || pinned.status === "waiting";
  // A stopped mission says why, and what Resume will do, in the same voice.
  const stopped = pinned.status === "blocked" ? stoppedWords(pinned) : null;
  const status = stopped ? `Stopped · ${stopped.reason}` : parts.label === "Live" ? parts.summary ?? "Working" : `${parts.label}${parts.summary ? ` · ${parts.summary}` : ""}`;
  const now = `<p class="dm-now">${parts.label === "Live" ? '<span class="dm-live" aria-hidden="true"></span>' : `<span class="dm-mark tone-${parts.tone}" aria-hidden="true">${h(parts.mark)}</span>`}<span>${h(status)}</span></p>`;
  const steps = driveTaskList(pinned).map((task) => {
    const kind = task.mark === "✓" ? "done" : task.mark === "◌" ? "on" : "next";
    return `<li class="dm-step ${kind}"><span class="dm-step-mark" aria-hidden="true">${kind === "done" ? "✓" : kind === "on" ? "" : ""}</span><span>${h(task.text)}</span></li>`;
  });
  // Only facts with something to say: no "0 tokens" or "step 0".
  const used = pinned.protection?.used, tokens = used ? used.planningTokens + used.workerTokens : 0;
  const facts = [activeMinutes(pinned), tokens ? `${num(tokens)} tokens` : ""].filter(Boolean).map((fact) => `<span title="${h(driveBudget(pinned))}">${h(fact)}</span>`);
  const open = detailsOpen.has("drive-details");
  const words = [
    pinned.homeSessionId !== state?.session?.id ? btn("select-session", "Watch", { id: pinned.homeSessionId }, "dm-word") : "",
    btn("drive-control", live ? "Pause" : "Resume", { control: live ? "pause" : "resume" }, "dm-word"),
    btn("drive-control", "Stop", { control: "stop" }, "dm-word stop"),
    pinned.steps.length ? btn("drive-details", `${stepCount(pinned)}${CHEVRON}`, {}, `dm-word dm-more${open ? " open" : ""}`).replace("<button ", `<button aria-expanded="${open}" `) : "",
  ].filter(Boolean);
  const evidence = stopped && open ? (pinned.evidence ?? []).slice(-2).filter((item) => item.quote?.trim()).map((item) => `<blockquote class="dm-quote">${h(item.quote.length > 400 ? `${item.quote.slice(0, 399)}…` : item.quote)}</blockquote>`).join("") : "";
  return `<section class="drive-mission${stopped ? " stopped" : ""}" aria-label="${stopped ? "Stopped mission" : "Live mission"}">${now}${stopped ? `<p class="dm-why">${h(stopped.hint)}</p>` : ""}${steps.length ? `<ol class="dm-steps">${steps.join("")}</ol>` : ""}${toldNotes(pinned)}<p class="dm-foot">${[...facts, ...words].join('<span class="bf-sep">·</span>')}</p>${open ? `${driveSteps(pinned)}${evidence}` : ""}</section>`;
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
  const signature = JSON.stringify([drive, worktree, retry, detailsOpen.has("drive-details"), [...detailsOpen].filter((key) => key.startsWith("drive-step:")), drive ? Math.floor(now / 10_000) : 0]);
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
    node.innerHTML = `${ask}<div class="response">${pinnedCard(drive)}</div>`;
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
    used ? `<span title="${h(driveBudget(drive))}">${num(used.planningTokens + used.workerTokens)} tokens</span>` : "",
    drive.recovery?.attempt && !retry ? `retried ${drive.recovery.attempt === 1 ? "once" : `${drive.recovery.attempt} times`}` : "",
  ].filter(Boolean).join('<span class="sep"> · </span>');
  const open = detailsOpen.has("drive-details");
  const actions = [
    btn("drive-control", live ? "pause" : "resume", { control: live ? "pause" : "resume" }, "link"),
    btn("drive-control", "stop", { control: "stop" }, "link danger"),
    drive.steps.length ? btn("drive-details", open ? "hide steps" : `${stepCount(drive)} ›`, {}, "link") : "",
  ].join("");
  const stage = el("stage"), bottom = follow;
  node.innerHTML = `${ask}<div class="response${live ? " running" : ""}"><ol class="drive-trail">${rows}</ol>${toldNotes(drive)}<div class="drive-turn-foot"><span class="drive-turn-meta">${meta}</span><span class="drive-turn-actions">${actions}</span></div>${open ? driveSteps(drive) : ""}</div>`;
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
    modelsMore = false;
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
  // Its right edge lines up with the chip; "More models" opens to the left.
  box.style.right = `${Math.max(12, main.right - anchor.right)}px`;
  box.style.bottom = `${main.bottom - anchor.top + 8}px`;
  box.style.maxHeight = `${Math.max(160, anchor.top - main.top - 20)}px`;
}
function renderModelPopover(hidden: number) {
  const open = modelsMore || Boolean(overlayQuery);
  let lastGroup = "";
  const item = (row: (typeof overlayRows)[number], index: number) => {
    const current = row.action === "model" && row.data.id === state!.model.id;
    const mark = current ? '<span class="mp-tick" aria-label="current">✓</span>' : row.kind === "short" ? `<span class="mp-key">${index + 1}</span>` : row.kind === "more" ? '<span class="mp-key">›</span>' : "";
    const label = row.kind === "rest" && row.group !== lastGroup ? `<div class="mp-group">${h(row.group ?? "")}</div>` : "";
    if (row.kind === "rest") lastGroup = row.group ?? "";
    const title = [row.value, row.description].filter(Boolean).join(" · ");
    return label + btn("choose-row", `<span class="name">${h(row.label)}</span>${mark}`, { index }, `mp-row${index === overlayIndex ? " selected" : ""}${row.kind === "more" && open ? " open" : ""}`)
      .replace("<button ", `<button ${row.kind === "more" ? 'data-more="1" ' : ""}${title ? `title="${h(title)}" ` : ""}`);
  };
  const rows = overlayRows.map((row, index) => [row, index] as const);
  const highlighted = overlayRows[overlayIndex],
    model = models.find((item) => item.id === (highlighted?.action === "model" ? highlighted.data.id : state!.model.id)),
    levels = model?.reasoningLevels ?? [],
    level = model ? modelLevel(model) : undefined;
  const thinking = model && levels.length
    ? `<div class="mp-thinking"><span>Thinking</span>${levels.map((item) => btn("model", h(item[0]!.toUpperCase() + item.slice(1)), { id: model.id, reasoning: item }, item === level ? "on" : "")).join("")}</div>`
    : "";
  const short = rows.filter(([row]) => row.kind === "short").map(([row, index]) => item(row, index)).join("");
  const more = rows.filter(([row]) => row.kind === "more").map(([row, index]) => item(row, index)).join("");
  const rest = rows.filter(([row]) => row.kind === "rest").map(([row, index]) => item(row, index)).join("");
  // The search box lives in the "More models" column; while that is shut it
  // stays focused but out of sight, so typing opens the column with matches.
  el("overlay").innerHTML =
    `<div class="mp-more${open ? "" : " shut"}"><input id="chooser-filter" placeholder="Search models…" aria-label="Filter models" value="${h(overlayQuery)}" autocomplete="off"><div class="mp-list">${rest || `<div class="mp-empty">${modelsLoading && !models.length ? "Loading models…" : "No matches."}</div>`}${hidden ? `<div class="mp-empty">${hidden} more · keep typing</div>` : ""}</div></div>` +
    `<div class="mp-main">${short || `<div class="mp-empty">${modelsLoading ? "Loading models…" : "No models."}</div>`}${thinking ? `<div class="mp-sep"></div>${thinking}` : ""}${more ? `<div class="mp-sep"></div>${more}` : ""}</div>`;
  el("overlay").querySelector(".mp-row.selected")?.scrollIntoView({ block: "nearest" });
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
      ...(window.demesne.mode === "desktop"
        ? [{
            title: "Notify me",
            description: "Mac banners when a chat waits on you, stops with an error, or Drive has a branch ready. Always also tells you when a chat finishes.",
            control: settingsSegments(NOTIFY_MODES.map(([mode, label]) => [label, notifyMode === mode, "notify-mode", { mode }] as [string, boolean, string, Record<string, unknown>]), "Notify me"),
            keywords: "notifications banners alerts dock",
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
/// Mac banners. "needs" (the default) speaks only when a chat waits on you,
/// stops with an error, or Drive has a branch ready; "always" also says when
/// a chat finishes; "never" stays quiet. Nothing shows for the chat you are
/// looking at, and the first look after opening only takes stock.
type NotifyMode = "needs" | "always" | "never";
const NOTIFY_MODES: [NotifyMode, string][] = [["needs", "When it needs you"], ["always", "Always"], ["never", "Never"]];
let notifyMode: NotifyMode = "needs";
try { const saved = localStorage.getItem("demesne-notify"); if (saved === "always" || saved === "never") notifyMode = saved; } catch {}
let notified: Set<string> | null = null;
const notifyFrom = Date.now() - 5_000;
function setNotifyMode(mode: NotifyMode) {
  notifyMode = mode;
  try { localStorage.setItem("demesne-notify", mode); } catch {}
}
function renderNotifications() {
  if (!state || window.demesne.mode !== "desktop" || state.connection !== "online") return;
  const current = state.session, looking = document.hasFocus();
  const alerts = new Map<string, { title: string; body: string; sessionId?: string; path?: string }>();
  for (const item of state.sessions) {
    // Whatever happened before the app opened is old news.
    if (Date.parse(item.updatedAt) < notifyFrom) continue;
    const mine = item.id === current?.id, title = mine && inSession() ? current!.title : item.title;
    const waits = mine ? Boolean(state.approvals.length || state.questions.length) : item.waiting;
    const where = { sessionId: item.id, path: item.workspace };
    if (waits) {
      const approval = mine ? state.approvals[0] : undefined, input = (approval?.input ?? {}) as Record<string, unknown>;
      const asked = approval?.overlap ? `${approval.overlap.agents[0]?.name ?? "Another agent"} changed ${approval.overlap.path.split("/").pop()}` : approval?.name === "run_command" ? `Wants to run: ${Array.isArray(input.argv) ? input.argv.join(" ") : String(input.command ?? "")}` : approval ? `Wants to ${approval.name.replace(/_/g, " ")}${input.path ? ` ${String(input.path).split("/").pop()}` : ""}` : "";
      const body = asked || (mine && state.questions.length ? "Has a question for you" : "Is waiting for you");
      alerts.set(`${item.id}:wait:${item.updatedAt}`, { title, body, ...where });
    } else if (item.status === "failed") alerts.set(`${item.id}:failed:${item.updatedAt}`, { title, body: "Stopped with an error", ...where });
    else if (item.status === "completed" && notifyMode === "always") alerts.set(`${item.id}:done:${item.updatedAt}`, { title, body: "Finished", ...where });
  }
  for (const job of reviewJobs()) if (job.status === "ready") alerts.set(`drive:${job.id}`, { title: "Drive", body: `${job.title} is ready to review${job.diff ? ` · +${job.diff.additions} −${job.diff.deletions}` : ""}`, ...(job.sessionId ? { sessionId: job.sessionId } : {}) });
  const fresh = notified ? [...alerts].filter(([key]) => !notified!.has(key)) : [];
  notified = new Set([...(notified ?? []), ...alerts.keys()]);
  if (notifyMode === "never") return;
  for (const [, alert] of fresh) {
    if (looking && alert.sessionId === current?.id) continue;
    void api("desktop-notify", alert).catch(() => {});
  }
}
// A banner's click comes back here and opens its chat.
document.addEventListener("demesne:open-chat", (event) => {
  const { sessionId, path } = (event as CustomEvent<{ sessionId?: string; path?: string }>).detail ?? {};
  if (!sessionId || !state) return;
  if (sessionId === state.session?.id) return;
  const here = !path || path === (document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace);
  void act(() => dispatch(here ? "select-session" : "project-session", here ? { id: sessionId } : { id: sessionId, path }));
});
async function driveAction(method: string, args: Record<string, unknown> = {}) {
  if (driveActionPending) return;
  driveActionPending = method;
  renderBriefing();
  try {
    return await api(method, args);
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    driveActionPending = "";
    renderBriefing();
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
    modelsMore,
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
    const turns = (model: ModelDescriptor) => scoreOf(model)?.turns ?? 0;
    const rowOf = (model: ModelDescriptor, kind: "short" | "rest") => {
      const level = modelLevel(model), score = scoreOf(model);
      return {
        label: model.displayName ?? model.id,
        value: [model.contextWindow ? `${tokensShort(model.contextWindow)} context` : "", model.maxOutputTokens ? `${tokensShort(model.maxOutputTokens)} out` : ""].filter(Boolean).join(" · "),
        group: model.provider.toUpperCase(),
        action: "model",
        data: { id: model.id, ...(level ? { reasoning: level } : {}) },
        kind,
        ...(score ? { description: scoreLine(score) } : {}),
      };
    };
    // The models you use most (the one in use always among them) make the
    // short list; the rest wait under "More models", by provider.
    const inUse = models.find((model) => model.id === state!.model.id);
    const mine = (model: ModelDescriptor) => Number(model.provider === state!.model.provider);
    let short = [...models].sort((a, b) => turns(b) - turns(a) || mine(b) - mine(a)).slice(0, SHORT_MODELS);
    if (inUse && !short.includes(inUse)) short = [inUse, ...short.slice(0, SHORT_MODELS - 1)];
    overlayRows = short.map((model) => rowOf(model, "short"));
    if (models.length > short.length) overlayRows.push({ label: "More models", value: "", action: "more-models", data: {}, kind: "more" });
    if (modelsMore || overlayQuery) {
      const query = overlayQuery.toLowerCase();
      const rest = (query ? [...models] : models.filter((model) => !short.includes(model)))
        .sort((a, b) => a.provider.localeCompare(b.provider) || turns(b) - turns(a))
        .map((model) => rowOf(model, "rest"))
        .filter((row) => !query || `${row.label} ${row.group} ${row.data.id}`.toLowerCase().includes(query));
      // A large catalog (OpenRouter's hundreds) collapses to one row until
      // a search looks through it.
      const sizes = new Map<string, number>();
      for (const model of models) sizes.set(model.provider, (sizes.get(model.provider) ?? 0) + 1);
      const large = [...sizes].filter(([, size]) => size > LARGE_CATALOG).map(([provider]) => provider.toUpperCase());
      overlayRows.push(...(query ? rest : rest.filter((row) => !large.includes(row.group))));
      if (!query)
        for (const group of large)
          overlayRows.push({ label: `All ${sizes.get(models.find((model) => model.provider.toUpperCase() === group)!.provider)} models`, value: "type to search", group, action: "focus-filter", data: {}, kind: "rest" });
    }
    // A new search highlights its first match.
    if (overlayQuery !== modelsQuery) {
      modelsQuery = overlayQuery;
      const first = overlayRows.findIndex((row) => row.kind === "rest");
      if (overlayQuery && first >= 0) overlayIndex = first;
    }
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
  if (overlayQuery && overlay !== "models")
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
      const open = openProjectPath ?? (document.getElementById("sidebar-sessions")?.dataset.workspace || state?.workspace);
      openProjectPath = open === path ? "" : path;
      unfoldingProject = openProjectPath;
      try { localStorage.setItem("demesne-project-open", JSON.stringify({ path: openProjectPath })); } catch {}
    } else if (expandedProjectChats.has(path)) expandedProjectChats.delete(path);
    else expandedProjectChats.add(path);
    renderSidebar();
    // Rendering replaces the control: keep keyboard focus on its replacement.
    document.querySelectorAll<HTMLButtonElement>(`#sidebar-sessions [data-action="${action}"]`).forEach(button => {
      if (JSON.parse(button.dataset.args ?? "{}").path === path) button.focus({ preventScroll: true });
    });
    return;
  }
  if (action === "agents-toggle") {
    const path = String(args.path);
    if (agentsShown.has(path)) agentsShown.delete(path); else agentsShown.add(path);
    renderSidebar();
    document.querySelectorAll<HTMLButtonElement>('#sidebar-sessions [data-action="agents-toggle"]').forEach(button => {
      if (JSON.parse(button.dataset.args ?? "{}").path === path) button.focus({ preventScroll: true });
    });
    return;
  }
  // The chat sends it over Heartbeat; you write what to say.
  if (action === "agent-message") return setDraft(`Message ${String(args.name)} at ${String(args.address)}: `);
  if (action === "project-open" || action === "project-session") {
    document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path: args.path, ...(action === "project-session" ? { sessionId: args.id } : {}) } }));
    return;
  }
  if (action === "cards-toggle") {
    cardsOn = !cardsOn;
    try { localStorage.setItem("demesne-cards", cardsOn ? "on" : "off"); } catch {}
    renderStatus();
    document.querySelector<HTMLButtonElement>(".header-cards")?.focus({ preventScroll: true });
    return;
  }
  if (action === "card-fold") {
    const name = String(args.name);
    if (cardsFolded.has(name)) { cardsFolded.delete(name); cardUnfolding = name; } else cardsFolded.add(name);
    try { localStorage.setItem("demesne-cards-folded", JSON.stringify([...cardsFolded])); } catch {}
    renderCards();
    document.querySelector<HTMLButtonElement>(`#cards [data-card="${name}"] .card-head`)?.focus({ preventScroll: true });
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
  if (action === "question-pick") return answerQuestion(String(args.text ?? ""), "suggestion");
  if (action === "question-skip") return answerQuestion(null, "skipped");
  if (action === "new-session") return api("new-session", {});
  if (["next-refresh", "next-run", "next-plan", "next-snooze", "next-never", "drive-auto", "drive-control"].includes(action)) return driveAction(action, args);
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
    heroSignature = briefingSignature = "";
    if (inSession()) renderBriefing();
    else renderHero();
    return;
  }
  if (action === "branch-more") {
    const key = String(args.key ?? "");
    if (detailsOpen.has(key)) detailsOpen.delete(key); else detailsOpen.add(key);
    heroSignature = briefingSignature = "";
    if (inSession()) renderBriefing();
    else renderHero();
    return;
  }
  if (action === "drive-asked") {
    const key = String(args.key ?? "");
    if (detailsOpen.has(key)) detailsOpen.delete(key); else detailsOpen.add(key);
    renderConversation();
    return;
  }
  if (action === "drive-step") {
    const key = String(args.key ?? "");
    if (detailsOpen.has(key)) detailsOpen.delete(key); else detailsOpen.add(key);
    renderDriveTurn();
    briefingSignature = "";
    renderBriefing();
    return;
  }
  if (action === "drive-details") {
    if (detailsOpen.has("drive-details")) detailsOpen.delete("drive-details");
    else detailsOpen.add("drive-details");
    renderDriveTurn();
    briefingSignature = "";
    renderBriefing();
    return;
  }
  if (action === "drive-tell-open") {
    tellOpen = !tellOpen;
    tellSent = "";
    renderBriefing();
    if (tellOpen) el("drive-reply").querySelector<HTMLInputElement>("#drive-tell-form input")?.focus({ preventScroll: true });
    return;
  }
  if (action === "drive-show" || action === "ideas-show" || action === "broke-show") {
    if (action === "drive-show") driveShown = !driveShown;
    else if (action === "broke-show") brokeShown = !brokeShown;
    else ideasShown = !ideasShown;
    if (inSession()) renderBriefing();
    else {
      heroSignature = "";
      renderHero();
    }
    return;
  }
  // /drive and Alt+J open what Drive has (its mission or its ideas) where it
  // lives: the line at the conversation's end, or under the start composer.
  if (action === "drive-open") {
    const run = worktreeRun(), busy = Boolean(pinnedMission() || run.fix || run.away);
    if (busy) driveShown = args.toggle ? !driveShown : true;
    else if (state?.driveNext.proposals.length) ideasShown = args.toggle ? !ideasShown : true;
    else return driveAction("next-refresh");
    if (inSession()) renderBriefing();
    else {
      heroSignature = "";
      renderHero();
    }
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
  if (action === "notify-mode") {
    setNotifyMode(args.mode as NotifyMode);
    overlaySignature = "";
    return renderOverlay();
  }
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
    if (row?.action === "more-models") {
      modelsMore = !modelsMore || Boolean(args.open);
      if (modelsMore && args.step) overlayIndex = Math.min(overlayRows.length, args.index + 1);
      renderOverlay();
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
  if (action === "setup" && overlay === "settings") {
    overlay = null;
    renderOverlay();
  }
  if (action === "setup" || action === "setup-action") return api(action, args);
  if (action === "open-link") return api("open-link", { url: args.url });
  // Width and reload act on the frame in place, so the page keeps its state.
  if (action === "preview-width") {
    const view = document.querySelector<HTMLElement>(`[data-preview="${CSS.escape(String(args.key))}"]`);
    args.phone ? previewPhone.add(args.key) : previewPhone.delete(args.key);
    view?.querySelector(".pv-view")?.classList.toggle("phone", Boolean(args.phone));
    view?.querySelectorAll<HTMLElement>(".pv-btn").forEach((button) => { if (button.dataset.action === "preview-width") button.classList.toggle("on", JSON.parse(button.dataset.args ?? "{}").phone === Boolean(args.phone)); });
    return;
  }
  if (action === "preview-reload") {
    const frame = document.querySelector<HTMLIFrameElement>(`[data-preview="${CSS.escape(String(args.key))}"] iframe`);
    if (frame) frame.src = frame.src;
    return;
  }
  if (action === "preview-output") {
    previewOutput.has(args.key) ? previewOutput.delete(args.key) : previewOutput.add(args.key);
    renderConversation();
    const [runId, id] = [String(args.key).slice(0, String(args.key).lastIndexOf(":")), Number(String(args.key).split(":").at(-1))];
    const tool = state?.runs.find((run) => run.id === runId)?.entries.find((entry) => entry.id === id);
    const record = tool?.type === "tool" ? state!.processes.find((command) => command.toolCallId === tool.toolCallId) : undefined;
    if (previewOutput.has(args.key) && record?.outputLoaded === false) {
      await api("panel-watch", { panel: "log", command: record.id });
      await api("processes");
    }
    return;
  }
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
    driveShown = ideasShown = brokeShown = tellOpen = false;
    tellSent = "";
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
  renderOverlay();
  renderCompletion();
  renderSetup();
  renderNotifications();
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
// Hovering "More models" opens its column, as a submenu would.
document.addEventListener("mouseover", (event) => {
  if (overlay !== "models" || modelsMore || !(event.target as Element).closest?.("[data-more]")) return;
  modelsMore = true;
  renderOverlay();
});
document.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "settings-theme") void act(() => dispatch("settings-set", { method: "theme", args: { name: target.value } }));
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
    if (form.id === "drive-tell-form") {
      const input = form.elements.namedItem("note") as HTMLInputElement, text = input.value.trim();
      if (!text) return;
      await api("drive-tell", { text });
      input.value = "";
      tellSent = text;
      renderBriefing();
    }
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
  // 1, 2, 3… pick the model's suggested answers while nothing is typed.
  if (!ctrl && !event.altKey && /^[1-9]$/.test(key) && (!field || (event.target === editor && !editor.value))) {
    const choice = document.querySelectorAll<HTMLElement>("#question .ask-choice")[Number(key) - 1];
    if (choice) { event.preventDefault(); choice.click(); return; }
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
      if (closeBriefingCard()) return;
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
    // 1–9 pick from the model picker's short list; → opens "More models".
    if (overlay === "models" && !overlayQuery && !ctrl && !event.altKey) {
      const short = overlayRows.filter((row) => row.kind === "short").length;
      const pick = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
      if (pick >= 0 && pick < short) {
        event.preventDefault();
        run(() => dispatch("choose-row", { index: pick }));
        return;
      }
      if (key === "arrowright" && overlayRows[overlayIndex]?.kind === "more") {
        event.preventDefault();
        run(() => dispatch("choose-row", { index: overlayIndex, open: true, step: true }));
        return;
      }
    }
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
    if (approval) run(() => (editor.value.trim() ? denyInstead(editor.value) : api("permission", { id: approval.id, decision: approval.overlap ? "deny" : "allow_once" })));
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
// One frame loop draws every cube mark, and only while a cube moves.
const drawCubes = (now: number) => {
  requestAnimationFrame(drawCubes);
  if (reducedMotion()) return;
  const marks = document.querySelectorAll<HTMLElement>(".cube-mark");
  if (!marks.length) return;
  cube = advance(cube, now);
  if (!moving(cube, now) && marks[0]!.dataset.at === String(cube.beatAt)) return;
  const frame = cubeSvg(cube, now);
  for (const mark of marks) { mark.innerHTML = frame; mark.dataset.at = String(cube.beatAt); }
};
requestAnimationFrame(drawCubes);
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
