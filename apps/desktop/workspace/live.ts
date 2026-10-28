import { THEMES } from "../../../packages/brand/src/theme.ts";
import { matchedRanges, matchesWords } from "./model-search.ts";
import { modelCardHTML } from "./model-card.ts";
import { commandIcon, groupWords, plainName, sectionRank, sectionTitle } from "./command-menu.ts";
import { compactedConversation } from "./compacted-conversation.ts";
import { SidebarProjectOrder } from "./sidebar-project-order.ts";
import { markdown, MarkdownView } from "./markdown.ts";
import { splitNextPrompt } from "../../../packages/protocol/src/next-prompt.ts";
import { parseMailTurn } from "../../../packages/protocol/src/heartbeat-mail.ts";
import { parseDriveReport } from "../../../packages/protocol/src/drive-report.ts";
import { agentPlace, projectSlug, type NearbyAgent } from "../../../packages/protocol/src/agents-nearby.ts";
import { advance, cubeSvg, moving, restingCube } from "./working-cube.ts";
import { mountSakura, type Sakura } from "./sakura.ts";
import { awaySentences, lastPrompt, type AwayAsk, type AwayPart } from "./away.ts";
import { StateReceiver, type StateUpdate } from "./state-wire.ts";
import { codeDiff } from "@demesne/workbench/change-diff.ts";
import { driveSince, driveStepLine, driveTaskList } from "@demesne/drive/drive-timeline.ts";
import { subagentPhrase } from "@demesne/workbench/subagent-phrases.ts";
import { noteKey, notesMessage, reviewRows, type DiffNote } from "./turn-review.ts";
import { pointLabel, pointMessage, type PointPick, type PointSource, type Pointed } from "./point.ts";
import { chatsPage as chatsPageHtml, type ChatsPageChat, type ChatsTab } from "./chats-page.ts";
import { scheduledPage } from "./scheduled-page.ts";
import { foundryPage, type FoundryUi } from "./foundry-page.ts";
import { FoundryChatArtifacts } from "./foundry-inline.ts";
import { FoundryPane } from "./foundry-pane.ts";
import { customizePage, type CustomizeUi } from "./customize-page.ts";
import { GLASS_DEFAULT, glassAlphas, isInk, isSettingsSection, notifyKinds, parseNumber, settingsNav, settingsPage, SETTINGS_ORDER, type Ink, type NotifyKind, type SettingsInfo, type SettingsSection, type SettingsView } from "./settings-page.ts";
import type { CustomizeView } from "./customize.ts";
import type { FoundryArtifact, FoundryArtifactDetail, PlanLimits, Routine } from "@demesne/protocol";
import { glanceHTML, type Glance } from "./glance.ts";
import { backChoices, backState } from "./back-later.ts";
import { agoWords, prHandable, prHandText, prStanding } from "./pr-row.ts";
import { pullRequestNews, type SessionPullRequest } from "../../../packages/protocol/src/pull-requests.ts";
import { PLAN_LIMIT_AMBER, PLAN_LIMIT_DRIVE_PAUSE, PLAN_LIMIT_SHOWN, planUsed, planWindows } from "@demesne/protocol";
import { markNear, timelineMarks, type Mark, type TurnFacts } from "./timeline.ts";
import type { WorkspaceHost } from "./host.ts";
import type { WorkspaceRun, WorkspaceApproval } from "./session-model.ts";
import { chatChanges, chatServers, contextInUse } from "./cards.ts";
import type {
  ToolEntry,
} from "@demesne/workbench/entries.ts";
import type {
  ModelDescriptor,
  ModelScore,
  ModelScoreboardResponse,
} from "@demesne/protocol";

type Snapshot = ReturnType<WorkspaceHost["snapshot"]>;
type OverlayName =
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
/// A model by its name, or its id in words when the provider gives no name:
/// "qwen/qwen3.8-27b-instruct" reads "Qwen3.8 27B Instruct".
const modelWords = (model: { id: string; displayName?: string | null }) => model.displayName?.trim() || model.id.split("/").at(-1)!.split(/[-_]/).filter(Boolean)
  .map((word) => /^\d+(\.\d+)?[bkm]$/i.test(word) ? word.toUpperCase() : /^(gpt|glm|llm|vl|it)$/i.test(word) ? word.toUpperCase() : word.replace(/^./, (c) => c.toUpperCase())).join(" ");
