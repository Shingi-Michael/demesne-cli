import { FilesView } from "./files-view.ts";
import { sourceLocations } from "./file-navigation.ts";
import { markdown, MarkdownView } from "./markdown.ts";
import { splitNextPrompt } from "../../packages/protocol/src/next-prompt.ts";
import { StateReceiver, type StateUpdate } from "./state-wire.ts";
import { codeDiff } from "../cli/src/workbench/change-diff.ts";
import { driveSince, driveStepLine, driveTaskList } from "../cli/src/workbench/drive-timeline.ts";
import { subagentPhrase } from "../cli/src/workbench/subagent-phrases.ts";
import type { GraphicsHost } from "./host.ts";
import type { GraphicsRun, GraphicsChange } from "./session-model.ts";
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
  ReviewScope,
  ReviewResponse,
  CommandRecord,
  ImageArtifact,
} from "@demesne/protocol";

type Snapshot = ReturnType<GraphicsHost["snapshot"]>;
type PaneName =
  | "files"
  | "changes"
  | "log"
  | "verification"
  | "history"
  | "context"
  | "preview"
  | "drive";
type OverlayName =
  | "settings"
  | "models"
  | "themes"
  | "providers"
  | "cleanup"
  | "sessions"
  | "rename"
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
  pane: PaneName | null = null,
  paneTurn = "",
  paneIndex = 0,
  paneDetail: number | null = null,
  paneFilter = "all",
  paneExpanded = false;
let overlay: OverlayName | null = null,
  overlayQuery = "",
  overlayIndex = 0,
  models: ModelDescriptor[] = [],
  /// The model scoreboard, by provider and model id.
  modelScores = new Map<string, ModelScore>(),
  modelsLoading = false,
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
let selectedImage = "",
  previewPinned = false,
  followImages = true,
  previewData = "",
  previewLoading = "";
let reviewScope: ReviewScope = "turn",
  reviewMeta: ReviewResponse | null = null,
  reviewError = "",
  reviewBusy = false,
  reviewMode: "diff" | "before" | "after" = "diff",
  hunkIndex = -1;
let commandTab: "events" | "running" = "events",
  commandSelection = "",
  commandSearch = "";
let referencePathDraft = "",
  referenceViewportWidth = "",
  referenceViewportHeight = "";
let referenceImage = "",
  referenceData = "",
  referenceLoading = "",
  previewCompare = false,
  previewOpacity = 50,
  previewFit = true,
  previewZoom = 1;
let previewObserver: ResizeObserver | undefined;
let changes: GraphicsChange[] = [],
  changesKey = "",
  changesRequest = 0;
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
/// The Drive popover under the top bar's Drive word; the briefing line's
/// unfolded parts above the composer; turns whose steps are open.
let drivePopOpen = false,
  driveShown = false,
  ideasShown = false;
const stepsOpen = new Set<string>();
let paneSignature = "",
  overlaySignature = "",
  approvalSignature = "",
  questionSignature = "",
  heroSignature = "";
const diffCache = new Map<string, { added: number; removed: number }>();
async function api<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return window.demesne.request<T>(method, {
    ...args,
    ...(["drive", "drive-control"].includes(method)
      ? { observation: observeUI() }
      : {}),
    sessionId: state?.session?.id,
  });
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
let statusSignature = "";
function renderStatus() {
  if (!state) return;
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
    pane,
    state.session?.workspace?.gitBranch,
    state.runs.length,
    inSession(),
    driveWord(),
    drivePopOpen,
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
  const c2 = c.percentage == null ? "" : `<span class="muted">·</span> ${c.percentage}% context`;
  el("composer-model").innerHTML = `${h(state.model.displayName ?? state.model.id) || "Choose a model"} <span class="muted">⌄</span>`;
  el("composer-context").innerHTML = c2;
  el("composer-context").hidden = !inSession() || !c2;
  el("status").innerHTML =
    `${working ? `<span class="state">${spinner()}</span>` : phase === "ready" ? "" : `<span class="state ${phase === "failed" ? "danger" : phase === "approval" || phase === "waiting" ? "amber" : ""}"><img src="assets/${phase === "approval" || phase === "waiting" ? "activity-dot" : "ready-dot"}.svg" width="8" height="8" alt="">${h(phase)}</span>`}<span>${h((state.model.displayName ?? state.model.id) || "Connecting…")}${state.reasoning ? `<span class="muted"> · ${h(state.reasoning)}</span>` : ""}</span><div class="spacer"></div>${btn("panel", `<div class="context">${c.percentage == null ? "<span>ctx —</span>" : `<div class="meter"><i style="--usage:${Math.min(100, c.percentage)}%"></i></div><span>${num(c.used)} · ${c.percentage}%</span>`}</div>`, { name: "context" })}${inSession() ? "" : btn("overlay", `${k("Tab")} settings`, { name: "settings" }, "key-action") + btn("insert-command", `${k("Ctrl+K")} commands`, {}, "key-action")}`;
  // The desktop toolbar already names the project; the header carries the
  // session's live state and, in a session, its four places as words.
  const word = driveWord();
  const places = inSession()
    ? `<nav class="header-nav" aria-label="Panels">${PLACES.map((place) =>
        place.name === "drive"
          ? `<button type="button" id="drive-word" class="${drivePopOpen || pane === "drive" ? "active" : ""}" data-action="drive-pop" aria-haspopup="dialog" aria-expanded="${drivePopOpen}">Drive${word.needs ? `<b class="count" aria-label="${word.needs} need you">${word.needs}</b>` : word.live ? '<i class="live" aria-label="working"></i>' : ""}</button>`
          : `<button type="button" class="${(place.views as readonly string[]).includes(pane ?? "") ? "active" : ""}" data-action="panel" data-args="${h(JSON.stringify({ name: place.name }))}" data-drive="panel-${place.name}">${place.label}</button>`,
      ).join("")}</nav>`
    : btn("panel", `${k("Alt+H")} history`, { name: "history" }, "key-action", true);
  el("header").innerHTML =
    `<div class="header-state">${state.session?.workspace?.gitBranch ? `<span>⎇ ${h(state.session.workspace.gitBranch)}</span>` : ""}${state.session?.autoApprove ? btn("overlay", "Auto-approve", { name: "settings" }, "pill auto-approve") : ""}${state.activeTurnId || state.approvals.length ? `<span class="pill ${state.approvals.length ? "approval" : "running"}">${state.approvals.length ? "approval" : "running"}</span>` : ""}</div>${places}`;
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
function toolRow(run: GraphicsRun, tool: ToolEntry) {
  const result =
    tool.name === "run_command" &&
    tool.input.background === true &&
    tool.state === "done"
      ? "background started"
      : tool.waiting
        ? tool.name === "ask_user" || state?.questions.some(q=>q.toolCallId===tool.toolCallId) ? "waiting for answer" : "awaiting approval"
        : tool.phase === "change"
          ? tool.drafting
            ? "drafting"
            : tool.state === "done"
              ? "applied"
              : tool.state
          : tool.exitCode != null
            ? `exit ${tool.exitCode}`
            : tool.state === "done" && tool.name === "run_command"
              ? "exit unknown"
              : tool.state === "running"
                ? subagentSteps(tool)
                : tool.state;
  return btn(
    "tool",
    `<span class="${tone(tool.state)}">${tool.state === "running" ? spinner() : h(mark(tool.state))}</span><span class="verb">${h(verb(tool))}</span><span class="target" title="${h(tool.detail ?? tool.name)}">${toolTarget(run, tool)}</span><span class="result ${tool.phase === "change" && tool.state === "done" ? "success" : "muted"}">${h(result)}</span>${tool.phase === "change" ? counts(totals(run, tool)) : ""}<span class="time">${tool.phase === "change" ? "open ▸" : duration(tool.durationMs)}</span>`,
    { runId: run.id, id: tool.id },
    `tool-row ${tool.state === "failed" ? "failed" : ""} ${tool.waiting ? "waiting" : ""}`,
    true,
  );
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
  if (index < state!.runs.length - 1 && !expanded.has(run.id) && !active(run))
    return btn(
      "expand-turn",
      `▸ Turn ${run.number} · <span class="${tone(run.status)}">${h(run.status)}</span> at ${clock(run.completedAt ?? run.createdAt).slice(0, 5)} · ${duration(run.receipt?.durationMs)} · ${files ? `${files} file${files === 1 ? "" : "s"} changed` : "no diff"} · <span class="muted">${h(shortcut("Ctrl+B"))} log</span>`,
      { id: run.id },
      "folded-turn",
      true,
    );
  // A finished turn reads as its answer: thinking and tool steps fold into
  // the receipt line under it, and open from there.
  const fold = run.status === "completed" && !stepsOpen.has(run.id);
  let body = "";
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i]!,
      key = `${run.id}:${entry.id}`;
    if (entry.type === "assistant")
      body += `<div class="markdown" data-answer="${h(run.id)}" data-entry="${entry.id}"></div>`;
    if (fold && (entry.type === "reasoning" || entry.type === "tool")) continue;
    if (entry.type === "reasoning") {
      const live = active(run) && i === run.entries.length - 1;
      // The trace leads; its activity/toggle row follows underneath. Preserve
      // the same live-open and manual collapse behavior as subagent traces.
      const open=(live && !detailsClosed.has(key)) || detailsOpen.has(key);
      body += `<div class="thinking thinking-main ${live ? "live" : ""}"><div class="thinking-content" id="thinking-body-${h(key)}"${open ? "" : " hidden"}>${thinkingBody(entry.raw)}</div><button type="button" class="thinking-toggle" data-action="toggle-thinking" data-args="${h(JSON.stringify({id:key}))}" aria-expanded="${open}" aria-controls="thinking-body-${h(key)}">${live ? spinner() : "◇"} ${live ? "Thinking" : "Thought"} <span class="muted">${duration(entry.durationMs)}</span></button></div>`;
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
        body += `<details class="explored" data-detail="${key}"${detailsOpen.has(key) ? " open" : ""}><summary>${summary} · ${duration(sum)}</summary><div>${group.map((tool) => toolRow(run, tool)).join("")}</div></details>`;
        i = j - 1;
      } else body += toolRow(run, entry) + subagentTrace(run, entry, key);
    }
    if (entry.type === "notice" && !entry.closesTurn)
      body += `<div class="system-band"><b>system</b><span>${h(entry.text)}</span></div>`;
  }
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
    const model = receipt?.model && receipt.model !== state!.model.id ? receipt.model.split("/").at(-1)! : "";
    const sep = '<span class="sep">·</span>';
    const parts = [
      error ? `<span class="${run.status === "failed" ? "danger" : ""}">${h(error)}</span>` : "",
      files ? `<span class="receipt-files">${files === 1 ? h(paths[0]!.split(/[\\/]/).at(-1) ?? paths[0]) : `${files} files`} ${counts(total)}</span>` : "",
      checks.length ? btn("panel", `${passed ? "checks passed" : failed ? "checks failed" : stopped ? "checks stopped" : "checks unknown"}`, { name: "verification", turnId: run.id }, passed ? "success" : failed ? "danger" : "", true) : "",
      run.status === "completed" && (steps || thought)
        ? btn("toggle-steps", fold ? (steps ? `${steps} step${steps === 1 ? "" : "s"}` : "thinking") : "hide steps", { id: run.id }, "receipt-steps")
        : "",
      receipt?.mode === "Plan" || run.planOnly ? "plan" : "",
      model ? h(model) : "",
      duration(receipt?.durationMs),
    ].filter(Boolean);
    const mark = run.status === "completed" ? '<span class="success">✓</span>' : run.status === "failed" ? '<span class="danger">×</span>' : "<span>■</span>";
    footer = `<div class="turn-receipt">${mark}${parts.join(sep)}${files ? btn("panel", "review ›", { name: "changes", turnId: run.id }, "receipt-review", true) : ""}${error ? btn("panel", "log ›", { name: "log", turnId: run.id }, "receipt-review", true) : ""}${btn("copy-answer", "copy", { id: run.id }, "copy-answer")}</div>`;
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
  const activity = active(run) && !thinkingLive
    ? `<div class="live-activity">${spinner()}${h(phase + (latestTool?.drafting || latestTool?.name === "run_command" ? "" : latestTool?.detail ?? "") + (latestTool?.name === "subagent" && latestTool.trace?.findLast((segment) => segment.kind === "step") ? ` · ${latestTool.trace.findLast((segment) => segment.kind === "step")!.text}` : "") + "…")}</div>`
    : "";
  return `<div class="request"><span class="text">${h(run.content)}</span><time>${clock(run.createdAt).slice(0, 5)}</time></div><div class="response ${active(run) ? "running" : run.status === "failed" ? "failed" : ""}">${body}${footer}${activity}</div>`;
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
function renderConversation() {
  if (!state) return;
  const root = el("conversation"),
    stage = el("stage"),
    top = stage.scrollTop,
    liveBefore = follow;
  const ids = new Set<string>();
  let changed = false;
  for (const [index, run] of state.runs.entries()) {
    ids.add(run.id);
    const signature = JSON.stringify([
      index === state.runs.length - 1,
      expanded.has(run.id),
      stepsOpen.has(run.id),
      state.questions.length > 0,
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
    signature = JSON.stringify([state.workspace, review.map((job) => job.id), away?.status, driveBusy, reviewShown, next.proposals, next.signals.length]);
  if (signature === heroSignature) return;
  heroSignature = signature;
  const composer = el("composer-slot");
  composer.remove();
  const name = state.workspace.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || state.workspace;
  const waiting = review.length
    ? `<p>${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review ›`, {}, "link", true)}<span class="muted"> · ${away && away.status !== "running" ? "Drive ran them while you were away" : "each in its own worktree"}</span></p>`
    : "";
  const top = next.proposals.slice(0, 3);
  const words = ["", "it", "both", "all three"];
  const footer = [
    top.length && !driveBusy ? btn("next-away", `Run ${words[top.length]} overnight ›`, { count: top.length }, "link", true).replace("<button ", `<button title="Run ${top.length === 1 ? "it" : "them"} one after another while you're away, each in its own worktree. They wait for your review." `) : "",
    next.proposals.length > 3 ? btn("panel", `${next.proposals.length - 3} more in Drive`, { name: "drive" }, "", true) : "",
  ].filter(Boolean).join('<span class="muted"> · </span>');
  el("hero").innerHTML =
    `<div class="intro"><h1>${h(name)}</h1>${waiting}</div><div id="hero-composer"></div>${
      // Drive's Next queue, ready when you open demesne: the top three, each
      // with the evidence it rests on; the full queue is in the Drive panel.
      top.length
        ? `<section class="proposals"><h2>DRIVE WOULD DO NEXT</h2>${proposalRows(top)}${footer ? `<p class="proposals-footer">${footer}</p>` : ""}</section>`
        : ""
    }`;
  // The composer is detached while the hero is rebuilt.
  el("hero-composer").append(composer);
}
/// Drive's proposals as rows: kind, title, estimate and the evidence it rests
/// on, with Run and Plan. The start screen shows three; a session's briefing
/// line unfolds them in place.
function proposalRows(items: Snapshot["driveNext"]["proposals"]) {
  const signal = new Map(state!.driveNext.signals.map((item) => [item.id, item]));
  const minutes = (value: number) => (value < 60 ? `${value} min` : `${Math.round(value / 6) / 10} h`);
  return `<div class="proposal-list">${items
    .map((item) => {
      const evidence = item.evidence.map((id) => signal.get(id)?.title).find(Boolean);
      return `<div class="proposal-row"><span class="next-kind kind-${item.kind}">${item.kind.toUpperCase()}</span><b title="${h(item.why)}">${h(item.title)}</b><small>~${minutes(item.expectedMinutes ?? item.minutes)}${evidence ? ` · ${h(evidence)}` : ""}</small>${btn("next-run", "Run", { id: item.id }, "primary", true)}${btn("next-plan", "Plan", { id: item.id })}</div>`;
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
    queued = Boolean(!question && state.activeTurnId && editor.value.trim());
  let approvalMode = form.querySelector<HTMLElement>(".approval-mode");
  if (!approvalMode) {
    approvalMode = document.createElement("div");
    approvalMode.className = "approval-mode";
    form.insertBefore(approvalMode, editor);
  }
  approvalMode.hidden = !state.session?.autoApprove;
  approvalMode.innerHTML = state.session?.autoApprove
    ? btn("overlay", `Auto-approve all · ${state.planOnly ? "Plan stays read only" : "this session"}`, { name: "settings" })
    : "";
  form.classList.toggle("queued", queued);
  form.classList.toggle("restored", state.restored && !question);
  form.classList.toggle("stop-armed", Date.now() < stopArmed);
  el("queue-label").hidden = Boolean(question) || !queued && !state.restored;
  el("queue-label").innerHTML =
    `<span>${queued ? 'Queued <span class="muted">sends when this turn completes</span>' : 'Restored · not sent <span class="muted">the turn did not finish</span>'}</span>${btn("clear-queue", "Clear ×")}`;
  const suggestion = nextSuggestion();
  editor.placeholder = question
    ? answered ? "Your answers are saved. Choose Resume to continue." : question.status === "paused" ? "Type your answer to resume the interview…" : "Type your answer here…"
    : inSession()
    ? state.activeTurnId
      ? "Type to queue a follow-up…"
      : suggestion ? `${suggestion}   ⇥ Tab` : "Continue the conversation…"
    : "What should we do?";
  editor.disabled =
    state.connection !== "online" ||
    state.busy ||
    answeringQuestion ||
    Boolean(answered) ||
    state.approvals.length > 0;
  el("composer-slot").hidden =
    state.approvals.length > 0;
  // Like the terminal: no stop hint while running (Esc Esc still stops; only
  // the armed confirmation shows). In a session, an empty composer shows
  // / and @, and a draft shows ↵ send instead. The start screen keeps both.
  const armed = Date.now() < stopArmed;
  const draft = Boolean(editor.value.trim()), session = inSession();
  el("send-label").innerHTML = question ? "answer" : state.activeTurnId
    ? armed ? `Press ${k("Esc")} again to stop` : ""
    : "send";
  form.querySelector<HTMLElement>(".send")!.hidden = question ? !draft : state.activeTurnId ? !armed : session && !draft;
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
function renderApproval() {
  if (!state) return;
  const approval = state.approvals[0],
    signature = JSON.stringify(approval);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  if (!approval) {
    el("approval").innerHTML = "";
    return;
  }
  const command = Array.isArray(approval.input.argv)
      ? approval.input.argv.join(" ")
      : JSON.stringify(approval.input, null, 2),
    run = state.runs.find((run) => run.id === approval.turnId),
    isCommand = approval.name === "run_command",
    preview = `<div class="command-inset"><pre>${isCommand ? "$ " : ""}${h(command)}</pre><small>in ${h(approval.input.cwd ?? state.workspace)}${isCommand ? ' · <span class="amber">runs on your machine, not sandboxed</span>' : ""}</small></div>`,
    description = isCommand
      ? `<details class="approval-details"><summary>Command details</summary>${preview}</details>`
      : `<p class="approval-description">${h(approval.summary)}</p>${preview}`;
  el("approval").innerHTML =
    `<div class="approval-card"><div class="approval-title"><span class="amber">!</span> Allow this ${isCommand ? "command" : "action"}?<small>${isCommand ? "" : `${h(approval.name)} · `}Turn ${run?.number ?? "—"}</small></div>${description}<div class="approval-actions">${btn("permission", `${k("y")} Allow once`, { id: approval.id, decision: "allow_once" })}${btn("permission", `${k("n")} Deny`, { id: approval.id, decision: "deny" }, "deny")}${!isCommand ? btn("permission", "a &nbsp; allow this session", { id: approval.id, decision: "allow_session" }, "quiet") : ""}${approval.rule ? btn("permission", "s &nbsp; always allow", { id: approval.id, decision: "allow_always" }, "quiet") : ""}${btn("auto-approve", "Auto-approve all · this session", { autoApprove: true }, "auto-approve")}</div><p class="approval-scope">With Auto-approve all, edits, commands, deletions and publishing run without asking.</p></div>`;
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
  const signature = JSON.stringify([folding, running, signals, fix, state.breakage.inbox, state.breakage.away, awayOpen, busy, message, fix?.status === "running" && !fix.mission ? Math.floor(Date.now() / 1000) : 0]);
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
      if (!running) return;
      const activity = fix.activity ? `${fix.activity.steps} step${fix.activity.steps === 1 ? "" : "s"}${fix.activity.last ? ` · ${h(fix.activity.last)}` : ""}` : "Creating the worktree…";
      cards.push(`<div class="breakage-card running"><div class="breakage-head"><span class="breakage-mark breakage-pulse">◌</span><span class="breakage-text">${fix.proposal ? "Working in a worktree" : "Fixing in a worktree"}</span><small>${elapsed}</small></div><p class="breakage-title">${h(fix.title)}</p><div class="breakage-meta">${branch}<span>${activity}</span></div><div class="breakage-actions">${btn("breakage-discard", doing("discard", "Stopping…", "Stop and discard"), { id: fix.id }, "quiet", true, Boolean(busy))}</div></div>`);
    } else if (fix.status === "ready") {
      const diff = fix.diff ? `<span class="add">+${fix.diff.additions}</span> <span class="del">−${fix.diff.deletions}</span> · ${fix.diff.files} file${fix.diff.files === 1 ? "" : "s"}` : "";
      const checks = (fix.checks ?? []).map((check) => `<li class="${check.passed ? "pass" : "fail"}">${check.passed ? "✓" : "✕"} <code>${h(check.command)}</code></li>`).join("");
      cards.push(`<div class="breakage-card ready"><div class="breakage-head"><span class="breakage-mark">✓</span><span class="breakage-text">${fix.mission ? "Mission ready to review" : fix.proposal ? "Ready to review" : "Fix ready to review"}</span><small>${diff}</small></div><p class="breakage-title">${h(fix.title)}</p>${fix.headline ? `<p class="breakage-receipt">${h(fix.headline)} ${btn("breakage-receipt", "Copy receipt", { id: fix.id }, "link", true)}</p>` : ""}${fix.summary ? `<p class="breakage-summary">${h(fix.summary)}</p>` : ""}${checks ? `<ul class="breakage-checks">${checks}</ul>` : '<p class="breakage-note">No checks ran in the worktree.</p>'}<div class="breakage-meta">${branch}<span>${(fix.diff?.paths ?? []).map(h).join(" · ")}</span></div><div class="breakage-actions">${btn("breakage-apply", doing("apply", "Applying…", "Apply to my branch"), { id: fix.id }, "primary", true, Boolean(busy))}${btn("breakage-pr", doing("pr", "Opening…", "Open PR"), { id: fix.id }, "", true, Boolean(busy))}${btn("breakage-discard", doing("discard", "Discarding…", "Discard"), { id: fix.id }, "quiet", true, Boolean(busy))}</div></div>`);
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
  if (pane === "verification" && !paneTurn) {
    const check = verificationChecks()[paneIndex];
    if (check) return state?.runs.find((run) => run.id === check.turnId);
  }
  return state?.runs.find((run) => run.id === paneTurn) ?? state?.runs.at(-1);
}
/// Every view's header: its title, one line of subject, and ×. A drill-down
/// (Checks, Steps, Image, Context) leads with a link back to its place.
function panelHeader(title: string, subject = "", back?: { name: PaneName; label: string }, subjectTone = "") {
  return `<div class="panel-heading">${back ? btn("panel", `‹ ${back.label}`, { name: back.name }, "back", true) : ""}<strong class="title">${h(title)}</strong><span class="subject${subjectTone ? ` tone-${subjectTone}` : ""}">${h(subject)}</span>${btn("close-panel", "×", {}, "close", true)}</div>`;
}
/// The panel's four places, as words in the top bar. Each view belongs to
/// one, and its word lights while the view is open.
const PLACES = [
  { name: "changes", label: "Review", views: ["changes", "verification", "log"] },
  { name: "files", label: "Files", views: ["files", "preview"] },
  { name: "drive", label: "Drive", views: ["drive"] },
  { name: "history", label: "Session", views: ["history", "context"] },
] as const;
/// `bun run check`, not `/opt/homebrew/Cellar/bun/1.4.0/bin/bun run check`.
const commandLabel = (argv: readonly string[]) => [String(argv[0] ?? "").split("/").pop(), ...argv.slice(1)].join(" ");
/// A path inside the workspace, relative to it.
const workspacePath = (path: string) => {
  const root = state!.workspace.replace(/\/$/, "");
  return path === root ? "" : path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
};
const filesView = new FilesView({
  request: api,
  attach: (text) =>
    setDraft(editor.value + (editor.value ? "\n\n" : "") + text + "\n\n"),
  insert: (path) => {
    void dispatch("insert-file", { path });
  },
  changed: () => reportObservation(),
  error: notice,
});
function outputHTML(text: string, cwd?: string) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const locations = sourceLocations(
    clean,
    new Set(state?.files.map((f) => f.path)),
    state?.workspace ?? "",
    cwd,
  );
  let at = 0,
    result = "";
  for (const location of locations) {
    result +=
      h(clean.slice(at, location.start)) +
      btn(
        "source-location",
        h(clean.slice(location.start, location.end)),
        location,
        "source-location",
      );
    at = location.end;
  }
  result += h(clean.slice(at));
  const lines = clean.split("\n");
  return result
    .split("\n")
    .map(
      (html, i) =>
        `<span class="${/^\s*(✓|\d+ pass)/.test(lines[i]!) ? "success" : /^\s*(×|error|\d+ fail)/i.test(lines[i]!) ? "failure" : ""}">${html}</span>`,
    )
    .join("\n");
}
async function openSource(path: string, line = 1, column?: number) {
  const session = state?.session?.id;
  if (pane !== "files") await openPanel("files");
  if (pane !== "files" || session !== state?.session?.id) return;
  await filesView.open({ path, line, column });
}
function panelScroll() {
  return pane === "files"
    ? (filesView.scrollElement() ?? el("panel-scroll"))
    : el("panel-scroll");
}

type PanelMemory = {
  turn: string;
  index: number;
  detail: number | null;
  filter: string;
  scroll: number;
};
const panelMemory = new Map<PaneName, PanelMemory>();
function rememberPanel() {
  if (pane)
    panelMemory.set(pane, {
      turn: paneTurn,
      index: paneIndex,
      detail: paneDetail,
      filter: paneFilter,
      scroll:
        el("panel").querySelector<HTMLElement>("#panel-scroll")?.scrollTop ?? 0,
    });
}
let panelWatchKey = "";
function watchPanel() {
  const command =
    pane === "verification"
      ? verificationChecks()[paneIndex]?.id
      : pane === "log" && commandTab === "running"
        ? commandSelection
        : undefined;
  const key = `${state?.session?.id}:${pane}:${command ?? "none"}`;
  if (key === panelWatchKey) return;
  panelWatchKey = key;
  void api("panel-watch", { panel: pane, command: command ?? "none" }).catch(
    () => {},
  );
}
async function openPanel(
  name: PaneName,
  turnId = "",
  detail: number | null = null,
) {
  rememberPanel();
  if (name === "changes" && turnId) {
    if (reviewMeta?.turnId !== turnId) {
      changes = [];
      reviewMeta = null;
    }
    reviewScope = "turn";
    reviewMode = "diff";
  }
  const remembered =
    !turnId && detail === null ? panelMemory.get(name) : undefined;
  pane = name;
  paneTurn = remembered?.turn ?? turnId;
  paneDetail = remembered?.detail ?? detail;
  paneIndex = remembered?.index ?? 0;
  paneFilter = remembered?.filter ?? "all";
  paneExpanded = false;
  overlay = null;
  paneSignature = "";
  changesKey = "";
  renderPanels();
  watchPanel();
  const scroll = el("panel").querySelector<HTMLElement>("#panel-scroll");
  if (scroll && remembered) scroll.scrollTop = remembered.scroll;
  if (name === "files") void act(() => api("files"));
  if (name === "changes") await refreshChanges();
  if (name === "preview") void loadPreview();
  el("panel").tabIndex = 0;
  el("panel").focus({ preventScroll: true });
  reportObservation();
}
let reviewPromise: Promise<void> | null = null;
function refreshChanges(force = false): Promise<void> {
  if (reviewPromise) return reviewPromise.then(() => refreshChanges(force));
  reviewPromise = refreshChangesNow(force).finally(() => {
    reviewPromise = null;
  });
  return reviewPromise;
}
async function refreshChangesNow(force = false) {
  const run = selectedRun();
  if (!state || pane !== "changes" || reviewBusy) return;
  if (reviewScope === "turn" && !run) {
    changes = [];
    return;
  }
  const signature =
    reviewScope +
    ":" +
    (run?.id ?? "") +
    ":" +
    (reviewScope === "turn"
      ? JSON.stringify(run && tools(run).filter((t) => t.phase === "change"))
      : state.reviewRevision);
  if (!force && signature === changesKey) return;
  changesKey = signature;
  reviewBusy = true;
  reviewError = "";
  const request = ++changesRequest,
    session = state.session?.id;
  try {
    const result = await api<ReviewResponse & { files: GraphicsChange[] }>(
      "changes",
      { turnId: run?.id, scope: reviewScope, force },
    );
    if (
      request === changesRequest &&
      state?.session?.id === session &&
      pane === "changes" &&
      result.scope === reviewScope
    ) {
      const path = changes[paneIndex]?.path;
      reviewMeta = result;
      changes = result.files;
      paneIndex = Math.max(
        0,
        path
          ? changes.findIndex((file) => file.path === path)
          : Math.min(paneIndex, changes.length - 1),
      );
    }
  } catch (error) {
    if (request === changesRequest)
      reviewError = error instanceof Error ? error.message : String(error);
  } finally {
    reviewBusy = false;
    if (request === changesRequest && pane === "changes") {
      paneSignature = "";
      renderPanels();
    }
  }
}
async function loadPreview() {
  if (!state || pane !== "preview") return;
  if (followImages && !previewPinned)
    selectedImage =
      state.artifacts.findLast(
        (item) => item.source.name !== "reference_import",
      )?.id ?? "";
  const item =
    state.artifacts.find((image) => image.id === selectedImage) ??
    state.artifacts.at(-1);
  if (!item) return;
  if (previewLoading === item.id) return;
  selectedImage = item.id;
  previewLoading = item.id;
  previewData = "";
  try {
    const data = await api<string>("artifact", { id: item.id, original: true });
    if (previewLoading === item.id) {
      previewData = data;
      paneSignature = "";
      renderPanels();
    }
  } catch (error) {
    notice(String(error));
  }
}
function logRecords(run: GraphicsRun) {
  return [
    { id: 0, type: "request", text: run.content, at: run.createdAt } as any,
    ...run.entries,
  ];
}
function recordText(entry: any) {
  return entry.type === "tool"
    ? (entry.detail ?? entry.name)
    : (entry.raw ?? entry.text ?? "");
}
function logBody(run: GraphicsRun) {
  const all = logRecords(run),
    records = all.filter(
      (entry) =>
        paneFilter === "all" ||
        (paneFilter === "changes" && entry.phase === "change") ||
        (paneFilter === "checks" && entry.phase === "verify") ||
        (paneFilter === "failed" &&
          (entry.state === "failed" || entry.state === "denied")),
    );
  const detail =
    paneDetail == null ? null : all.find((entry) => entry.id === paneDetail);
  if (detail) {
    const index = all.indexOf(detail),
      tool = detail.type === "tool" ? (detail as ToolEntry) : null;
    return `<div class="panel-detail"><h3>${tool ? `<span class="${tone(tool.state)}">${mark(tool.state)} ${h(verb(tool))}</span> ` : ""}${h(tool ? (tool.detail ?? tool.name).replace(/^\$\s*/, "") : detail.type === "request" ? "Request" : detail.type === "assistant" ? "Response" : detail.type === "reasoning" ? "Thinking" : "Event")}</h3>${tool ? `<div><span class="pill ${tool.state === "failed" ? "failed" : ""}">${h(tool.state)}${tool.exitCode != null ? ` · exit ${tool.exitCode}` : ""}</span> &nbsp;${duration(tool.durationMs)} <span class="muted">· ${h(tool.input.cwd ?? state!.workspace)}</span></div><div class="output-label">OUTPUT <span>${(tool.message ?? "").split("\n").length} lines · stdout + stderr</span></div><pre class="output">${outputHTML(tool.message ?? (tool.state === "running" ? "Running…" : "No output recorded."), typeof tool.input.cwd === "string" ? tool.input.cwd : undefined)}</pre><details><summary>Arguments</summary><pre class="output">${h(JSON.stringify(tool.input, null, 2))}</pre></details>` : `<div class="markdown">${detail.type === "assistant" ? markdown(detail.raw) : `<pre class="output">${h(recordText(detail))}</pre>`}</div>`}</div>`;
  }
  paneIndex = Math.min(paneIndex, Math.max(0, records.length - 1));
  const count = (filter: string) =>
    all.filter(
      (entry) =>
        filter === "all" ||
        (filter === "changes" && entry.phase === "change") ||
        (filter === "checks" && entry.phase === "verify") ||
        (filter === "failed" &&
          (entry.state === "failed" || entry.state === "denied")),
    ).length;
  return `<div class="filters">${["all", "changes", "checks", "failed"].map((filter) => btn("log-filter", `${filter[0]!.toUpperCase() + filter.slice(1)} ${count(filter)}`, { filter }, paneFilter === filter ? "selected" : "", true)).join("")}</div><div class="panel-body" id="panel-scroll">${records
    .map((entry, index) => {
      const time = entry.startedAt ?? Date.parse(entry.at ?? "");
      return btn(
        "log-entry",
        `<span class="offset">${Number.isFinite(time) ? `+${((time - Date.parse(run.createdAt)) / 1000).toFixed(1)}s` : ""}</span><span class="${tone(entry.state ?? "")}">${entry.type === "tool" ? mark(entry.state) : entry.type === "request" ? "▶" : entry.type === "reasoning" ? "◇" : "·"}</span><span class="verb">${h(entry.type === "tool" ? verb(entry) : entry.type === "assistant" ? "Response" : entry.type === "request" ? "Request" : entry.type === "reasoning" ? "Thinking" : "Event")}</span><span class="name">${h(recordText(entry).split("\n")[0])}</span><span class="right ${entry.state === "failed" ? "danger" : ""}">${entry.exitCode != null ? `exit ${entry.exitCode}` : entry.phase === "change" ? `${totals(run, entry).added ? `+${totals(run, entry).added}` : ""}` : ""} ${duration(entry.durationMs)}</span>`,
        { id: entry.id, index },
        `panel-row ${index === paneIndex ? "selected" : ""}`,
        true,
      );
    })
    .join("")}</div>`;
}
function contextBody() {
  const c = context(),
    plan = state!.provider?.contextPlan,
    usage = state!.provider?.usage,
    metrics = state!.provider?.metrics;
  const amounts =
    plan && plan.capacityTokens && plan.reserves.totalTokens != null
      ? [
          plan.estimatedMessageTokens,
          plan.estimatedToolDefinitionTokens,
          plan.reserves.totalTokens,
          Math.max(
            0,
            plan.capacityTokens -
              plan.estimatedInputTokens -
              plan.reserves.totalTokens,
          ),
        ]
      : null;
  const colors = [
      "var(--electric)",
      "var(--syntaxType)",
      "var(--thinking)",
      "#22323d",
    ],
    labels = ["messages", "tool definitions", "reserved", "free"];
  const kv = (label: string, value: string) =>
    `<div class="kv"><span>${label}</span><span>${value}</span></div>`;
  const rate =
    usage?.outputTokens != null && metrics?.durationMs
      ? usage.outputTokens / (metrics.durationMs / 1000)
      : null;
  return `<div class="context-details"><div class="context-section">CONTEXT PLAN <span>estimated before request</span></div><div class="context-top">${c.estimated ? "~" : ""}${num(c.used)} <span class="muted">of ${num(c.capacity)}${c.percentage == null ? "" : ` · ${c.percentage}%`}</span></div>${amounts ? `<div class="stack">${amounts.map((n, i) => `<span style="width:${Math.min(100, (n / c.capacity!) * 100)}%;background:${colors[i]}"></span>`).join("")}</div><div class="legend">${amounts.map((n, i) => `<span><i style="background:${colors[i]}"></i>${labels[i]} ~${num(n)}</span>`).join("")}</div>` : '<p class="muted">Context breakdown has not been reported.</p>'}${kv("reserves", plan ? `output ${num(plan.reserves.outputTokens)} · results ${num(plan.reserves.toolResultTokens)} · safety ${num(plan.reserves.safetyTokens)}` : "—")}${kv("reductions", plan?.actions.length ? `<span class="success">${plan.actions.length} applied · saved ~${num(plan.actions.reduce((sum, a) => sum + a.estimatedTokensSaved, 0))}</span>` : "none")}<div class="context-section">LAST REQUEST <span>reported by provider</span></div>${kv("tokens", `${num(usage?.inputTokens)} in · ${num(usage?.outputTokens)} out · ${num(usage?.cachedInputTokens)} cached`)}${kv("timing", `queue ${duration(metrics?.queueDurationMs)} · first token ${duration(metrics?.timeToFirstTokenMs)} · request ${duration(metrics?.durationMs)}`)}${kv(
    "speed",
    `${rate == null ? "—" : rate.toFixed(1)} tok/s${(() => {
      const rates = state!.runs
        .map((run) => run.receipt?.tokensPerSecond)
        .filter((rate): rate is number => rate != null && Number.isFinite(rate))
        .slice(-10);
      return rates.length > 1
        ? `<span class="spark" title="Recent turn throughput">${rates.map((rate) => `<i style="height:${Math.max(2, Math.round((rate / Math.max(...rates)) * 18))}px"></i>`).join("")}</span>`
        : "";
    })()}`,
  )}<div class="context-section">TURN</div>${kv("status", state!.activeTurnId ? `<span class="amber">◌ running · ${duration(Date.now() - Date.parse(state!.runs.at(-1)!.createdAt))}</span>` : h(state!.runs.at(-1)?.status ?? "ready"))}${kv("thinking", "provider default")}${state!.checkpoint ? kv("compaction", `~${num(state!.checkpoint.beforeTokens)} → ~${num(state!.checkpoint.afterTokens)}`) : ""}</div>`;
}
/// The Next queue: Drive's ranked proposals, each with its evidence and the
/// four ways to answer it.
/// The Drive panel: a live (or paused, or blocked) mission pinned on top,
/// then two tabs. Next is the ranked queue as one-line rows, one expanded at
/// a time; Done is the finished mission and what Drive recorded as outcomes
/// and blockers. Missions start from /drive in the composer.
let driveTab: "next" | "done" = "next";
let nextOpen: string | null = null;
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
/// The Drive popover: what needs you, then what Drive finished, then how its
/// picks have turned out here. The full history is in the Drive panel.
let drivePopSignature = "";
function renderDrivePop() {
  const node = el("drive-pop");
  if (!state || !drivePopOpen || !inSession()) {
    drivePopOpen = false;
    node.hidden = true;
    drivePopSignature = "";
    return;
  }
  const pinned = pinnedMission(), run = worktreeRun(), next = state.driveNext;
  const needs = needsYou();
  const finished = state.drive && !pinned && state.drive.status === "completed" ? state.drive : null;
  const finishedTitle = finished ? missionTitle(finished).toLowerCase() : "";
  const outcomes = [...state.driveMemory].reverse().filter((entry) => entry.source === "drive" && entry.kind === "outcome" && !(finishedTitle && entry.text.toLowerCase().startsWith(finishedTitle)));
  const done = [
    ...(finished ? [{ title: missionTitle(finished), detail: "mission" }] : []),
    ...outcomes.map((entry) => ({ title: entry.text, detail: age(entry.at) })),
  ];
  const status = pinned?.status === "blocked" ? ["needs you", "thinking"] : pinned?.status === "paused" ? ["paused", "secondary"]
    : pinned || run.fix || run.away ? ["working", "citron"] : ["idle", ""];
  const calibration = next.calibration;
  const signature = JSON.stringify([needs, done.slice(0, 4), status, calibration, next.generatedAt && age(next.generatedAt)]);
  if (signature !== drivePopSignature) {
    drivePopSignature = signature;
    const row = (item: { mark: string; tone: string; title: string; detail: string; action?: string }) =>
      `<div class="pop-row"><span class="tone-${item.tone}">${h(item.mark)}</span><span class="pop-title" title="${h(item.title)}">${h(item.title)}</span><span class="pop-detail">${h(item.detail)}${item.detail && item.action ? " · " : ""}${item.action ?? ""}</span></div>`;
    node.innerHTML =
      `<div class="pop-head"><b>Drive</b><span class="${status[1] ? `tone-${status[1]}` : ""}">${status[0]}</span>${next.generatedAt ? `<span>· looked ${age(next.generatedAt)}</span>` : ""}</div>` +
      (needs.length ? `<h3>NEEDS YOU</h3>${needs.map(row).join("")}` : "") +
      (done.length ? `<h3>DONE</h3>${done.slice(0, 3).map((item) => row({ mark: "✓", tone: "citron", ...item })).join("")}${done.length > 3 ? `<div class="pop-more">${btn("drive-log", `${done.length - 3} more ›`, {}, "link")}</div>` : ""}` : "") +
      (!needs.length && !done.length ? '<p class="pop-empty">Nothing needs you. What Drive finishes shows here.</p>' : "") +
      `<div class="pop-foot"><span>${calibration?.total ? `Picks landed ${calibration.landed} of ${calibration.total}${calibration.timeRatio === 1 ? "" : ` · runs take ~${calibration.timeRatio}× its estimates`}` : ""}</span>${btn("drive-log", "all runs ›", {}, "link")}</div>`;
  }
  node.hidden = false;
  // Under the Drive word, kept inside the window.
  const anchor = document.getElementById("drive-word")?.getBoundingClientRect();
  if (anchor) {
    const width = node.offsetWidth || 460;
    node.style.top = `${Math.round(anchor.bottom + 6)}px`;
    node.style.left = `${Math.round(Math.max(12, Math.min(anchor.left + anchor.width / 2 - width / 2, innerWidth - width - 12)))}px`;
  }
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
    pinned && (driveShown ? [pinned, detailsOpen.has("drive-details"), Math.floor(Date.now() / 10_000)] : [pinned.status, pinned.mission, activeMinutes(pinned)]),
    run.fix && [run.fix.title, run.fix.status], run.away && run.away.items.map((item) => item.state),
    driveShown, ideasShown, next.proposals, next.loading, next.generatedAt && age(next.generatedAt),
  ]);
  if (signature === briefingSignature) return;
  briefingSignature = signature;
  const parts: string[] = [];
  let unfolded = "";
  if (review.length) {
    const only = review.length === 1 ? review[0]! : null;
    const about = only ? `${only.title}${only.diff ? ` · +${only.diff.additions} −${only.diff.deletions}` : ""}` : away && away.status !== "running" ? "Drive ran them while you were away" : "";
    parts.push(`${btn("review-open", `${review.length} ${review.length === 1 ? "branch" : "branches"} to review ${reviewShown ? "⌄" : "›"}`, {}, "link", true)}${about ? `<span class="muted">${h(about)}</span>` : ""}`);
  }
  if (pinned) {
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
      const top = next.proposals.slice(0, 5), words = ["", "it", "both", "all three", "all four", "all five"];
      const away = Math.min(3, top.length);
      unfolded = `<div class="briefing-ideas">${proposalRows(top)}<p class="proposals-footer">${[
        btn("next-away", `Run ${words[away]} overnight ›`, { count: away }, "link", true),
        btn("next-refresh", next.loading ? "looking…" : "look again", {}, "link", false, next.loading),
        next.generatedAt ? `<span class="muted">looked ${age(next.generatedAt)}</span>` : "",
        count > 5 ? btn("panel", `${count - 5} more in Drive`, { name: "drive" }, "", true) : "",
      ].filter(Boolean).join('<span class="muted"> · </span>')}</p></div>`;
    }
  }
  node.innerHTML = parts.length ? `<p class="briefing-line">${parts.join('<span class="muted sep">·</span>')}</p>${unfolded}` : "";
  node.hidden = !inSession() || !parts.length;
}
/// One model's scoreboard line in the model picker: how it has done on your
/// own recorded work over the last 30 days.
function scoreLine(score: ModelScore) {
  const ended = score.finished + score.failed;
  return [
    `${score.turns} turn${score.turns === 1 ? "" : "s"}${ended ? ` · ${Math.round((100 * score.finished) / ended)}% finished` : ""}`,
    score.toolCalls ? `${Math.round((100 * (score.toolCalls - score.toolErrors)) / score.toolCalls)}% tool calls ok` : "",
    score.tokensPerSecond !== null ? `${Math.round(score.tokensPerSecond)} tok/s` : "",
    score.firstTokenMs !== null ? `first token ${score.firstTokenMs < 1000 ? `${score.firstTokenMs} ms` : `${(score.firstTokenMs / 1000).toFixed(1)} s`}` : "",
    score.checkedTurns ? `checks passing ${score.passingTurns}/${score.checkedTurns}` : "",
    score.driveRuns ? `Drive runs kept ${score.driveLanded}/${score.driveRuns}` : "",
  ].filter(Boolean).join(" · ");
}
/// The Next heading: how the queue is ranked and, once any proposal has
/// run, how Drive's picks have actually turned out here.
function calibrationLine(calibration: import("@demesne/protocol").DriveCalibration | null | undefined) {
  if (!calibration?.total) return "ranked by value · confidence · cost";
  const levels = (["high", "medium", "low"] as const).filter((level) => calibration.levels[level].total)
    .map((level) => `${level} ${calibration.levels[level].landed}/${calibration.levels[level].total}`).join(", ");
  const time = calibration.timeRatio === 1 ? "" : ` · runs take ~${calibration.timeRatio}× its estimates`;
  return `<span title="Ranked by value · confidence · cost, with confidence and time taken from how Drive's proposals turned out here (landed by confidence: ${levels})">Drive's picks landed ${calibration.landed} of ${calibration.total} here${time}</span>`;
}
function nextQueueHTML(busy = false) {
  const next = state!.driveNext;
  const signal = new Map(next.signals.map((item) => [item.id, item]));
  // null: the top proposal opens by itself; "": all collapsed.
  const open = nextOpen === "" ? "" : next.proposals.some((item) => item.id === nextOpen) ? nextOpen : next.proposals[0]?.id;
  const minutes = (value: number) => (value < 60 ? `${value} min` : `${Math.round(value / 6) / 10} h`);
  const rows = next.proposals
    .map((item) => {
      const tag = `<span class="next-kind kind-${item.kind}">${item.kind.toUpperCase()}</span>`;
      if (item.id !== open)
        return `<div class="next-row">${tag}${btn("next-open", h(item.title), { id: item.id }, "next-row-title")}${busy ? '<span class="muted next-after">after this</span>' : btn("next-run", "▶", { id: item.id }, "next-row-run", true)}</div>`;
      return `<div class="next-item first"><div class="next-top">${tag}<span class="next-title">${h(item.title)}</span>${btn("next-open", "▾", { id: "" }, "next-collapse")}</div><p class="next-why">${h(item.why)}</p><div class="next-facts">${item.evidence.map((id) => `<span title="${h(signal.get(id)?.detail ?? "")}">${item.urgent && signal.get(id)?.urgent ? "! " : ""}${h(signal.get(id)?.title ?? id)}</span>`).join("")}<span${item.expectedMinutes ? ` title="Drive estimated ${minutes(item.minutes)}; runs here take ${next.calibration?.timeRatio ?? 1}× its estimates"` : ""}>~${minutes(item.expectedMinutes ?? item.minutes)} · ${item.coders} coder${item.coders === 1 ? "" : "s"}</span><span class="confidence-${item.confidence}">confidence ${item.confidence}</span></div><div class="next-actions">${busy ? '<span class="muted next-after">Runs after this mission</span>' : btn("next-run", "▶ Run", { id: item.id }, "primary", true)}${btn("next-plan", "Plan first", { id: item.id })}${btn("next-snooze", "Not now", { id: item.id }, "quiet")}${btn("next-never", "Never", { id: item.id }, "quiet")}</div></div>`;
    })
    .join("");
  // Away mode: the top few run one after another, each in its own worktree.
  const awayCount = Math.min(3, next.proposals.length);
  const awayLink = awayCount && !busy && state!.breakage.away?.status !== "running"
    ? btn("next-away", `Run top ${awayCount} away`, { count: awayCount }, "link next-away", true).replace("<button ", `<button title="Run the top ${awayCount === 1 ? "proposal" : `${awayCount} proposals`} one after another while you're away, each in its own worktree. They wait for your review." `) : "";
  return `<div class="next-heading"><span class="muted next-rank">${calibrationLine(next.calibration)}</span><span class="muted next-age">${next.loading ? "Reading…" : next.generatedAt ? age(next.generatedAt) : ""}</span>${awayLink}${btn("next-refresh", "↻", {}, "link", false, next.loading)}</div>${
    next.error ? `<p class="next-error">${h(next.error)}</p>` : ""
  }${rows || (next.loading ? "" : '<p class="muted next-empty">Nothing worth proposing right now. Drive looks again after your next turn, or press ↻.</p>')}`;
}
/// The mission's status line, steps, tasks, stats and Details, shared by the
/// pinned card and the finished mission at the top of Done.
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
  const stats = [`step ${drive.step}`, active, used ? `${num(used.planningTokens + used.workerTokens)} tokens` : "", drive.mode === "continuous" ? "continuous" : "bounded", planner].filter(Boolean).join(" · ");
  const ledger = Array.isArray(drive.ledger?.tasks) ? drive.ledger.tasks.filter((task) => task && typeof task.id === "string") : [];
  const section = (title: string, body: string) => body ? `<div class="drive-heading">${title}</div>${body}` : "";
  const details = [
    drive.answer ? section("ANSWER", `<p>${h(drive.answer)}</p>`) : section("NOTE", `<p>${h(summary)}</p>`),
    steps.length ? section("TIMELINE", `<ol class="drive-timeline">${steps.map((step) => `<li class="tone-${step.tone}"><span>${h(step.mark)}</span><span class="drive-step">${h(step.text)}</span><time>${h(step.when)}</time></li>`).join("")}</ol>`) : "",
    section("REASONING", trace?.reasoning ? `<pre>${h(trace.reasoning)}</pre>` : `<p class="muted">No reasoning recorded.</p>`),
    trace?.text || trace?.action ? section("OUTPUT", `<pre>${h(trace.text || trace.action)}</pre>`) : "",
    section("MISSION", `<p>${h(drive.mission)}</p><p class="muted">${drive.mode === "continuous" ? "Continuous: finishes each task, chooses worthwhile next work, then goes idle." : "Bounded: finishes after one verified task."}</p>`),
    drive.notes ? section("NOTES", `<pre>${h(drive.notes)}</pre>`) : "",
    drive.protection ? section("BUDGET", `<p class="muted">${Math.floor(drive.protection.used.activeMs / 60_000)}/${drive.protection.limits.maxActiveMinutes} active min · ${drive.protection.used.cycles}/${drive.protection.limits.maxCycles} cycles · ${drive.protection.used.workerRequests}/${drive.protection.limits.maxWorkerRequests} coder requests</p>`) : "",
    ledger.some((task) => task.status === "completed") ? `<p class="muted">Reopen a finished task: /drive reopen &lt;task-id&gt; &lt;reason&gt;<br>${ledger.filter((task) => task.status === "completed").slice(-4).map((task) => `${h(task.id.slice(0, 8))} · ${h(task.title)}`).join("<br>")}</p>` : "",
  ].join("");
  const title = missionTitle(drive);
  return {
    mark, label, tone, summary, title, stats,
    tasks: tasks.length ? `<ul class="drive-tasks">${tasks.map((task) => `<li class="tone-${task.tone}">${h(task.mark)} ${h(task.text)}</li>`).join("")}</ul>` : "",
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
function driveBody() {
  const drive = state!.drive;
  const pinned = pinnedMission();
  const finished = drive && !pinned ? drive : null;
  const card = pinned ? pinnedCard(pinned) : "";
  // The finished mission is shown in full at the top of Done; its own
  // outcome line in memory would only repeat it.
  const finishedTitle = finished ? missionParts(finished).title.toLowerCase() : "";
  const memory = state!.driveMemory.filter((entry) => entry.source === "drive" && (entry.kind === "outcome" || entry.kind === "blocker")
    && !(finishedTitle && entry.text.toLowerCase().startsWith(finishedTitle))).slice().reverse();
  const doneCount = memory.length + (finished ? 1 : 0);
  const tab = (name: "next" | "done", label: string, count: number) => `<button type="button" role="tab" aria-selected="${driveTab === name}" class="drive-tab${driveTab === name ? " active" : ""}" data-action="drive-tab" data-args="${h(JSON.stringify({ tab: name }))}">${label}${count ? ` <span class="count">${count}</span>` : ""}</button>`;
  const tabs = `<div class="drive-tabs" role="tablist">${tab("next", "Next", state!.driveNext.proposals.length)}${tab("done", "Done", doneCount)}</div>`;
  let body: string;
  if (driveTab === "next") body = nextQueueHTML(Boolean(pinned));
  else {
    let top = "";
    if (finished) {
      const parts = missionParts(finished);
      top = `<div class="done-item first"><div class="done-top"><span class="tone-${parts.tone}">${parts.mark}</span><span class="done-title">${h(parts.title)}</span></div><p class="next-why">${h(finished.answer ?? parts.summary ?? parts.label)}</p>${parts.tasks}<div class="drive-meta">${h(parts.stats)}</div><div class="next-actions">${finished.homeSessionId && finished.homeSessionId !== state!.session?.id ? btn("select-session", "Open session", { id: finished.homeSessionId }, "primary") : ""}${btn("panel", "Review changes", { name: "changes" }, finished.homeSessionId && finished.homeSessionId !== state!.session?.id ? "" : "primary", true)}</div>${parts.details}</div>`;
    }
    const rows = memory.slice(0, 30).map((entry) => `<div class="done-row"><span class="${entry.kind === "blocker" ? "tone-thinking" : "tone-citron"}">${entry.kind === "blocker" ? "◌" : "✓"}</span><span class="done-text">${entry.kind === "blocker" ? '<b class="tone-thinking">Needs you:</b> ' : ""}${h(entry.text)}</span><time>${h(age(entry.at))}</time></div>`).join("");
    body = top || rows ? `<div class="next-heading"><span class="muted">newest first · outcomes also go to Drive memory</span></div>${top}${rows}` : '<p class="muted next-empty">Finished missions and what Drive learned from them appear here.</p>';
  }
  return `<div class="drive-content">${card}${tabs}<div class="drive-tab-body">${body}</div><p class="drive-foot muted">${pinned ? "Steer Drive by typing in the composer" : "Start your own mission: <code>/drive</code> in the composer"}</p></div>`;
}
function processError() {
  return state?.processesError
    ? `<div class="panel-error">${h(state.processesError)} ${btn("refresh-processes", "Retry")}<br><small>These panels require the updated daemon.</small></div>`
    : "";
}
function checkLabel(command: CommandRecord) {
  if (["running", "stopping"].includes(command.status)) return "running";
  if (command.freshness === "outdated") return "outdated";
  if (command.status === "failed") return "failed";
  if (["stopped", "interrupted"].includes(command.status)) return "stopped";
  return command.exitCode === 0 && command.freshness === "current"
    ? "passed"
    : "unverified";
}
function verificationChecks() {
  if (!state) return [];
  const records = state.processes.filter(
    (command) => command.check && (!paneTurn || command.turnId === paneTurn),
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
    (run) => !paneTurn || run.id === paneTurn,
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
function verificationOverall(checks: CommandRecord[]) {
  if (!checks.length) return "not run";
  const statuses = checks.map(checkLabel);
  return (
    ["running", "failed", "outdated", "stopped", "unverified"].find((status) =>
      statuses.some((value) => value === status),
    ) ?? "passed"
  );
}
function commandsBody() {
  const all = state!.processes,
    records = all.filter((command) =>
      (command.argv.join(" ") + command.cwd + command.status)
        .toLowerCase()
        .includes(commandSearch.toLowerCase()),
    );
  const selected =
    all.find((command) => command.id === commandSelection) ?? records[0];
  if (selected) commandSelection = selected.id;
  const run = state!.runs.at(-1),
    waiting = state!.approvals.length
      ? "Waiting for your approval"
      : state!.questions.length
        ? "Waiting for your answer"
        : state!.queuePosition != null
          ? `Queued for the model · position ${state!.queuePosition}`
          : run?.status === "queued"
            ? "Queued for the model"
            : state!.activeTurnId
              ? tools(run!).some((tool) => tool.state === "running")
                ? "Executing tools"
                : "Model request in progress"
              : "Agent idle";
  return (
    processError() +
    `<div class="panel-note">${h(waiting)}</div><div class="panel-filter"><input id="command-search" aria-label="Filter commands" placeholder="Filter commands…" value="${h(commandSearch)}"></div><div class="command-list">${records.map((command) => btn("command-select", `<span class="${command.status === "completed" ? "success" : command.status === "failed" ? "danger" : "amber"}">${command.status === "running" ? "◌" : command.status === "completed" ? "✓" : "·"}</span><span class="name">${h(command.argv.join(" "))}</span><span class="right">${command.background ? "background · " : ""}${h(command.status)}</span>`, { id: command.id }, `panel-row ${command.id === selected?.id ? "selected" : ""}`)).join("")}</div>${selected ? `<div class="panel-detail command-detail"><h3>${h(selected.argv.join(" "))}</h3><div class="panel-note">${h(selected.cwd)}<br>Turn ${state!.runs.find((run) => run.id === selected.turnId)?.number ?? "—"} · PID ${selected.pid ?? "—"} · ${selected.background ? "background" : "foreground"} · <span data-command-elapsed="${h(selected.id)}">${duration(Date.parse(selected.completedAt ?? new Date().toISOString()) - Date.parse(selected.startedAt))}</span><br><span data-command-output-age="${h(selected.id)}">${selected.lastOutputAt ? `Last output ${age(selected.lastOutputAt)}` : "No output yet"}</span> · ${selected.exitCode == null ? h(selected.status) : `exit ${selected.exitCode}`}${selected.timedOut ? " · timed out" : ""}</div><div class="panel-actions">${["running", "stopping"].includes(selected.status) ? btn("stop-command", "Stop command", { id: selected.id }, "danger") : ""}${btn("copy-command-output", "Copy output", { id: selected.id })}</div><div class="output-label">STDOUT ${selected.truncated ? "<span>Bounded tail · older output omitted</span>" : ""}</div><pre class="output command-output">${outputHTML(selected.stdout || (selected.outputLoaded === false ? "Loading recorded stdout…" : "No stdout recorded."), selected.cwd)}</pre>${selected.stderr ? `<div class="output-label">STDERR</div><pre class="output command-output">${outputHTML(selected.stderr, selected.cwd)}</pre>` : ""}</div>` : '<div class="empty">No command recordings. Commands launched with the updated daemon appear here.</div>'}`
  );
}
async function loadReference() {
  const id = referenceImage;
  if (!id || id === referenceLoading) return;
  referenceLoading = id;
  referenceData = "";
  try {
    const data = await api<string>("artifact", { id, original: true });
    if (referenceImage === id) {
      referenceData = data;
      paneSignature = "";
      renderPanels();
    }
  } catch (error) {
    notice(String(error));
  }
}
function applyPreviewLayout() {
  const canvas = el("panel").querySelector<HTMLElement>(".preview-canvas"),
    plane = canvas?.querySelector<HTMLElement>(".preview-plane"),
    item = state?.artifacts.find((image) => image.id === selectedImage),
    reference = previewCompare
      ? state?.artifacts.find((image) => image.id === referenceImage)
      : undefined;
  if (!canvas || !plane || !item) return;
  const width = Math.max(item.width, reference?.width ?? 0),
    height = Math.max(item.height, reference?.height ?? 0),
    // Zoom follows CSS pixels, including on Retina displays.
    density = 1;
  const zoom = previewFit
    ? Math.min(canvas.clientWidth / width, canvas.clientHeight / height)
    : previewZoom / density;
  plane.style.width = `${width * zoom}px`;
  plane.style.height = `${height * zoom}px`;
  for (const [selector, image] of [
    [".preview-current", item],
    [".preview-reference", reference],
  ] as const) {
    const element = plane.querySelector<HTMLElement>(selector);
    if (element && image) {
      element.style.width = `${image.width * zoom}px`;
      element.style.height = `${image.height * zoom}px`;
    }
  }
  plane.style.setProperty("--reference-opacity", String(previewOpacity / 100));
}
function commandClocks() {
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-command-elapsed]",
  )) {
    const command = state?.processes.find(
      (command) => command.id === element.dataset.commandElapsed,
    );
    if (command)
      element.textContent = duration(
        Date.parse(command.completedAt ?? new Date().toISOString()) -
          Date.parse(command.startedAt),
      );
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-command-output-age]",
  )) {
    const command = state?.processes.find(
      (command) => command.id === element.dataset.commandOutputAge,
    );
    if (command)
      element.textContent = command.lastOutputAt
        ? `Last output ${age(command.lastOutputAt)}`
        : "No output yet";
  }
}