/// A session view, not the start screen: it has turns, or Drive is working
/// it (Drive plans before its first turn).
const projectLabel = (path: string) => path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path;
/// A chat that isn't in a project: no files, commands or Drive.
const isPlain = (snapshot: Snapshot | null = state) => Boolean(snapshot?.session && !snapshot.session.workspace);
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
    foundry_save: "Made",
    foundry_edit: "Changed",
    foundry_read: "Looked in Foundry",
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
  /// The picker's "More models" list is unfolded in its panel.
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
    icon?: string;
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
      content: HTMLElement;
      artifacts: FoundryChatArtifacts;
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
/// Point at it: the preview being pointed at, and what was picked so far.
/// Picks ride with the next message as chips, like notes on the changes.
let pointing: string | null = null;
const pointed: Pointed[] = [];
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
/// Initially show six chats per group; Show more and search reveal the rest.
const SIDEBAR_ROWS = 6;
const expandedProjectChats = new Set<string>();
const projectOrder = new SidebarProjectOrder(
  document.getElementById("sidebar-sessions"),
  () => state ? [document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace, ...JSON.parse(document.getElementById("sidebar-sessions")?.dataset.projects ?? "[]")] : [],
  renderSidebar,
);
/// How the list is laid out: by project, by day, or by what each chat
/// needs; newest first or by name. Group and sort unfolds under a heading.
type SidebarView = { group: "project" | "date" | "status"; sort: "recent" | "name" };
const sidebarView: SidebarView = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("demesne-sidebar-view") ?? "null");
    return { group: ["project", "date", "status"].includes(saved?.group) ? saved.group : "project", sort: saved?.sort === "name" ? "name" : "recent" };
  } catch { return { group: "project", sort: "recent" }; }
})();
/// Groups folded or unfolded by hand: "p:" and a project's folder,
/// "pinned", "plain", or a day or state ("d:Today", "s:Working"). Without
/// one, the project you are in is open and other projects are folded.
const foldedGroups: Record<string, boolean> = (() => {
  try { return JSON.parse(localStorage.getItem("demesne-sidebar-folded") ?? "{}") ?? {}; } catch { return {}; }
})();
function saveSidebarLayout() {
  try {
    localStorage.setItem("demesne-sidebar-view", JSON.stringify(sidebarView));
    localStorage.setItem("demesne-sidebar-folded", JSON.stringify(foldedGroups));
  } catch { /* storage may be off */ }
}
/// Whether a group shows its chats. On Home or in a plain chat every project
/// starts folded.
function groupIsOpen(key: string) {
  if (key in foldedGroups) return !foldedGroups[key];
  const here = document.getElementById("sidebar-sessions")?.dataset.workspace || state?.workspace;
  return !key.startsWith("p:") || (!isPlain() && key === `p:${here}`);
}
/// The heading whose Group and sort line is unfolded beneath it.
let viewOpenAt = "";
/// How many chats are archived, read when Group and sort unfolds.
let archivedCount: number | null = null;
let openProjectFor: string | undefined;
/// Projects whose agents are unfolded under their line.
const agentsShown = new Set<string>();
/// An agent's mark: its client's initial on a tone of its own.
const agentMark = (agent: NearbyAgent) => `<span class="agent-mark" data-provider="${h(agent.provider)}" aria-hidden="true">${h((agent.provider === "codex" ? "x" : agent.name[0] ?? "?"))}</span>`;
/// The group just unfolded from its heading animates once, not on every redraw.
let unfoldingGroup = "";
/// Conversations deleted from the sidebar, hidden at once while the daemon
/// archives them.
const deletedSessions = new Set<string>();
const ICON_BRANCH = '<svg class="ico sidebar-branch" viewBox="0 0 24 24" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
const ICON_ARCHIVE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>';
const ICON_BELL = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
/// The row whose Bring it back words are unfolded under it.
let backOpenFor: string | null = null;
const ICON_PR = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8"/><path d="M18 16V9a3 3 0 0 0-3-3h-3"/><path d="m14 4-2 2 2 2"/></svg>';
/// Its pull request on the row: what gh last said about each chat's pull
/// request, the row whose news is unfolded, and when you last looked at each
/// (its activityAt then). A pull request you haven't looked at counts from
/// when it opened.
const pullRequests = new Map<string, SessionPullRequest>();
let prOpenFor: string | null = null, prOpenSince = "", prKey = "";
const PR_SEEN_KEY = "demesne-pr-seen";
const prSeen: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(PR_SEEN_KEY) ?? "{}") ?? {}; } catch { return {}; }
})();
const prSeenAt = (id: string, pr: SessionPullRequest) => prSeen[id] ?? pr.createdAt;
function markPrSeen(id: string, at: string) {
  if (prSeen[id] === at) return;
  prSeen[id] = at;
  try { localStorage.setItem(PR_SEEN_KEY, JSON.stringify(prSeen)); } catch { /* storage may be off */ }
}
const prNew = (id: string, pr: SessionPullRequest) => pr.state === "open" && pr.activityAt > prSeenAt(id, pr);
/// Whether a chat is away, back, or neither; "when its PR merges" asks gh.
const backOf = (item: { id: string; backAt?: string }) => backState(item.backAt, Date.now(), pullRequests.get(item.id)?.state === "merged");
/// Asks the daemon what gh says; `fresh` asks gh again now for that chat.
async function refreshPullRequests(fresh?: string) {
  const ids = (state?.sessions ?? []).filter((item) => item.prUrl).map((item) => item.id);
  for (const id of [...pullRequests.keys()]) if (!ids.includes(id)) pullRequests.delete(id);
  if (!ids.length) return;
  let found: Record<string, SessionPullRequest>;
  try { found = await api<Record<string, SessionPullRequest>>("session-prs", fresh ? { ids: [fresh], fresh: true } : { ids }); } catch { return; }
  let changed = false;
  for (const [id, pr] of Object.entries(found)) {
    if (JSON.stringify(pullRequests.get(id)) !== JSON.stringify(pr)) changed = true;
    pullRequests.set(id, pr);
    // An unfolded row shows its news, so it counts as looked at.
    if (prOpenFor === id) markPrSeen(id, pr.activityAt);
  }
  if (changed) { renderSidebar(); renderNotifications(); }
}
setInterval(() => { if (prKey) void refreshPullRequests(); }, 60_000);
const ICON_PIN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/></svg>';
/// A project's folder is its fold: shut while folded, open while its chats show.
const ICON_FOLDER_SHUT = '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2.2h8.4a1 1 0 0 1 1 1v9.8a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/></svg>';
const ICON_FOLDER_OPEN = '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 18.5V6.5a1 1 0 0 1 1-1h4.6l2 2.2h7.4a1 1 0 0 1 1 1V10"/><path d="M3.5 18.5 6 11.2a1 1 0 0 1 .95-.7H21a.8.8 0 0 1 .76 1.05L19.5 18.5z"/></svg>';
const ICON_GROUP_ICONS: Record<string, string> = {
  pinned: '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/></svg>',
  back: '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  plain: '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/></svg>',
  d: '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>',
  s: '<svg class="ico sidebar-group-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><path d="M12 8v4l2.5 1.5"/></svg>',
};
const ICON_PLUS_SMALL = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12"/><path d="M6 12h12"/></svg>';
const ICON_SORT = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m13 16 4 4 4-4"/></svg>';
const VIEW_WORDS = { project: "Project", date: "Date", status: "Status", recent: "Recent", name: "Name" } as const;
/// The day a chat falls under when the list is grouped by date.
function sidebarDay(date: string) {
  const then = new Date(date), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : days < 30 ? "This month" : "Earlier";
}
/// Pinned chats lead, then one group per project and Just a chat; worktree
/// chats remain with their parent.
function renderSidebar() {
  const list = document.getElementById("sidebar-sessions");
  if (!state || !list || projectOrder.dragging) return;
  // While a title is being renamed, the list holds still under the cursor.
  if (renaming && list.parentElement?.querySelector(".sidebar-rename")) return;
  const query = (document.getElementById("sidebar-search") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  // A chat Drive runs on its own branch (a worktree) joins the list with a
  // branch mark; its branch is in the tooltip.
  const branches = new Map([state.breakage.fix, ...state.breakage.inbox].filter((job): job is NonNullable<typeof job> => Boolean(job?.sessionId)).map((job) => [job.sessionId!, job.branch] as const));
  const sessions = state.sessions.filter(item => !deletedSessions.has(item.id));
  const prs = sessions.filter((item) => item.prUrl).map((item) => `${item.id}=${item.prUrl}`).join(",");
  if (prs !== prKey) { prKey = prs; void refreshPullRequests(); }
  const projectWorkspace = list.dataset.workspace || state.workspace;
  const projectPaths = projectOrder.paths();
  // Worktree chats stay with their parent project, alongside its review
  // actions. A chat with no folder is under Just a chat (null).
  const projectFor = (item: typeof sessions[number]) => !item.workspace ? null : branches.has(item.id) || item.id === state!.session?.id ? projectWorkspace : item.workspace;
  const plainNow = isPlain();
  const review = reviewJobs(), pinned = pinnedMission(), run = worktreeRun(), word = driveWord();
  const ideas = state.driveNext.proposals.length;
  const waiting = state.approvals.length ? "approval" : state.questions.length ? "answer" : "";
  // Switching to a project unfolds it.
  if (openProjectFor !== undefined && openProjectFor !== projectWorkspace && foldedGroups[`p:${projectWorkspace}`]) {
    delete foldedGroups[`p:${projectWorkspace}`];
    saveSidebarLayout();
  }
  openProjectFor = projectWorkspace;
  const isOpen = (key: string) => Boolean(query) || groupIsOpen(key);
  const agents = state.agents ?? [];
  // A mission's chat sits under the chat it was started from.
  const parentOf = missionLinks();
  const signature = JSON.stringify([[...parentOf], sessions, projectPaths, sidebarView, foldedGroups, viewOpenAt, agents, [...agentsShown], [...expandedProjectChats], [...deletedSessions], state.session?.id, state.session?.title, state.connection, archivedCount, state.activeTurnId, query, waiting, review.map((job) => [job.id, job.status, job.title, job.diff]), pinned && [pinned.status, pinned.mission, driveProgress(pinned)], run.fix?.status, run.away?.status, word, ideas, state.session?.workspace?.gitBranch, inSession(), [...branches], renaming, backOpenFor, prOpenFor, [...pullRequests].map(([id, pr]) => [id, pr.state, pr.activityAt, pr.number, prSeenAt(id, pr)]), pageOpen, plainNow, Math.floor(Date.now() / 60_000)]);
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;
  const current = state.session;
  // One cube on screen at most: it turns in the conversation, and a working
  // chat is a small breathing dot here.
  const dot = (tone: string) => `<span class="sidebar-session-mark ${tone}" aria-hidden="true"></span>`;
  const nav = list.parentElement ?? list;
  const focusedControl = document.activeElement instanceof HTMLButtonElement && nav.contains(document.activeElement)
    ? { action: document.activeElement.dataset.action, args: document.activeElement.dataset.args } : null;
  const focusedRow = document.activeElement?.closest(".sidebar-item")?.querySelector(".sidebar-session");
  const focused = focusedRow ? [...nav.querySelectorAll(".sidebar-session")].indexOf(focusedRow) : -1;
  const titleOf = (item: typeof sessions[number]) => item.id === current?.id ? inSession() ? current!.title : "New chat" : item.turns ? item.title : "New chat";
  // What a chat's dot says: amber when it needs you, a breathing dot while
  // it works, a cross when it failed, blue for a reply you haven't seen.
  const toneOf = (item: typeof sessions[number]) => {
    const selected = item.id === current?.id;
    const asks = selected ? Boolean(waiting) : Boolean(item.waiting);
    // A mission's chat keeps its mark while Drive plans between turns.
    const driving = Boolean(pinned && pinned.homeSessionId === item.id && ["running", "waiting"].includes(pinned.status));
    const working = selected ? (Boolean(state!.activeTurnId) || driving) && !waiting : !asks && (item.status === "running" || item.status === "queued" || driving);
    // Looking at a chat marks it seen; one that has moved on since, while
    // you were elsewhere, carries the blue dot until you open it.
    if (selected || !(item.id in seenChats)) markSeen(item.id, item.updatedAt);
    const fresh = !selected && item.status === "completed" && seenChats[item.id] !== item.updatedAt;
    return asks ? "warn" : working ? "working" : item.status === "failed" ? "bad" : fresh ? "acc" : "";
  };
  const tones = new Map(sessions.map((item) => [item.id, toneOf(item)] as const));
  // Drive's own chats stay off the list: its work unfolds from its line in
  // your chat and lands as a branch to review. One you open shows while open.
  // An empty chat is the composer itself, and the New chat row above already
  // names it; it joins the list once it has a turn.
  const listed = sessions.filter((item) => (!branches.has(item.id) || item.id === current?.id) && (backOf(item) !== "away" || item.id === current?.id) && (titleOf(item) !== "New chat" || tones.get(item.id) === "working" || (item.id === current?.id && Boolean(waiting))));
  const matches = (item: typeof sessions[number]) => !query || titleOf(item).toLowerCase().includes(query) || Boolean(item.workspace?.toLowerCase().includes(query));
  const sorted = (items: typeof sessions) => sidebarView.sort === "name" ? [...items].sort((a, b) => titleOf(a).localeCompare(titleOf(b))) : items;
  const whereWords = (item: typeof sessions[number]) => { const project = projectFor(item); return project ? projectLabel(project) : "Just a chat"; };
  // One line per chat: a mark for its state, its title, and on the right its
  // time (or its project, when the list is by date or state). Pointing at it
  // shows Pin and Archive there instead. The tooltip and the accessible name
  // say in words what the mark shows.
  const row = (item: typeof sessions[number], right: string, nested: boolean) => {
    const id = item.id, title = titleOf(item), tone = tones.get(id) ?? "", selected = id === current?.id && !pageOpen;
    const about = STATE_WORDS[tone] ?? "", branch = branches.get(id);
    const project = projectFor(item);
    const here = project === projectWorkspace || project === null;
    const mark = tone || !item.pinned ? dot(tone) : `<span class="sidebar-pin-mark" aria-hidden="true">${ICON_PIN}</span>`;
    const pr = pullRequests.get(id);
    const side = tone || pr || (id === current?.id && !inSession()) ? "" : right;
    const open = btn(here ? "select-session" : "project-session", `${mark}<span class="sidebar-session-name">${h(title)}</span>${branch ? ICON_BRANCH : ""}${side ? `<span class="sidebar-session-age">${h(side)}</span>` : ""}`, { id, ...(project ? { path: project } : {}) }, `sidebar-session${selected ? " selected" : ""}`)
      .replace("<button ", `<button data-about="${h(about)}" data-when="${h(fullTime(item.updatedAt))}" data-updated="${h(item.updatedAt)}" aria-label="${h(about ? `${title}, ${about}` : title)}" aria-keyshortcuts="Delete"${selected ? ' aria-current="page"' : ""} `);
    // Pin and Archive sit on the row itself: no menu, no dialog. The keyboard
    // archives with Delete on the row, so they stay out of the tab order.
    const pin = btn("pin-session", ICON_PIN, { id, pinned: !item.pinned }, `sidebar-pin${item.pinned ? " on" : ""}`).replace("<button ", `<button title="${item.pinned ? "Unpin" : "Pin"}" aria-label="${h(`${item.pinned ? "Unpin" : "Pin"} ${title}`)}" tabindex="-1" `);
    const archive = tone === "working" ? "" : btn("delete-session", ICON_ARCHIVE, { id }, "sidebar-delete").replace("<button ", `<button title="Archive" aria-label="Archive ${h(title)}" tabindex="-1" `);
    // Bring it back later: the bell unfolds a few times under the row.
    const bell = btn("back-open", ICON_BELL, { id }, `sidebar-bell${backOpenFor === id ? " on" : ""}`).replace("<button ", `<button title="Bring it back later" aria-label="${h(`Bring ${title} back later`)}" aria-expanded="${backOpenFor === id}" tabindex="-1" `);
    const backLine = backOpenFor === id ? `<div class="sidebar-back-line" role="group" aria-label="Bring it back"><span class="sidebar-back-label">Bring it back</span>${backChoices(new Date(), pr?.state === "open" ? pr.number : undefined).map((choice) => btn("bring-back", h(choice.label), { id, at: choice.at }, "sidebar-back-opt")).join("")}</div>` : "";
    const back = backOf(item) === "back";
    // Its pull request sits where the time would: #N, a blue dot for news
    // since you looked, purple once merged. The number unfolds the news.
    const fresh = pr ? prNew(id, pr) : false;
    const prWords = pr ? `#${pr.number} ${pr.state === "open" ? fresh ? "has news" : pr.draft ? "draft" : "open" : pr.state}` : "";
    const chip = pr ? btn("pr-open", `${ICON_PR}<span>#${pr.number}</span>${fresh ? '<span class="sidebar-pr-dot" aria-hidden="true"></span>' : ""}`, { id }, `sidebar-pr ${pr.state}${fresh ? " new" : ""}${prOpenFor === id ? " on" : ""}`)
      .replace("<button ", `<button title="${h(`${pr.title} · ${prWords}`)}" aria-label="${h(`Pull request ${prWords}`)}" aria-expanded="${prOpenFor === id}" tabindex="-1" `) : "";
    const prLine = pr && prOpenFor === id ? (() => {
      const github = btn("pr-github", "GitHub", { id }, "sidebar-back-opt");
      if (pr.state === "merged") return `<div class="sidebar-pr-line" role="group" aria-label="Pull request #${pr.number}"><span class="sidebar-pr-head">Merged ${h(agoWords(pr.mergedAt ?? pr.activityAt))}</span>${tone === "working" ? "" : btn("delete-session", "Archive", { id }, "sidebar-back-opt key")}${github}</div>`;
      if (pr.state === "closed") return `<div class="sidebar-pr-line" role="group" aria-label="Pull request #${pr.number}"><span class="sidebar-pr-head">Closed without merging</span>${github}</div>`;
      const news = pullRequestNews(pr, prOpenSince);
      const head = news.length ? `<b>${news.length} new on #${pr.number}</b>` : `<b>#${pr.number}</b> ${h(pr.title)}`;
      const lines = (news.length ? news : prStanding(pr)).map((line) => `<span class="sidebar-pr-note">${h(line)}</span>`).join("");
      const hand = prHandable(pr, prOpenSince) ? btn("pr-hand", "Hand it to the chat", { id }, "sidebar-back-opt key") : "";
      return `<div class="sidebar-pr-line" role="group" aria-label="Pull request #${pr.number}"><span class="sidebar-pr-head">${head}</span>${lines}${hand}${github}</div>`;
    })() : "";
    if (renaming === id) return `<div class="sidebar-item${nested ? " kid" : ""}"><form class="sidebar-rename" data-id="${h(id)}">${dot(tone)}<input name="title" value="${h(title)}" maxlength="200" aria-label="Rename ${h(title)}" autocomplete="off"></form></div>`;
    return `<div class="sidebar-item${nested ? " kid" : ""}${back ? " back" : ""}${pr ? " has-pr" : ""}">${open}<span class="sidebar-row-actions">${bell}${pin}${archive}${chip}</span></div>${backLine}${prLine}`;
  };
  // A group's rows, the first six unless searching or expanded.
  const groupRows = (key: string, items: typeof sessions, right: (item: typeof sessions[number]) => string, nested: (item: typeof sessions[number]) => boolean = () => false) => {
    const limit = query || expandedProjectChats.has(key) ? Infinity : SIDEBAR_ROWS;
    const rows = items.slice(0, limit).map((item) => row(item, right(item), nested(item)));
    if (items.length > limit) rows.push(btn("project-more", `Show ${items.length - limit} more`, { key }, "sidebar-more"));
    else if (!query && expandedProjectChats.has(key) && items.length > SIDEBAR_ROWS) rows.push(btn("project-more", "Show fewer", { key }, "sidebar-more"));
    return rows;
  };
  // Group and sort, unfolded in place under the heading it was opened from.
  const viewLine = (key: string) => {
    if (viewOpenAt !== key) return "";
    const choice = (word: keyof typeof VIEW_WORDS, args: Record<string, string>, on: boolean) =>
      btn("sidebar-view", VIEW_WORDS[word], args, `sidebar-view-opt${on ? " on" : ""}`).replace("<button ", `<button aria-pressed="${on}" `);
    const archived = btn("chats-page", `<span>Archived chats</span><span class="sidebar-view-count">${archivedCount === null ? "" : `${archivedCount} `}›</span>`, { tab: "archived" }, "sidebar-view-archived");
    return `<div class="sidebar-view-line" role="group" aria-label="Group and sort"><div class="sidebar-view-row"><span class="sidebar-view-label">Group</span>${(["project", "date", "status"] as const).map((group) => choice(group, { group }, sidebarView.group === group)).join("")}</div><div class="sidebar-view-row"><span class="sidebar-view-label">Sort</span>${(["recent", "name"] as const).map((sort) => choice(sort, { sort }, sidebarView.sort === sort)).join("")}</div>${archived}</div>`;
  };
  // Every heading folds its group; pointing at it trades the count for
  // Group and sort.
  const viewButton = (key: string) => btn("sidebar-view-open", ICON_SORT, { key }, `sidebar-view-button${viewOpenAt === key ? " on" : ""}`)
    .replace("<button ", `<button title="Group and sort" aria-label="Group and sort" aria-expanded="${viewOpenAt === key}" `);
  const group = (key: string, label: string, rows: string[], count: number) => {
    const open = isOpen(key);
    const icon = ICON_GROUP_ICONS[key] ?? ICON_GROUP_ICONS[key.split(":")[0]!] ?? "";
    const toggle = btn("group-toggle", `${icon}<span>${h(label)}</span>`, { key }, "sidebar-group-toggle").replace("<button ", `<button aria-expanded="${open}" `);
    return `<section class="sidebar-group-block" data-group="${h(key)}"><div class="sidebar-group-row">${toggle}<span class="sidebar-group-count">${count || ""}</span>${viewButton(key)}</div>${viewLine(key)}<div class="sidebar-group-chats${key === unfoldingGroup && open ? " unfolding" : ""}"${open ? "" : " hidden"}>${rows.join("")}</div></section>`;
  };

  const reviewLine = () => review.length ? btn("review-open", `Review ${review.length} ${review.length === 1 ? "branch" : "branches"} ›`, { show: true }, "sidebar-more sidebar-review") : "";
  // Chats you asked to bring back lead the list once they're due, until you
  // open them; the time they came back sits on the right.
  const backChats = listed.filter((item) => backOf(item) === "back" && item.id !== current?.id && matches(item));
  const backList = document.getElementById("sidebar-back");
  if (backList) {
    backList.hidden = !backChats.length;
    backList.innerHTML = backChats.length ? group("back", "Back now", groupRows("back", backChats, (item) => item.backAt === "merge" ? "merged" : new Date(item.backAt!).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })), 0) : "";
  }
  const isBack = (item: typeof sessions[number]) => backChats.includes(item);
  // Pinned chats lead the list, whichever project they are in.
  const pinnedChats = sorted(listed.filter((item) => item.pinned && !isBack(item) && matches(item)));
  const pinnedList = document.getElementById("sidebar-pinned");
  if (pinnedList) {
    pinnedList.hidden = !pinnedChats.length;
    pinnedList.innerHTML = pinnedChats.length ? group("pinned", "Pinned", groupRows("pinned", pinnedChats, (item) => shortAge(item.updatedAt)), 0) : "";
  }
  const rest = listed.filter((item) => !item.pinned && !isBack(item));
  const groups: string[] = [];
  let plainGroup = "";
  if (sidebarView.group === "project") {
    for (const [index, path] of projectPaths.entries()) {
      const name = projectLabel(path);
      const projectMatches = Boolean(query) && path.toLowerCase().includes(query);
      const projectSessions = sessions.filter(item => projectFor(item) === path);
      const found = rest.filter(item => projectFor(item) === path && (projectMatches || titleOf(item).toLowerCase().includes(query)));
      const nested = (item: typeof found[number]) => found.some(parent => parent.id === parentOf.get(item.id));
      const matching = sorted(found.filter(item => !nested(item)));
      for (const child of found.filter(nested)) matching.splice(matching.findIndex(parent => parent.id === parentOf.get(child.id)) + 1, 0, child);
      if (query && !projectMatches && !matching.length) continue;
      const key = `p:${path}`, expanded = isOpen(key), active = path === projectWorkspace;
      const rows = groupRows(key, matching, (item) => shortAge(item.updatedAt), nested);
      if (active && !query) rows.push(reviewLine());
      // The whole line is the fold, its folder shut or open with it; + starts
      // a chat in the project.
      const label = btn("project-toggle", `${expanded ? ICON_FOLDER_OPEN : ICON_FOLDER_SHUT}<span>${h(name)}</span>`, { path }, "sidebar-project-name")
        .replace("<button ", `<button draggable="true" aria-expanded="${expanded}" aria-controls="project-chats-${index}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="${h(path)} · Drag to reorder (Alt+↑/↓)"${active ? ' aria-current="location"' : ""}${query ? " aria-disabled=\"true\"" : ""} `);
      const start = btn("project-new", ICON_PLUS_SMALL, { path }, "sidebar-project-new").replace("<button ", `<button title="${h(`New chat in ${name}`)}" aria-label="${h(`New chat in ${name}`)}" `);
      // Each project's line says its state on the right, so a closed project
      // still shows what it needs: branches to review, a chat waiting on you,
      // work in progress, or how many chats it holds.
      const asking = projectSessions.some(item => item.id === current?.id ? Boolean(waiting) : item.waiting);
      const busy = projectSessions.some(item => item.id === current?.id ? Boolean(state!.activeTurnId) : item.status === "running" || item.status === "queued");
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
        // An open project names its branch; a folded one, how many chats it holds.
        : expanded && active && state.session?.workspace?.gitBranch ? `<span class="sidebar-project-state sidebar-project-branch" title="On ${h(state.session.workspace.gitBranch)}">${ICON_BRANCH}<span>${h(state.session.workspace.gitBranch)}</span></span>`
        : here.length || expanded ? "" : `<span class="sidebar-group-count">${found.length || ""}</span>`;
      const agentRows = showing ? `<div class="sidebar-agent-rows">${here.map(agent => `<div class="sidebar-agent-row" title="${h(agent.address)}">${agentMark(agent)}<span>${h(agent.name)} · ${h(agentPlace(agent).replace(/^on /, ""))}</span>${btn("agent-message", "Message", { address: agent.address, name: agent.name }, "sidebar-agent-message")}</div>`).join("")}</div>` : "";
      groups.push(`<section class="sidebar-project${active ? " active" : ""}" data-project="${h(path)}"><div class="sidebar-project-header">${label}${marks}${status}${start}${viewButton(key)}</div>${viewLine(key)}${agentRows}<div class="sidebar-project-chats${key === unfoldingGroup && expanded ? " unfolding" : ""}" id="project-chats-${index}"${expanded ? "" : " hidden"}>${rows.length ? rows.join("") : '<p class="sidebar-empty">No chats yet</p>'}</div></section>`);
    }
    // Chats with no project follow, under Just a chat.
    const plainChats = sorted(rest.filter((item) => !item.workspace && matches(item)));
    if (plainChats.length) plainGroup = group("plain", "Just a chat", groupRows("plain", plainChats, (item) => shortAge(item.updatedAt)), plainChats.length);
  } else {
    // By date or by state, every chat in one list, each naming its project.
    // The open project's branches to review lead it.
    const lead = query || plainNow ? "" : reviewLine();
    if (lead) groups.push(`<div class="sidebar-lead">${lead}</div>`);
    const buckets = new Map<string, typeof sessions>();
    const STATE_GROUPS: Record<string, string> = { warn: "Needs you", working: "Working", bad: "Failed", acc: "New replies", "": "Done" };
    const order = sidebarView.group === "date" ? ["Today", "Yesterday", "This week", "This month", "Earlier"] : Object.values(STATE_GROUPS);
    for (const label of order) buckets.set(label, []);
    for (const item of sorted(rest.filter(matches))) buckets.get(sidebarView.group === "date" ? sidebarDay(item.updatedAt) : STATE_GROUPS[tones.get(item.id) ?? ""]!)!.push(item);
    for (const [label, items] of buckets) {
      if (!items.length) continue;
      const key = `${sidebarView.group === "date" ? "d" : "s"}:${label}`;
      groups.push(group(key, label, groupRows(key, items, whereWords), items.length));
    }
  }
  list.innerHTML = groups.length || plainGroup || pinnedChats.length ? groups.join("") : `<p class="sidebar-empty">${query ? "No matching conversations or projects" : "No chats yet"}</p>`;
  const chatList = document.getElementById("sidebar-chats");
  if (chatList) {
    chatList.hidden = !plainGroup;
    chatList.innerHTML = plainGroup;
  }
  unfoldingGroup = "";
  const editing = nav.querySelector<HTMLInputElement>(".sidebar-rename input");
  if (editing && document.activeElement !== editing) { editing.focus(); editing.select(); }
  // A redraw keeps keyboard focus where it was, or on the row that moved up.
  if (focusedControl && !editing) {
    const sameControl = [...nav.querySelectorAll<HTMLButtonElement>("button")].find(button =>
      button.dataset.action === focusedControl.action && button.dataset.args === focusedControl.args && !button.closest("[hidden]"));
    const buttons = [...nav.querySelectorAll<HTMLElement>(".sidebar-session")].filter(button => !button.closest("[hidden]"));
    (sameControl ?? (focused >= 0 ? buttons[Math.min(focused, buttons.length - 1)] : null) ?? document.getElementById("sidebar-search"))?.focus({ preventScroll: true });
  }
  const title = document.getElementById("workspace-title");
  if (title) { title.textContent = pageOpen === "scheduled" ? "Scheduled" : pageOpen === "foundry" ? foundryOpen?.title ?? "Foundry" : pageOpen === "customize" ? "Customize" : pageOpen === "settings" ? "Settings" : pageOpen ? "All chats" : inSession() ? current?.title ?? "Conversation" : "Home"; title.title = title.textContent; }
  // A mission's chat says where it came from, and goes back there.
  const crumb = document.getElementById("workspace-from"), from = current && inSession() ? parentOf.get(current.id) : undefined;
  if (crumb) {
    crumb.hidden = !from || Boolean(pageOpen);
    crumb.innerHTML = from ? `from ${btn("select-session", h(chatTitle(from)), { id: from }, "workspace-from-link")}` : "";
  }
  // Where an open chat lives: Just a chat, or its project.
  const where = document.getElementById("workspace-where");
  if (where) {
    where.hidden = Boolean(pageOpen) || !inSession() || Boolean(from);
    where.textContent = plainNow ? "Just a chat" : projectLabel(projectWorkspace);
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
document.getElementById("sidebar-projects")?.addEventListener("keydown", (event) => {
  const rows = [...document.querySelectorAll<HTMLElement>("#sidebar-projects .sidebar-session")].filter(row => !row.closest("[hidden]"));
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
  const ids = [...document.querySelectorAll<HTMLElement>('#sidebar-projects .sidebar-session[data-action="select-session"]')].filter(row => !row.closest("[hidden]")).map((row) => JSON.parse(row.dataset.args ?? "{}").id as string).filter(Boolean);
  if (!ids.length) return undefined;
  const at = ids.indexOf(state?.session?.id ?? "");
  return ids[at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length];
}
// Double-click a title to rename it in place: Enter or leaving the field
// keeps it, Escape puts it back.
// The first click opens the chat and redraws the row, so the second click
// may not complete on the same element: the second press starts the rename.
document.getElementById("sidebar-projects")?.addEventListener("mousedown", (event) => {
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
// Rest on a chat to see where it stands (pass 76 C): after a moment its card
// sits beside the row, read from that chat's state. It goes when the pointer
// leaves the row or a click lands.
const glanceCache = new Map<string, { key: string; glance: Glance }>();
let glanceTimer: ReturnType<typeof setTimeout> | undefined, glanceRow: HTMLElement | null = null;
function hideGlance() {
  clearTimeout(glanceTimer);
  glanceRow = null;
  document.getElementById("sidebar-glance")?.remove();
}
async function showGlance(row: HTMLElement) {
  const id = JSON.parse(row.dataset.args ?? "{}").id as string | undefined;
  if (!id) return;
  const key = row.dataset.updated ?? "", cached = glanceCache.get(id);
  let glance = cached?.key === key ? cached.glance : null;
  if (!glance) {
    try { glance = await api<Glance>("session-glance", { id }); } catch { return; }
    glanceCache.set(id, { key, glance });
  }
  if (glanceRow !== row || !row.isConnected) return;
  const card = document.getElementById("sidebar-glance") ?? Object.assign(document.createElement("div"), { id: "sidebar-glance", role: "tooltip" });
  const title = row.querySelector(".sidebar-session-name")?.textContent ?? "";
  card.innerHTML = glanceHTML(title, row.dataset.about ?? "", row.dataset.when ?? "", glance, (model) => modelWords({ id: model, displayName: models.find((item) => item.id === model)?.displayName }));
  document.body.append(card);
  const box = row.getBoundingClientRect(), side = document.getElementById("desktop-sidebar")?.getBoundingClientRect();
  card.style.left = `${Math.round((side?.right ?? box.right) + 6)}px`;
  card.style.top = `${Math.round(Math.max(8, Math.min(box.top - 6, innerHeight - card.offsetHeight - 8)))}px`;
  row.setAttribute("aria-describedby", "sidebar-glance");
}
document.getElementById("desktop-sidebar")?.addEventListener("pointerover", (event) => {
  const row = (event.target as Element).closest<HTMLElement>(".sidebar-session[data-updated]");
  if (row === glanceRow) return;
  hideGlance();
  if (!row) return;
  glanceRow = row;
  glanceTimer = setTimeout(() => void showGlance(row), 450);
});
document.getElementById("desktop-sidebar")?.addEventListener("pointerleave", hideGlance);
document.addEventListener("pointerdown", hideGlance, true);
document.getElementById("sidebar-projects")?.addEventListener("scroll", hideGlance, { passive: true });
document.getElementById("sidebar-projects")?.addEventListener("submit", (event) => { event.preventDefault(); endRename(true); });
// A press anywhere else keeps the new title. Focus taken by the app itself
// (the composer, as the chat opens) goes back to the field.
document.addEventListener("pointerdown", (event) => {
  if (renaming && !(event.target as HTMLElement).closest(".sidebar-rename")) endRename(true);
}, true);
document.getElementById("sidebar-projects")?.addEventListener("focusout", (event) => {
  const form = (event.target as HTMLElement).closest(".sidebar-rename");
  if (!form || !renaming) return;
  const next = (event as FocusEvent).relatedTarget as HTMLElement | null;
  if (next?.matches("textarea")) setTimeout(() => { if (renaming && form.isConnected) form.querySelector("input")?.focus(); });
  else if (next) endRename(true);
});
document.getElementById("sidebar-projects")?.addEventListener("keydown", (event) => {
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
/// The cards on the right: what this chat changed, its preview, its context
/// once half full, the agents near its edits and the connectors it called.
/// A card shows only while the chat uses it, and a chat that uses none has
/// no column (pass 86 A); its header folds it to one line.
const ICON_CHEVRON = '<svg class="ico card-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const cardsFolded = new Set<string>((() => { try { return JSON.parse(localStorage.getItem("demesne-cards-folded") ?? "[]") as string[]; } catch { return []; } })());
let cardsSignature = "";
/// The card whose body is unfolding now; only it animates.
let cardUnfolding = "";
function card(name: string, title: string, summary: string, body: string) {
  const folded = cardsFolded.has(name);
  return `<section class="card${folded ? " folded" : ""}" data-card="${name}"><button type="button" class="card-head" data-action="card-fold" data-args='${JSON.stringify({ name })}' aria-expanded="${!folded}"><span class="card-title">${title}</span>${ICON_CHEVRON}<span class="card-sum">${summary}</span></button>${folded ? "" : `<div class="card-body">${body}</div>`}</section>`;
}
function renderCards() {
  // A page in place of the chat (Settings, Customize…) hides the chat's cards.
  const aside = el("cards"), app = el("app");
  const hide = () => { app.classList.remove("cards-on", "cards-context"); aside.hidden = true; cardsSignature = ""; };
  if (!state || !inSession() || pageOpen) return hide();
  const s = state, root = isPlain(s) ? "" : s.workspace ?? "";
  const c = context(), plan = s.provider?.contextPlan;
  // What this chat itself did, rewound turns left out.
  const used = s.runs.filter((run) => !rewoundBy(run)).flatMap(tools);
  const files = chatChanges(s.files.filter((file) => file.status), used.flatMap((t) => t.phase === "change" && t.state === "done" ? t.changes?.map((change) => change.path) ?? [String(t.input.path ?? "")] : []), root);
  const changes = { files: files.length, added: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), removed: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) };
  const calls = new Set(used.map((t) => t.toolCallId));
  const previews = s.processes.filter((command) => command.serves && command.status === "running" && (!command.toolCallId || calls.has(command.toolCallId)));
  // Demesne can't see which files another agent edits, so an agent in this
  // project shows while this chat has edits of its own it could collide with.
  const here = root && files.length ? s.agents.filter((agent) => agent.project === projectSlug(root)) : [];
  const servers = chatServers(s.connectors.servers, used.map((t) => t.name));
  const showContext = c.percentage != null && contextInUse(c.percentage);
  if (!files.length && !previews.length && !showContext && !here.length && !servers.length) return hide();
  app.classList.add("cards-on");
  app.classList.toggle("cards-context", showContext);
  aside.hidden = false;
  const signature = JSON.stringify([c, plan?.estimatedMessageTokens, plan?.estimatedToolDefinitionTokens, plan?.reserves.totalTokens, files, here, previews.map((command) => command.serves), servers, Boolean(s.activeTurnId), [...cardsFolded]]);
  if (signature === cardsSignature) return;
  cardsSignature = signature;
  const row = (icon: string, label: string, right = "", title = "") => `<div class="card-row"${title ? ` title="${h(title)}"` : ""}>${icon}<span class="card-label">${label}</span>${right ? `<span class="card-right">${right}</span>` : ""}</div>`;
  const out: string[] = [];
  if (showContext && c.percentage != null) {
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
      // A card the chat just started using slides in.
      if (!node) {
        replacement.classList.add("arriving");
        replacement.addEventListener("animationend", () => replacement.classList.remove("arriving"), { once: true });
      }
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
/// The sidebar's foot: who you are and what pays for the models, the theme
/// switch, and Settings.
const ICON_SUN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>';
const ICON_MOON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const isLightTheme = (name: string) => {
  const option = state?.themeOptions.find((item) => item.name === name);
  if (name==="system" && option?.systemFallback) return !systemDark();
  return option?.appearance ? option.appearance === "light" : /light|latte/.test(name);
};
function renderFoot() {
  if (!state) return;
  const you = state.you || "You", first = you.split(/\s+/)[0] || you;
  const plan = state.model.provider === "Codex" ? "Codex plan" : state.chatgptAccount?.planEnabled ? "ChatGPT plan" : state.model.provider || "";
  const light = isLightTheme(state.theme);
  const html = [first, plan, light].join("\0");
  const foot = document.querySelector<HTMLElement>(".sidebar-foot");
  if (!foot || foot.dataset.html === html) return;
  foot.dataset.html = html;
  el("sidebar-avatar").textContent = first[0]?.toUpperCase() ?? "";
  el("sidebar-you").textContent = first;
  el("sidebar-you").title = you;
  el("sidebar-plan").textContent = plan;
  el("sidebar-plan").title = state.chatgptAccount?.email ?? plan;
  const theme = el("sidebar-theme"), word = light ? "Dark theme" : "Light theme";
  theme.innerHTML = light ? ICON_MOON : ICON_SUN;
  theme.title = word;
  theme.setAttribute("aria-label", word);
}
/// The sun and moon swap between your last light and dark themes.
function flipTheme(): void {
  if (!state) return;
  const light = isLightTheme(state.theme), names = state.themes;
  try { localStorage.setItem(light ? "demesne-theme-light" : "demesne-theme-dark", state.theme); } catch {}
  let saved: string | null = null;
  try { saved = localStorage.getItem(light ? "demesne-theme-dark" : "demesne-theme-light"); } catch {}
  const next = saved && names.includes(saved) && isLightTheme(saved) !== light ? saved
    : names.includes(light ? "demesne" : "demesne-light") ? (light ? "demesne" : "demesne-light")
    : names.find((name) => isLightTheme(name) !== light);
  if (next) void act(() => dispatch("settings-set", { method: "theme", args: { name: next } }));
}
function renderStatus() {
  if (!state) return;
  renderSidebar();
  renderFoot();
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
    pageOpen,
  ]);
  renderCards();
  const rim = rimState(phase), peek = drivePeek();
  applyRim(rim);
  renderPlanLimit();
  if (signature + JSON.stringify([rim, peek]) === statusSignature) return;
  statusSignature = signature + JSON.stringify([rim, peek]);
  // A quiet footer: a spinner while working, a word only when the state
  // needs attention (failed, approval, offline…). "ready" says nothing.
  const working = Boolean(state.activeTurnId) && !["approval", "waiting", "failed"].includes(phase);
  // The composer names the model and the context used, and a session's top
  // bar carries its live state, so a session has no status bar.
  el("status").dataset.quiet = String(phase === "ready");
  el("status").hidden = inSession();
  // The context used, as a small ring; the numbers wait in its tooltip.
  const c2 = c.percentage == null ? "" : `<span class="ring" style="--usage:${Math.min(100, c.percentage)}%"></span>`;
  el("composer-model").innerHTML = `${h(state.model.id ? modelWords({ id: state.model.id, displayName: state.model.displayName ?? models.find((model) => model.id === state!.model.id)?.displayName }) : "") || "Choose a model"}${state.reasoning ? `<span class="composer-effort">${h(state.reasoning[0]!.toUpperCase() + state.reasoning.slice(1))}</span>` : ""}`;
  el("composer-context").innerHTML = c2;
  el("composer-context").title = c.percentage == null ? "" : `${num(c.used)} of ${num(c.capacity)} · ${c.percentage}% of the context used`;
  el("composer-context").hidden = !inSession() || !c2;
  renderContextCard();
  el("status").innerHTML =
    `${working ? `<span class="state">${spinner()}</span>` : phase === "ready" ? "" : `<span class="state ${phase === "failed" ? "danger" : phase === "approval" || phase === "waiting" ? "amber" : ""}"><img src="assets/${phase === "approval" || phase === "waiting" ? "activity-dot" : "ready-dot"}.svg" width="8" height="8" alt="">${h(phase)}</span>`}<span>${h((state.model.displayName ?? state.model.id) || "Connecting…")}${state.reasoning ? `<span class="muted"> · ${h(state.reasoning)}</span>` : ""}</span><div class="spacer"></div><div class="context">${c.percentage == null ? "<span>ctx —</span>" : `<div class="meter"><i style="--usage:${Math.min(100, c.percentage)}%"></i></div><span>${num(c.used)} · ${c.percentage}%</span>`}</div>${inSession() ? "" : btn("page-open", `${k("Tab")} settings`, { page: "settings" }, "key-action") + btn("insert-command", `${k("Ctrl+K")} commands`, {}, "key-action")}`;
  // The top bar carries the session's branch and ⋯, which opens the
  // session's own view (rename, compact, history). The sidebar shows what
  // needs you; Drive lives in its footer.
  el("header").innerHTML =
    `<div class="header-state">${pageOpen ? "" : branchChip()}${rimWords(rim)}</div>${driveWords(peek)}${inSession() && !pageOpen ? btn("overlay", "⋯", { name: "session" }, `header-more${overlay === "session" ? " active" : ""}`).replace("<button ", '<button title="This conversation" aria-label="This conversation" ') : ""}`;
}
/// Your plan's limit (pass 75 D): nothing under half; past it a small ring
/// and the fuller window's percentage sit beside the model word, amber from
/// 75%. Pointing at it gives the resets, the week, and Drive's rule.
let planLimits: PlanLimits[] = [], planLimitsAt = 0, planLimitsTurn: string | null = null, planLimitSignature = "";
async function loadPlanLimits() {
  planLimitsAt = Date.now();
  try { planLimits = await api<PlanLimits[]>("plan-limits") ?? []; } catch { return; }
  renderPlanLimit();
}
const resetWords = (at: string | null) => {
  if (!at) return "";
  const date = new Date(at), time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `, resets ${date.getTime() - Date.now() < 86_400_000 ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`}`;
};
function renderPlanLimit() {
  const node = document.getElementById("composer-limit");
  if (!node || !state) return;
  const limits = planLimits.find((item) => item.provider === state!.model.provider);
  const top = limits && planUsed(limits);
  const used = top ? Math.round(top.window.usedPercent) : 0;
  const signature = JSON.stringify([limits, used, Math.floor(Date.now() / 60_000)]);
  if (signature === planLimitSignature) return;
  planLimitSignature = signature;
  node.hidden = !top || used < PLAN_LIMIT_SHOWN;
  if (node.hidden || !limits || !top) { node.innerHTML = ""; node.removeAttribute("title"); return; }
  node.classList.toggle("warn", used >= PLAN_LIMIT_AMBER);
  node.innerHTML = `<span class="ring" style="--usage:${used}%"></span>${used}% of your ${h(top.name)} limit`;
  const plan = limits.plan ? `${limits.provider} ${limits.plan[0]!.toUpperCase()}${limits.plan.slice(1)}` : `${limits.provider} plan`;
  const windows = planWindows(limits).map(({ name, window }) => `${name === "weekly" ? "This week" : `${name[0]!.toUpperCase()}${name.slice(1)} window`} ${Math.round(window.usedPercent)}%${resetWords(window.resetsAt)}`);
  node.title = [plan, ...windows, used >= PLAN_LIMIT_DRIVE_PAUSE ? "Drive has paused its own runs" : `Drive pauses its own runs at ${PLAN_LIMIT_DRIVE_PAUSE}%`].join("\n");
}
// Each answer brings fresh numbers: look right after a turn ends, every 20
// seconds while one works, and every minute otherwise.
setInterval(() => {
  if (!state || document.hidden) return;
  const turn = state.activeTurnId ?? null, since = Date.now() - planLimitsAt;
  if ((planLimitsTurn && !turn) || since > (turn ? 20_000 : 60_000)) void loadPlanLimits();
  planLimitsTurn = turn;
}, 2_000);
/// The rim says the state (pass 74 B): the panel's hairline edge carries the
/// open chat's state, readable from across the room. A blue light runs along
/// it while a turn works, a still amber arc means it waits on you, and a red
/// dash marks a failed check or turn until you next touch the window.
type Rim = { kind: "work" | "wait" | "fail"; words: string } | null;
let rimFailSeen = "", rimFailShown = "";
function rimState(phase: string): Rim {
  if (!state || !inSession() || pageOpen) return null;
  if (phase === "approval") {
    const tool = state.approvals[0];
    return { kind: "wait", words: tool ? `Waiting on you · ${approvalWords(tool)}` : "Waiting on you" };
  }
  if (phase === "waiting") return { kind: "wait", words: "Waiting on your answer" };
  if (phase === "running" || phase === "checking") {
    const last = state.runs.at(-1), step = last ? tools(last).findLast((tool) => tool.state === "running") : undefined;
    const doing: Record<string, string> = { Run: "Running", Read: "Reading", Write: "Writing", Edit: "Editing", Search: "Searching", List: "Listing", Agent: "Asking an agent" };
    const target = step ? (step.name === "run_command" ? (step.detail ?? "").replace(/^\$\s*/, "").replace(/^\S*\//, "") : String(step.input.path ?? step.detail ?? "")) : "";
    const words = step ? `${doing[verb(step)] ?? verb(step)}${target && verb(step) !== "Agent" ? ` ${target}` : ""}` : phase === "checking" ? "Checking" : "Working";
    return { kind: "work", words: words.length > 48 ? `${words.slice(0, 47)}…` : words };
  }
  const last = state.runs.at(-1);
  if (!last || active(last)) return null;
  const check = tools(last).find((t) => t.phase === "verify" && t.name === "run_command" && t.input.background !== true && (t.state === "failed" || t.state === "denied"));
  if (last.status !== "failed" && !check) return null;
  rimFailShown = last.id;
  if (rimFailSeen === last.id) return null;
  return { kind: "fail", words: check ? "Check failed" : "Turn failed" };
}
/// A short name for what an approval asks: "run bun test?", "edit hello.ts?".
function approvalWords(tool: WorkspaceApproval) {
  const input = tool.input ?? {};
  // The program by its name, not its path: "bun run check", as the row says.
  const argv = Array.isArray(input.argv) ? input.argv.map(String).map((part, index) => index ? part : part.split(/[\\/]/).at(-1)!).join(" ") : typeof input.command === "string" ? input.command : "";
  const path = typeof input.path === "string" ? input.path.split(/[\\/]/).at(-1) : "";
  const words = tool.name === "run_command" && argv ? `run ${argv}` : path ? `${/write|create/.test(tool.name) ? "write" : "edit"} ${path}` : tool.name.replaceAll("_", " ");
  return words ? `${words.length > 40 ? `${words.slice(0, 39)}…` : words}?` : "";
}
function rimWords(rim: Rim) {
  if (!rim) return "";
  // A dot, not the cube: the cube lives in the conversation, and only once.
  return `<span class="header-live ${rim.kind}"><i aria-hidden="true"></i><span>${h(rim.words)}</span></span>`;
}
function applyRim(rim: Rim) {
  const app = el("app");
  for (const kind of ["work", "wait", "fail"]) app.classList.toggle(`rim-${kind}`, rim?.kind === kind);
}
// Looking at the window (a click or a key) settles a failure's red dash.
for (const type of ["pointerdown", "keydown"] as const)
  document.addEventListener(type, () => {
    if (rimFailShown && rimFailSeen !== rimFailShown && el("app").classList.contains("rim-fail")) {
      rimFailSeen = rimFailShown;
      queueMicrotask(() => { statusSignature = ""; renderStatus(); });
    }
  }, true);
/// Drive's panel waits behind yours (pass 74 D): while Drive works in its
/// own worktree chat, that chat sits behind the open one with one edge
/// showing, its title along it. Click the edge and the two swap. A finished
/// branch turns the edge green until you open it; inside Drive's chat the
/// edge is the chat it came from.
const peekSeen = new Set<string>();
/// Drive's word at the right end of the title bar (pass 79 A): a breathing
/// dot and the mission while a branch is being made elsewhere, green "Ready"
/// once it is, until you open it. Inside the mission's own chat the title
/// bar already says where it came from, so it carries nothing there.
type Peek = { sessionId: string; kind: "work" | "ready"; words: string };
function drivePeek(): Peek | null {
  if (!state || !inSession() || pageOpen) return null;
  const current = state.session?.id;
  const jobs = [state.breakage.fix, ...state.breakage.inbox].filter((job): job is NonNullable<typeof job> => Boolean(job?.sessionId));
  const name = (job: (typeof jobs)[number]) => (job.mission ? job.mission.split("\n")[0]!.replace(/^--(bounded|continuous)\s+/, "") : job.title) || "Drive's branch";
  const mine = jobs.find((job) => job.sessionId === current);
  if (mine) {
    if (mine.status === "ready") peekSeen.add(mine.id);
    return null;
  }
  const running = jobs.find((job) => job.status === "starting" || job.status === "running");
  if (running) return { sessionId: running.sessionId!, kind: "work", words: `Drive · ${name(running)}` };
  const ready = jobs.find((job) => job.status === "ready" && !peekSeen.has(job.id));
  return ready ? { sessionId: ready.sessionId!, kind: "ready", words: `Ready · ${name(ready)}` } : null;
}
function driveWords(peek: Peek | null) {
  if (!peek) return "";
  const title = `${peek.words} · open Drive's chat`;
  return `<button type="button" class="header-drive ${peek.kind}" data-action="select-session" data-args="${h(JSON.stringify({ id: peek.sessionId }))}" title="${h(title)}" aria-label="${h(title)}"><i aria-hidden="true"></i><span>${h(peek.words)}</span></button>`;
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
  return !inSession() && state && !isPlain() ? state.driveNext.proposals[0]?.title ?? null : null;
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
/// A step's target in mono: a path, a command by its program's name, a
/// question's first words, a sub-agent's task, with a saying that cycles
/// the whole time the sub-agent works (changed in place by a timer).
function toolTarget(run: WorkspaceRun, tool: ToolEntry) {
  if (tool.name === "ask_user") {
    const asked = Array.isArray(tool.input.questions) ? tool.input.questions as { question?: unknown }[] : [];
    const first = typeof asked[0]?.question === "string" ? asked[0].question : "";
    return first ? `${h(first)}${asked.length > 1 ? `<span class="muted"> · ${asked.length - 1} more</span>` : ""}` : "";
  }
  if (tool.name === "foundry_save") return h(String(tool.input.title || (tool.input.id ? "a new version" : "an artifact")));
  if (tool.name === "foundry_edit") { const n = Array.isArray(tool.input.edits) ? tool.input.edits.length : 0; return h(String(tool.input.title || (n ? `${n} edit${n === 1 ? "" : "s"}` : "an artifact"))); }
  if (tool.name === "foundry_read") return "";
  const base = (tool.detail ?? tool.name).replace(/^\$\s*/, "");
  // A command by its program's name: the full path is on hover.
  if (tool.name === "run_command") return h(base.replace(/^\S*\//, ""));
  if (tool.name !== "subagent" || tool.state !== "running") return h(base);
  // Still being written by the model: not running yet.
  if (tool.drafting) return `${h(base || "…")}<span class="muted"> · writing</span>`;
  const slot = run.entries.filter((entry) => entry.type === "tool" && entry.name === "subagent").indexOf(tool);
  const model = tool.subagentModel ?? state!.model.id;
  const phrase = matchMedia("(prefers-reduced-motion: reduce)").matches ? "working" : subagentPhrase(slot, Date.now(), model);
  return `${h(base)}<span class="muted"> · </span><span class="phrase" data-subagent-phrase data-slot="${slot}" data-model="${h(model)}">${h(phrase)}</span>`;
}
/// "3 steps": how far a sub-agent has got, on the right of its row.
function subagentSteps(tool: ToolEntry) {
  const steps = tool.name === "subagent" ? (tool.trace ?? []).length : 0;
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
const stepIconFor = (kind: string) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${STEP_ICONS[kind] ?? STEP_ICONS.other}</svg>`;
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
  return stepIconFor(kind);
};
const ICON_SWITCH = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h12l-3-3"/><path d="M21 17H9l3 3"/><path d="M15 7a6 6 0 0 1 6 6"/></svg>';
const ICON_SPARK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';
const ICON_COPY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_UNDO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const CHEVRON = '<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
/// Whether a step has something to unfold: an edit's diff, a command's
/// output, a sub-agent's own steps and what it found.
const foldable = (tool: ToolEntry) =>
  (tool.phase === "change" && tool.state !== "running" && !tool.drafting && (Boolean(tool.changes?.length) || Boolean(tool.diff))) ||
  (tool.name === "run_command" && !tool.waiting && !tool.drafting && Boolean(tool.toolCallId)) ||
  (tool.name === "subagent" && !tool.drafting && Boolean(tool.toolCallId));
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
            ? `<span class="success">✓</span> ${tool.exitCode != null && tool.exitCode !== 0 ? `exit ${tool.exitCode} · ` : ""}${tool.name === "subagent" && subagentSteps(tool) ? `${subagentSteps(tool)} · ` : ""}${duration(tool.durationMs)}`
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
  // A finished step can become "now" again: files and chat go back to here.
  const back = canRewind(run) && tool.toolCallId && ["done", "failed", "denied"].includes(tool.state) && !tool.waiting
    ? btn("rewind", `${ICON_UNDO}Rewind to here`, { turnId: run.id, toolCallId: tool.toolCallId }, "step-rewind").replace("<button ", '<button title="Put the files and the chat back to just after this step" ')
    : "";
  // Something made in Foundry opens from its step.
  const made = (tool.name === "foundry_save" || tool.name === "foundry_edit") && tool.state === "done"
    ? btn("foundry-open-step", "Open ›", { id: tool.input.id ?? null, title: tool.input.title ?? null, message: tool.message ?? null }, "fd-step-open")
    : "";
  return (back || made ? `<div class="step-line">${row}${made}${back}</div>` : row) + (open && canFold ? stepFold(run, tool) : "");
}
/// Rewind waits for running work, and only conversation turns rewind.
const canRewind = (run: WorkspaceRun) => !state!.activeTurnId && !run.kind && run.status !== "running" && run.status !== "queued";
/// The rewind that stopped inside this turn, if one did.
const rewindIn = (run: WorkspaceRun) => state!.rewinds.find((rewind) => rewind.turnId === run.id && rewind.toolCallId);
/// The rewind that folded this turn away, if one did.
const rewoundBy = (run: WorkspaceRun) => state!.rewinds.find((rewind) => rewind.hiddenTurnIds.includes(run.id));
/// A rewind's one line where the undone part was: what went back, and Redo
/// until the next message.
function rewindLine(rewind: Snapshot["rewinds"][number]) {
  const hidden = state!.runs.filter((run) => rewind.hiddenTurnIds.includes(run.id));
  const cut = rewind.toolCallId ? state!.runs.find((run) => run.id === rewind.turnId) : undefined;
  const at = cut ? cut.entries.findIndex((entry) => entry.type === "tool" && entry.toolCallId === rewind.toolCallId) : -1;
  const after = cut ? cut.entries.slice(at + 1) : [];
  const steps = after.filter((entry) => entry.type === "tool").length + hidden.reduce((sum, run) => sum + tools(run).length, 0);
  const undone = [
    steps ? `${steps} step${steps === 1 ? "" : "s"}` : "",
    hidden.length ? `${hidden.length} message${hidden.length === 1 ? "" : "s"}` : "",
    after.some((entry) => entry.type === "assistant") ? "the answer" : "",
  ].filter(Boolean);
  const words = [
    "Rewound",
    undone.length ? `${undone.length > 1 ? `${undone.slice(0, -1).join(", ")} and ${undone.at(-1)}` : undone[0]} undone` : "",
    rewind.files.length === 1 ? `${rewind.files[0]!.split("/").at(-1)} put back` : rewind.files.length ? `${rewind.files.length} files put back` : "",
    rewind.commands ? `<span title="Rewind can't take back what commands did">${rewind.commands} command${rewind.commands === 1 ? "" : "s"} ran</span>` : "",
  ].filter(Boolean);
  return `<div class="rewind-line" title="${h(rewind.files.join("\n"))}"><span class="rw-mark" aria-hidden="true">${ICON_UNDO}</span><span class="rw-what">${words.join('<span class="muted"> · </span>')}</span>${rewind.redoable && !state!.activeTurnId ? btn("rewind-redo", "Redo", {}, "link rw-redo") : ""}</div>`;
}
/// What unfolds under a step: the edit's diff with a little context, the
/// command's recorded output (its tail), loaded when first opened, or a
/// sub-agent's own guide.
function stepFold(run: WorkspaceRun, tool: ToolEntry) {
  if (tool.name === "subagent") return agentFold(run, tool);
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
    return `<div class="step-fold pv" data-preview="${h(key)}"><div class="pv-bar"><span class="pv-live" aria-hidden="true"></span><span class="pv-url" title="${h(url)}">${h(host)}</span><span class="sp"></span>${tab("Desktop", !phone, "preview-width", { key, phone: false })}${tab("Phone", phone, "preview-width", { key, phone: true })}${tab(pointing === key ? "Pointing · Esc" : "⌖ Point", pointing === key, "preview-point", { key }).replace("<button ", '<button title="Point at something in the page; it goes in your next message with the code behind it" ')}${tab("Reload", false, "preview-reload", { key })}${tab("Output", false, "preview-output", { key })}${tab("Open ↗", false, "open-link", { url })}</div><div class="pv-view${phone ? " phone" : ""}"><iframe src="${h(url)}" name="pv-${h(key)}" title="Preview of ${h(host)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" referrerpolicy="no-referrer"></iframe></div></div>`;
  }
  const text = record ? `${record.stdout}${record.stderr ? `\n${record.stderr}` : ""}`.trim().split("\n").slice(-40).join("\n") : "";
  const body = text ? `<pre class="out">${h(text)}</pre>` : `<div class="out muted">${record?.outputLoaded === false ? "Loading output…" : record ? "No output." : "Output not recorded."}</div>`;
  const back = record?.serves ? btn("preview-output", "Preview", { key }, "pv-btn pv-back") : "";
  return `<div class="step-fold"><div class="fold-cmd">$ ${h(String(tool.detail ?? "").replace(/^\$\s*/, ""))}${back}</div>${body}</div>`;
}
/// A sub-agent's guide, one level in under its row: its reads, searches and
/// lists as the same quiet lines as the turn's own (three or more reads in a
/// row fold as Explored), the last one shining while it runs, and at the end
/// what it found, clipped to a few lines until clicked. No thinking: a
/// sub-agent runs with it off.
const foundOpen = new Set<string>();
function agentFold(run: WorkspaceRun, tool: ToolEntry) {
  const key = `${run.id}:${tool.id}`, live = tool.state === "running";
  const steps = (tool.trace ?? []).map((segment) => {
    const text = segment.text.replace(/^[^·]+ · /, "");
    const match = /^(read|search|list|git \w+)(?: (.*))?$/.exec(text);
    const kind = match?.[1] === "read" || match?.[1]?.startsWith("git") ? "read" : match?.[1] === "search" ? "search" : match?.[1] === "list" ? "list" : "other";
    const verb = match?.[1] === "read" ? "Read" : match?.[1] === "search" ? "Searched" : match?.[1] === "list" ? "Listed" : match?.[1]?.startsWith("git") ? "Checked git" : text;
    return { kind, verb, target: match ? match[2] ?? "" : "" };
  });
  const line = (kind: string, verb: string, target: string, meta: string, shining = false) =>
    `<div class="tool-row quiet">${stepIconFor(kind)}<span class="verb">${shining ? shine(verb) : h(verb)}</span>${target ? `<code class="target" title="${h(target)}">${h(target)}</code>` : ""}<span class="sp"></span><small class="meta">${meta}</small></div>`;
  let body = tool.subagentModel ? `<div class="tool-row quiet agent-on">${stepIconFor("agent")}<span class="verb">on ${h(tool.subagentModel)}</span></div>` : "";
  for (let i = 0; i < steps.length; i++) {
    const last = i === steps.length - 1 && live;
    let j = i;
    while (j < steps.length && steps[j]!.kind === "read" && !(j === steps.length - 1 && live)) j++;
    if (j - i >= 3) {
      const fold = `${key}:explored:${i}`;
      body += `<details class="explored" data-detail="${fold}"${detailsOpen.has(fold) ? " open" : ""}><summary>${stepIconFor("read")}<span class="verb">Explored · ${j - i} reads</span><span class="sp"></span><small class="meta"></small></summary><div>${steps.slice(i, j).map((step) => line(step.kind, step.verb, step.target, '<span class="success">✓</span>')).join("")}</div></details>`;
      i = j - 1;
      continue;
    }
    body += line(steps[i]!.kind, steps[i]!.verb, steps[i]!.target, last ? "" : '<span class="success">✓</span>', last);
  }
  if (live && !steps.length) body += line("agent", "Starting", "", "", true);
  if (tool.state === "failed" || tool.state === "denied" || tool.state === "stopped")
    body += `<div class="agent-found"><b><span class="danger">×</span> ${h(tool.state === "stopped" ? "Stopped" : "Failed")}</b>${tool.message ? ` · ${h(tool.message.replace(/^Error: (sub-agent failed: )?/, "").split("\n")[0] ?? "")}` : ""}</div>`;
  else if (tool.report) {
    const open = foundOpen.has(key), text = tool.report.trim(), clipped = !open && text.length > 240;
    body += `<div class="agent-found"><b>Found</b> · ${h(clipped ? `${text.slice(0, 240).trimEnd()}…` : text)}${text.length > 240 ? btn("agent-found", open ? "less" : "more", { key }, "link agent-more") : ""}</div>`;
  }
  return `<div class="agent-steps" role="group">${body}</div>`;
}
function runHTML(run: WorkspaceRun, index: number) {
  const rewound = rewoundBy(run);
  if (rewound) return rewindLine(rewound);
  const cut = rewindIn(run);
  if (cut) {
    const at = run.entries.findIndex((entry) => entry.type === "tool" && entry.toolCallId === cut.toolCallId);
    if (at >= 0) run = { ...run, entries: run.entries.slice(0, at + 1) };
  }
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
  const live = active(run), fold = run.status === "completed" && !cut && !stepsOpen.has(run.id) && !items.some((tool) => serving(tool));
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
      // A sub-agent stands alone: its row unfolds its own guide.
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
      } else steps += toolRow(run, entry);
    }
    if (entry.type === "notice" && !entry.closesTurn) {
      if (entry.steer) { steps += steerLine(entry.text); continue; }
      if (entry.quiet) { steps += `<div class="tool-row switch">${ICON_SWITCH}<span class="verb">${h(entry.text)}</span></div>`; continue; }
      flush();
      body += `<div class="system-band"><b>system</b><span>${h(entry.text)}</span></div>`;
    }
  }
  // Words you sent that the model hasn't read yet wait at the end of the guide.
  if (live && run.id === state!.activeTurnId) for (const steer of state!.steers ?? []) steps += steerLine(steer.text, true);
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
  if (cut) footer = rewindLine(cut);
  else if (!active(run)) {
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
    ? `<div class="live-activity">${spinner()}${shine(phase + (latestTool?.drafting || latestTool?.name === "run_command" ? "" : latestTool?.detail ?? "") + "…")}</div>`
    : "";
  const answered = run.entries.some((e) => e.type === "assistant");
  const asks = `<span class="ask-actions">${btn("edit-ask", "edit", { id: run.id })}${live || state!.activeTurnId ? "" : btn("retry-ask", "retry", { id: run.id })}${canRewind(run) ? btn("rewind", "rewind", { turnId: run.id }).replace("<button ", '<button title="Put the files and the chat back to just before this message" ') : ""}</span>`;
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
/// Words you sent mid-turn: one line on the guide where the model read them,
/// faint with "on its way" until it does.
function steerLine(text: string, pending = false): string {
  return `<div class="tool-row steer${pending ? " pending" : ""}"><span class="steer-mark">↳</span><span class="verb" title="${h(text)}">you: ${h(text)}</span>${pending ? '<small class="meta">on its way</small>' : ""}</div>`;
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
      saved.views.get(entry.id)!.update(splitNextPrompt(entry.raw).text, run.status === "running");
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
    // A rewind folds the turns after its cut into one line: on the turn it
    // stopped in, or in place of the first turn it took back.
    const folded = rewoundBy(run);
    if (folded && (folded.toolCallId || folded.hiddenTurnIds.find((id) => state!.runs.some((item) => item.id === id)) !== run.id)) continue;
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
      active(run) ? state.steers : [],
      state.activeTurnId,
      reviewOpen.has(run.id) ? reviewVersion : 0,
      detailsOpen.has(`drive-asked:${run.id}`),
      state.rewinds.filter((rewind) => rewind.turnId === run.id || rewind.hiddenTurnIds.includes(run.id)),
    ]);
    let saved = runNodes.get(run.id);
    if (!saved) {
      const node = document.createElement("article");
      node.className = "turn";
      node.id = `turn-${run.id}`;
      const content = document.createElement("div");
      content.className = "turn-content";
      const artifacts = new FoundryChatArtifacts({
        open: (artifact) => pane.show(artifact.id, artifact.version),
        isOpen: (artifact) => pane.isOpen(artifact.id, artifact.version),
      });
      node.append(content, artifacts.element);
      root.append(node);
      saved = { node, content, artifacts, signature: "", views: new Map() };
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
        view.update(splitNextPrompt(entry.raw).text, run.status === "running");
        slot.replaceWith(view.element);
      }
      saved.content.replaceChildren(template.content);
      const retained = new Set(
        [...saved.node.querySelectorAll<HTMLElement>("[data-entry]")].map(
          (node) => Number(node.dataset.entry),
        ),
      );
      for (const id of saved.views.keys())
        if (!retained.has(id)) saved.views.delete(id);
    }
    const rewind = rewindIn(run);
    const at = rewind && run.entries.findIndex((entry) => entry.type === "tool" && entry.toolCallId === rewind.toolCallId);
    saved.artifacts.update(rewoundBy(run) ? [] : typeof at === "number" && at >= 0 ? run.entries.slice(0, at + 1) : run.entries);
    saved.signature = signature;
    saved.run = run;
    changed = true;
  }
  for (const [id, saved] of runNodes)
    if (!ids.has(id)) {
      saved.artifacts.dispose();
      saved.node.remove();
      runNodes.delete(id);
      changed = true;
    }
  if (changed) pane.refresh([...runNodes.values()].flatMap((item) => item.artifacts.artifacts));
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
/// Home's cherry blossom lives behind the start screen only, and sleeps while
/// a chat or a page is showing.
let sakura: Sakura | null = null, sakuraTried = false, sakuraDark: boolean | null = null;
const colorProbe = document.createElement("canvas").getContext("2d");
function inkIsDark() {
  if (!colorProbe) return true;
  // the canvas normalises any CSS colour to #rrggbb
  colorProbe.fillStyle = "#000"; colorProbe.fillStyle = getComputedStyle(document.body).getPropertyValue("--ink").trim() || "#000";
  const hex = String(colorProbe.fillStyle), [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  return .2126 * r! + .7152 * g! + .0722 * b! < 128;
}
function renderSakura(show: boolean) {
  const host = document.getElementById("sakura");
  if (!host) return;
  if (show && !sakuraTried) {
    sakuraTried = true;
    try { sakura = mountSakura(host, inkIsDark()); } catch { sakura = null; }
  }
  host.hidden = !show || !sakura;
  if (!sakura) return;
  const dark = inkIsDark();
  if (dark !== sakuraDark) { sakuraDark = dark; sakura.setDark(dark); }
  if (show) sakura.resume(); else sakura.pause();
}
/// When the window was last in front of you, kept on this computer: Home
/// says what happened since.
const LEFT_KEY = "demesne-left-at";
let leftAt: number | null = (() => { try { const at = Number(localStorage.getItem(LEFT_KEY)); return at > 0 ? at : null; } catch { return null; } })();
const leaving = () => { leftAt = Date.now(); try { localStorage.setItem(LEFT_KEY, String(leftAt)); } catch { /* storage may be off */ } };
window.addEventListener("blur", leaving);
window.addEventListener("pagehide", leaving);
document.addEventListener("visibilitychange", () => { if (document.hidden) leaving(); });
/// The chat whose approval is unfolded under Home's paragraph.
let awayAskShown: string | null = null;
/// Routines, for what ran on a schedule while you were away.
let homeRoutines: { at: number; routines: Routine[] } | null = null, homeRoutinesLoading = false;
function loadHomeRoutines() {
  if (homeRoutinesLoading || (homeRoutines && Date.now() - homeRoutines.at < 60_000)) return;
  homeRoutinesLoading = true;
  void api<Routine[]>("routines").then((routines) => { homeRoutines = { at: Date.now(), routines: Array.isArray(routines) ? routines : [] }; }, () => { homeRoutines = { at: Date.now(), routines: [] }; })
    .finally(() => { homeRoutinesLoading = false; heroSignature = ""; renderHero(); });
}
const awayPart = (part: AwayPart) => typeof part === "string" ? h(part)
  : "name" in part ? `<i>${h(part.name)}</i>`
  : "code" in part ? `<code>${h(part.code)}</code>`
  : btn(part.action, h(part.text), part.args ?? {}, `away-link${part.tone ? ` ${part.tone}` : ""}${part.open ? " on" : ""}`).replace("<button ", part.open === undefined ? "<button " : `<button aria-expanded="${part.open}" `);
/// A chat's approval on Home: the same amber row the chat shows, answered
/// here while the chat carries on.
function awayApproval(sessionId: string, ask: Extract<AwayAsk, { kind: "permission" }>) {
  const icon = ask.verb === "run" ? APPROVAL_ICONS.command : /edit|append/.test(ask.verb) ? APPROVAL_ICONS.edit : APPROVAL_ICONS.other;
  const habit = Boolean(ask.rule) && ask.allowedBefore >= 3;
  const always = ask.rule ? btn("away-permission", habit ? "Always here" : "Always", { session: sessionId, id: ask.id, decision: "allow_always" }, habit ? "allow" : "always").replace("<button ", `<button title="Saved to your config (${h(ask.rule)})" `) : "";
  return `<div class="approval-row" role="group" aria-label="Approval">${icon}<span class="approval-verb">${h(ask.verb.replace(/^./, (c) => c.toUpperCase()))}</span>${ask.target ? `<code>${h(ask.target)}</code>` : ""}<span class="approval-space"></span>`
    + (habit ? always + btn("away-permission", "Once", { session: sessionId, id: ask.id, decision: "allow_once" }, "always") : btn("away-permission", "Allow", { session: sessionId, id: ask.id, decision: "allow_once" }, "allow") + always)
    + btn("away-permission", "Deny", { session: sessionId, id: ask.id, decision: "deny" }, "deny")
    + btn("select-session", "Open chat ›", { id: sessionId }, "always")
    + `</div>`;
}
function renderHero() {
  if (!state) return;
  const review = reviewJobs(),
    next = state.driveNext,
    user = document.body.dataset.user ?? "",
    branch = state.session?.workspace?.gitBranch ?? "",
    hour = new Date().getHours(),
    running = worktreeRun().fix,
    plain = isPlain();
  const here = plain ? [] : state.sessions.filter((session) => session.workspace === state!.workspace && session.id !== state!.session?.id);
  if (!plain) loadHomeRoutines();
  const waiting = here.filter((session) => session.waiting);
  if (awayAskShown && !waiting.some((session) => session.id === awayAskShown && session.ask?.kind === "permission")) awayAskShown = null;
  // Routines that ran here since you left; their chats are named once.
  const ran = (homeRoutines?.routines ?? []).filter((routine) => routine.workspace === state!.workspace)
    .flatMap((routine) => routine.runs.filter((run) => leftAt != null && Date.parse(run.at) > leftAt!).map((run) => ({ title: state!.sessions.find((session) => session.id === run.sessionId)?.title || routine.text, at: run.at, sessionId: run.sessionId })))
    .filter((run) => !waiting.some((session) => session.id === run.sessionId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const sentences = plain ? [] : awaySentences({
    now: Date.now(),
    leftAt,
    branches: review.map((job) => ({ title: job.title, status: job.status === "failed" ? "failed" : "ready", finishedAt: job.finishedAt, failedCheck: job.checks?.find((check) => !check.passed)?.command, unchanged: job.unchanged })),
    running: running ? { title: running.title, steps: running.activity?.steps ?? 0 } : null,
    waiting: waiting.map((session) => ({ sessionId: session.id, title: chatTitle(session.id), ask: session.ask })),
    busy: here.filter((session) => !session.waiting && (session.status === "running" || session.status === "queued") && !ran.some((run) => run.sessionId === session.id)).map((session) => ({ sessionId: session.id, title: chatTitle(session.id) })),
    routines: ran,
    ideas: next.proposals.length,
    asks: state.asks,
    shown: { branches: reviewShown, drive: driveShown, ideas: ideasShown, ask: awayAskShown },
  });
  // Back to the chat you were last in, with the last thing you asked there.
  const last = [...here].filter((session) => session.turns > 0).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const asked = waiting.find((session) => session.id === awayAskShown)?.ask;
  const signature = JSON.stringify([plain, state.workspace, sentences, review.map((job) => [job.id, job.status, job.diff, job.summary, job.checks]), running && [running.id, running.activity], state.breakage.busy, state.breakage.message, [...detailsOpen].filter((key) => key.startsWith("branch:")), next.proposals, next.loading, ideasShown && next.generatedAt && age(next.generatedAt), user, branch, hour, asked, last && [last.id, last.title, last.lastAsk, age(last.updatedAt)]]);
  if (signature === heroSignature) return;
  heroSignature = signature;
  const composer = el("composer-slot");
  composer.remove();
  const name = state.workspace.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || state.workspace;
  const day = new Date().toLocaleDateString(undefined, { weekday: "long" }),
    when = `${day} ${hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}`,
    where = branch ? `${h(name)} on ${h(branch)}` : h(name);
  // One paragraph: what happened while you were away, what needs you first.
  // Each underlined phrase unfolds that thing right under it.
  const paragraph = sentences.length ? `<p class="away">${sentences.map((sentence) => sentence.map(awayPart).join("")).join(" ")}</p>` : "";
  const folds = [
    reviewShown && review.length ? branchRows(review) : "",
    asked?.kind === "permission" ? awayApproval(awayAskShown!, asked) : "",
    driveShown && running ? branchRows([running]) : "",
    ideasShown && next.proposals.length ? `${proposalRows(next.proposals)}<p class="proposals-footer">${btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", next.loading)}${next.generatedAt ? `<span class="muted"> · looked ${age(next.generatedAt)}</span>` : ""}</p>` : "",
  ].filter(Boolean);
  const fold = (folds.length ? `<div class="away-fold">${folds.join("")}</div>` : "") + branchNote();
  // While Drive works, its phrase carries a moving line.
  const bar = running ? '<span class="away-bar" aria-hidden="true"></span>' : "";
  const pick = last
    ? btn("select-session", `<span class="pick-word">Pick up</span><b>${h(chatTitle(last.id))}</b>${last.lastAsk ? `<q>${h(last.lastAsk)}</q>` : ""}<span class="pick-age">${h(age(last.updatedAt))}</span><span class="pick-go" aria-hidden="true">›</span>`, { id: last.id }, "hero-pick")
    : "";
  // Just a chat: the time of day and the greeting; the project's news comes
  // back once a project is picked.
  el("hero").innerHTML = plain
    ? `<div class="intro"><span class="hero-eyebrow">${ICON_SPARK}${h(when)}</span><h1>What are we building${user ? `, ${h(user)}` : ""}?</h1></div><div id="hero-composer"></div>`
    : `<div class="intro"><span class="hero-eyebrow">${ICON_SPARK}${h(when)} · ${where}</span><h1>What are we building${user ? `, ${h(user)}` : ""}?</h1>${paragraph}${bar}${fold}${pick}</div><div id="hero-composer"></div>`;
  el("hero-composer").append(composer);
}
/// A page in place of the conversation, opened from the sidebar: All chats
/// (Active or Archived), Scheduled, Customize or Settings. "" when closed.
type PageKind = ChatsTab | "scheduled" | "foundry" | "customize" | "settings";
let pageOpen: "" | PageKind = "";
/// Foundry: the gallery, the artifact open in it, and how it is shown.
let foundryList: FoundryArtifact[] | null = null, foundryOpen: FoundryArtifactDetail | null = null, foundrySaves = -1;
const foundryUi: FoundryUi = { tab: "all", view: "preview", width: "desktop", edit: null, draft: "", error: "", busy: false };
/// The pane beside the conversation: one artifact open the way Claude
/// shows one. Per chat; the chips in the chat open and mark it.
const pane = new FoundryPane(el("pane"), {
  read: (id, version) => api<FoundryArtifactDetail>("foundry-get", version ? { id, version } : { id }),
  markdown,
  copy: (text) => api("copy", { text }),
  export: async (id, version) => {
    const result = await api<{ path: string } | null>("desktop-foundry-export", { id, version });
    if (result?.path) notice(`Exported to ${result.path}`);
  },
  revise: async (detail) => {
    await api("foundry-revise", { id: detail.id, title: detail.title });
    editor.focus({ preventScroll: true });
  },
  restore: (detail) => api<FoundryArtifactDetail>("foundry-save", { id: detail.id, source: detail.source }),
  openFoundry: (id, version) => { void openFoundry(id, version); },
  notice,
  changed: () => {
    el("app").classList.toggle("pane-on", pane.open);
    runNodes.forEach((item) => item.artifacts.mark());
  },
});
let archivedChats: ChatsPageChat[] | null = null;
let routinesHere: Routine[] | null = null;
const routineUi = { error: "", draft: "" };
let customizeData: CustomizeView | null = null;
const customizeUi: CustomizeUi = { editing: null, error: "" };
async function customizeCall(method: string, args: Record<string, unknown> = {}) {
  try {
    const result = await api<unknown>(method, args);
    customizeUi.error = "";
    return result;
  } catch (error) {
    customizeUi.error = error instanceof Error ? error.message.replace(/^.*?: /, "") : String(error);
    renderPage();
    return undefined;
  }
}
async function loadCustomize() {
  const view = await customizeCall("customize") as CustomizeView | undefined;
  if (view) customizeData = view;
  renderPage();
}
/// Unfolds a file under its row, or folds it when it is already open.
async function editCustomizable(path: string) {
  if (customizeUi.editing?.path === path) { customizeUi.editing = null; return renderPage(); }
  customizeUi.editing = { path, text: null };
  renderPage();
  const read = await customizeCall("customize-read", { path }) as { text: string } | undefined;
  if (customizeUi.editing?.path !== path) return;
  if (!read) { customizeUi.editing = null; return renderPage(); }
  customizeUi.editing.text = read.text;
  renderPage();
  document.querySelector<HTMLTextAreaElement>("#page .cz-edit textarea")?.focus({ preventScroll: true });
}
/// Settings: the section shown, the search, the row whose words are unfolded,
/// and what the host read from config.toml and the daemon.
const settingsUi = { section: "general" as SettingsSection, query: "", fold: "", error: "" };
let settingsInfo: SettingsInfo | null = null, usageScores: ModelScore[] | null = null,
  /// The window's zoom, read from the desktop shell when Settings opens.
  zoomLevel: number | null = null;
/// Settings › General, kept on this device.
let openOn: "home" | "last" = "home", keepAwake = true;
try { if (localStorage.getItem("demesne-open-on") === "last") openOn = "last"; if (localStorage.getItem("demesne-awake") === "off") keepAwake = false; } catch {}
/// Settings › Appearance › Glass and Ink, kept on this device.
let glassLevel = GLASS_DEFAULT, inkName: Ink = "neutral";
try {
  const saved = Number(localStorage.getItem("demesne-glass"));
  if (localStorage.getItem("demesne-glass") !== null && Number.isFinite(saved)) glassLevel = Math.min(100, Math.max(0, saved));
  const ink = localStorage.getItem("demesne-ink");
  if (isInk(ink)) inkName = ink;
} catch {}
function applyGlass() {
  const { shell, panel } = glassAlphas(glassLevel), root = document.documentElement.style;
  root.setProperty("--shell-a", String(shell)); root.setProperty("--panel-a", String(panel));
}
function applyInk() {
  if (inkName === "neutral") delete document.documentElement.dataset.ink;
  else document.documentElement.dataset.ink = inkName;
}
applyGlass(); applyInk();
async function settingsCall(method: string, args: Record<string, unknown> = {}) {
  try {
    settingsInfo = await api<SettingsInfo>(method, args);
    settingsUi.error = "";
  } catch (error) {
    settingsUi.error = error instanceof Error ? error.message.replace(/^.*?: /, "") : String(error);
  }
  renderPage();
}
async function saveSystemThemeSource(enabled: boolean, path: string) {
  try {
    await api("theme-system-source",{enabled,path});
    settingsUi.error="";
  }catch(error) { settingsUi.error=error instanceof Error?error.message:String(error); }
  renderPage();
}
function loadSettings() {
  void settingsCall("settings-info");
  void loadArchived();
  void api("providers-refresh").catch(() => {});
  void api<ModelScoreboardResponse>("model-scores").then((result) => { usageScores = result.models; renderPage(); }, () => { usageScores = usageScores ?? []; renderPage(); });
  if (window.demesne.mode === "desktop")
    void api<{ zoom?: number }>("desktop-zoom").then((result) => { zoomLevel = typeof result?.zoom === "number" ? result.zoom : null; renderPage(); }, () => {});
}
function settingsView(): SettingsView {
  const s = state!, session = s.session;
  const here = document.getElementById("sidebar-sessions")?.dataset.workspace || s.workspace;
  const mode = !session ? null : s.planOnly ? "plan" : session.autoApprove ? "auto" : session.acceptEdits ? "edits" : "ask";
  return {
    section: settingsUi.section, query: settingsUi.query, fold: settingsUi.fold, error: settingsUi.error,
    mac: /Mac/i.test(navigator.platform), glass: document.documentElement.classList.contains("glass"), desktop: window.demesne.mode === "desktop", home: settingsInfo?.home ?? "",
    info: settingsInfo,
    general: { openOn, awake: keepAwake },
    notify: notifyOn,
    appearance: { theme: s.theme, themes: s.themes.map((name) => ({ name, label: s.themeOptions.find((item) => item.name === name)?.label ?? name })), canUndo: s.themeCanUndo, systemSource: s.systemThemeSource, zoom: zoomLevel, glass: glassLevel, ink: inkName },
    archived: archivedChats,
    usage: usageScores,
    modelWords,
    permissions: { mode, asks: s.asks },
    drive: { project: isPlain() ? "" : projectLabel(here), auto: isPlain() ? null : s.breakage.auto },
    model: { words: modelWords(s.model), provider: s.model.provider ?? "", reasoning: s.reasoning ?? "", chatgpt: s.model.provider === "ChatGPT" ? s.chatgptAccount?.email ?? s.chatgptAccount?.label ?? "" : null },
    providers: s.providers,
    connectors: s.connectors,
    agents: s.agents,
    chats: { here: s.sessions.filter((item) => item.workspace === here && item.turns).length, all: s.sessions.filter((item) => item.turns).length },
    online: s.connection === "online",
  };
}
/// The sidebar holds Settings' list while it is open; the search keeps the
/// keyboard and its caret across a redraw.
let settingsNavHtml = "";
function renderSettingsNav() {
  const sidebar = document.getElementById("desktop-sidebar"), nav = document.getElementById("settings-nav");
  if (!sidebar || !nav) return;
  const open = pageOpen === "settings";
  sidebar.classList.toggle("settings-open", open);
  nav.hidden = !open;
  if (!open) { settingsNavHtml = ""; return; }
  const html = settingsNav({ section: settingsUi.section, query: settingsUi.query, archived: archivedChats, info: settingsInfo });
  if (html === settingsNavHtml) return;
  const search = document.activeElement?.id === "settings-search" ? (document.activeElement as HTMLInputElement) : null, at = search?.selectionStart ?? 0;
  nav.innerHTML = settingsNavHtml = html;
  if (search) { const again = el<HTMLInputElement>("settings-search"); again.focus({ preventScroll: true }); again.setSelectionRange(at, at); }
}
function settingsSection(id: SettingsSection) {
  settingsUi.section = id;
  settingsUi.query = settingsUi.fold = "";
  const search = document.getElementById("settings-search") as HTMLInputElement | null;
  if (search) search.value = "";
  if (id === "usage" || id === "archived" || id === "permissions" || id === "data") loadSettings();
  renderPage();
  document.getElementById("page")?.scrollTo?.({ top: 0 });
}
/// A number typed in Settings, saved when you press Enter or leave the field.
function saveSettingsNumber(input: HTMLInputElement) {
  const value = parseNumber(input.value), was = Number(input.dataset.value);
  if (value === was) { input.value = was.toLocaleString("en-US"); return; }
  if (value === null || value <= 0) { input.value = was.toLocaleString("en-US"); settingsUi.error = "Type a whole number, like 400k or 2M."; renderPage(); return; }
  void settingsCall("settings-config", { key: input.dataset.key, value });
}
/// Keeps the Mac awake while a turn or Drive runs, when Settings says so.
let awakeAsked: boolean | null = null;
function renderAwake() {
  if (!state || window.demesne.mode !== "desktop") return;
  const working = keepAwake && state.connection === "online" && (Boolean(state.activeTurnId)
    || state.sessions.some((item) => item.status === "running" || item.status === "queued")
    || ["running", "waiting"].includes(state.drive?.status ?? "") || reviewJobs().some((job) => job.status === "running"));
  if (working === awakeAsked) return;
  awakeAsked = working;
  void api("desktop-awake", { on: working }).catch(() => {});
}
/// Open on Last chat: the chat you were in when the window last closed.
let lastChatOpened = false;
function renderLastChat() {
  if (!state || state.connection !== "online") return;
  const session = state.session;
  if (!lastChatOpened) {
    lastChatOpened = true;
    let saved: { id?: string; path?: string } | null = null;
    try { saved = JSON.parse(localStorage.getItem("demesne-last-chat") ?? "null"); } catch {}
    if (openOn === "last" && saved?.id && saved.id !== session?.id && state.sessions.some((item) => item.id === saved!.id)) {
      const here = !saved.path || saved.path === state.workspace;
      void act(() => dispatch(here ? "select-session" : "project-session", here ? { id: saved!.id } : { id: saved!.id, path: saved!.path }));
      return;
    }
  }
  if (session && inSession()) try { localStorage.setItem("demesne-last-chat", JSON.stringify({ id: session.id, path: session.workspace?.root ?? null })); } catch {}
}
function openPage(kind: "" | PageKind) {
  const was = pageOpen;
  pageOpen = kind;
  sidebarSignature = heroSignature = "";
  if (kind === "active" || kind === "archived") void loadArchived();
  if (kind === "scheduled") { if (was !== "scheduled") routineUi.error = ""; void loadRoutines(); }
  if (kind === "customize") { if (was !== "customize") Object.assign(customizeUi, { editing: null, error: "" }); void loadCustomize(); }
  if (kind === "foundry") { if (was !== "foundry") Object.assign(foundryUi, { edit: null, error: "" }); foundrySaves = foundrySaveCount(); void loadFoundry(); }
  if (kind === "settings" && was !== "settings") { Object.assign(settingsUi, { query: "", fold: "", error: "" }); loadSettings(); }
  if (state) renderState({ ...state });
  if (kind === "active" || kind === "archived") document.querySelector<HTMLElement>("#page .cp-tab.on")?.focus({ preventScroll: true });
  if (kind === "scheduled") document.querySelector<HTMLInputElement>("#routine-new input")?.focus({ preventScroll: true });
  if (kind === "foundry" && !foundryOpen) document.querySelector<HTMLInputElement>("#foundry-make input")?.focus({ preventScroll: true });
  if (kind === "settings" && was !== "settings") document.querySelector<HTMLElement>("#settings-nav .st-nav.on")?.focus({ preventScroll: true });
  if (!kind && was === "settings") document.querySelector<HTMLElement>(".sidebar-settings")?.focus({ preventScroll: true });
}
/// Foundry saves seen in this window's chats: a new one refreshes the page.
function foundrySaveCount() {
  return (state?.runs ?? []).reduce((count, run) => count + tools(run).filter((tool) => (tool.name === "foundry_save" || tool.name === "foundry_edit") && tool.state === "done").length, 0);
}
async function loadFoundry() {
  try {
    foundryList = await api<FoundryArtifact[]>("foundry-list");
    // The open artifact follows its newest version unless an older one or an edit is on screen.
    const open = foundryOpen, latest = open && foundryList.find((item) => item.id === open.id);
    if (open && !latest) foundryOpen = null;
    else if (open && latest && foundryUi.edit === null && open.version === open.versions[0]?.version && latest.version !== open.version) await openFoundry(open.id);
    foundryUi.error = "";
  } catch (error) {
    foundryList = foundryList ?? [];
    foundryUi.error = errorWords(error);
  }
  renderPage();
}
async function openFoundry(id: string, version?: number) {
  try {
    const found = await api<FoundryArtifactDetail>("foundry-get", version ? { id, version } : { id });
    if (foundryOpen?.id !== found.id) Object.assign(foundryUi, { view: "preview", edit: null });
    foundryOpen = found;
    foundryUi.error = "";
  } catch (error) { foundryUi.error = errorWords(error); }
  if (pageOpen !== "foundry") openPage("foundry"); else { renderPage(); if (state) renderState({ ...state }); }
  document.getElementById("page")?.scrollTo({ top: 0 });
}
const errorWords = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^.*?: /, "");
async function foundryMake(text: string) {
  foundryUi.busy = true; renderPage();
  try {
    await api("foundry-make", { text });
    foundryUi.draft = foundryUi.error = "";
    openPage("");
  } catch (error) { foundryUi.error = errorWords(error); }
  finally { foundryUi.busy = false; renderPage(); }
}
async function loadArchived() {
  try {
    const result = await api<{ sessions: Array<{ id: string; title: string; archivedAt: string; workspace?: string }> }>("archived-list");
    archivedChats = result.sessions.map((chat) => ({ id: chat.id, title: chat.title, at: chat.archivedAt, workspace: chat.workspace ?? null }));
  } catch { archivedChats = archivedChats ?? []; }
  renderPage();
}
async function loadRoutines(method = "routines", args: Record<string, unknown> = {}) {
  try {
    routinesHere = await api<Routine[]>(method, args);
    routineUi.error = "";
    if (method === "routine-add") {
      routineUi.draft = "";
      const input = document.querySelector<HTMLInputElement>("#routine-new input");
      if (input) input.value = "";
    }
  } catch (error) {
    routinesHere = routinesHere ?? [];
    routineUi.error = error instanceof Error ? error.message.replace(/^.*?: /, "") : String(error);
  }
  renderPage();
  if (method === "routine-add") document.querySelector<HTMLInputElement>("#routine-new input")?.focus({ preventScroll: true });
}
function renderPage() {
  renderSettingsNav();
  const root = document.getElementById("page");
  if (!root || !state || !pageOpen) return;
  const here = document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace;
  let html = "";
  if (pageOpen === "scheduled") {
    // Typing in the new routine keeps the field as it is.
    if (document.activeElement?.closest("#routine-new")) routineUi.draft = (document.activeElement as HTMLInputElement).value;
    html = scheduledPage({ routines: routinesHere, auto: isPlain() ? null : state.breakage.auto, here: isPlain() ? "" : here, error: routineUi.error, draft: routineUi.draft });
  } else if (pageOpen === "foundry") {
    // Source being edited keeps its words through a redraw.
    const area = root.querySelector<HTMLTextAreaElement>(".fd-source textarea:not([readonly])");
    if (area && foundryUi.edit !== null) foundryUi.edit = area.value;
    if (document.activeElement?.closest("#foundry-make")) foundryUi.draft = (document.activeElement as HTMLInputElement).value;
    const saves = foundrySaveCount();
    if (saves !== foundrySaves) { foundrySaves = saves; void loadFoundry(); }
    html = foundryPage({ list: foundryList, open: foundryOpen, ui: foundryUi, here: isPlain() ? "" : here, markdownHtml: markdown });
  } else if (pageOpen === "customize") {
    // A file being edited keeps its words through a redraw.
    const area = root.querySelector<HTMLTextAreaElement>(".cz-edit textarea");
    if (area && customizeUi.editing?.text != null) customizeUi.editing.text = area.value;
    html = customizePage(customizeData, customizeUi, state.connectors, /Mac/i.test(navigator.platform));
  } else if (pageOpen === "settings") {
    html = settingsPage(settingsView());
  } else if (pageOpen === "active" || pageOpen === "archived") {
    const active = state.sessions.filter((item) => item.turns && !deletedSessions.has(item.id)).map((item) => ({ id: item.id, title: item.title, at: item.updatedAt, workspace: item.workspace ?? null, here: item.workspace === here }));
    html = chatsPageHtml(pageOpen, active, archivedChats);
  }
  root.dataset.kind = pageOpen;
  if (root.dataset.html === html) return;
  // Whatever field has the keyboard keeps it, with its caret, across the redraw.
  const active = document.activeElement;
  const field = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && root.contains(active)
    ? { form: active.closest("form")?.className ?? "", kind: (active.closest("form") as HTMLElement | null)?.dataset.kind ?? "", value: active.value, at: active.selectionStart ?? 0, scroll: active.scrollTop } : null;
  root.innerHTML = html;
  root.dataset.html = html;
  if (field) {
    const again = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("form input, form textarea")].find((node) => node.closest("form")?.className === field.form && ((node.closest("form") as HTMLElement).dataset.kind ?? "") === field.kind);
    if (again) { again.value = field.value; again.focus({ preventScroll: true }); again.setSelectionRange(field.at, field.at); again.scrollTop = field.scroll; }
  }
}
// Glass follows the slider as it moves, and is kept when you let go.
document.getElementById("page")?.addEventListener("input", (event) => {
  const input = event.target as HTMLElement;
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-glass]")) return;
  glassLevel = Math.min(100, Math.max(0, Number(input.value) || 0));
  applyGlass();
});
document.getElementById("page")?.addEventListener("change", (event) => {
  const input = event.target as HTMLElement;
  if (input instanceof HTMLSelectElement && input.matches("[data-foundry-version]") && foundryOpen) return void openFoundry(foundryOpen.id, Number(input.value));
  if (input instanceof HTMLInputElement && input.matches("[data-glass]")) try { localStorage.setItem("demesne-glass", String(glassLevel)); } catch {}
});
// A number in Settings saves on Enter, or when you leave it.
document.getElementById("page")?.addEventListener("focusout", (event) => {
  const input = event.target as HTMLElement;
  if (input instanceof HTMLInputElement && input.closest(".st-num")) saveSettingsNumber(input);
});
document.getElementById("settings-nav")?.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== "settings-search") return;
  settingsUi.query = input.value;
  settingsUi.fold = "";
  renderPage();
});
// ⌘↵ saves the file being edited.
document.getElementById("page")?.addEventListener("keydown", (event) => {
  const area = event.target as HTMLElement;
  if (event.key === "Enter" && area instanceof HTMLInputElement && area.closest(".st-num")) {
    event.preventDefault();
    area.blur();
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && area.matches(".cz-edit textarea")) {
    event.preventDefault();
    area.closest("form")?.requestSubmit();
  }
});
document.getElementById("page")?.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.classList.contains("cz-edit")) {
    event.preventDefault();
    const path = form.dataset.path ?? "", text = form.querySelector("textarea")?.value ?? "";
    void customizeCall("customize-save", { path, text }).then((view) => {
      if (!view) return;
      customizeData = view as CustomizeView;
      customizeUi.editing = null;
      renderPage();
    });
    return;
  }
  if (form.classList.contains("cz-new")) {
    event.preventDefault();
    const name = form.querySelector("input")?.value.trim() ?? "";
    if (!name) return;
    void customizeCall("customize-new", { kind: form.dataset.kind, name }).then(async (made) => {
      if (!made) return;
      form.querySelector("input")!.value = "";
      await loadCustomize();
      await editCustomizable((made as { path: string }).path);
    });
    return;
  }
  // Settings › Connectors: a name and the command that starts the server.
  if (form.id === "mcp-new") {
    event.preventDefault();
    const name = form.querySelector<HTMLInputElement>('[name="name"]')?.value.trim() ?? "", command = form.querySelector<HTMLInputElement>('[name="command"]')?.value.trim() ?? "";
    if (name && command) void settingsCall("mcp-add", { name, command }).then(() => { if (!settingsUi.error) form.reset(); });
    return;
  }
  if (form.id==="system-theme-source") {
    event.preventDefault();
    const path=form.querySelector<HTMLInputElement>('[name="path"]')?.value.trim() ?? "";
    void saveSystemThemeSource(state?.systemThemeSource?.enabled ?? false,path);
    return;
  }
  if (form.classList.contains("st-text")) {
    event.preventDefault();
    const value = form.querySelector("input")?.value.trim() ?? "";
    if (value) void settingsCall("settings-config", { key: form.dataset.key, value });
    return;
  }
  if (form.id === "foundry-make") {
    event.preventDefault();
    const text = form.querySelector("input")?.value.trim() ?? "";
    foundryUi.draft = text;
    if (text && !foundryUi.busy) void foundryMake(text);
    return;
  }
  if (form.id !== "routine-new") return;
  event.preventDefault();
  const text = form.querySelector("input")?.value.trim() ?? "";
  routineUi.draft = text;
  if (text) void loadRoutines("routine-add", { text });
});
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
/// Home's where word unfolds its choices under the composer; a plain chat's
/// "Move to a project" unfolds the projects under its line.
let whereOpen: "home" | "move" | null = null;
function whereProjects(): string[] {
  if (!state) return [];
  const recent = JSON.parse(document.getElementById("sidebar-sessions")?.dataset.projects ?? "[]") as string[];
  return [...new Set([document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace, ...recent])].filter(Boolean).slice(0, 6);
}
function whereRow(mode: "home" | "move") {
  const plain = isPlain(), here = state?.workspace;
  const choice = (label: string, args: Record<string, unknown>, on = false) =>
    btn("where-pick", label, { ...args, mode }, `where-opt${on ? " on" : ""}`).replace("<button ", `<button aria-pressed="${on}" `);
  return [
    mode === "home" ? choice("Just a chat", { plain: true }, plain) : "",
    ...whereProjects().map((path) => choice(h(projectLabel(path)), { path }, mode === "home" && !plain && path === here).replace("<button ", `<button title="${h(path)}" `)),
    choice(`Open a folder <kbd>${/Mac/i.test(navigator.platform) ? "⌘O" : "Ctrl+O"}</kbd>`, { folder: true }),
  ].join("");
}
function renderWhere() {
  const row = el("where-row");
  row.hidden = whereOpen !== "home";
  const html = whereOpen === "home" ? whereRow("home") : "";
  if (row.dataset.html !== html) { row.innerHTML = html; row.dataset.html = html; }
}
function toggleWhere(mode: "home" | "move" | null) {
  whereOpen = mode;
  composerSignature = "";
  renderComposer();
  renderPlainLine();
  // The choice already made takes focus, so ←→ and Enter pick at once.
  const host = mode === "home" ? el("where-row") : mode === "move" ? el("plain-line") : null;
  if (host) (host.querySelector<HTMLElement>(".where-opt.on") ?? host.querySelector<HTMLElement>(".where-opt"))?.focus({ preventScroll: true });
  else editor.focus({ preventScroll: true });
}
async function pickWhere(args: Record<string, any>) {
  if (!state) return;
  const mode = args.mode === "move" ? "move" : "home", draft = editor.value;
  whereOpen = null;
  composerSignature = "";
  renderComposer();
  renderPlainLine();
  let path: string | null = typeof args.path === "string" ? args.path : null;
  if (mode === "move") {
    if (args.folder) path = await api<string | null>("desktop-pick-folder");
    if (!path) return;
    const moved = await api<{ here: boolean; sessionId: string }>("move-session", { path });
    if (!moved.here) document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path, sessionId: moved.sessionId } }));
    return;
  }
  const here = document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace;
  if (args.plain) { if (!isPlain()) await api("new-session", { plain: true, reuse: true, draft }); }
  else if (args.folder) document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { fresh: true, draft } }));
  else if (path === here) { if (isPlain()) await api("new-session", { reuse: true, draft }); }
  else if (path) document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path, fresh: true, draft } }));
  editor.focus({ preventScroll: true });
}
// Esc folds the where choices, from a choice or from the composer, before
// anything else Esc does.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !whereOpen || event.isComposing) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(".where-opt") && target !== editor) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  toggleWhere(null);
}, true);
/// A plain chat ends with one quiet line: what it can't do, and the way on.
function renderPlainLine() {
  const node = el("plain-line");
  const show = Boolean(state) && isPlain() && inSession() && !state!.activeTurnId;
  if (!show && whereOpen === "move") whereOpen = null;
  node.hidden = !show;
  const html = show ? `<p class="plain-note">Create in Foundry here. ${btn("where-move", `Move to a project ${whereOpen === "move" ? "⌄" : "›"}`, {}, "link").replace("<button ", `<button aria-expanded="${whereOpen === "move"}" `)} to work with local files.</p>${whereOpen === "move" ? `<div class="where-row" role="group" aria-label="Move this chat to">${whereRow("move")}</div>` : ""}` : "";
  if (node.dataset.html !== html) { node.innerHTML = html; node.dataset.html = html; }
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
    isPlain(),
    whereOpen,
    state.workspace,
    diffNotes.size,
    pointed.map((point) => point.id).join(),
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
  // On Home one word says where the chat will live, and unfolds the choices.
  const whereWord = el("composer-where"), home = !inSession() && !question;
  if (!home && whereOpen === "home") whereOpen = null;
  whereWord.hidden = !home;
  whereWord.innerHTML = `${isPlain() ? "Just a chat" : `in ${h(projectLabel(state.workspace))}`}<span class="where-caret" aria-hidden="true">⌄</span>`;
  whereWord.classList.toggle("open", whereOpen === "home");
  whereWord.setAttribute("aria-expanded", String(whereOpen === "home"));
  whereWord.title = "Where this chat lives (⌥P)";
  el("hint-mention").hidden = isPlain();
  renderWhere();
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
      ? "Steer it while it works…"
      : suggestion ? `${suggestion}   ⇥ Tab` : "Continue the conversation…"
    : driveSuggestion() ? `Drive suggests: ${driveSuggestion()}   ⇥ Tab` : isPlain() ? "Ask anything…" : "Describe a change, paste an error, or drop a file…";
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
  const draft = Boolean(editor.value.trim()) || diffNotes.size > 0 || pointed.length > 0 || state.attachments.length > 0, session = inSession();
  const attachRow = el("attach-row");
  attachRow.hidden = !state.attachments.length || Boolean(question);
  attachRow.innerHTML = state.attachments.map((image) => {
    const preview = attachmentPreviews.get(image.id);
    return `<span class="att" title="${h(`${image.filename} · ${image.width}×${image.height}`)}">${preview ? `<img src="${preview}" alt="${h(image.filename)}">` : `<span class="att-name">${h(image.filename)}</span>`}${btn("detach", "×", { id: image.id }, "att-x").replace("<button ", `<button aria-label="Remove ${h(image.filename)}" `)}</span>`;
  }).join("");
  // While a turn runs the send button is Stop; Enter queues what you type.
  el("send-label").innerHTML = question ? "answer" : state.activeTurnId
    ? armed ? `Press ${k("Esc")} again to stop` : `${draft ? `<span class="queue-hint">${asking ? `${k("Enter")} send instead` : `${k("↵")} steer · ${k("⌥↵")} after this turn`}</span>` : ""}<span class="stop-word">■ Stop</span>`
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
    .filter((path) => state!.files.some((file) => file.path === path || (path.endsWith("/") && file.path.startsWith(path))));
  const notes = diffNotes.size && !question ? btn("notes-clear", `${diffNotes.size} note${diffNotes.size === 1 ? "" : "s"} on the changes ×`, {}, "chip notes-chip").replace("<button ", '<button title="Sent with your next message. Click to drop them." ') : "";
  const points = question ? "" : pointed.map((point) => btn("point-remove", `⌖ ${h(pointLabel(point))} ×`, { id: point.id }, "chip point-chip").replace("<button ", `<button title="${h(point.source ? `${point.source.path}:${point.source.line}` : "Source not found; the page and selector go with your message")}. Click to drop it." `)).join("");
  el("mention-chips").innerHTML = points + notes + [...new Set(mentions)]
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
  // The same thing allowed three times is a habit: the row says so and
  // Always takes Enter, so one key ends that question for good.
  const habit = habitual(approval);
  const always = approval.rule ? btn("permission", habit ? `Always here ${k("↵")}` : "Always", { id: approval.id, decision: "allow_always" }, habit ? "allow" : "always").replace("<button ", `<button title="${h(scope)} · saved to your config (${h(approval.rule)})" `) : "";
  slot.innerHTML =
    `<div class="approval-row" role="group" aria-label="Approval">${icon}<span class="approval-verb">${h(verb)}</span>${target ? `<code${isCommand ? ` title="${h(where)}"` : ""}>${h(target)}</code>` : ""}${isCommand ? "" : `<span class="approval-note">· ${note}</span>`}${habit ? `<span class="approval-note habit" title="You've allowed this ${approval.allowedBefore} times in a row in this project">· allowed ${approval.allowedBefore}×</span>` : ""}<span class="approval-space"></span>` +
    (isCommand ? "" : btn("approval-show", approvalOpen ? "hide" : hunks ? "diff" : "details", {}, `approval-show${approvalOpen ? " open" : ""}`)) +
    (habit ? always + btn("permission", "Once", { id: approval.id, decision: "allow_once" }, "always") : btn("permission", `Allow ${k("↵")}`, { id: approval.id, decision: "allow_once" }, "allow") + always) +
    btn("permission", `Deny ${k("Esc")}`, { id: approval.id, decision: "deny" }, "deny") +
    `</div>${isCommand ? "" : `<div class="approval-fold command-inset"${approvalOpen ? "" : " hidden"}>${preview}</div>`}`;
}
/// Allowed three times in a row in this project: Always goes under Enter.
const habitual = (approval: WorkspaceApproval) => Boolean(approval.rule) && approval.allowedBefore >= 3 && !approval.overlap;
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
  // The signature is what the tile draws. Typing an answer sends drafts
  // to the daemon, which come back on the question in its stored shape;
  // neither the draft nor the shape may redraw the tile, since a redraw
  // replays its entrance and flickers under every keystroke.
  const question = state.questions[0],
    signature = JSON.stringify(question ? [question.id, question.status, question.questions, question.answers] : null);
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
        const when = auto.planPaused ? `waits while your plan is at ${auto.planPaused}%` : auto.usedToday >= auto.perDay ? "done for today" : `starts the first after ${auto.quietMinutes} quiet minutes`;
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
  // A chat with no project has no Drive.
  node.hidden = !inSession() || !parts.length || isPlain();
  // The folded reply empties too, so no stale control (a Pause after Stop) waits in it.
  if (node.hidden) { node.innerHTML = ""; el("drive-reply").hidden = true; el("drive-reply").innerHTML = ""; el("drive-reply").classList.remove("open"); return; }
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
/// A thinking level in full: "Extra high", not "xhigh".
const LEVEL_WORDS: Record<string, string> = { xhigh: "Extra high", none: "None", off: "Off" };
const levelWord = (level: string) => LEVEL_WORDS[level] ?? level[0]!.toUpperCase() + level.slice(1);
/// A model's name with the search's matches in bold.
const marked = (text: string, query: string) => {
  let out = "", from = 0;
  for (const [at, to] of matchedRanges(text, query)) { out += `${h(text.slice(from, at))}<b>${h(text.slice(at, to))}</b>`; from = to; }
  return out + h(text.slice(from));
};
/// The model picker is one panel anchored to the model word: search on top,
/// your models, then how hard the highlighted one thinks, as a track with a
/// stop per level. More models unfolds in the same panel.
function renderModelPopover(hidden: number) {
  let lastGroup = "";
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  const item = (row: (typeof overlayRows)[number], index: number) => {
    const current = row.action === "model" && row.data.id === state!.model.id;
    const right = current ? '<span class="mp-tick" aria-label="current">✓</span>'
      : row.kind === "short" ? `<span class="mp-key">${index + 1}</span>`
      : row.kind === "more" ? `<span class="mp-key">${h(row.value)} ${modelsMore ? "‹" : "›"}</span>`
      : row.value ? `<span class="mp-key">${h(row.value)}</span>` : "";
    let label = "";
    if (row.kind === "rest" && row.group !== lastGroup) {
      const all = counts.get(row.group ?? "") ?? 0, shown = overlayRows.filter((other) => other.kind === "rest" && other.group === row.group && other.action === "model").length;
      const count = overlayQuery ? `${shown} of ${all}` : row.action === "focus-filter" ? String(all) : `${shown} more`;
      label = `<div class="mp-group"><span>${h(row.group ?? "")}</span><span>${count}</span></div>`;
    }
    if (row.kind === "rest") lastGroup = row.group ?? "";
    const title = row.action === "model" ? "" : [row.data.id !== row.label ? row.data.id : "", row.description].filter(Boolean).join(" · ");
    const name = overlayQuery && row.action === "model" ? marked(row.label, overlayQuery) : h(row.label);
    return label + btn("choose-row", `<span class="name">${name}</span>${right}`, { index }, `mp-row${index === overlayIndex ? " selected" : ""}${row.kind === "more" || row.action === "focus-filter" ? " dim" : ""}`)
      .replace("<button ", `<button data-index="${index}" ${title ? `title="${h(String(title))}" ` : ""}`);
  };
  const rows = overlayRows.map((row, index) => [row, index] as const);
  const highlighted = overlayRows[overlayIndex],
    model = models.find((item) => item.id === (highlighted?.action === "model" ? highlighted.data.id : state!.model.id)),
    levels = model?.reasoningLevels ?? [],
    level = model ? modelLevel(model) : undefined,
    at = level ? levels.indexOf(level) : -1;
  // Thinking is one groove that fills from the left (pass 77): the fill's
  // edge is the handle. Drag it, click anywhere on it, or use ←→; it settles
  // on the nearest level. A model without thinking keeps the groove empty,
  // reading None, so the panel keeps its height as you move down the list.
  const n = levels.length, share = (index: number) => ((index + 1) / Math.max(1, n)) * 100;
  const notches = levels.slice(1).map((_, index) => `<span class="mp-notch${index <= at ? " in" : ""}" style="left:${share(index)}%"></span>`).join("");
  const thinking = n && model
    ? `<div class="mp-thinking" role="slider" tabindex="-1" aria-label="Thinking" aria-valuemin="0" aria-valuemax="${n - 1}" aria-valuenow="${Math.max(0, at)}" aria-valuetext="${h(level ? levelWord(level) : "")}" data-model="${h(model.id)}" data-levels="${h(JSON.stringify(levels))}" title="Drag, click or ←→"><span class="mp-fill" style="width:${at >= 0 ? share(at) : 0}%"></span>${notches}<span class="mp-thinking-label">Thinking</span><span class="mp-level">${level ? h(levelWord(level)) : ""}</span></div>`
    : `<div class="mp-thinking none"><span class="mp-thinking-label">Thinking</span><span class="mp-level off">None</span></div>`;
  const short = rows.filter(([row]) => row.kind === "short").map(([row, index]) => item(row, index)).join("");
  const rest = rows.filter(([row]) => row.kind === "rest").map(([row, index]) => item(row, index)).join("");
  const more = rows.filter(([row]) => row.kind === "more").map(([row, index]) => item(row, index)).join("");
  const empty = modelsLoading && !models.length ? "Loading models…" : overlayQuery ? "No matches." : "No models.";
  const list = (overlayQuery ? rest : short + (rest ? `<div class="mp-sep"></div>${rest}` : "")) || `<div class="mp-empty">${empty}</div>`;
  el("overlay").innerHTML =
    `<div class="mp"><label class="mp-search"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="chooser-filter" placeholder="Search ${models.length || ""} models" aria-label="Filter models" value="${h(overlayQuery)}" autocomplete="off" spellcheck="false"></label>` +
    `<div class="mp-list">${list}${hidden ? `<div class="mp-empty">${hidden} more · keep typing</div>` : ""}</div>` +
    `<div class="mp-sep"></div>${thinking}${more ? `<div class="mp-sep"></div>${more}` : ""}` +
    (overlayQuery ? `<div class="mp-hint">${k("↵")} switch ${k("↑↓")} choose ${k("Esc")} close</div>` : "") + `</div>`;
  el("overlay").querySelector(".mp-row.selected")?.scrollIntoView({ block: "nearest" });
  // An open card follows the highlight, from the pointer or the arrow keys.
  if (modelCardOpen) placeModelCard(overlayIndex);
}
/// Pass 82 A: resting on a model in the picker opens a small card beside the
/// panel, level with the row. A quarter-second rest opens it; once open it
/// follows from row to row at once, and it closes when the pointer leaves
/// the list or the picker closes.
let modelCardOpen = false, modelCardTimer: ReturnType<typeof setTimeout> | null = null;
function modelCardEl() {
  let card = document.getElementById("model-card");
  if (!card) { card = document.createElement("div"); card.id = "model-card"; card.className = "model-card"; card.setAttribute("role", "tooltip"); document.body.append(card); }
  return card;
}
function placeModelCard(index: number) {
  const row = overlayRows[index], model = row?.action === "model" ? models.find((item) => item.id === row.data.id && item.provider === row.group) ?? models.find((item) => item.id === row.data.id) : undefined;
  const button = el("overlay").querySelector<HTMLElement>(`.mp-row[data-index="${index}"]`), panel = el("overlay").querySelector<HTMLElement>(".mp");
  if (!model || !button || !panel || overlay !== "models") { hideModelCard(); return; }
  const score = modelScores.get(`${model.provider}\u0000${model.id}`);
  const card = modelCardEl();
  card.innerHTML = modelCardHTML(model, { name: row!.label, record: score ? scoreLine(score) : "", levelWord });
  const box = panel.getBoundingClientRect(), at = button.getBoundingClientRect(), width = card.offsetWidth || 220, height = card.offsetHeight || 160;
  const right = box.right + 6 + width <= window.innerWidth - 8;
  card.style.left = `${right ? box.right + 6 : Math.max(8, box.left - 6 - width)}px`;
  card.style.top = `${Math.max(8, Math.min(at.top - 10, window.innerHeight - height - 8))}px`;
  card.classList.add("show");
  modelCardOpen = true;
}
function pointModelCard(index: number) {
  if (modelCardTimer) clearTimeout(modelCardTimer);
  modelCardTimer = null;
  if (modelCardOpen) placeModelCard(index);
  else modelCardTimer = setTimeout(() => { modelCardTimer = null; if (overlay === "models") placeModelCard(overlayIndex === index ? index : overlayIndex); }, 250);
}
function hideModelCard() {
  if (modelCardTimer) clearTimeout(modelCardTimer);
  modelCardTimer = null;
  modelCardOpen = false;
  document.getElementById("model-card")?.classList.remove("show");
}
/// Native notifications, each kind with its own switch in Settings › Notifications:
/// a chat waits on you, stops with an error, Drive has a branch ready, a chat
/// finishes. Nothing shows while the app is focused, and the first
/// look after opening only takes stock.
let notifyOn: Record<NotifyKind, boolean> = notifyKinds(null, null);
try { notifyOn = notifyKinds(localStorage.getItem("demesne-notify-kinds"), localStorage.getItem("demesne-notify")); } catch {}
function setNotifyKind(kind: NotifyKind, on: boolean) {
  notifyOn = { ...notifyOn, [kind]: on };
  try { localStorage.setItem("demesne-notify-kinds", JSON.stringify(notifyOn)); } catch {}
}
let notified: Set<string> | null = null;
const notifyFrom = Date.now() - 5_000;
// A chat set to come back returns on the minute, with or without other news.
setInterval(() => {
  if (!state?.sessions.some((item) => backOf(item) === "away" || (backOf(item) === "back" && !notified?.has(`${item.id}:back:${item.backAt}`)))) return;
  renderSidebar();
  renderNotifications();
}, 15_000);
function renderNotifications() {
  if (!state || window.demesne.mode !== "desktop" || state.connection !== "online") return;
  const current = state.session, looking = document.hasFocus();
  const alerts = new Map<string, { title: string; body: string; kind: NotifyKind; sessionId?: string; path?: string }>();
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
      alerts.set(`${item.id}:wait:${item.updatedAt}`, { title, body, kind: "wait", ...where });
    } else if (item.status === "failed") alerts.set(`${item.id}:failed:${item.updatedAt}`, { title, body: "Stopped with an error", kind: "error", ...where });
    else if (item.status === "completed") alerts.set(`${item.id}:done:${item.updatedAt}`, { title, body: "Finished", kind: "done", ...where });
  }
  // A chat you asked to bring back, once it's due (and it fell due while open).
  for (const item of state.sessions) if (backOf(item) === "back" && Date.parse(item.backAt === "merge" ? pullRequests.get(item.id)?.mergedAt ?? "" : item.backAt!) >= notifyFrom)
    alerts.set(`${item.id}:back:${item.backAt}`, { title: item.title, body: "Back, as you asked", kind: "wait", sessionId: item.id, path: item.workspace });
  for (const job of reviewJobs()) if (job.status === "ready") alerts.set(`drive:${job.id}`, { title: "Drive", body: `${job.title} is ready to review${job.diff ? ` · +${job.diff.additions} −${job.diff.deletions}` : ""}`, kind: "drive", ...(job.sessionId ? { sessionId: job.sessionId } : {}) });
  const fresh = notified ? [...alerts].filter(([key]) => !notified!.has(key)) : [];
  notified = new Set([...(notified ?? []), ...alerts.keys()]);
  for (const [, { kind, ...alert }] of fresh) {
    if (!notifyOn[kind] || looking) continue;
    void api("desktop-notify", alert).catch(() => {});
  }
}
// A banner's click comes back here and opens its chat.
document.addEventListener("demesne:open-chat", (event) => {
  const { sessionId, path } = (event as CustomEvent<{ sessionId?: string; path?: string }>).detail ?? {};
  if (!sessionId || !state) return;
  if (sessionId === state.session?.id && inSession()) return;
  const here = !path || path === (document.getElementById("sidebar-sessions")?.dataset.workspace || state.workspace);
  void act(() => dispatch(here ? "select-session" : "project-session", here ? { id: sessionId } : { id: sessionId, path }));
});
let driveActionDone: Promise<unknown> = Promise.resolve();
async function driveAction(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  // Pause, resume and stop wait for the one on its way instead of being
  // dropped: Stop clicked while Resume is still answering still stops.
  if (driveActionPending) {
    if (method !== "drive-control") return;
    await driveActionDone.catch(() => {});
    return driveAction(method, args);
  }
  driveActionPending = method;
  renderBriefing();
  const run = api(method, args);
  driveActionDone = run;
  try {
    return await run;
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
  if (overlay !== "models") hideModelCard();
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
    modelsMore,
  ]);
  if (signature === overlaySignature) return;
  overlaySignature = signature;
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
        label: modelWords(model),
        value: model.contextWindow ? tokensShort(model.contextWindow) : "",
        group: model.provider,
        action: "model",
        data: { id: model.id, ...(level ? { reasoning: level } : {}) },
        kind,
        ...(score ? { description: scoreLine(score) } : {}),
      };
    };
    // The models you use most (the one in use always among them) make the
    // short list; the rest unfold under "More models", by provider. A search
    // looks through every provider at once, in place of the list.
    const inUse = models.find((model) => model.id === state!.model.id);
    const sizes = new Map<string, number>();
    for (const model of models) sizes.set(model.provider, (sizes.get(model.provider) ?? 0) + 1);
    // Ties go to the provider in use, unless it is a large catalog: picking
    // one OpenRouter model shouldn't fill the list with strangers.
    const mine = (model: ModelDescriptor) => Number(model.provider === state!.model.provider && (sizes.get(model.provider) ?? 0) <= LARGE_CATALOG);
    let short = [...models].sort((a, b) => turns(b) - turns(a) || mine(b) - mine(a)).slice(0, SHORT_MODELS);
    if (inUse && !short.includes(inUse)) short = [inUse, ...short.slice(0, SHORT_MODELS - 1)];
    const query = overlayQuery.toLowerCase();
    if (!query) overlayRows = short.map((model) => rowOf(model, "short"));
    if (query || modelsMore) {
      const rest = (query ? [...models] : models.filter((model) => !short.includes(model)))
        .sort((a, b) => a.provider.localeCompare(b.provider) || turns(b) - turns(a))
        .map((model) => rowOf(model, "rest"))
        .filter((row) => !query || matchesWords(`${row.label} ${row.group} ${row.data.id}`, query));
      // A large catalog (OpenRouter's hundreds) stays behind one row until
      // a search looks through it.
      const large = [...sizes].filter(([, size]) => size > LARGE_CATALOG).map(([provider]) => provider);
      overlayRows.push(...(query ? rest : rest.filter((row) => !large.includes(row.group))));
      if (!query)
        for (const group of large)
          overlayRows.push({ label: `Search all ${sizes.get(group)}`, value: "", group, action: "focus-filter", data: {}, kind: "rest" });
    }
    if (!query && models.length > short.length) overlayRows.push({ label: modelsMore ? "Fewer models" : "More models", value: String(models.length - short.length), action: "more-models", data: {}, kind: "more" });
    // A new search highlights its first match.
    if (overlayQuery !== modelsQuery) {
      modelsQuery = overlayQuery;
      if (overlayQuery) overlayIndex = 0;
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
    footerNote = state.providers.message ?? "Enter signs in or out · Codex uses your Codex plan, ChatGPT is metered as credits, OpenRouter uses hosted models";
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
      { label: "Settings", value: "", action: "page-open", data: { page: "settings" }, hint: "⌘," },
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
      group: sectionTitle(command.section).toUpperCase(),
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
        icon: "file",
      }));
  } else if (command) {
    const row = (item: Snapshot["commands"][number], group = sectionTitle(item.section)) => ({
      label: plainName(item.name),
      description: item.description,
      hint: item.detail ?? item.aliases.join(" "),
      group,
      value: item.name,
      kind: "command" as const,
      icon: item.id,
    });
    // Commands sit in six groups by what they act on (pass 84), always in
    // the same order, so each one is always in the same place.
    const all = state.commands
      .filter((item) => [item.name, ...item.aliases].some((name) => name.startsWith(value)))
      .map((item, at) => ({ item, at }))
      .sort((a, b) => sectionRank(a.item.section) - sectionRank(b.item.section) || a.at - b.at)
      .map(({ item }) => item);
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
  // One quiet panel (pass 83 A): an icon, the plain name with what you've
  // typed in bold, a faint argument, and the description. No footer.
  let group = "";
  const needle = mention?.[1] ?? (command ? value.slice(1) : ""),
    highlight = (label: string) => {
      const index = label.toLowerCase().indexOf(needle.toLowerCase());
      return needle && index >= 0
        ? h(label.slice(0, index)) + `<b>${h(label.slice(index, index + needle.length))}</b>` + h(label.slice(index + needle.length))
        : h(label);
    };
  const rows = completionItems
    .map((item, index) => {
      const heading = group !== item.group ? `<div class="cm-group">${h(groupWords(item.group))}</div>` : "";
      group = item.group;
      const definition = item.kind === "command" ? state!.commands.find((command) => command.name === item.value) : undefined;
      const argument = definition && definition.argument !== "none" && definition.argumentLabel ? `<span class="cm-arg">${h(definition.argumentLabel)}</span>` : "";
      return (
        heading +
        btn(
          "completion",
          `${commandIcon(item.icon ?? "")}<span class="cm-name">${highlight(item.label)}</span>${argument}<span class="cm-desc">${h(item.description)}</span>`,
          { index },
          `cm-row${index === completionIndex ? " selected" : ""}`)
      );
    })
    .join("");
  const more = !mention && completionMore ? btn("completion-more", `<span>${completionMore} more</span><span>›</span>`, {}, "cm-more") : "";
  el("completion").innerHTML = `<div class="cm-list">${rows}</div>${more}`;
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
/// Point at it: the picker runs inside the preview; a click comes back as an
/// element, the host finds the code behind it, and it lands as a chip.
/// The Point button changes in place, so the page in the frame keeps its state.
function pointButton(key: string) {
  const button = document.querySelector<HTMLElement>(`[data-preview="${CSS.escape(key)}"] .pv-btn[data-action="preview-point"]`);
  if (!button) return;
  button.classList.toggle("on", pointing === key);
  button.textContent = pointing === key ? "Pointing · Esc" : "⌖ Point";
  document.querySelector(`[data-preview="${CSS.escape(key)}"]`)?.classList.toggle("pointing", pointing === key);
}
async function pointAt(key: string) {
  if (pointing === key) return void api("desktop-point", { cancel: true }).catch(() => {});
  if (pointing) await api("desktop-point", { cancel: true }).catch(() => {});
  pointing = key;
  pointButton(key);
  let pick: PointPick | null = null;
  try { pick = await api<PointPick | null>("desktop-point", { frame: `pv-${key}` }); }
  catch (error) { notice(error instanceof Error ? error.message : String(error)); }
  finally { if (pointing === key) pointing = null; pointButton(key); }
  if (!pick) return;
  let source: PointSource | null = null;
  try { source = await api<PointSource | null>("point-source", { pick }); } catch { /* sent without a source */ }
  pointed.push({ ...pick, id: `${Date.now()}:${pointed.length}`, source });
  renderComposer();
  editor.focus();
}
async function submitText(value = editor.value, wait = false) {
  if (!state) return;
  // Notes on the diff open the next message; a message may be only notes.
  const notes = !pendingQuestion() && !value.startsWith("/") ? [pointMessage(pointed), notesMessage([...diffNotes.values()])].filter(Boolean).join("\n\n") : "";
  if (!value.trim() && !notes && !state.attachments.length) return;
  if (notes) {
    value = value.trim() ? `${notes}\n\n${value}` : notes;
    diffNotes.clear();
    pointed.length = 0;
    reviewVersion++;
    renderConversation();
  }
  if (pendingQuestion()) return answerQuestion(value);
  if (state.activeTurnId) {
    // Enter while a turn runs steers it; ⌥↵ queues the next message.
    if (value.startsWith("/")) return;
    clearTimeout(draftTimer);
    editor.value = "";
    renderComposer();
    await api("submit", { text: value, wait });
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
    if (id === "foundry") {
      if (!argument) {
        editor.value = "/foundry ";
        renderComposer();
        notice("Describe the mockup you want after /foundry.");
        editor.focus();
        return;
      }
      openPage("");
      followLatest();
      await api("foundry-create", { text: argument });
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
      notice(`${c.estimated ? "~" : ""}${num(c.used)} of ${c.capacity ? tokensShort(c.capacity) : "—"} context used${c.percentage == null ? "" : ` · ${c.percentage}%`} · ${modelWords(state!.model)}`);
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
/// Foundry's buttons: the gallery, one artifact, and handing it to a chat.
async function foundryAction(action: string, args: Record<string, any>) {
  const open = foundryOpen;
  const redraw = () => { renderPage(); if (state) renderState({ ...state }); };
  if (action === "foundry-tab") { foundryUi.tab = args.tab; return renderPage(); }
  if (action === "foundry-open") return openFoundry(String(args.id));
  if (action === "foundry-open-step") {
    // A new artifact's id is in the tool's result; a revision names it in its input.
    let id = typeof args.id === "string" ? args.id : "";
    if (!id && typeof args.message === "string") try { id = JSON.parse(args.message).id ?? ""; } catch {}
    if (!id) {
      const list = await api<FoundryArtifact[]>("foundry-list").catch(() => [] as FoundryArtifact[]);
      id = list.find((item) => item.title === args.title)?.id ?? "";
    }
    if (id) return pane.show(id);
    return openPage("foundry");
  }
  if (action === "foundry-close") { foundryOpen = null; foundryUi.edit = null; redraw(); void loadFoundry(); return; }
  if (action === "foundry-view") { foundryUi.view = args.view === "source" ? "source" : "preview"; return renderPage(); }
  if (action === "foundry-width") { foundryUi.width = args.width; return renderPage(); }
  if (!open) return;
  if (action === "foundry-version") return openFoundry(open.id, Number(args.version));
  if (action === "foundry-reload") { const frame = document.querySelector<HTMLIFrameElement>("#page .fd-frame"); if (frame) frame.src = frame.src; return; }
  if (action === "foundry-edit") { foundryUi.edit = open.source; foundryUi.view = "source"; renderPage(); document.querySelector<HTMLTextAreaElement>("#page .fd-source textarea")?.focus(); return; }
  if (action === "foundry-edit-cancel") { foundryUi.edit = null; return renderPage(); }
  if (action === "foundry-edit-save" || action === "foundry-restore") {
    const area = document.querySelector<HTMLTextAreaElement>("#page .fd-source textarea:not([readonly])");
    const source = action === "foundry-restore" ? open.source : area?.value ?? foundryUi.edit ?? "";
    try {
      foundryOpen = await api<FoundryArtifactDetail>("foundry-save", { id: open.id, source });
      Object.assign(foundryUi, { edit: null, view: "preview", error: "" });
    } catch (error) { foundryUi.error = errorWords(error); }
    return renderPage();
  }
  if (action === "foundry-copy") { await act(() => api("copy", { text: open.source })); return notice("Copied the source"); }
  if (action === "foundry-export") {
    const saved = await act(() => api<{ path: string } | null>("desktop-foundry-export", { id: open.id, version: open.version }));
    if (saved && typeof saved === "object" && "path" in saved) notice(`Exported to ${saved.path}`);
    return;
  }
  if (action === "foundry-delete") {
    if (!confirm(`Delete "${open.title}" and all ${open.versions.length} version${open.versions.length === 1 ? "" : "s"}?`)) return;
    await act(() => api("foundry-delete", { id: open.id }));
    pane.forget(open.id);
    foundryOpen = null;
    redraw();
    return loadFoundry();
  }
  if (action === "foundry-revise") {
    await act(() => api("foundry-revise", { id: open.id, title: open.title, chat: open.sessionId }));
    openPage("");
    editor.focus({ preventScroll: true });
  }
}
// Double-click an artifact's title to rename it; Enter keeps it, Esc puts it back.
document.getElementById("page")?.addEventListener("dblclick", (event) => {
  const title = (event.target as HTMLElement).closest<HTMLElement>("[data-foundry-title]");
  if (!title || !foundryOpen || title.isContentEditable) return;
  const before = foundryOpen.title, id = foundryOpen.id;
  title.contentEditable = "plaintext-only";
  title.focus();
  getSelection()?.selectAllChildren(title);
  const finish = async (keep: boolean) => {
    title.removeEventListener("keydown", keys);
    title.contentEditable = "false";
    const next = (title.textContent ?? "").trim();
    if (!keep || !next || next === before) { title.textContent = before; return; }
    try { await api("foundry-rename", { id, title: next }); if (foundryOpen?.id === id) foundryOpen = { ...foundryOpen, title: next }; void loadFoundry(); }
    catch (error) { title.textContent = before; notice(errorWords(error)); }
  };
  const keys = (key: KeyboardEvent) => {
    if (key.key === "Enter") { key.preventDefault(); title.blur(); }
    if (key.key === "Escape") { key.preventDefault(); key.stopPropagation(); void finish(false); }
  };
  title.addEventListener("keydown", keys);
  title.addEventListener("blur", () => void finish(true), { once: true });
});
async function dispatch(
  action: string,
  args: Record<string, any>,
  target?: HTMLElement,
) {
  if (pageOpen && ["select-session", "new-session", "project-new", "project-session", "review-open", "drive-open"].includes(action)) openPage("");
  if (action === "chats-page") return openPage(args.tab === "archived" ? "archived" : "active");
  if (action === "page-open") {
    const page = String(args.page ?? "");
    return openPage(!page || pageOpen === page ? "" : (["foundry", "customize", "settings", "active", "archived"].includes(page) ? page : "scheduled") as PageKind);
  }
  if (action.startsWith("foundry-")) return foundryAction(action, args);
  if (action === "settings-section") return isSettingsSection(args.id) ? settingsSection(args.id) : undefined;
  if (action === "settings-fold") { settingsUi.fold = settingsUi.fold === args.fold ? "" : String(args.fold); return renderPage(); }
  if (action === "system-theme-toggle") {
    const source=state?.systemThemeSource;
    if(!source)return;
    const path=args.enabled===true ? document.querySelector<HTMLInputElement>('#system-theme-source [name="path"]')?.value.trim() ?? source.path : source.path;
    return saveSystemThemeSource(args.enabled===true,path);
  }
  if (action === "settings-local") {
    if (args.key === "openOn") { openOn = args.value === "last" ? "last" : "home"; try { localStorage.setItem("demesne-open-on", openOn); } catch {} }
    if (args.key === "ink" && isInk(args.value)) { inkName = args.value; try { localStorage.setItem("demesne-ink", inkName); } catch {} applyInk(); }
    if (args.key === "awake") { keepAwake = args.value === true; try { localStorage.setItem("demesne-awake", keepAwake ? "on" : "off"); } catch {} renderAwake(); }
    return renderPage();
  }
  if (action === "notify-kind") { setNotifyKind(args.kind as NotifyKind, args.on === true); return renderPage(); }
  // A setting changes in place; the page stays to show it took.
  if (action === "settings-set") {
    const result = await api<{ zoom?: number } | null>(String(args.method), args.args ?? {});
    if (args.method === "desktop-zoom" && typeof result?.zoom === "number") zoomLevel = result.zoom;
    if (args.method === "theme") settingsUi.fold = "";
    return renderPage();
  }
  if (action === "settings-command") { openPage(""); return setDraft(String(args.text)); }
  if (action === "subagent-model") { settingsUi.fold = ""; return settingsCall("subagent-model", { model: args.model ?? null }); }
  if (["settings-config", "allow-rule-remove", "trusted-forget", "mcp-remove"].includes(action)) return settingsCall(action, args);
  if (action === "restart-daemon") {
    settingsUi.error = "";
    notice("Restarting the daemon…");
    return settingsCall("restart-daemon");
  }
  if (action === "routine-set" || action === "routine-remove") return loadRoutines(action, args);
  if (action === "cz-edit") return editCustomizable(String(args.path));
  if (action === "cz-cancel") { customizeUi.editing = null; return renderPage(); }
  if (action === "cz-run") { openPage(""); return setDraft(`/${String(args.name)} `); }
  if (action === "chats-restore") {
    await api("restore", { id: String(args.id) });
    deletedSessions.delete(String(args.id));
    archivedChats = archivedChats?.filter((chat) => chat.id !== args.id) ?? null;
    renderPage();
    return;
  }
  if (action === "project-toggle" || action === "group-toggle" || action === "project-more") {
    const key = action === "project-toggle" ? `p:${String(args.path)}` : String(args.key);
    // While searching every project shows its matches; folding waits.
    if (action === "project-toggle" && (document.getElementById("sidebar-search") as HTMLInputElement | null)?.value.trim()) return;
    if (action === "project-more") {
      if (expandedProjectChats.has(key)) expandedProjectChats.delete(key); else expandedProjectChats.add(key);
    } else {
      foldedGroups[key] = groupIsOpen(key);
      if (!foldedGroups[key]) unfoldingGroup = key;
      saveSidebarLayout();
    }
    renderSidebar();
    // Rendering replaces the control: keep keyboard focus on its replacement.
    document.querySelectorAll<HTMLButtonElement>(`#sidebar-projects [data-action="${action}"]`).forEach(button => {
      if (button.dataset.args === JSON.stringify(args)) button.focus({ preventScroll: true });
    });
    return;
  }
  // Group and sort unfolds under the heading it was opened from; a choice
  // rearranges the list at once and the line stays until you fold it.
  if (action === "sidebar-view-open") {
    viewOpenAt = viewOpenAt === String(args.key) ? "" : String(args.key);
    renderSidebar();
    if (viewOpenAt) void api<{ sessions: unknown[] }>("archived-list").then((result) => { archivedCount = result.sessions.length; renderSidebar(); }, () => {});
    return;
  }
  // + on a project's line: a new chat there, switching to it if need be.
  if (action === "project-new") {
    const path = String(args.path), here = document.getElementById("sidebar-sessions")?.dataset.workspace || state?.workspace;
    if (path === here) await api("new-session", { reuse: true });
    else document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path, fresh: true, draft: "" } }));
    editor.focus({ preventScroll: true });
    return;
  }
  if (action === "sidebar-view") {
    const regroup = (args.group === "project" || args.group === "date" || args.group === "status") && args.group !== sidebarView.group;
    if (regroup) sidebarView.group = args.group;
    if (args.sort === "recent" || args.sort === "name") sidebarView.sort = args.sort;
    saveSidebarLayout();
    if (regroup) {
      // The line moves to the first heading of the new layout.
      viewOpenAt = "";
      renderSidebar();
      viewOpenAt = JSON.parse(document.querySelector<HTMLElement>("#sidebar-projects [data-action='sidebar-view-open']")?.dataset.args ?? "{}").key ?? "";
    }
    renderSidebar();
    document.querySelector<HTMLElement>(`#sidebar-projects .sidebar-view-opt[data-args='${JSON.stringify(args)}']`)?.focus({ preventScroll: true });
    return;
  }
  if (action === "theme-flip") { flipTheme(); return; }
  if (action === "pr-open") {
    const id = String(args.id), pr = pullRequests.get(id);
    prOpenFor = prOpenFor === id ? null : id;
    if (prOpenFor && pr) {
      prOpenSince = prSeenAt(id, pr);
      markPrSeen(id, pr.activityAt);
      void refreshPullRequests(id);
    }
    renderSidebar();
    // Enter takes the first word: hand the news to the chat, or archive it.
    document.querySelector<HTMLButtonElement>(".sidebar-pr-line .key")?.focus({ preventScroll: true });
    return;
  }
  if (action === "pr-github") {
    const pr = pullRequests.get(String(args.id));
    if (pr) await api("open-link", { url: pr.url });
    return;
  }
  if (action === "pr-hand") {
    const id = String(args.id), pr = pullRequests.get(id);
    if (!pr) return;
    const text = prHandText(pr, prOpenSince);
    prOpenFor = null;
    if (state?.session?.id !== id) {
      const path = state?.sessions.find((item) => item.id === id)?.workspace;
      if (path && path !== (el("sidebar-sessions").dataset.workspace || state?.workspace)) document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path, sessionId: id } }));
      else await api("select-session", { id });
      for (let tries = 0; tries < 80 && state?.session?.id !== id; tries++) await new Promise((done) => setTimeout(done, 50));
      if (state?.session?.id !== id) return;
    }
    renderSidebar();
    setDraft(text);
    return;
  }
  if (action === "back-open") {
    backOpenFor = backOpenFor === String(args.id) ? null : String(args.id);
    renderSidebar();
    return;
  }
  if (action === "bring-back") {
    backOpenFor = null;
    await api("bring-back", { id: String(args.id), at: args.at === null ? null : String(args.at) });
    return;
  }
  if (action === "pin-session") {
    await api("pin", { id: String(args.id), pinned: args.pinned === true });
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
  if (action === "project-session") {
    document.dispatchEvent(new CustomEvent("demesne:open-project", { detail: { path: args.path, ...(action === "project-session" ? { sessionId: args.id } : {}) } }));
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
  // A new chat starts on Home as Just a chat; the where word moves it.
  if (action === "new-session") return api("new-session", { plain: true, reuse: true });
  if (action === "where-toggle") return toggleWhere(whereOpen === "home" ? null : "home");
  if (action === "where-pick") return pickWhere(args);
  if (action === "where-move") return toggleWhere(whereOpen === "move" ? null : "move");
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
  // Home: a chat's phrase unfolds what it waits on; the row answers it there.
  if (action === "away-ask") {
    awayAskShown = awayAskShown === args.id ? null : String(args.id ?? "");
    heroSignature = "";
    renderHero();
    return;
  }
  if (action === "away-permission") {
    awayAskShown = null;
    await act(() => api("away-permission", args));
    heroSignature = "";
    renderHero();
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
  if (action === "rewind" || action === "rewind-redo") {
    await act(() => api(action, args));
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
  if (action === "agent-found") {
    const key = String(args.key);
    foundOpen.has(key) ? foundOpen.delete(key) : foundOpen.add(key);
    follow = false;
    renderConversation();
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
  if (action === "choose-row") {
    const row = overlayRows[args.index];
    if (row?.action === "focus-filter") {
      el("overlay").querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    if (row?.action === "more-models") {
      modelsMore = !modelsMore || Boolean(args.open);
      // Unfolding from the keyboard steps onto the first of the rest.
      if (modelsMore && args.step) overlayIndex = SHORT_MODELS;
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
  if (action === "setup" && pageOpen === "settings") openPage("");
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
  if (action === "preview-point") return pointAt(String(args.key));
  if (action === "point-remove") {
    const at = pointed.findIndex((point) => point.id === args.id);
    if (at >= 0) pointed.splice(at, 1);
    return renderComposer();
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

const systemAppearance = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark=()=>window.demesne.mode==="desktop" ? window.demesneSystemDark ?? systemAppearance.matches : systemAppearance.matches;
let nativeThemeMode="";
function applyPalette(next: Snapshot) {
  const option=next.themeOptions.find(t=>t.name===next.theme);
  const fallback=next.theme==="system" && option?.systemFallback;
  const resolved=fallback ? THEMES[systemDark()?"demesne":"demesne-light"]! : option;
  const colors=fallback ? resolved!.colors : next.palette;
  const dark=resolved ? resolved.appearance!=="light" : !/light/.test(next.theme);
  const mode=fallback?"system":dark?"dark":"light";
  if(window.demesne.mode==="desktop" && mode!==nativeThemeMode) {
    nativeThemeMode=mode;
    void api<{dark:boolean} | null>("desktop-theme",{dark,system:Boolean(fallback)}).then(result=>{
      if(mode!==nativeThemeMode || !fallback || typeof result?.dark!=="boolean")return;
      window.demesneSystemDark=result.dark;
      if(state){applyPalette(state);renderFoot();}
    }).catch(()=>{if(nativeThemeMode===mode)nativeThemeMode="";});
  }
  if (renderedPalette===colors) return;
  for (const [name,color] of Object.entries(colors)) document.documentElement.style.setProperty(`--${name}`,color);
  document.documentElement.dataset.theme=fallback ? resolved!.name : next.theme;
  document.documentElement.dataset.appearance=dark?"dark":"light";
  renderedPalette=colors;
}
systemAppearance.addEventListener("change",()=>{if(window.demesne.mode!=="desktop" && state?.theme==="system"){applyPalette(state);renderFoot();}});
document.addEventListener("demesne:system-appearance",()=>{if(state?.theme==="system"){applyPalette(state);renderFoot();}});
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
    pointed.length = 0;
    if (pointing) { pointing = null; void api("desktop-point", { cancel: true }).catch(() => {}); }
    follow = true;
    overlay = null;
    driveShown = ideasShown = brokeShown = tellOpen = false;
    tellSent = "";
    unwatchOutput();
    expanded.clear();
    expandedCompactions.clear();
    compactionCard?.remove(); compactionCard = null; compactionCardSignature = "";
    runNodes.forEach((item) => { item.artifacts.dispose(); item.node.remove(); });
    runNodes.clear();
    heroSignature = overlaySignature = sidebarSignature = "";
    pane.switchSession(next.session?.id ?? "");
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
  applyPalette(next);
  // Drive working this session is a session, even before its first turn:
  // its mission is the conversation's turn.
  const start = !inSession(next) && !pageOpen;
  el("app").classList.toggle("start", start);
  el("app").classList.toggle("paging", Boolean(pageOpen));
  el("hero").hidden = !start;
  el("conversation").hidden = start || Boolean(pageOpen);
  el("page").hidden = !pageOpen;
  document.querySelectorAll<HTMLElement>('.sidebar-nav [data-action="page-open"]').forEach((button) => {
    const on = JSON.parse(button.dataset.args ?? "{}").page === pageOpen;
    button.classList.toggle("on", on);
    if (on) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  renderPage();
  renderAwake();
  renderLastChat();
  if (start) renderHero();
  else if (wasStart || el("composer-slot").parentElement !== el("input-area")) el("input-area").append(el("composer-slot"));
  renderSakura(start);
  renderStatus();
  renderConversation();
  renderDriveTurn();
  renderComposer();
  renderPlainLine();
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
/// Dragging the thinking groove: the fill follows the pointer, and letting
/// go settles on the nearest level, with the picker still open. The
/// groove is found again on every move, since the picker may redraw.
let thinkingDrag: { pointer: number; model: string; levels: string[] } | null = null;
const grooveOf = () => el("overlay").querySelector<HTMLElement>(".mp-thinking[data-levels]");
function grooveAt(groove: HTMLElement, x: number, count: number) {
  const box = groove.getBoundingClientRect(), f = Math.max(0, Math.min(1, (x - box.left) / Math.max(1, box.width)));
  return { f, index: Math.max(0, Math.min(count - 1, Math.ceil(f * count) - 1)) };
}
function paintGroove(groove: HTMLElement, f: number, index: number, levels: string[]) {
  const fill = groove.querySelector<HTMLElement>(".mp-fill"), word = groove.querySelector<HTMLElement>(".mp-level");
  if (fill) fill.style.width = `${Math.max(6, f * 100)}%`;
  groove.querySelectorAll<HTMLElement>(".mp-notch").forEach((notch, k) => notch.classList.toggle("in", ((k + 1) / levels.length) * 100 <= f * 100 + 2));
  if (word && word.textContent !== levelWord(levels[index]!)) word.textContent = levelWord(levels[index]!);
  groove.setAttribute("aria-valuenow", String(index));
  groove.setAttribute("aria-valuetext", levelWord(levels[index]!));
}
document.addEventListener("pointerdown", (event) => {
  const groove = (event.target as Element).closest?.<HTMLElement>("#overlay .mp-thinking[data-levels]");
  if (!groove || event.button !== 0) return;
  event.preventDefault();
  const levels = JSON.parse(groove.dataset.levels ?? "[]") as string[];
  if (!levels.length) return;
  thinkingDrag = { pointer: event.pointerId, model: groove.dataset.model ?? "", levels };
  groove.classList.add("drag");
  const { f, index } = grooveAt(groove, event.clientX, levels.length);
  paintGroove(groove, f, index, levels);
});
document.addEventListener("pointermove", (event) => {
  const groove = grooveOf();
  if (!thinkingDrag || event.pointerId !== thinkingDrag.pointer || !groove) return;
  groove.classList.add("drag");
  const { f, index } = grooveAt(groove, event.clientX, thinkingDrag.levels.length);
  paintGroove(groove, f, index, thinkingDrag.levels);
});
const settleGroove = (event: PointerEvent) => {
  if (!thinkingDrag || event.pointerId !== thinkingDrag.pointer) return;
  const drag = thinkingDrag, groove = grooveOf();
  thinkingDrag = null;
  groove?.classList.remove("drag");
  if (!groove || event.type === "pointercancel") { renderOverlay(); return; }
  // The picker stays open: the level is kept for that model, and for the
  // model in use it applies at once.
  const { index } = grooveAt(groove, event.clientX, drag.levels.length), reasoning = drag.levels[index]!;
  modelLevels.set(drag.model, reasoning);
  overlaySignature = "";
  renderOverlay();
  if (drag.model === state?.model.id) void act(() => api("model", { id: drag.model, reasoning }));
};
document.addEventListener("pointerup", settleGroove);
document.addEventListener("pointercancel", settleGroove);
// Pointing at a model in the picker highlights it, so Thinking is for the
// row you are on.
document.addEventListener("mouseover", (event) => {
  if (overlay !== "models" || thinkingDrag) return;
  const index = Number((event.target as Element).closest?.<HTMLElement>("#overlay .mp-row")?.dataset.index ?? NaN);
  // Off the rows, the card goes; on a model row it opens or follows.
  if (Number.isNaN(index) || overlayRows[index]?.action !== "model") { if (modelCardOpen || modelCardTimer) hideModelCard(); if (Number.isNaN(index)) return; }
  if (index !== overlayIndex) { overlayIndex = index; renderOverlay(); }
  if (overlayRows[index]?.action === "model") pointModelCard(index);
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
    // A fold's state outlives the next repaint (the guide redraws on every event).
    const detail = event.target as HTMLDetailsElement;
    if (detail.dataset.detail) {
      if (detail.open) { detailsOpen.add(detail.dataset.detail); detailsClosed.delete(detail.dataset.detail); }
      else { detailsOpen.delete(detail.dataset.detail); detailsClosed.add(detail.dataset.detail); }
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
// The edge is a timeline: the scrollbar is gone, and pointing at the
// panel's right edge shows the chat's shape on a hairline. Marks are measured
// from the rendered turns; the line repaints when they move or the chat
// scrolls, and only while it shows.
let timeline: Mark[] = [], timelineFrame = 0, timelineHot: Mark | null = null;
function timelineFacts(stage: HTMLElement): TurnFacts[] {
  const base = stage.getBoundingClientRect().top - stage.scrollTop;
  const top = (node: Element | null) => node ? Math.round(node.getBoundingClientRect().top - base) : null;
  return (state?.runs ?? []).flatMap((run) => {
    const node = document.getElementById(`turn-${run.id}`);
    if (!node || !node.isConnected) return [];
    const items = tools(run);
    const edited = [...new Set(items.filter((t) => t.phase === "change" && t.state === "done").flatMap((t) => t.changes?.map((c) => c.path) ?? [String(t.input.path ?? t.detail ?? "")]).filter(Boolean))];
    const check = items.find((t) => t.phase === "verify" && t.name === "run_command" && t.input.background !== true && (t.state === "failed" || t.state === "denied"));
    const failed = check ? { name: String(check.detail ?? check.name).replace(/^\$\s*/, ""), at: clock(run.createdAt).slice(0, 5) }
      : run.status === "failed" ? { name: "the turn failed", at: clock(run.createdAt).slice(0, 5) } : null;
    return [{
      ask: run.content, time: clock(run.createdAt).slice(0, 5),
      askTop: top(node.querySelector(".request")), answerTop: top(node.querySelector(".answer")),
      stepsTop: top(node.querySelector(".steps, .step-trail")), receiptTop: top(node.querySelector(".turn-receipt")),
      edited, failed,
    }];
  });
}
function paintTimeline() {
  timelineFrame = 0;
  const line = el("timeline"), stage = el("stage"), conversation = el("conversation");
  const long = Boolean(state) && !conversation.hidden && stage.scrollHeight > stage.clientHeight + 40;
  line.hidden = !long;
  if (!long) { timeline = []; return; }
  line.style.top = `${stage.offsetTop + 14}px`;
  line.style.height = `${Math.max(0, stage.clientHeight - 28)}px`;
  const view = line.querySelector<HTMLElement>(".tl-view")!;
  view.style.top = `${(stage.scrollTop / stage.scrollHeight) * 100}%`;
  view.style.height = `${(stage.clientHeight / stage.scrollHeight) * 100}%`;
  if (!line.classList.contains("on")) return;
  timeline = timelineMarks(timelineFacts(stage), stage.scrollHeight);
  line.querySelector(".tl-marks")!.innerHTML = timeline.map((mark) =>
    `<i class="tl-m ${mark.kind}${mark === timelineHot || (timelineHot && mark.top === timelineHot.top && mark.kind === timelineHot.kind) ? " hot" : ""}" style="top:${(mark.at * 100).toFixed(2)}%"></i>`).join("");
}
const repaintTimeline = () => { if (!timelineFrame) timelineFrame = requestAnimationFrame(paintTimeline); };
function timelineAt(event: PointerEvent | MouseEvent): Mark | null {
  const line = el("timeline"), box = line.getBoundingClientRect();
  if (!box.height) return null;
  return markNear(timeline, (event.clientY - box.top) / box.height, 10 / box.height);
}
function showTimelineLabel(mark: Mark | null) {
  timelineHot = mark;
  const line = el("timeline"), label = line.querySelector<HTMLElement>(".tl-label")!;
  label.hidden = !mark;
  if (mark) {
    label.innerHTML = `${h(mark.label)}${mark.meta ? ` <span>· ${h(mark.meta)}</span>` : ""}`;
    label.style.top = `${(mark.at * 100).toFixed(2)}%`;
  }
  for (const node of line.querySelectorAll<HTMLElement>(".tl-m")) node.classList.remove("hot");
  if (mark) line.querySelectorAll<HTMLElement>(".tl-m")[timeline.indexOf(mark)]?.classList.add("hot");
}
el("timeline").addEventListener("pointerenter", () => { el("timeline").classList.add("on"); paintTimeline(); });
el("timeline").addEventListener("pointerleave", () => { el("timeline").classList.remove("on"); showTimelineLabel(null); });
el("timeline").addEventListener("pointermove", (event) => { const mark = timelineAt(event); if (mark !== timelineHot) showTimelineLabel(mark); });
el("timeline").addEventListener("click", (event) => {
  const stage = el("stage"), line = el("timeline"), box = line.getBoundingClientRect();
  const mark = timelineAt(event);
  // A mark goes to its place; anywhere else on the line goes to that point.
  const top = mark ? mark.top - 18 : ((event.clientY - box.top) / box.height) * stage.scrollHeight - stage.clientHeight / 2;
  follow = false;
  stage.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});
el("stage").addEventListener("scroll", repaintTimeline, { passive: true });
new ResizeObserver(repaintTimeline).observe(el("conversation"));
new ResizeObserver(repaintTimeline).observe(el("stage"));
document.addEventListener("demesne:open-settings", () => {
  if (state && !state.setup) openPage("settings");
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
  if (pointing && event.key === "Escape") {
    event.preventDefault();
    void api("desktop-point", { cancel: true }).catch(() => {});
    return;
  }
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
  if (key === "escape" && !ctrl && pageOpen === "settings" && (settingsUi.query || settingsUi.fold) && (!field || (event.target as HTMLElement).id === "settings-search")) {
    event.preventDefault();
    if (settingsUi.query) settingsSection(settingsUi.section);
    else { settingsUi.fold = ""; renderPage(); }
    return;
  }
  // Esc in an open artifact goes back to Foundry's gallery first.
  if (key === "escape" && !ctrl && pageOpen === "foundry" && foundryOpen && !field) {
    event.preventDefault();
    if (foundryUi.edit !== null) foundryUi.edit = null; else foundryOpen = null;
    renderPage();
    if (state) renderState({ ...state });
    return;
  }
  if (key === "escape" && !ctrl && pageOpen && (!field || (event.target as HTMLElement).id === "settings-search")) {
    event.preventDefault();
    openPage("");
    return;
  }
  // ↑↓ step through Settings' sections while no field has the keyboard.
  if (pageOpen === "settings" && !field && !ctrl && !event.altKey && (key === "arrowdown" || key === "arrowup")) {
    event.preventDefault();
    const at = SETTINGS_ORDER.indexOf(settingsUi.section);
    settingsSection(SETTINGS_ORDER[(at + (key === "arrowdown" ? 1 : -1) + SETTINGS_ORDER.length) % SETTINGS_ORDER.length]!);
    document.querySelector<HTMLElement>("#settings-nav .st-nav.on")?.focus({ preventScroll: true });
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
  // ⌘K is Search in the sidebar: the list narrows as you type.
  if (ctrl && key === "k") {
    event.preventDefault();
    const search = document.getElementById("sidebar-search") as HTMLInputElement | null;
    if (document.getElementById("desktop-shell")?.classList.contains("sidebar-collapsed")) document.getElementById("rail-expand")?.click();
    search?.focus();
    search?.select();
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
  // ⌥P unfolds Home's where word; in its row ←→ move, Esc folds.
  if (event.altKey && !ctrl && event.code === "KeyP" && !inSession()) {
    event.preventDefault();
    toggleWhere(whereOpen === "home" ? null : "home");
    return;
  }
  const option = event.target instanceof Element ? event.target.closest<HTMLElement>(".where-opt") : null;
  if (option && (key === "arrowleft" || key === "arrowright")) {
    event.preventDefault();
    const options = [...option.parentElement!.querySelectorAll<HTMLElement>(".where-opt")], at = options.indexOf(option);
    options[(at + (key === "arrowleft" ? -1 : 1) + options.length) % options.length]?.focus({ preventScroll: true });
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
    // While searching models, ↑↓ and Enter work on the matches, not the
    // short list above them.
    if (overlay === "models" && overlayQuery && (key === "arrowdown" || key === "arrowup" || key === "enter")) {
      const matches = overlayRows.flatMap((row, index) => row.kind === "rest" && row.action === "model" ? [index] : []);
      event.preventDefault();
      if (!matches.length) return;
      if (key === "enter") {
        run(() => dispatch("choose-row", { index: matches.includes(overlayIndex) ? overlayIndex : matches[0]! }));
        return;
      }
      const at = matches.indexOf(overlayIndex);
      overlayIndex = matches[at < 0 ? 0 : (at + (key === "arrowdown" ? 1 : -1) + matches.length) % matches.length]!;
      renderOverlay();
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
  // Recall without sending or replacing a draft; completion menus above keep ↑.
  if (event.target === editor && key === "arrowup" && !ctrl && !event.altKey && !event.shiftKey
    && !pageOpen && !editor.value && !pendingQuestion() && !state.approvals.length) {
    const prompt = lastPrompt(state.runs);
    if (prompt) { event.preventDefault(); setDraft(prompt); }
    return;
  }
  if (key === "tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.target === editor) {
    run(() => cycleMode());
    return;
  }
  if (event.target === editor && key === "enter" && !event.shiftKey) {
    // During an approval Enter allows; with text it denies and says why.
    const approval = !pendingQuestion() ? state.approvals[0] : undefined;
    if (approval) run(() => (editor.value.trim() ? denyInstead(editor.value) : api("permission", { id: approval.id, decision: approval.overlap ? "deny" : habitual(approval) ? "allow_always" : "allow_once" })));
    else run(() => submitText(editor.value, event.altKey));
    event.preventDefault();
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
    run(() => (suggestion ? setDraft(suggestion) : openPage("settings")));
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
  host: { session: state?.session?.id, active: state?.activeTurnId, busy: state?.busy, queue: state?.queue, draft: state?.draft, questionDraft: state?.questions[0]?.draft, restored: state?.restored, connection: state?.connection, notice: el("notice").hidden ? "" : el("notice").textContent, requests: recentRequests.map((entry) => `${entry.method} ${entry.outcome}`) },
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
// A working sub-agent's saying changes in place, without repainting the guide.
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