let pointerHeld = false,
  pendingPanelRender = false;
function releasePanelPointer() {
  pointerHeld = false;
  if (pendingPanelRender) {
    pendingPanelRender = false;
    setTimeout(() => renderPanels(), 0);
  }
}
document.addEventListener(
  "pointerdown",
  () => {
    pointerHeld = true;
  },
  true,
);
document.addEventListener("pointerup", releasePanelPointer, true);
document.addEventListener("pointercancel", releasePanelPointer, true);
document.addEventListener(
  "pointermove",
  (event) => {
    if (pointerHeld && event.buttons === 0) releasePanelPointer();
  },
  true,
);
function renderPanels() {
  if (!state) return;
  if (pointerHeld) {
    pendingPanelRender = true;
    return;
  }
  renderStatus();
  el("panel").hidden = !pane;
  filesView.setActive(pane === "files");
  if (pane === "files") filesView.update(state.files);
  if (!pane) {
    watchPanel();
    return;
  }
  if (pane === "changes") void refreshChanges();
  if (pane === "preview") void loadPreview();
  const run = selectedRun();
  const content =
    pane === "files"
      ? state.files
      : pane === "history"
        ? [
            state.runs.map((run) => [
              run.id,
              run.status,
              run.content,
              run.receipt,
            ]),
            state.sessions,
            state.driveMemory,
          ]
        : pane === "context"
          ? [state.provider, state.checkpoint, state.activeTurnId]
          : pane === "drive"
            ? [state.drive, state.driveNext, state.driveMemory, driveTab, nextOpen]
            : pane === "preview"
              ? [
                  state.artifacts,
                  selectedImage,
                  previewPinned,
                  previewData,
                  referenceImage,
                  referenceData,
                  previewCompare,
                  previewFit,
                  previewZoom,
                ]
              : pane === "changes"
                ? [
                    changes,
                    reviewScope,
                    reviewMode,
                    reviewMeta,
                    reviewError,
                    reviewBusy,
                  ]
                : pane === "verification"
                  ? [
                      run && tools(run).filter((t) => t.phase === "verify"),
                      state.processes,
                      state.verificationFingerprint,
                      state.processesError,
                      state.checkQueue,
                    ]
                  : [
                      run,
                      commandTab,
                      commandSelection,
                      commandSearch,
                      state.processes,
                      state.processesError,
                      state.queuePosition,
                    ];
  const signature = JSON.stringify([
    pane,
    paneTurn,
    paneIndex,
    paneDetail,
    paneFilter,
    paneExpanded,
    content,
  ]);
  if (signature === paneSignature) return;
  paneSignature = signature;
  const focusedField =
      el("panel").querySelector<HTMLInputElement>("input:focus"),
    focusedId = focusedField?.id,
    caret = focusedField?.selectionStart;
  const scroll =
    el("panel").querySelector<HTMLElement>("#panel-scroll")?.scrollTop ?? 0;
  el("panel").className =
    `${pane === "drive" ? "drive-pane" : pane === "files" ? "files-pane" : ""} ${paneExpanded ? "expanded" : ""}`;
  let header = "",
    body = "",
    footer = "";
  if (pane === "files") {
    const images = state.artifacts.filter((image) => image.source.name !== "reference_import");
    // Counts live in the search field and the list's own sections.
    header = panelHeader("Files", state.workspace.split("/").pop() ?? "");
    body = (images.length ? `<div class="panel-actions">${btn("panel", `Images ${images.length} ›`, { name: "preview" }, "", true)}</div>` : "") + '<div id="files-mount"></div>';
  }

  if (pane === "history") {
    const c = context(),
      usage = state.provider?.usage,
      metrics = state.provider?.metrics,
      rate = usage?.outputTokens != null && metrics?.durationMs ? usage.outputTokens / (metrics.durationMs / 1000) : null,
      cached = usage?.cachedInputTokens != null && usage.inputTokens ? Math.round((100 * usage.cachedInputTokens) / usage.inputTokens) : null,
      others = state.sessions.filter((item) => item.id !== state!.session?.id && item.turns > 0).slice(0, 5);
    header = panelHeader("Session", state.session?.title ?? "");
    body =
      `<div class="panel-actions">${btn("overlay", "Rename", { name: "rename" })}${btn("compact", "Compact")}${btn("new-session", "New session")}</div>` +
      `<div class="panel-section">CONTEXT ${btn("panel", "Details ›", { name: "context" }, "link", true)}</div><div class="session-context"><strong>${c.estimated ? "~" : ""}${num(c.used)}</strong><span class="muted"> of ${num(c.capacity)}${c.percentage == null ? "" : ` · ${c.percentage}%`}</span><div class="meter"><i style="--usage:${Math.min(100, c.percentage ?? 0)}%"></i></div></div>` +
      `<div class="panel-section">MODEL ${btn("overlay", "Change", { name: "models" }, "link")}</div><div class="session-model"><span class="name">${h(state.model.displayName ?? state.model.id)}</span><span class="muted">${h(state.model.provider)}${state.reasoning ? ` · thinking ${h(state.reasoning)}` : ""}</span><small class="muted">${[rate != null ? `${rate.toFixed(1)} tok/s` : "", metrics?.timeToFirstTokenMs != null ? `first token ${(metrics.timeToFirstTokenMs / 1000).toFixed(1)}s` : "", cached != null ? `cached ${cached}%` : ""].filter(Boolean).join(" · ")}</small></div>` +
      `<div class="panel-section">TURNS</div>${[...state.runs]
        .reverse()
        .map((item, index) =>
          btn(
            "jump-turn",
            `<span class="muted">${item.number}</span><span class="${tone(item.status)}">${mark(item.status)}</span><span class="name">${h(item.content)}</span><span class="right">${active(item) ? "running" : duration(item.receipt?.durationMs)}</span>`,
            { id: item.id, index },
            `panel-row ${index === paneIndex ? "selected" : ""}`,
            true,
          ),
        )
        .join("")}` +
      // Drive memory and other sessions appear once they have something in them.
      (state.driveMemory.length
        ? `<div class="panel-section">DRIVE MEMORY <span>${state.driveMemory.length}</span></div>${[...state.driveMemory]
            .reverse()
            .slice(0, 12)
            .map(
              (item) =>
                `<div class="check-row memory-row"><span class="${item.kind === "outcome" ? "success" : item.kind === "blocker" ? "danger" : "electric"}">${item.kind === "outcome" ? "✓" : item.kind === "blocker" ? "×" : "you"}</span><span class="name" title="${h(item.text)}">${h(item.text)}</span>${btn("drive-forget", "Forget", { id: item.id }, "link")}</div>`,
            )
            .join("")}`
        : "") +
      (others.length
        ? `<div class="panel-section">OTHER SESSIONS ${btn("overlay", "Clean up", { name: "cleanup" }, "link")}${btn("overlay", "All ›", { name: "sessions" }, "link")}</div>${others
            .map((item) =>
              btn(
                "select-session",
                `<span class="muted">→</span><span class="name">${h(item.title)}</span><span class="right">${age(item.updatedAt)}</span>`,
                { id: item.id },
                "panel-row",
                true,
              ),
            )
            .join("")}`
        : "");
  }
  if (pane === "context") {
    header = panelHeader("Context", `${state.model.id} · ${state.model.provider}`, { name: "history", label: "Session" });
    body = contextBody();
  }
  if (pane === "log") {
    const running = state.processes.filter((command) => ["running", "stopping"].includes(command.status)).length;
    header =
      commandTab === "running"
        ? panelHeader("Commands", `${running} running`, { name: "changes", label: "Review" })
        : panelHeader("Steps", run ? `Turn ${run.number} · ${logRecords(run).length} steps · ${duration(run.receipt?.durationMs)}` : "", { name: "changes", label: "Review" });
    body =
      `<div class="panel-tabs">${btn("command-tab", "Steps", { tab: "events" }, commandTab === "events" ? "selected" : "")}${btn("command-tab", `Commands ${running ? "●" : ""}`, { tab: "running" }, commandTab === "running" ? "selected" : "")}${btn("refresh-processes", "↻", {}, "right")}</div>` +
      (commandTab === "running"
        ? commandsBody()
        : run
          ? logBody(run)
          : '<div class="empty">No recorded steps.</div>');
    if (commandTab === "events" && run && paneDetail !== null) {
      const all = logRecords(run),
        index = all.findIndex((entry) => entry.id === paneDetail);
      header = `<div class="panel-heading">${btn("log-back", "‹ Steps", {}, "back", true)}<strong class="title">Step ${index + 1} of ${all.length}</strong><span class="subject">Turn ${run.number}</span>${btn("log-next", "Next ›", {}, "link", true)}${btn("close-panel", "×", {}, "close", true)}</div>`;
    }
  }
  if (pane === "changes") {
    const file = changes[paneIndex],
      total = changes.reduce(
        (n, f) => ({
          added: n.added + f.added,
          removed: n.removed + f.removed,
        }),
        { added: 0, removed: 0 },
      ),
      checks = verificationChecks(),
      busy = Boolean(state.activeTurnId || state.processes.some((c) => ["running", "stopping"].includes(c.status)));
    header = panelHeader(
      "Review",
      [
        reviewScope === "turn" ? (run ? `Turn ${run.number}` : "This turn") : reviewScope === "session" ? "Session" : "Workspace",
        `${changes.length} ${changes.length === 1 ? "file" : "files"}`,
        checks.length ? `checks ${verificationOverall(checks)}` : "",
      ].filter(Boolean).join(" · "),
    );
    const tabs = `<div class="panel-tabs">${(["turn", "session", "workspace"] as const).map((scope) => btn("review-scope", scope === "turn" ? "This turn" : scope === "session" ? "Session" : "Workspace", { scope }, scope === reviewScope ? "selected" : "")).join("")}${btn("refresh-review", reviewBusy ? "Refreshing…" : "↻", {}, "right")}</div>`;
    let code = "";
    if (file) {
      if (reviewMode !== "diff") {
        const text = reviewMode === "before" ? file.before : file.after;
        code =
          text == null
            ? '<div class="empty">This side has no available text.</div>'
            : text
                .split("\n")
                .map(
                  (line, i) =>
                    `<div class="diff-line context">${reviewMode === "after" ? btn("source-location", String(i + 1), { path: file.path, line: i + 1 }, "number") : `<span class="number">${i + 1}</span>`}<code>${h(line)}</code></div>`,
                )
                .join("");
      } else {
        let section = -1,
          wasChanged = false;
        code =
          file.rows
            .map((row) => {
              const changed = row.kind === "added" || row.kind === "removed",
                anchor =
                  changed && !wasChanged ? ` data-hunk="${++section}"` : "";
              wasChanged = changed;
              return `<div class="diff-line ${row.kind}"${anchor}>${row.kind === "gap" ? h(row.text) : `<span class="number">${row.old ?? ""}</span>${row.next ? btn("source-location", String(row.next), { path: file.path, line: row.next }, "number") : '<span class="number"></span>'}<span class="marker">${row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span><code>${h(row.text)}</code>`}</div>`;
            })
            .join("") || '<div class="empty">No textual changes.</div>';
      }
    }
    const checksSection = `<div class="panel-section">CHECKS ${btn("panel", "Details ›", { name: "verification" }, "link", true)}</div>` + (checks.length
      ? `${checks
          .slice(0, 4)
          .map((check, index) => {
            const label = checkLabel(check);
            return `<div class="check-row">${btn("open-check", `<span class="${label === "passed" ? "success" : label === "failed" ? "danger" : "amber"}">${label === "passed" ? "✓" : label === "failed" ? "×" : label === "running" ? "◌" : "·"}</span><span class="name">${h(commandLabel(check.argv))}</span><span class="muted">${label === "passed" ? "" : label}</span>`, { index }, "", true)}${check.id.startsWith("legacy:") ? "" : btn("rerun-check", "↻ Rerun", { id: check.id }, "link", false, busy)}</div>`;
          })
          .join("")}`
      : '<div class="check-row muted">No checks run</div>');
    body =
      tabs +
      (reviewError
        ? `<div class="panel-error">${h(reviewError)} ${btn("refresh-review", "Retry")}</div>`
        : "") +
      checksSection +
      `<div class="panel-section">FILES <span>${changes.length ? counts(total) : ""}</span></div><div class="file-list">${changes.map((file, index) => btn("change-file", `<span class="name">${pathHTML(file.path)}</span>${file.state === "applied" ? "" : `<span class="muted">${h(file.state)}</span>`}<span class="right"></span>${counts(file)}`, { index }, `panel-row ${index === paneIndex ? "selected" : ""}`, true)).join("")}</div>` +
      (file
        ? `<div class="panel-actions">${(["diff", "before", "after"] as const).map((mode) => btn("review-mode", mode === "diff" ? "Diff" : mode === "before" ? "Before" : "After", { mode }, reviewMode === mode ? "selected" : "")).join("")}${btn("review-current", "Open", { path: file.path })}${file.undo?.available ? btn("review-undo", "Undo file", { path: file.path, turnId: file.undo.turnId }, "danger right") : ""}</div>${file.undo && !file.undo.available ? `<div class="panel-note">Undo unavailable: ${h(file.undo.reason)}</div>` : ""}<div class="diff-code">${file.unavailable && reviewMode === "diff" ? `<div class="empty">${h(file.unavailable)}</div>` : code}</div>${reviewMeta?.truncated ? '<div class="panel-note">Some diff content is omitted.</div>' : ""}`
        : '<div class="empty">No changes in this scope.</div>');
    // The turn's step log, one row down; Ctrl+B opens it too.
    footer = run
      ? btn("panel", `▸ Steps <span class="muted">${logRecords(run).length} · ${duration(run.receipt?.durationMs)}</span>`, { name: "log" }, "panel-steps", true)
      : "";
  }
  if (pane === "verification") {
    const checks = verificationChecks(),
      selected = checks[Math.min(paneIndex, Math.max(0, checks.length - 1))],
      busy = Boolean(state.activeTurnId || state.processes.some((c) => ["running", "stopping"].includes(c.status)));
    header = panelHeader("Checks", `${paneTurn && run ? `Turn ${run.number}` : "Session"} · ${verificationOverall(checks)}`, { name: "changes", label: "Review" });
    const where = selected ? workspacePath(selected.cwd) : "";
    body =
      processError() +
      `<div class="panel-actions">${btn("rerun-failed", "Rerun failed", {}, "", false, busy || !checks.some((c) => c.status === "failed"))}<span class="muted">${state.checkQueue.length ? `${state.checkQueue.length} queued` : ""}</span>${btn("refresh-processes", "↻", {}, "right")}</div>` +
      checks
        .map((check, index) =>
          btn(
            "check-select",
            `<span class="${checkLabel(check) === "passed" ? "success" : checkLabel(check) === "failed" ? "danger" : "amber"}">${checkLabel(check) === "passed" ? "✓" : checkLabel(check) === "failed" ? "×" : checkLabel(check) === "running" ? "◌" : "·"}</span><span class="name">${h(commandLabel(check.argv))}</span><span class="right">${checkLabel(check)}</span>`,
            { index },
            `panel-row ${index === paneIndex ? "selected" : ""}`,
            true,
          ),
        )
        .join("") +
      (selected
        ? `<div class="panel-detail"><div class="panel-note">${where ? `${h(where)} · ` : ""}${selected.completedAt ? `ran ${clock(selected.completedAt)} · exit ${selected.exitCode ?? "—"}` : "running…"}${selected.freshness === "outdated" && selected.freshnessReason ? `<br>${h(selected.freshnessReason)}` : ""}</div><div class="panel-actions">${btn("command-open", "Open output", { id: selected.id }, "", true)}${selected.id.startsWith("legacy:") ? "" : btn("rerun-check", "Rerun", { id: selected.id }, "", false, busy)}</div><pre class="output">${outputHTML((selected.stdout + "\n" + selected.stderr).trim().split("\n").slice(-20).join("\n") || (selected.outputLoaded === false ? "Loading recorded output…" : "No recorded output."), selected.cwd)}</pre>${selected.truncated ? '<small class="muted">Output is a bounded excerpt.</small>' : ""}</div>`
        : '<div class="empty">No checks have run.</div>');
  }
  if (pane === "preview") {
    const item = state.artifacts.find((image) => image.id === selectedImage),
      reference = state.artifacts.find((image) => image.id === referenceImage);
    header = panelHeader(
      "Image",
      [item?.filename, item ? `${item.width} × ${item.height}` : "", previewPinned ? "pinned" : followImages ? "following new" : ""].filter(Boolean).join(" · "),
      { name: "files", label: "Files" },
    );
    body =
      `<div class="panel-actions">${btn("follow-images", "Follow new", {}, followImages && !previewPinned ? "selected" : "")}${btn("preview-fit", "Fit", {}, previewFit ? "selected" : "")}${btn("preview-zoom", "100%", { zoom: 1 }, !previewFit && previewZoom === 1 ? "selected" : "")}${btn("preview-zoom", "−", { step: -0.25 })}${btn("preview-zoom", "+", { step: 0.25 })}${btn("preview-compare", previewCompare ? "Hide comparison" : "Compare", {}, previewCompare ? "selected" : "")}</div>` +
      (item
        ? `<div class="preview-canvas" tabindex="0"><div class="preview-plane"><img class="preview-current" src="${h(previewData)}" alt="${h(item.filename)}" draggable="false">${previewCompare && referenceData ? `<img class="preview-reference" src="${h(referenceData)}" alt="Reference: ${h(reference?.filename)}" draggable="false">` : ""}</div></div>${previewCompare ? `<div class="compare-controls"><label>Reference opacity <input aria-label="Reference opacity" type="range" min="0" max="100" value="${previewOpacity}" id="reference-opacity"></label><span>${h(reference?.filename ?? "Choose a reference below")}${reference ? ` · ${reference.width} × ${reference.height} px · ${reference.viewport ? `${reference.viewport.width} × ${reference.viewport.height} viewport` : "viewport not recorded"}` : ""}</span></div>${reference && (reference.width !== item.width || reference.height !== item.height) ? '<div class="panel-note amber">Different image dimensions. Both are aligned at the top left; neither is stretched.</div>' : ""}` : ""}<div class="preview-actions">${btn("pin-image", previewPinned ? "Unpin" : "Pin")}${btn("expand-panel", paneExpanded ? "Restore" : "Expand")}${btn("open-image", "Open original")}</div>`
        : '<div class="empty">Images will appear here when a tool creates them.</div>') +
      `<details class="reference-picker"${!referenceImage ? " open" : ""}><summary>Reference ${reference ? `· ${h(reference.filename)}` : "image"}</summary><div class="preview-history">${state.artifacts
        .filter((image) => image.id !== selectedImage)
        .map((image) =>
          btn(
            "reference-image",
            h(image.filename),
            { id: image.id },
            `chip ${image.id === referenceImage ? "selected" : ""}`,
          ),
        )
        .join(
          "",
        )}</div><form id="reference-form"><label>Figma PNG/JPG/WebP export in this workspace<input id="reference-path" name="path" value="${h(referencePathDraft)}" placeholder="designs/reference.png" required></label><div class="viewport-inputs"><label>Viewport width (optional)<input id="reference-width" name="viewportWidth" inputmode="numeric" value="${h(referenceViewportWidth)}" placeholder="1200"></label><label>Height<input id="reference-height" name="viewportHeight" inputmode="numeric" value="${h(referenceViewportHeight)}" placeholder="720"></label></div><button type="submit" class="chip">Import reference</button></form></details><div class="preview-history">${state.artifacts
        .filter((image) => image.source.name !== "reference_import")
        .slice(-12)
        .map((image) =>
          btn(
            "select-image",
            h(image.filename),
            { id: image.id },
            `chip ${image.id === selectedImage ? "selected" : ""}`,
          ),
        )
        .join("")}</div>`;

  }
  if (pane === "drive") {
    const status = state.drive?.status;
    // Drive's state, as in the design: idle when nothing runs, ● live while
    // it works; the proposal count lives on the Next tab.
    const [subject, tone] = status === "running" || status === "waiting" ? ["● live", "citron"]
      : status === "paused" ? ["‖ paused", "secondary"]
      : status === "blocked" ? ["× needs you", "signal"]
      : ["idle", ""];
    header = panelHeader("Drive", subject, undefined, tone);
    body = driveBody();
  }
  const previewScroll =
      el("panel").querySelector<HTMLElement>(".preview-canvas"),
    panX = previewScroll?.scrollLeft ?? 0,
    panY = previewScroll?.scrollTop ?? 0;
  el("panel").style.setProperty(
    "--panel-width",
    state.panelWidth
      ? `${state.panelWidth}px`
      : pane === "drive"
        ? "340px"
        : "42%",
  );
  el("panel").innerHTML =
    '<div id="panel-resizer" role="separator" aria-label="Resize panel" aria-orientation="vertical" tabindex="0"></div>' +
    header +
    (pane === "log" && paneDetail == null && commandTab === "events"
      ? body
      : `<div class="panel-body" id="panel-scroll">${body}</div>`) +
    footer;
  if (pane === "files") el("files-mount").replaceWith(filesView.element);
  const container = el("panel").querySelector<HTMLElement>("#panel-scroll");
  if (container) container.scrollTop = scroll;
  if (focusedId) {
    const input = document.getElementById(focusedId) as HTMLInputElement | null;
    input?.focus({ preventScroll: true });
    if (input && caret != null && !["range", "number"].includes(input.type))
      input.setSelectionRange(caret, caret);
  }
  previewObserver?.disconnect();
  if (pane === "preview") {
    applyPreviewLayout();
    const canvas = el("panel").querySelector<HTMLElement>(".preview-canvas");
    if (canvas) {
      canvas.scrollLeft = panX;
      canvas.scrollTop = panY;
      previewObserver = new ResizeObserver(applyPreviewLayout);
      previewObserver.observe(canvas);
    }
  }
  watchPanel();
  reportObservation();
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
function renderOverlay() {
  if (!state) return;
  el("overlay").hidden = !overlay;
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
    title = "Settings";
    subtitle = "this session";
    filter = false;
    footerNote = `Tab or ${shortcut("Ctrl+K")} opens this`;
    overlayRows = [
      {
        label: "Mode",
        value: state.planOnly ? "Plan · read only" : "Build · edits allowed",
        group: "SESSION",
        action: "mode",
        data: { planOnly: !state.planOnly },
        hint: `to ${state.planOnly ? "Build" : "Plan"} ↵`,
      },
      {
        label: "Model",
        value: state.reasoning ? `${state.model.id} · thinking ${state.reasoning}` : state.model.id,
        group: "SESSION",
        action: "overlay",
        data: { name: "models" },
        hint: "/model",
      },
      {
        label: "Approvals",
        value: state.session?.autoApprove ? "Auto-approve all" : "Ask first",
        group: "SESSION",
        action: "auto-approve",
        data: { autoApprove: !state.session?.autoApprove },
        hint: state.session?.autoApprove ? "turn off ↵" : "turn on ↵",
        description: "Auto-approve all skips prompts for edits, commands, deletions and publishing. Plan stays read only.",
      },
      {
        label: "Theme",
        value: state.theme,
        group: "APPEARANCE",
        action: "overlay",
        data: { name: "themes" },
        hint: "/theme",
      },
      {
        label: "Sessions",
        value: `${state.sessions.filter((item) => item.turns > 0 && item.id !== state!.session?.id).slice(0, 3).length} recent · ${state.sessions.length} total`,
        group: "NAVIGATE",
        action: "overlay",
        data: { name: "sessions" },
        hint: "/sessions",
      },
      {
        label: "Clean up sessions",
        value: "delete empty, quick and old ones",
        group: "NAVIGATE",
        action: "overlay",
        data: { name: "cleanup" },
        hint: "/cleanup",
      },
      {
        label: "All commands",
        value: `${state.commands.length} commands`,
        group: "NAVIGATE",
        action: "insert-command",
        data: {},
        hint: "/",
      },
      {
        label: "Providers",
        value: state.providers.items.length ? `${state.providers.items.filter((item) => item.status === "signed-in").length} signed in` : "sign in · sign out",
        group: "CONNECTION",
        action: "overlay",
        data: { name: "providers" },
        hint: "/providers",
      },
      {
        label: "Provider setup",
        value: state.model.provider,
        group: "CONNECTION",
        action: "setup",
        data: {},
        hint: "setup",
      },
      // The ChatGPT plan lives here, not in the status bar.
      ...(state.model.provider === "ChatGPT"
        ? [
            {
              label: "ChatGPT plan",
              value: state.chatgptAccount?.email ?? state.chatgptAccount?.label ?? "signed in",
              group: "CONNECTION",
              action: "open-link",
              data: { url: "https://chatgpt.com/settings/usage" },
              hint: "manage usage ↗",
            },
          ]
        : []),
    ];
  } else if (overlay === "models") {
    title = "Switch model";
    subtitle = `current: ${state.model.id}`;
    noun = "models";
    footerNote = "Tab next group";
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
        value: [
          model.contextWindow
            ? `${num(model.contextWindow)} ctx`
            : "context unknown",
          model.maxOutputTokens ? `${num(model.maxOutputTokens)} out` : "",
          level ? `thinking ${level}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        group: model.provider.toUpperCase(),
        action: "model",
        data: { id: model.id, ...(level ? { reasoning: level } : {}) },
        hint: [model.reasoningLevels?.length ? "←→ thinking" : "", current ? "● current" : ""].filter(Boolean).join("  "),
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
    if (!models.length && modelsLoading) footerNote = "Loading models…";
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
  } else if (overlay === "rename") {
    el("overlay").innerHTML =
      `<div class="modal-title">Rename session</div><form id="rename-form"><div class="filter-wrap"><input name="title" aria-label="Session title" value="${h(overlayQuery || state.session?.title)}" maxlength="200"></div><div class="menu-footer"><button type="submit">${k("Enter")} save</button>${btn("close-overlay", `${k("Esc")} cancel`)}</div></form>`;
    return;
  } else if (overlay === "confirm-archive" || overlay === "confirm-undo") {
    title =
      overlay === "confirm-archive"
        ? "Archive this session?"
        : "Undo the last turn’s changes?";
    el("overlay").innerHTML =
      `<div class="modal-title">${title}</div><p class="empty">${overlay === "confirm-archive" ? "The session remains recoverable in the daemon archive." : "This reverts recorded file changes from the last turn. Changes made separately on disk may prevent a revert."}</p><div class="menu-footer">${btn(overlay === "confirm-archive" ? "archive" : "undo", "Confirm", {}, "danger")}${btn("close-overlay", `${k("Esc")} cancel`)}</div>`;
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
          `<span class="name">${h(row.label)}</span><span class="value">${h(row.value)}</span><span class="hint">${h(row.hint ?? "")}${index === overlayIndex && overlay !== "settings" ? ` ${k("↵")}` : ""}</span>`,
          { index },
          `menu-row ${index === overlayIndex ? "selected" : ""}`,
          overlay === "sessions",
        ) + (row.description ? `<p class="settings-description">${h(row.description)}</p>` : "")
      );
    })
    .join("");
  el("overlay").innerHTML =
    `<div class="modal-title">${title} <span>${h(subtitle)}</span>${noun ? `<small>${overlayQuery ? `${overlayRows.length} of ` : ""}${allCount} ${noun}</small>` : ""}</div>${filter ? `<div class="filter-wrap"><input id="chooser-filter" placeholder="filter" aria-label="Filter ${title}" value="${h(overlayQuery)}" autocomplete="off"></div>` : ""}<div class="menu-list">${rows || `<div class="empty">${overlay === "models" && modelsLoading && !models.length ? "Loading models…" : "No matches."}</div>`}${hidden ? `<div class="empty">${hidden} more · keep typing to narrow</div>` : ""}</div><div class="menu-footer">${k("↑↓")} select ${k("↵")} ${overlay === "models" ? "switch" : "change"} ${btn("close-overlay", `${k("Esc")} cancel`)}<span class="right">${footerNote}</span></div>`;
  if (hasFocus) {
    const input = el("overlay").querySelector<HTMLInputElement>("input");
    input?.focus({ preventScroll: true });
    if (selection != null) input?.setSelectionRange(selection, selection);
  }
  el("overlay")
    .querySelector(".menu-row.selected")
    ?.scrollIntoView({ block: "nearest" });
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
    completionItems = state.commands
      .filter((item) =>
        [item.name, ...item.aliases].some((name) => name.startsWith(value)),
      )
      .map((item) => ({
        label: item.name,
        description: item.description,
        hint: item.aliases.join(" "),
        group: item.section.toUpperCase(),
        value: item.name,
        kind: "command",
      }));
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
          ? `<div class="section-label">${item.group}<span>${mention ? `${completionItems.length} match${completionItems.length === 1 ? "" : "es"} “${h(needle)}”` : completionItems.filter((row) => row.group === item.group).length}</span></div>`
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
    `<div class="menu-list">${rows}</div><div class="menu-footer">${k("↑↓")} select ${k("↵")} ${mention ? "insert" : "run"} ${!mention ? `${k("Tab")} complete` : ""} ${k("Esc")} close <span class="right">${mention ? "files with spaces are skipped" : `${completionItems.length} commands`}</span></div>`;
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
  // Writing in the composer is what takes over from Drive; clicking,
  // navigating and reading panels leave it running.
  if (state?.drive && ["running", "waiting"].includes(state.drive.status))
    void api("manual");
  completionDismissed = false;
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
  if (state.activeTurnId) return;
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
    if (id === "diff" || id === "context" || id === "status") {
      await openPanel(id === "diff" ? "changes" : "context");
      clear();
      return;
    }
    if (id === "drive") {
      // A new mission unfolds on the briefing line; /drive alone opens the panel.
      if (argument) {
        driveShown = true;
        await api("drive", { text: argument });
      } else await openPanel("drive");
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
  if(action === "toggle-thinking") {
    const content=document.getElementById(`thinking-body-${args.id}`), toggle=content?.nextElementSibling;
    if(!content || !(toggle instanceof HTMLButtonElement))return;
    const open=toggle.getAttribute("aria-expanded") === "true";
    if(open){detailsOpen.delete(args.id);detailsClosed.add(args.id);}
    else{detailsClosed.delete(args.id);detailsOpen.add(args.id);}
    content.hidden=open;toggle.setAttribute("aria-expanded",String(!open));reportObservation();return;
  }
  if (drivePopOpen && target?.closest("#drive-pop")) {
    drivePopOpen = false;
    renderStatus();
    renderDrivePop();
  }
  if (action === "question-control") return questionAction(args.action);
  if (action === "auto-approve" && driveNavigating)
    throw new Error("Only you can change session approvals.");
  if (action === "review-scope") {
    reviewScope = args.scope;
    reviewMode = "diff";
    paneIndex = 0;
    changes = [];
    changesKey = "";
    reviewMeta = null;
    await refreshChanges(true);
    return;
  }
  if (action === "review-mode") {
    reviewMode = args.mode;
    hunkIndex = -1;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "refresh-review") {
    await refreshChanges(true);
    return;
  }
  if (["review-current", "source-location", "read-file"].includes(action)) {
    await openSource(args.path, args.line ?? 1, args.column);
    return;
  }
  if (action === "review-undo") {
    const file = changes.find((file) => file.path === args.path);
    if (!file?.undo?.available) return;
    await openOverlay("confirm-undo");
    el("overlay").querySelector(".confirm-copy")?.remove();
    el("overlay").innerHTML =
      `<div class="modal-title">Undo ${h(args.path)}</div><div class="panel-detail"><p>Restore this file to its contents before Turn ${state!.runs.find((run) => run.id === args.turnId)?.number ?? "—"}. Undo is refused if the file has changed since.</p><div class="panel-actions">${btn("review-undo-confirm", "Undo file", args, "danger")}${btn("close-overlay", "Cancel")}</div></div>`;
    return;
  }
  if (action === "review-undo-confirm") {
    await api("undo", args);
    overlay = null;
    renderOverlay();
    changesKey = "";
    await refreshChanges(true);
    notice("File restored");
    return;
  }
  if (action === "hunk") {
    const hunks = [...el("panel").querySelectorAll<HTMLElement>("[data-hunk]")];
    if (!hunks.length) return;
    hunkIndex =
      (hunkIndex + Number(args.direction) + hunks.length) % hunks.length;
    hunks[hunkIndex]!.scrollIntoView({ block: "center" });
    return;
  }
  if (action === "command-tab") {
    commandTab = args.tab;
    paneDetail = null;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "refresh-processes") {
    await api("processes");
    return;
  }
  if (action === "command-select") {
    commandSelection = args.id;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "command-open") {
    const legacy = String(args.id).startsWith("legacy:");
    if (legacy) {
      const check = verificationChecks().find((check) => check.id === args.id),
        run = state!.runs.find((run) => run.id === check?.turnId),
        tool =
          run &&
          tools(run).find((tool) => tool.toolCallId === check?.toolCallId);
      if (tool) await openPanel("log", run!.id, tool.id);
      return;
    }
    commandSelection = args.id;
    commandTab = "running";
    await openPanel("log");
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "stop-command") {
    await api("stop-command", { id: args.id });
    return;
  }
  if (action === "copy-command-output") {
    const command = state!.processes.find((command) => command.id === args.id);
    if (command) {
      await api("copy", {
        text:
          command.stdout +
          (command.stderr ? "\nSTDERR:\n" + command.stderr : ""),
      });
      notice("Copied recorded output");
    }
    return;
  }
  if (action === "rerun-check") {
    await api("rerun-checks", { ids: [args.id] });
    notice("Check queued");
    return;
  }
  if (action === "rerun-failed") {
    const ids = verificationChecks()
      .filter(
        (check) => check.status === "failed" && !check.id.startsWith("legacy:"),
      )
      .map((check) => check.id);
    if (!ids.length) {
      notice("No failed recorded checks to rerun");
      return;
    }
    await api("rerun-checks", { ids });
    return;
  }
  if (action === "preview-fit") {
    previewFit = true;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "preview-zoom") {
    previewFit = false;
    previewZoom = Math.max(
      0.25,
      Math.min(4, args.zoom ?? previewZoom + args.step),
    );
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "preview-compare") {
    if (!referenceImage) {
      notice("Choose or import a reference image below");
      el("panel")
        .querySelector<HTMLDetailsElement>(".reference-picker")
        ?.setAttribute("open", "");
      return;
    }
    previewCompare = !previewCompare;
    void loadReference();
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "reference-image") {
    referenceImage = args.id;
    referenceLoading = "";
    previewCompare = true;
    await loadReference();
    return;
  }
  if (action === "panel") return openPanel(args.name, args.turnId ?? "");
  // A check row in Review opens that check in Checks.
  if (action === "open-check") {
    const turn = paneTurn;
    await openPanel("verification", turn);
    paneIndex = Number(args.index) || 0;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "new-session") return api("new-session", {});
  if (["next-refresh", "next-run", "next-plan", "next-snooze", "next-never"].includes(action)) return api(action, args);
  if (action === "next-away") return act(() => api(action, args));
  if (action.startsWith("breakage-")) return act(() => api(action, args));
  if (["provider-signin", "provider-signout", "provider-cancel"].includes(action)) return act(() => api(action, args));
  if (["cleanup-toggle", "cleanup-delete"].includes(action)) return act(() => api(action, args));
  if (action === "drive-forget") return api("drive", { text: `forget ${args.id}` });
  if (action === "overlay") return openOverlay(args.name, args.query ?? "");
  if (action === "close-overlay") {
    overlay = null;
    renderOverlay();
    editor.focus({ preventScroll: true });
    return;
  }
  if (action === "close-panel") {
    rememberPanel();
    pane = null;
    watchPanel();
    renderPanels();
    editor.focus({ preventScroll: true });
    reportObservation();
    return;
  }
  if (action === "expand-panel") {
    paneExpanded = !paneExpanded;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "follow") {
    follow = true;
    readingHeld = false;
    paneTurn = "";
    overlay = null;
    renderOverlay();
    renderConversation();
    el("stage").scrollTop = el("stage").scrollHeight;
    editor.focus({ preventScroll: true });
    return;
  }
  if (action === "drive-tab") {
    driveTab = args.tab === "done" ? "done" : "next";
    renderPanels();
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
  if (action === "drive-show" || action === "ideas-show") {
    if (action === "drive-show") driveShown = !driveShown;
    else ideasShown = !ideasShown;
    renderBriefing();
    renderBreakage();
    return;
  }
  if (action === "drive-pop") {
    drivePopOpen = !drivePopOpen;
    renderStatus();
    renderDrivePop();
    return;
  }
  if (action === "drive-log") {
    driveTab = "done";
    return openPanel("drive");
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
  if (action === "next-open") {
    nextOpen = args.id;
    renderPanels();
    return;
  }
  if (action === "expand-turn") {
    expanded.has(args.id) ? expanded.delete(args.id) : expanded.add(args.id);
    follow = false;
    renderConversation();
    return;
  }
  if (action === "jump-turn") {
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
  if (action === "tool") {
    const run = state!.runs.find((run) => run.id === args.runId),
      tool = run?.entries.find((entry) => entry.id === args.id);
    if (tool?.type === "tool" && tool.name === "run_command") {
      const command = state!.processes.find(
        (command) => command.toolCallId === tool.toolCallId,
      );
      if (command) return dispatch("command-open", { id: command.id });
    }
    if (tool?.type === "tool" && tool.phase === "change") {
      await openPanel("changes", args.runId);
      return;
    }
    return openPanel("log", args.runId, args.id);
  }
  if (action === "log-filter") {
    paneFilter = args.filter;
    paneIndex = 0;
    paneDetail = null;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "log-entry") {
    paneDetail = args.id;
    paneIndex = args.index;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "log-next") {
    const run = selectedRun();
    if (run) {
      const records = logRecords(run),
        index = records.findIndex((entry) => entry.id === paneDetail);
      paneDetail = records[(index + 1) % records.length]!.id;
      paneSignature = "";
      renderPanels();
    }
    return;
  }
  if (action === "log-back") {
    paneDetail = null;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "change-file" || action === "check-select") {
    paneIndex = args.index;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "changes-live") {
    paneTurn = "";
    changesKey = "";
    void refreshChanges();
    return;
  }
  if (action === "check-output") {
    const check = verificationChecks()[paneIndex];
    if (check) return dispatch("command-open", { id: check.id });
    return;
  }
  if (action === "file-back") return filesView.action("back");
  if (action === "insert-file") {
    if (/\s/.test(args.path)) {
      notice(
        "This path contains spaces. Use Attach lines to include its contents.",
      );
      return;
    }
    pane = null;
    renderPanels();
    return setDraft(
      editor.value +
        `${editor.value.endsWith(" ") || !editor.value ? "" : " "}@${args.path} `,
    );
  }
  if (action === "select-image") {
    selectedImage = args.id;
    followImages = false;
    previewLoading = "";
    await loadPreview();
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "pin-image") {
    previewPinned = !previewPinned;
    if (!previewPinned) followImages = true;
    paneSignature = "";
    renderPanels();
    return;
  }
  if (action === "follow-images") {
    previewPinned = false;
    followImages = true;
    previewLoading = "";
    await loadPreview();
    return;
  }
  if (action === "open-image")
    return api("open-artifact", { id: selectedImage });
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
    rememberPanel();
    pane = null;
    watchPanel();
    renderPanels();
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
    pane = null;
    overlay = null;
    panelMemory.clear();
    filesView.reset();
    commandSelection = "";
    commandSearch = "";
    reviewScope = "turn";
    reviewMeta = null;
    reviewError = "";
    changes = [];
    changesRequest++;
    reviewBusy = false;
    selectedImage =
      referenceImage =
      referenceLoading =
      referenceData =
      previewLoading =
      previewData =
        "";
    previewPinned = false;
    followImages = true;
    previewCompare = false;
    watchPanel();
    expanded.clear();
    runNodes.forEach((item) => item.node.remove());
    runNodes.clear();
    paneSignature = heroSignature = overlaySignature = "";
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
    renderedPalette = next.palette;
  }
  // Drive working this session is a session, even before its first turn:
  // the start screen would sit beside the Drive panel.
  const start = !inSession(next);
  el("app").classList.toggle("start", start);
  el("hero").hidden = !start;
  el("conversation").hidden = start;
  if (start) renderHero();
  else if (wasStart) el("input-area").append(el("composer-slot"));
  renderStatus();
  renderConversation();
  renderComposer();
  renderApproval();
  renderQuestion();
  renderBriefing();
  renderBreakage();
  renderPanels();
  renderDrivePop();
  renderOverlay();
  renderCompletion();
  renderSetup();
  if (
    !editor.disabled &&
    !pane &&
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
  if (drivePopOpen && !(event.target as Element).closest("#drive-pop, #drive-word")) {
    drivePopOpen = false;
    renderStatus();
    renderDrivePop();
  }
  const summary = (event.target as Element).closest("summary");
  if (summary instanceof HTMLElement && summary.closest("#approval")) summary.focus({ preventScroll: true });
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
  if (input.id === "reference-path") referencePathDraft = input.value;
  if (input.id === "reference-width") referenceViewportWidth = input.value;
  if (input.id === "reference-height") referenceViewportHeight = input.value;
  if (input.id === "command-search") {
    commandSearch = input.value;
    paneSignature = "";
    renderPanels();
  }
  if (input.id === "reference-opacity") {
    previewOpacity = Number(input.value);
    applyPreviewLayout();
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
      } else await submitText();
    }
    if (form.id === "rename-form") {
      await api("rename", {
        title: (form.elements.namedItem("title") as HTMLInputElement).value,
      });
      overlay = null;
      renderOverlay();
    }
    if (form.id === "reference-form") {
      const path = (form.elements.namedItem("path") as HTMLInputElement).value;
      const width = (
          form.elements.namedItem("viewportWidth") as HTMLInputElement
        ).value,
        height = (form.elements.namedItem("viewportHeight") as HTMLInputElement)
          .value;
      const image = await api<ImageArtifact>("import-reference", {
        path,
        ...(width || height
          ? { viewport: { width: Number(width), height: Number(height) } }
          : {}),
      });
      referenceImage = image.id;
      referenceLoading = "";
      previewCompare = true;
      await loadReference();
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
    const control = event.target.closest<HTMLElement>("#approval summary, #approval button, .thinking-toggle");
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
  if (
    pane === "files" &&
    !overlay &&
    event.target !== editor &&
    filesView.handleKey(event)
  )
    return;
  if (key === "escape") {
    run(() => {
      if (drivePopOpen) {
        drivePopOpen = false;
        renderStatus();
        renderDrivePop();
        return;
      }
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
      if (pane === "log" && paneDetail !== null)
        return dispatch("log-back", {});
      if (pane) {
        return dispatch("close-panel", {});
      }
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
  if (ctrl && key === "b") {
    run(() => openPanel("log"));
    return;
  }
  if (ctrl && key === "g") {
    run(() => dispatch("follow", {}));
    return;
  }
  if (event.altKey && ["d", "o", "c", "v", "j", "t"].includes(key)) {
    run(() =>
      openPanel(
        (
          {
            d: "changes",
            o: "files",
            c: "context",
            v: "preview",
            j: "drive",
            t: "verification",
          } as Record<string, PaneName>
        )[key]!,
      ),
    );
    return;
  }
  if (event.altKey && key === "h") {
    run(() => openPanel("history"));
    return;
  }
  if (event.altKey && key === "enter" && pane) {
    run(() => dispatch("expand-panel", {}));
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
    run(() => (state!.activeTurnId && !pendingQuestion() ? undefined : submitText()));
    return;
  }
  if (
    key === "tab" &&
    !event.shiftKey &&
    event.target === editor &&
    !editor.value
  ) {
    // The model's suggested next prompt, when one shows; else Settings.
    const suggestion = nextSuggestion();
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
  if (
    (event.target as HTMLElement).id === "panel-resizer" &&
    ["arrowleft", "arrowright"].includes(key)
  ) {
    run(() => {
      const width =
        el("panel").getBoundingClientRect().width +
        (key === "arrowleft" ? 16 : -16);
      el("panel").style.setProperty("--panel-width", `${width}px`);
      return api("panel-width", { width });
    });
    return;
  }
  if (pane === "changes" && !field && (key === "[" || key === "]")) {
    run(() => dispatch("hunk", { direction: key === "[" ? -1 : 1 }));
    return;
  }
  if (pane && !field) {
    if (pane === "log" && paneDetail !== null && key === "tab") {
      run(() => dispatch("log-next", {}));
      return;
    }
    if (
      pane === "drive" &&
      state.drive?.status !== "completed" &&
      !state.drive?.protection?.trip &&
      (key === "p" || key === "s")
    ) {
      run(() =>
        api("drive-control", {
          control:
            key === "s"
              ? "stop"
              : ["running", "waiting"].includes(state!.drive?.status ?? "")
                ? "pause"
                : "resume",
        }),
      );
      return;
    }
    const rows = [
      ...el("panel").querySelectorAll<HTMLButtonElement>(".panel-row"),
    ];
    if (
      (key === "arrowdown" || key === "arrowup") &&
      rows.length &&
      pane !== "changes"
    ) {
      run(() => {
        paneIndex =
          (paneIndex + (key === "arrowdown" ? 1 : -1) + rows.length) %
          rows.length;
        rows.forEach((row, i) =>
          row.classList.toggle("selected", i === paneIndex),
        );
        rows[paneIndex]?.scrollIntoView({ block: "nearest" });
        if (pane === "verification") {
          paneSignature = "";
          renderPanels();
        }
      });
      return;
    }
    if (key === "enter" && rows[paneIndex]) {
      run(() => rows[paneIndex]!.click());
      return;
    }
    if ((key === "arrowleft" || key === "arrowright") && pane === "changes") {
      run(() => {
        paneIndex = Math.max(
          0,
          Math.min(
            changes.length - 1,
            paneIndex + (key === "arrowright" ? 1 : -1),
          ),
        );
        paneSignature = "";
        renderPanels();
      });
      return;
    }
    if ((key === "arrowleft" || key === "arrowright") && pane === "preview") {
      run(() => {
        const index = state!.artifacts.findIndex((a) => a.id === selectedImage),
          item = state!.artifacts[index + (key === "arrowright" ? 1 : -1)];
        if (item) return dispatch("select-image", { id: item.id });
      });
      return;
    }
  }
});
window.demesneInspect = () => ({
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
      "button,input,textarea,summary,[role=separator],.preview-canvas",
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
  fileView: filesView.inspect(),
  reviewScope,
  reviewMode,
  reviewPaths: changes.map((c) => c.path),
  referenceImage,
  previewCompare,
  previewFit,
  previewZoom,
  panelWidth: el("panel").getBoundingClientRect().width,
  previewGeometry: (() => {
    const canvas = el("panel").querySelector<HTMLElement>(".preview-canvas"),
      image = canvas?.querySelector<HTMLImageElement>("img");
    return canvas && image
      ? {
          left: canvas.scrollLeft,
          top: canvas.scrollTop,
          imageWidth: image.getBoundingClientRect().width,
          canvasWidth: canvas.clientWidth,
        }
      : null;
  })(),
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
  approvalDetailsOpen: el("approval").querySelector<HTMLDetailsElement>("details")?.open ?? false,
  questions: state?.questions.length,
  queue: state?.queue,
  pane,
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
  if (pane === "log") commandClocks();
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
  "panel",
  "close-panel",
  "expand-panel",
  "expand-turn",
  "jump-turn",
  "tool",
  "log-filter",
  "log-entry",
  "log-back",
  "change-file",
  "check-select",
  "check-output",
  "read-file",
  "file-back",
  "changes-live",
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
        "#status,header,.drive-pane,.drive-live,#drive-pop,#overlay[hidden],#completion[hidden],time,script,style,textarea",
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
      element.closest(".drive-pane, .drive-live, #drive-pop")
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
    checks = run
      ? verificationChecks().filter((check) => check.turnId === run.id)
      : [],
    surface =
      pane === "changes"
        ? "diff"
        : pane === "verification"
          ? "review"
          : (pane ?? "response");
  const panes: NonNullable<DriveObservation["panes"]> = [],
    scrollRegions: NonNullable<DriveObservation["scrollRegions"]> = [];
  for (const [element, name, scrollName] of [
    [el("stage"), "response", "response"],
    ...(pane && pane !== "drive"
      ? [[panelScroll(), surface, pane === "changes" ? "diff-code" : surface]]
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
      files: changes.map((c) => c.path).slice(0, 128),
      checks: checks.map((c) => String(c.id)).slice(0, 128),
      ...(pane === "changes" && changes[paneIndex]
        ? { item: changes[paneIndex]!.path }
        : pane === "verification" && checks[paneIndex]
          ? { item: String(checks[paneIndex]!.id) }
          : {}),
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
        if (pane !== "drive") pane = null;
        expanded.add(current.id);
        follow = false;
        readingHeld = false;
        renderPanels();
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
        if (action.target === "diff") {
          reviewScope = "turn";
          reviewMode = "diff";
        }
        await openPanel(
          action.target === "diff"
            ? "changes"
            : action.target === "checks"
              ? "verification"
              : "log",
          current.id,
        );
        if (action.target === "diff") await refreshChanges();
        if (action.item) {
          paneIndex =
            action.target === "diff"
              ? Math.max(
                  0,
                  changes.findIndex((file) => file.path === action.item),
                )
              : Math.max(
                  0,
                  verificationChecks().findIndex(
                    (check) => check.id === action.item,
                  ),
                );
          paneSignature = "";
          renderPanels();
        }
      }
      if (action.target === "checks") {
        const check = verificationChecks()[paneIndex];
        if (check && !check.id.startsWith("legacy:")) {
          await api("panel-watch", {
            panel: "verification",
            command: check.id,
          });
          await api("processes");
          const deadline = performance.now() + 3000;
          while (
            state?.session?.id === observation.sessionId &&
            state.processes.find((record) => record.id === check.id)
              ?.outputLoaded === false &&
            performance.now() < deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 16));
          const loaded = state?.processes.find(
            (record) => record.id === check.id,
          );
          if (!loaded || loaded.outputLoaded === false || state?.processesError)
            throw new Error(
              state?.processesError ??
                "Check output has not loaded. Inspect this check again.",
            );
          renderPanels();
        }
      }
      const scroll = pane ? panelScroll() : el("stage");
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
      const scroll =
        region.surface === "response" ? el("stage") : panelScroll();
      const before = scroll.scrollTop;
      scroll.scrollTop += action.amount * 18;
      result =
        before === scroll.scrollTop
          ? "Scroll did not move; boundary reached."
          : "Scrolled the visible view.";
    } else if (action.kind === "key") {
      const scroll = pane && pane !== "drive" ? panelScroll() : el("stage");
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
      } else if (action.key === "escape") await dispatch("close-panel", {});
      else if (action.key === "ctrl+g") await dispatch("follow", {});
      else if (action.key === "ctrl+b") await openPanel("log");
      else if (action.key === "alt+d") await openPanel("changes");
      else if (action.key === "alt+v") await openPanel("verification");
      else if (action.key === "alt+h") await openPanel("history");
      else if (action.key === "alt+enter" && pane)
        await dispatch("expand-panel", {});
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

let panelDrag: { startX: number; width: number } | null = null,
  previewDrag: {
    canvas: HTMLElement;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null = null;
document.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "panel-resizer") {
    event.preventDefault();
    panelDrag = {
      startX: event.clientX,
      width: el("panel").getBoundingClientRect().width,
    };
    target.setPointerCapture(event.pointerId);
  } else {
    const canvas = target.closest<HTMLElement>(".preview-canvas");
    if (canvas && event.button === 0) {
      event.preventDefault();
      previewDrag = {
        canvas,
        x: event.clientX,
        y: event.clientY,
        left: canvas.scrollLeft,
        top: canvas.scrollTop,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("panning");
    }
  }
});
document.addEventListener("pointermove", (event) => {
  if (panelDrag) {
    const width = Math.max(
      300,
      Math.min(
        innerWidth - 280,
        panelDrag.width + panelDrag.startX - event.clientX,
      ),
    );
    el("panel").style.setProperty("--panel-width", `${width}px`);
  }
  if (previewDrag) {
    previewDrag.canvas.scrollLeft =
      previewDrag.left + previewDrag.x - event.clientX;
    previewDrag.canvas.scrollTop =
      previewDrag.top + previewDrag.y - event.clientY;
  }
});
document.addEventListener("pointerup", () => {
  if (panelDrag) {
    panelDrag = null;
    void act(() =>
      api("panel-width", { width: el("panel").getBoundingClientRect().width }),
    );
  }
  previewDrag?.canvas.classList.remove("panning");
  previewDrag = null;
});
