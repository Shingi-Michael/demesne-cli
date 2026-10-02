import { FilesView } from "./files-view.ts";
import { sourceLocations } from "./file-navigation.ts";
import { markdown, MarkdownView } from "./markdown.ts";
import { StateReceiver, type StateUpdate } from "./state-wire.ts";
import { codeDiff } from "../cli/src/workbench/change-diff.ts";
import type { GraphicsHost } from "./host.ts";
import type { GraphicsRun, GraphicsChange } from "./session-model.ts";
import type {
  ToolEntry,
  WorkbenchEntry,
} from "../cli/src/workbench/entries.ts";
import type {
  ModelDescriptor,
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
  | "sessions"
  | "rename"
  | "confirm-archive"
  | "confirm-undo"
  | "help";
declare global {
  interface Window {
    demesne: {
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
const k = (key: string) => `<kbd>${h(key)}</kbd>`;
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
  overlayRows: {
    label: string;
    value: string;
    action: string;
    data: Record<string, unknown>;
    group?: string;
    hint?: string;
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
    c,
    last?.receipt?.tokensPerSecond,
    state.provider?.usage,
    state.provider?.metrics,
    state.workspace,
    state.session?.title,
    pane,
    state.session?.workspace?.gitBranch,
    state.activeTurnId
      ? Math.floor((Date.now() - Date.parse(state.session!.createdAt)) / 1000)
      : state.session?.createdAt,
    state.runs.length,
  ]);
  if (signature === statusSignature) return;
  statusSignature = signature;
  const speed =
    last?.receipt?.tokensPerSecond ??
    (state.provider?.usage?.outputTokens && state.provider.metrics?.durationMs
      ? state.provider.usage.outputTokens /
        (state.provider.metrics.durationMs / 1000)
      : null);
  el("status").innerHTML =
    `<span class="state ${phase === "failed" ? "danger" : phase === "approval" || phase === "waiting" ? "amber" : ""}"><img src="assets/${phase === "approval" || phase === "waiting" ? "activity-dot" : "ready-dot"}.svg" width="8" height="8" alt="">${h(phase)}</span><span>${h(state.model.id || "Connecting…")}</span>${state.runs.length ? `<span class="speed">${speed == null ? "—" : speed.toFixed(1)} tok/s</span>` : ""}${btn("panel", `<div class="context"><div class="meter"><i style="--usage:${Math.min(100, c.percentage ?? 0)}%"></i></div><span>${c.estimated ? "~" : ""}${num(c.used)} / ${num(c.capacity)}${c.percentage == null ? "" : ` · ${c.percentage}%`}</span></div>`, { name: "context" })}<div class="spacer"></div>${state.runs.length ? btn("panel", `${k("Ctrl+B")} log`, { name: "log" }, "key-action", true) + btn("follow", `${k("Ctrl+G")} live`, {}, "key-action", true) : btn("overlay", `${k("Tab")} settings`, { name: "settings" }, "key-action") + btn("insert-command", `${k("Ctrl+K")} commands`, {}, "key-action")}`;
  const workspace = state.workspace.replace(/^.*\/projects\//, "projects/");
  el("header").innerHTML =
    `<div class="identity"><strong>demesne</strong>${pane === "changes" && state.session ? `<span class="session-title">${h(state.session.title)}</span>` : ""}<span title="${h(state.workspace)}">${pane === "changes" ? "" : "· "}${h(workspace)}</span></div><div class="header-state">${state.session?.workspace?.gitBranch ? `<span>⎇ ${h(state.session.workspace.gitBranch)}</span>` : ""}${state.activeTurnId || state.approvals.length ? `<span class="pill ${state.approvals.length ? "approval" : "running"}">${state.approvals.length ? "approval" : "running"}</span>` : ""}${state.runs.length ? `<span class="age">${pane === "changes" ? clock(Date.now()).slice(0, 5) : `· ${duration(Date.now() - Date.parse(state.session!.createdAt))}`}</span>` : btn("panel", `${k("Alt+H")} history`, { name: "history" }, "key-action", true)}</div>`;
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
function toolRow(run: GraphicsRun, tool: ToolEntry) {
  const result =
    tool.name === "run_command" &&
    tool.input.background === true &&
    tool.state === "done"
      ? "background started"
      : tool.waiting
        ? "awaiting approval"
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
                ? ""
                : tool.state;
  return btn(
    "tool",
    `<span class="${tone(tool.state)}">${h(mark(tool.state))}</span><span class="verb">${h(verb(tool))}</span><span class="target" title="${h(tool.detail ?? tool.name)}">${h((tool.detail ?? tool.name).replace(/^\$\s*/, ""))}</span><span class="result ${tool.phase === "change" && tool.state === "done" ? "success" : "muted"}">${h(result)}</span>${tool.phase === "change" ? counts(totals(run, tool)) : ""}<span class="time">${tool.phase === "change" ? "open ▸" : duration(tool.durationMs)}</span>`,
    { runId: run.id, id: tool.id },
    `tool-row ${tool.state === "failed" ? "failed" : ""} ${tool.waiting ? "waiting" : ""}`,
    true,
  );
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
      `▸ Turn ${run.number} · <span class="${tone(run.status)}">${h(run.status)}</span> at ${clock(run.completedAt ?? run.createdAt).slice(0, 5)} · ${duration(run.receipt?.durationMs)} · ${files ? `${files} file${files === 1 ? "" : "s"} changed` : "no diff"} · <span class="muted">Ctrl+B log</span>`,
      { id: run.id },
      "folded-turn",
      true,
    );
  let body = "";
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i]!,
      key = `${run.id}:${entry.id}`;
    if (entry.type === "assistant")
      body += `<div class="markdown" data-answer="${h(run.id)}" data-entry="${entry.id}"></div>`;
    if (entry.type === "reasoning") {
      const live = active(run) && i === run.entries.length - 1;
      body += `<details class="thinking ${live ? "live" : ""}" data-detail="${key}"${(live && !detailsClosed.has(key)) || detailsOpen.has(key) ? " open" : ""}><summary>◇ ${live ? "Thinking" : "Thought"}${live ? '<img src="assets/thinking-dots.svg" alt="">' : ""} <span class="muted">${duration(entry.durationMs)}</span></summary><pre>${h(entry.raw)}</pre></details>`;
    }
    if (entry.type === "tool") {
      const group: ToolEntry[] = [entry];
      let j = i + 1;
      if (entry.phase === "inspect" && entry.state === "done" && !entry.waiting)
        while (j < run.entries.length) {
          const next = run.entries[j];
          if (
            next?.type !== "tool" ||
            next.phase !== "inspect" ||
            next.state !== "done" ||
            next.waiting
          )
            break;
          group.push(next);
          j++;
        }
      if (group.length >= 3) {
        const sum = group.reduce((n, t) => n + (t.durationMs ?? 0), 0);
        body += `<details class="explored" data-detail="${key}"${detailsOpen.has(key) ? " open" : ""}><summary>Explored · ${group.length} reads · ${duration(sum)}</summary><div>${group.map((tool) => toolRow(run, tool)).join("")}</div></details>`;
        i = j - 1;
      } else body += toolRow(run, entry);
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
  let footer = "";
  if (!active(run)) {
    const ctx = receipt?.context,
      percentage =
        ctx?.used != null && ctx.capacity
          ? Math.round((ctx.used / ctx.capacity) * 100)
          : null;
    const closed = run.entries.findLast(
      (e) => e.type === "notice" && e.closesTurn,
    );
    const error =
      run.status === "failed"
        ? `${closed?.type === "notice" ? closed.text : "Failed"}${run.entries.some((e) => e.type === "assistant") ? "" : " · no final response"}`
        : ["cancelled", "interrupted"].includes(run.status)
          ? `Stopped by you · ${items.filter((t) => t.state === "stopped").length} command${items.filter((t) => t.state === "stopped").length === 1 ? "" : "s"} interrupted`
          : "";
    const meta = `${receipt?.mode ?? (run.planOnly ? "Plan" : "Build")} · ${h(receipt?.model ?? state!.model.id)} · ${duration(receipt?.durationMs)} · ${receipt?.tokensPerSecond == null ? "—" : receipt.tokensPerSecond.toFixed(1)} tok/s · ctx ${percentage == null ? `${num(ctx?.used)}/${num(ctx?.capacity)}` : `${percentage}%`}`;
    footer = `<div class="turn-footer">${error ? `<span class="${run.status === "failed" ? "danger" : ""}">${run.status === "failed" ? "×" : "■"} ${h(error)}</span>` : `<span>${meta}</span>`}<span class="links">${error ? `<span>${meta}</span>` : ""}${btn("copy-answer", "copy", { id: run.id }, "copy-answer")}${files ? btn("panel", `${files} file${files === 1 ? "" : "s"} changed ▸`, { name: "changes", turnId: run.id }, "", true) : ""}${checks.length ? btn("panel", `${passed ? "✓" : failed ? "×" : stopped ? "■" : "·"} checks ${passed ? "passed" : failed ? "failed" : stopped ? "stopped" : "unknown"} ▸`, { name: "verification", turnId: run.id }, passed ? "success" : failed ? "danger" : "", true) : ""}${error ? btn("panel", "log ▸", { name: "log", turnId: run.id }, "", true) : ""}</span></div>`;
  }
  const latestTool = items.findLast(
      (tool) => tool.state === "running" || tool.waiting,
    ),
    phase = state!.questions.length
      ? "Waiting for your answer · "
      : latestTool?.waiting
        ? "Waiting for your approval · "
        : latestTool?.drafting
          ? "Drafting "
          : latestTool
            ? `${verb(latestTool)} `
            : "Thinking";
  const activity = active(run)
    ? `<div class="live-activity"><img src="assets/activity-dot.svg" width="8" height="8" alt="">${h(phase + (latestTool?.detail ?? "") + (latestTool ? "…" : "…"))}</div>`
    : "";
  return `<div class="request"><span class="mark">▶</span><span class="text">${h(run.content)}</span><time>${clock(run.createdAt).slice(0, 5)}</time></div><div class="response ${active(run) ? "running" : run.status === "failed" ? "failed" : ""}"><div class="speaker"><span>demesne</span><time>${clock(run.entries.find((e) => e.type === "assistant")?.type === "assistant" ? (run.entries.find((e) => e.type === "assistant") as any).at : run.createdAt)}${active(run) ? " · live" : ""}</time></div>${body}${footer}${activity}</div>`;
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
      saved.views.get(entry.id)!.update(entry.raw);
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
        view.update(entry.raw);
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
function renderHero() {
  if (!state) return;
  const recent = state.sessions
      .filter(
        (session) => session.turns > 0 && session.id !== state!.session?.id,
      )
      .slice(0, 3),
    signature = JSON.stringify([recent, state.model, state.planOnly]);
  if (signature === heroSignature) return;
  heroSignature = signature;
  const composer = el("composer-slot");
  composer.remove();
  el("hero").innerHTML =
    `<div class="intro"><h1>What are we working on?</h1><p>${h(state.model.id || "Choose a model")} · ctx ${num(state.model.contextWindow)} · ${state.planOnly ? "Plan" : "Build"} mode</p></div><div id="hero-composer"></div><section class="operations"><h2>START FROM</h2><div class="grid">${[
      ["Explore", "Trace a call flow end to end"],
      ["Debug", "Find and fix a failing behavior"],
      ["Build", "Implement a feature with tests"],
      ["Learn", "Map the architecture"],
    ]
      .map(([label, prompt], i) =>
        btn(
          "operation",
          `<span>${i + 1}</span><b>${label}</b><small>${prompt}</small>`,
          { text: prompt },
          `operation ${i === 0 ? "selected" : ""}`,
          true,
        ),
      )
      .join(
        "",
      )}</div></section><section class="recent"><h2>RECENT</h2><div class="list">${recent.length ? recent.map((session) => btn("select-session", `<span class="${tone(session.status ?? "")}">${mark(session.status ?? "")}</span><b>${h(session.title)}</b><span class="meta">${session.turns} turns · ${h(session.status ?? "")}</span><small>${age(session.updatedAt)}</small>`, { id: session.id })).join("") : '<div class="empty">Your sessions will appear here.</div>'}</div><p class="recent-footer">${btn("overlay", "Alt+H all sessions", { name: "sessions" }, "", true)} · /resume &lt;name&gt;</p></section>`;
  el("hero-composer").append(composer);
}
let composerSignature = "",
  composerFiles: Snapshot["files"] | null = null,
  composerWidth = 0;
function renderComposer() {
  if (!state) return;
  const width = editor.clientWidth;
  const signature = JSON.stringify([
    editor.value,
    Boolean(state.activeTurnId),
    state.restored,
    Date.now() < stopArmed,
    state.runs.length > 0,
    state.connection,
    state.busy,
    state.approvals.length,
    state.questions.length,
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
    queued = Boolean(state.activeTurnId && editor.value.trim());
  form.classList.toggle("queued", queued);
  form.classList.toggle("restored", state.restored);
  form.classList.toggle("stop-armed", Date.now() < stopArmed);
  el("queue-label").hidden = !queued && !state.restored;
  el("queue-label").innerHTML =
    `<span>${queued ? 'Queued <span class="muted">sends when this turn completes</span>' : 'Restored · not sent <span class="muted">the turn did not finish</span>'}</span>${btn("clear-queue", "Clear ×")}`;
  editor.placeholder = state.runs.length
    ? state.activeTurnId
      ? "Type to queue a follow-up…"
      : "Continue the conversation…"
    : "Describe what you want to build, fix, or explore…";
  editor.disabled =
    state.connection !== "online" ||
    state.busy ||
    state.approvals.length > 0 ||
    state.questions.length > 0;
  el("composer-slot").hidden =
    state.approvals.length > 0 || state.questions.length > 0;
  el("send-label").innerHTML = state.activeTurnId
    ? Date.now() < stopArmed
      ? `Press ${k("Esc")} again to stop`
      : `${k("Esc Esc")} stop`
    : "send";
  (form.querySelector(".send") as HTMLButtonElement).disabled =
    state.connection !== "online" || state.busy;
  form.querySelector<HTMLElement>(".send>kbd")!.hidden = Boolean(
    state.activeTurnId,
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
    run = state.runs.find((run) => run.id === approval.turnId);
  el("approval").innerHTML =
    `<div class="approval-card"><div class="approval-title"><span class="amber">!</span> Allow this ${approval.name === "run_command" ? "command" : "action"}?<small>${h(approval.name)} · Turn ${run?.number ?? "—"}</small></div><p class="approval-description">${h(approval.summary)}</p><div class="command-inset"><pre>${approval.name === "run_command" ? "$ " : ""}${h(command)}</pre><small>in ${h(approval.input.cwd ?? state.workspace)}${approval.name === "run_command" ? ' · <span class="amber">runs on your machine, not sandboxed</span>' : ""}</small></div><div class="approval-actions">${btn("permission", `${k("y")} Allow once`, { id: approval.id, decision: "allow_once" })}${btn("permission", `${k("n")} Deny`, { id: approval.id, decision: "deny" }, "deny")}${approval.name !== "run_command" ? btn("permission", "a &nbsp; allow this session", { id: approval.id, decision: "allow_session" }, "quiet") : ""}${approval.rule ? btn("permission", "s &nbsp; always allow", { id: approval.id, decision: "allow_always" }, "quiet") : ""}</div></div>`;
}
function renderQuestion() {
  if (!state) return;
  const question = state.questions[0],
    signature = JSON.stringify(question);
  if (signature === questionSignature) return;
  questionSignature = signature;
  el("question").innerHTML = question
    ? `<form id="question-form" class="question-card" data-id="${h(question.id)}"><div class="approval-title"><span class="amber">?</span> A question before continuing</div>${question.questions.map((item, i) => `<fieldset><legend>${h(item.question)}</legend>${item.reason ? `<p class="muted">${h(item.reason)}</p>` : ""}<div class="suggestions">${item.suggestions.map((value) => btn("suggest-answer", h(value), { index: i, value })).join("")}</div><input name="${i}" aria-label="${h(item.question)}" autocomplete="off"></fieldset>`).join("")}<button type="submit">${k("↵")} Answer</button></form>`
    : "";
}
function selectedRun() {
  if (pane === "verification" && !paneTurn) {
    const check = verificationChecks()[paneIndex];
    if (check) return state?.runs.find((run) => run.id === check.turnId);
  }
  return state?.runs.find((run) => run.id === paneTurn) ?? state?.runs.at(-1);
}
function panelHeader(label: string, subject = "", meta = "") {
  return `<div class="panel-heading"><span class="label">${label}</span><span class="subject">${h(subject)}</span><span class="meta">${meta}</span>${btn("close-panel", "×", {}, "", true)}</div>`;
}
function panelFooter(hints: string, extra = "") {
  return `<div class="panel-footer">${hints}${btn("close-panel", `${k("Esc")} close`, {}, "", true)}<span class="right">${extra}</span></div>`;
}
const filesView = new FilesView({
  request: api,
  attach: (text) =>
    setDraft(editor.value + (editor.value ? "\n\n" : "") + text + "\n\n"),
  insert: (path) => {
    void dispatch("insert-file", { path });
  },
  changed: () => reportObservation(),
  manual: () => {
    if (state?.drive && ["running", "waiting"].includes(state.drive.status))
      void api("manual");
  },
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
function driveBody() {
  const drive = state!.drive;
  if (!drive)
    return `<div class="drive-content"><h3>Give Drive a mission</h3><p class="muted">Drive reads the session, directs work, and reviews the results. Tool approvals remain yours.</p><form id="drive-form"><input name="mission" placeholder="What should Drive finish?" aria-label="Drive mission" required><label class="drive-mode"><input type="checkbox" name="continuous"> Keep choosing improvements</label><button type="submit" class="chip">Start Drive</button></form></div>`;
  const retry = drive.recovery && drive.recovery.retryAt > Date.now(),
    label = retry
      ? `↻ Retrying in ${Math.ceil((drive.recovery!.retryAt - Date.now()) / 1000)}s`
      : drive.protection?.trip
        ? "■ Stopped at a limit"
        : drive.status === "paused"
          ? "‖ Paused by you"
          : drive.status === "blocked"
            ? "× Blocked · needs you"
            : drive.status === "completed"
              ? "✓ Mission complete"
              : drive.status === "waiting"
                ? "◌ Coder is working"
                : drive.status === "stopped"
                  ? "■ Stopped"
                  : drive.status === "idle"
                    ? "Idle"
                    : "✓ Keep working";
  const trace = drive.traces?.at(-1);
  const taskRecords = Array.isArray(drive.ledger?.tasks)
    ? drive.ledger.tasks.filter(
        (task) =>
          task &&
          typeof task.id === "string" &&
          Array.isArray(task.criteria) &&
          Array.isArray(task.completions),
      )
    : [];
  const ledger =
    taskRecords
      .map(
        (task) =>
          `<details data-detail="drive-task-${h(task.id)}"${detailsOpen.has(`drive-task-${task.id}`) ? " open" : ""}><summary>${task.status === "completed" ? "✓" : "◌"} ${h(task.id.slice(0, 8))} · ${h(task.title)}</summary><div class="panel-note">${task.criteria.map((criterion) => `· ${h(criterion)}`).join("<br>")}${task.reopened ? `<br>Reopened: ${h(task.reopened.reason)}` : ""}${task.completions.at(-1) ? `<br>${h(task.completions.at(-1)!.summary)}<br>${task.completions.at(-1)!.files.length} files · ${task.completions.at(-1)!.checks.length} checks recorded` : ""}</div></details>`,
      )
      .join("") ?? "";
  return `<div class="drive-content"><div class="verdict ${retry ? "retrying" : drive.status}"><h3>${h(label)}</h3><p>${h(drive.protection?.trip?.reason ?? drive.activity)}</p></div><div class="panel-note">${drive.mode === "continuous" ? "Continuous · select unfinished work, then idle" : "Bounded · finish after verification"}</div>${ledger ? `<div><div class="muted">RECORDED TASKS</div>${ledger}<div class="panel-note">Reopen with /drive reopen &lt;task-id&gt; &lt;reason&gt;</div></div>` : ""}${!ledger && (drive.remaining.length || drive.completed.length) ? `<div><div class="muted">TASKS</div>${drive.completed.map((item) => `<div>✓ ${h(item)}</div>`).join("")}${drive.remaining.map((item) => `<div class="muted">· ${h(item)}</div>`).join("")}</div>` : ""}<div class="drive-meta">Step ${drive.step} · ${age(drive.updatedAt)}<br>${h(drive.model ?? state!.model.id)}${trace?.usage?.totalTokens != null ? ` · ${num(trace.usage.totalTokens)} tokens` : ""}</div><details data-detail="drive-reasoning"${detailsOpen.has("drive-reasoning") ? " open" : ""}><summary>Show reasoning</summary><pre>${h(trace?.reasoning || "No reasoning recorded.")}</pre></details><details data-detail="drive-raw"${detailsOpen.has("drive-raw") ? " open" : ""}><summary>Raw output</summary><pre>${h(trace?.text || trace?.action || "No output recorded.")}</pre></details><details data-detail="drive-constraints"${detailsOpen.has("drive-constraints") ? " open" : ""}><summary>Constraints carried</summary><pre>${h(drive.mission + "\n\n" + drive.notes)}</pre></details></div>`;
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
    density = window.devicePixelRatio || 1;
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
let railSignature = "";
function renderPanels() {
  if (!state) return;
  if (pointerHeld) {
    pendingPanelRender = true;
    return;
  }
  renderStatus();
  el("panel").hidden = !pane;
  el("rail").hidden =
    Boolean(pane && pane !== "changes") || state.runs.length === 0;
  const railHTML = `<span class="rail-state ${state.activeTurnId ? "running" : ""}"></span><hr>${(
    [
      ["files", "≡", "Files"],
      ["changes", "╪", "Changes"],
      ["verification", "✓", "Verification"],
      ["preview", "▣", "Preview"],
      ["drive", "▷", "Agent Drive"],
      ["history", "◷", "History"],
      ["context", "◉", "Context"],
    ] as const
  )
    .map(
      ([name, icon, label]) =>
        `<button type="button" class="${pane === name ? "active" : ""}" title="${label}" aria-label="${label}" data-action="panel" data-args="${h(JSON.stringify({ name }))}" data-drive="panel-${name}">${icon}${name === "drive" && state!.drive && ["running", "waiting", "blocked"].includes(state!.drive.status) ? '<img class="dot" src="assets/rail-badge.svg" alt="">' : ""}</button>`,
    )
    .join("")}`;
  if (railHTML !== railSignature) {
    railSignature = railHTML;
    el("rail").innerHTML = railHTML;
  }
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
          ]
        : pane === "context"
          ? [state.provider, state.checkpoint, state.activeTurnId]
          : pane === "drive"
            ? state.drive
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
    const changed = state.files.filter((file) => file.status?.trim());
    header = panelHeader(
      "FILES",
      state.workspace,
      `${state.files.length} files · ${changed.length} changed`,
    );
    body = '<div id="files-mount"></div>';
    footer = `<div class="panel-footer">${k("Ctrl+F")} find ${k("Ctrl+L")} line ${k("Esc")} back/close ${btn("close-panel", "Close", {}, "right", true)}</div>`;
  }

  if (pane === "history") {
    header = panelHeader(
      "HISTORY",
      state.session?.title ?? "Sessions",
      `${state.runs.length} turns`,
    );
    body = `<div class="panel-section">THIS SESSION <span>newest first</span></div>${[
      ...state.runs,
    ]
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
      .join(
        "",
      )}<div class="panel-section">RECENT SESSIONS <span>/sessions for all</span></div>${state.sessions
      .filter((item) => item.id !== state!.session?.id && item.turns > 0)
      .slice(0, 12)
      .map((item) =>
        btn(
          "select-session",
          `<span class="muted">→</span><span class="name">${h(item.title)}</span><span class="right">${item.turns} turns &nbsp; ${age(item.updatedAt)}</span>`,
          { id: item.id },
          "panel-row",
          true,
        ),
      )
      .join("")}`;
    footer = panelFooter(`${k("↑↓")} select ${k("Enter")} jump to turn`);
  }
  if (pane === "context") {
    header = panelHeader(
      "CONTEXT",
      `${state.model.id} · ${state.model.provider}`,
      run ? `Turn ${run.number}` : "",
    );
    body = contextBody();
    footer = panelFooter(
      `${k("↑↓")} scroll`,
      btn("compact", "/compact to free space"),
    );
  }
  if (pane === "log") {
    header = panelHeader(
      "EXECUTION LOG",
      run ? `Turn ${run.number}` : "",
      run
        ? `${logRecords(run).length} events · ${duration(run.receipt?.durationMs)}`
        : "",
    );
    if (commandTab === "running")
      header = panelHeader(
        "COMMANDS",
        state.session?.title ?? "Session",
        `${state.processes.filter((command) => ["running", "stopping"].includes(command.status)).length} running`,
      );
    body =
      `<div class="panel-tabs">${btn("command-tab", "Events", { tab: "events" }, commandTab === "events" ? "selected" : "")}${btn("command-tab", `Commands ${state.processes.filter((command) => ["running", "stopping"].includes(command.status)).length ? "●" : ""}`, { tab: "running" }, commandTab === "running" ? "selected" : "")}${btn("refresh-processes", "↻", {}, "right")}</div>` +
      (commandTab === "running"
        ? commandsBody()
        : run
          ? logBody(run)
          : '<div class="empty">No recorded events.</div>');
    footer = panelFooter(`${k("↑↓")} select ${k("Enter")} open`);
    if (commandTab === "events" && run && paneDetail !== null) {
      const all = logRecords(run),
        index = all.findIndex((entry) => entry.id === paneDetail);
      header = `<div class="panel-heading">${btn("log-back", "‹ Log", {}, "electric", true)}<span class="muted">event ${index + 1} of ${all.length}</span><span class="meta">Turn ${run.number}</span></div>`;
      footer = `<div class="panel-footer">${k("↑↓")} scroll ${btn("log-next", `${k("Tab")} next event`, {}, "", true)} ${btn("log-back", `${k("Esc")} back`, {}, "", true)}</div>`;
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
      );
    header = panelHeader(
      "CHANGES",
      reviewScope === "turn"
        ? run
          ? `Turn ${run.number}`
          : ""
        : reviewScope === "session"
          ? "Whole session"
          : "Workspace vs HEAD",
      btn(
        "expand-panel",
        `${k("Alt+↵")} ${paneExpanded ? "restore" : "expand"}`,
      ),
    );
    const tabs = `<div class="panel-tabs">${(["turn", "session", "workspace"] as const).map((scope) => btn("review-scope", scope === "turn" ? "This turn" : scope === "session" ? "Session" : "Workspace", { scope }, scope === reviewScope ? "selected" : "")).join("")}${btn("refresh-review", "↻ Refresh", {}, "right")}</div>`;
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
    body =
      tabs +
      (reviewError
        ? `<div class="panel-error">${h(reviewError)} ${btn("refresh-review", "Retry")}</div>`
        : "") +
      `<div class="summary-line"><span>${changes.length} files ${counts(total)}</span><span class="muted">${reviewBusy ? "Refreshing…" : reviewMeta ? `as of ${clock(reviewMeta.capturedAt)}` : ""}</span></div><div class="file-list">${changes.map((file, index) => btn("change-file", `<span class="${file.state === "applied" ? "success" : "muted"}">${file.state === "applied" ? "✓" : "·"}</span><span class="name">${pathHTML(file.path)}</span><span class="right">${h(file.state)}</span>${counts(file)}`, { index }, `panel-row ${index === paneIndex ? "selected" : ""}`, true)).join("")}</div>${file ? `<div class="file-header"><strong>${h(file.path)}</strong><span class="muted">${h(file.state)}</span>${counts(file)}</div><div class="panel-actions">${(["diff", "before", "after"] as const).map((mode) => btn("review-mode", mode === "diff" ? "Diff" : mode === "before" ? "Full before" : "Full after", { mode }, reviewMode === mode ? "selected" : "")).join("")}${btn("review-current", "Open current", { path: file.path })}${file.undo?.available ? btn("review-undo", "Undo file", { path: file.path, turnId: file.undo.turnId }, "danger") : ""}</div>${file.undo && !file.undo.available ? `<div class="panel-note">Undo unavailable: ${h(file.undo.reason)}</div>` : ""}<div class="diff-code">${file.unavailable && reviewMode === "diff" ? `<div class="empty">${h(file.unavailable)}</div>` : code}</div>` : '<div class="empty">No changes in this scope.</div>'}<div class="panel-note">${h(reviewMeta?.description ?? "")}${reviewMeta?.truncated ? " · Some diff content is omitted." : ""}</div>`;
    footer = panelFooter(
      `${k("←→")} files ${btn("hunk", `${k("[")} previous`, { direction: -1 })} ${btn("hunk", `${k("]")} next change`, { direction: 1 })}`,
      btn("changes-live", `${k("Ctrl+G")} live`, {}, "", true),
    );
  }
  if (pane === "verification") {
    const checks = verificationChecks(),
      selected = checks[Math.min(paneIndex, Math.max(0, checks.length - 1))],
      overall = verificationOverall(checks);
    header = panelHeader(
      "VERIFICATION",
      paneTurn && run ? `Turn ${run.number}` : "Session checks",
      `<span class="pill ${overall === "failed" ? "failed" : ""}">${overall}</span>`,
    );
    body =
      processError() +
      `<div class="panel-actions">${btn("refresh-processes", "↻ Refresh")}${btn("rerun-failed", "Rerun failed", {}, "", false, Boolean(state.activeTurnId || state.processes.some((c) => ["running", "stopping"].includes(c.status)) || !checks.some((c) => c.status === "failed")))}<span class="muted">${state.checkQueue.length ? `${state.checkQueue.length} queued` : ""}</span></div>` +
      checks
        .map((check, index) =>
          btn(
            "check-select",
            `<span class="${checkLabel(check) === "passed" ? "success" : checkLabel(check) === "failed" ? "danger" : "amber"}">${checkLabel(check) === "passed" ? "✓" : checkLabel(check) === "running" ? "◌" : "·"}</span><span class="name">${h(check.argv.join(" "))}</span><span class="right">${checkLabel(check)}</span>`,
            { index },
            `panel-row ${index === paneIndex ? "selected" : ""}`,
            true,
          ),
        )
        .join("") +
      (selected
        ? `<div class="panel-detail"><div class="panel-note">${h(selected.cwd)}<br>${selected.completedAt ? `Ran ${clock(selected.completedAt)} · exit ${selected.exitCode ?? "—"}` : "Running…"}${selected.freshnessReason ? `<br>${h(selected.freshnessReason)}` : ""}</div><div class="panel-actions">${btn("command-open", "Open output", { id: selected.id }, "", true)}${selected.id.startsWith("legacy:") ? "" : btn("rerun-check", "Rerun this check", { id: selected.id }, "", false, Boolean(state.activeTurnId || state.processes.some((c) => ["running", "stopping"].includes(c.status))))}</div><pre class="output">${outputHTML((selected.stdout + "\n" + selected.stderr).trim().split("\n").slice(-20).join("\n") || (selected.outputLoaded === false ? "Loading recorded output…" : "No recorded output."), selected.cwd)}</pre>${selected.truncated ? '<small class="muted">Output is a bounded excerpt.</small>' : ""}</div>`
        : '<div class="empty">Not run — no verification commands have been recorded.</div>') +
      `<div class="panel-note">Freshness covers ${h(state.verificationFingerprint?.scope ?? "source files")}. ${state.verificationFingerprint?.reason ? h(state.verificationFingerprint.reason) : "Results become outdated when these files change."}</div>`;
    footer = panelFooter(
      `${k("↑↓")} select ${btn("check-output", `${k("Enter")} output`, {}, "", true)}`,
    );
  }
  if (pane === "preview") {
    const item = state.artifacts.find((image) => image.id === selectedImage),
      reference = state.artifacts.find((image) => image.id === referenceImage);
    header = panelHeader(
      "PREVIEW",
      previewPinned
        ? "pinned"
        : followImages
          ? "following new images"
          : "browsing history",
      item ? `${item.width} × ${item.height} px` : "",
    );
    body =
      `<div class="panel-actions">${btn("preview-fit", "Fit", {}, previewFit ? "selected" : "")}${btn("preview-zoom", "100%", { zoom: 1 }, !previewFit && previewZoom === 1 ? "selected" : "")}${btn("preview-zoom", "−", { step: -0.25 })}${btn("preview-zoom", "+", { step: 0.25 })}${btn("preview-compare", previewCompare ? "Hide comparison" : "Compare", {}, previewCompare ? "selected" : "")}</div>` +
      (item
        ? `<div class="panel-detail"><span>${h(item.filename)}</span><small class="muted">Recorded ${clock(item.createdAt)} · ${item.width} × ${item.height} image pixels · ${item.viewport ? `${item.viewport.width} × ${item.viewport.height} viewport` : "viewport not recorded"}</small></div><div class="preview-canvas" tabindex="0"><div class="preview-plane"><img class="preview-current" src="${h(previewData)}" alt="${h(item.filename)}" draggable="false">${previewCompare && referenceData ? `<img class="preview-reference" src="${h(referenceData)}" alt="Reference: ${h(reference?.filename)}" draggable="false">` : ""}</div></div>${previewCompare ? `<div class="compare-controls"><label>Reference opacity <input aria-label="Reference opacity" type="range" min="0" max="100" value="${previewOpacity}" id="reference-opacity"></label><span>${h(reference?.filename ?? "Choose a reference below")}${reference ? ` · ${reference.width} × ${reference.height} px · ${reference.viewport ? `${reference.viewport.width} × ${reference.viewport.height} viewport` : "viewport not recorded"}` : ""}</span></div>${reference && (reference.width !== item.width || reference.height !== item.height) ? '<div class="panel-note amber">Different image dimensions. Both are aligned at the top left; neither is stretched.</div>' : ""}` : ""}<div class="preview-actions">${btn("pin-image", previewPinned ? "Unpin" : "Pin")}${btn("expand-panel", paneExpanded ? "Restore" : "Expand")}${btn("open-image", "Open original")}</div>`
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
    footer = panelFooter(
      `${k("←→")} images · drag to pan`,
      btn("follow-images", "Follow new images"),
    );
  }
  if (pane === "drive") {
    header = panelHeader(
      "AGENT DRIVE",
      "",
      h(
        state.drive?.status === "running"
          ? "live"
          : (state.drive?.status ?? "idle"),
      ),
    );
    body = driveBody();
    const status = state.drive?.status;
    footer = panelFooter(
      `${state.drive && status !== "completed" && !state.drive.protection?.trip ? btn("drive-control", `${k("P")} ${status === "running" || status === "waiting" ? "pause" : "resume"}`, { control: status === "running" || status === "waiting" ? "pause" : "resume" }) + btn("drive-control", `${k("S")} stop`, { control: "stop" }) : ""}`,
    );
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
  if (name === "models") {
    const result = await act(() => api<ModelDescriptor[]>("models"));
    if (Array.isArray(result)) models = result;
    overlaySignature = "";
    renderOverlay();
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
    state.sessions,
    models,
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
    footerNote = "Tab or Ctrl+K opens this";
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
        value: state.model.id,
        group: "SESSION",
        action: "overlay",
        data: { name: "models" },
        hint: "/model",
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
        label: "All commands",
        value: `${state.commands.length} commands`,
        group: "NAVIGATE",
        action: "insert-command",
        data: {},
        hint: "/",
      },
      {
        label: "Provider setup",
        value: state.model.provider,
        group: "CONNECTION",
        action: "setup",
        data: {},
        hint: "setup",
      },
    ];
  } else if (overlay === "models") {
    title = "Switch model";
    subtitle = `current: ${state.model.id}`;
    noun = "models";
    footerNote = "Tab next group";
    overlayRows = [...models]
      .sort((a, b) => a.provider.localeCompare(b.provider))
      .map((model) => ({
        label: model.id,
        value: [
          model.contextWindow
            ? `${num(model.contextWindow)} ctx`
            : "context unknown",
          model.maxOutputTokens ? `${num(model.maxOutputTokens)} out` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        group: model.provider.toUpperCase(),
        action: "model",
        data: { id: model.id },
        hint: model.id === state!.model.id ? "● current" : "",
      }));
  } else if (overlay === "themes") {
    title = "Theme";
    subtitle = "this session";
    noun = "themes";
    overlayRows = state.themes.map((name) => ({
      label: name,
      value: name === state!.theme ? "current" : "",
      action: "theme",
      data: { name },
      group:
        name.includes("light") ||
        name.includes("latte") ||
        name === "github-light"
          ? "LIGHT"
          : "DARK",
    }));
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
  const allCount = overlayRows.length;
  if (overlayQuery)
    overlayRows = overlayRows.filter((row) =>
      `${row.label} ${row.value} ${row.group ?? ""}`
        .toLowerCase()
        .includes(overlayQuery.toLowerCase()),
    );
  overlayIndex = Math.min(overlayIndex, Math.max(0, overlayRows.length - 1));
  let lastGroup = "";
  const rows = overlayRows
    .map((row, index) => {
      const group =
        row.group && row.group !== lastGroup
          ? `<div class="section-label">${h(row.group)}${overlay !== "settings" ? `<span>${overlayRows.filter((item) => item.group === row.group).length}</span>` : ""}</div>`
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
        )
      );
    })
    .join("");
  el("overlay").innerHTML =
    `<div class="modal-title">${title} <span>${h(subtitle)}</span>${noun ? `<small>${overlayQuery ? `${overlayRows.length} of ` : ""}${allCount} ${noun}</small>` : ""}</div>${filter ? `<div class="filter-wrap"><input id="chooser-filter" placeholder="filter" aria-label="Filter ${title}" value="${h(overlayQuery)}" autocomplete="off"></div>` : ""}<div class="menu-list">${rows || '<div class="empty">No matches.</div>'}</div><div class="menu-footer">${k("↑↓")} select ${k("↵")} ${overlay === "models" ? "switch" : "change"} ${btn("close-overlay", `${k("Esc")} cancel`)}<span class="right">${footerNote}</span></div>`;
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
    if (command.argument === "none") {
      editor.value = "";
      completionDismissed = true;
      el("completion").hidden = true;
      await submitText(item.value);
    } else setDraft(`${item.value} `);
  }
}
async function submitText(value = editor.value) {
  if (!state || !value.trim()) return;
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
    if (id === "theme") {
      if (argument) await api("theme", { name: argument });
      else await openOverlay("themes");
      clear();
      return;
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
      await openPanel("drive");
      if (argument) await api("drive", { text: argument });
      clear();
      return;
    }
    if (id === "plan") {
      if (!argument) {
        notice("Usage: /plan <prompt>");
        return;
      }
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
  await api("submit", { text: value });
}
async function dispatch(
  action: string,
  args: Record<string, any>,
  target?: HTMLElement,
) {
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
  if (action === "operation") return setDraft(String(args.text));
  if (action === "panel") return openPanel(args.name, args.turnId ?? "");
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
          .map((e) => (e as any).raw)
          .join("\n\n") ?? "",
    });
    notice("Copied");
    return;
  }
  if (action === "suggest-answer") {
    const input = el("question").querySelectorAll("input")[args.index];
    if (input) {
      input.value = args.value;
      input.dataset.source = "suggestion";
    }
    return;
  }
  if (
    action === "mode" ||
    action === "model" ||
    action === "theme" ||
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
  if (
    [
      "permission",
      "cancel",
      "clear-queue",
      "compact",
      "connect",
      "start-daemon",
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
  if (lastDraftVersion !== next.draftVersion) {
    lastDraftVersion = next.draftVersion;
    editor.value = next.draft;
  }
  if (renderedPalette !== next.palette) {
    for (const [name, color] of Object.entries(next.palette))
      document.documentElement.style.setProperty(`--${name}`, color);
    renderedPalette = next.palette;
  }
  const start = !next.runs.length;
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
  renderPanels();
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
  const message =
    next.error ??
    (next.connection === "connecting" ? "Connecting to the daemon…" : "");
  const bannerKey = JSON.stringify([message, next.connection]);
  if (bannerKey !== bannerSignature) {
    bannerSignature = bannerKey;
    el("banner").hidden = !message;
    el("banner").innerHTML =
      `${h(message)}${next.connection === "offline" ? ` ${btn("connect", "Retry")} ${btn("start-daemon", "Start daemon")} ${btn("setup", "Setup")}` : ""}`;
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
  if (state?.drive && ["running", "waiting"].includes(state.drive.status))
    void api("manual");
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
  if (input.closest("#question")) input.dataset.source = "typed";
  if (input.closest("#setup")) setupInput(input);
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  void act(async () => {
    if (form.id === "composer") {
      if (state?.activeTurnId) {
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
    if (form.id === "question-form") {
      const inputs = [...form.querySelectorAll("input")];
      await api("answer", {
        id: form.dataset.id,
        answers: inputs.map((input) => ({
          answer: input.value.trim() || null,
          source: input.value.trim()
            ? (input.dataset.source ?? "typed")
            : "skipped",
        })),
      });
    }
    if (form.id === "drive-form")
      await api("drive", {
        text: `${(form.elements.namedItem("continuous") as HTMLInputElement)?.checked ? "--continuous " : ""}${(form.elements.namedItem("mission") as HTMLInputElement).value}`,
      });
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
el("stage").addEventListener(
  "wheel",
  () => {
    readingHeld = true;
    follow = false;
  },
  { passive: true },
);
el("stage").addEventListener("scroll", () => {
  if (!driveNavigating) {
    const stage = el("stage");
    follow = stage.scrollHeight - stage.clientHeight - stage.scrollTop < 24;
    if (follow) readingHeld = false;
  }
  reportObservation();
});
document.addEventListener("scroll", () => reportObservation(), true);
document.addEventListener("keydown", (event) => {
  if (!state || event.isComposing) return;
  const field =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement;
  const key = event.key.toLowerCase(),
    ctrl = event.ctrlKey || event.metaKey;
  if (
    state.drive &&
    ["running", "waiting"].includes(state.drive.status) &&
    !["shift", "control", "alt", "meta"].includes(key)
  )
    void api("manual");
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
    run(() => (state!.activeTurnId ? undefined : submitText()));
    return;
  }
  if (
    key === "tab" &&
    !event.shiftKey &&
    event.target === editor &&
    !editor.value
  ) {
    run(() => openOverlay("settings"));
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
  controls: [
    ...document.querySelectorAll<HTMLElement>(
      "button,input,textarea,[role=separator],.preview-canvas",
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
  sessionId: state?.session?.id,
  activeTurnId: state?.activeTurnId,
  runs: state?.runs.map((run) => ({
    id: run.id,
    status: run.status,
    entries: run.entries.length,
  })),
  approvals: state?.approvals.length,
  questions: state?.questions.length,
  queue: state?.queue,
  pane,
  overlay,
  setup: state?.setup,
  drive: state?.drive?.status,
  driveMode: state?.drive?.mode,
  drivePhase: state?.drive?.autonomy?.phase,
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
  el("status").hidden = Boolean(setup);
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
  const stepIndex = ["provider", "custom", "auth"].includes(step)
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
        "custom",
      ] as const;
    body = `<h1>Where should demesne run its model?</h1><p>${probes.filter((p) => p.reachable).length ? `Found ${probes.filter((p) => p.reachable).length} local server${probes.filter((p) => p.reachable).length === 1 ? "" : "s"}.` : "No local servers detected."} You can change this later with demesne setup.</p>${list(options.map((option, index) => (typeof option === "string" ? row(index, option === "openrouter" ? "OpenRouter" : "Custom URL", option === "openrouter" ? "Hosted models · sign in with your browser" : "Any OpenAI-compatible endpoint", "", index === setup.providerIndex) : row(index, h(option.target.label), `${h(option.target.url)} · ${option.reachable ? `${option.models.length} models` : "not reachable"}`, option.reachable ? '<span class="muted">detected</span>' : "", index === setup.providerIndex))))}<p class="setup-note">${setup.probes === null ? "Checking local servers…" : "Unreachable servers stay listed so you can start them and press r to rescan."}</p>`;
    left = `${k("↑↓")} choose ${button("r", `${k("r")} rescan`)} ${button("escape", `${k("Esc")} quit`)}`;
  }
  if (step === "model") {
    const models = setup.provider?.models ?? [],
      largest = Math.max(...models.map((m) => m.contextWindow ?? 0)),
      recommended = models.findIndex((m) => (m.contextWindow ?? 0) === largest),
      order = [
        recommended,
        ...models.map((_, i) => i).filter((i) => i !== recommended),
      ].filter((i) => i >= 0);
    body = `<h1>Choose a model</h1><p>${h(setup.provider?.target.label)} · ${h(setup.provider?.target.url)}</p>${models.length ? list(order.map((index) => row(index, h(models[index]!.id), `${num(models[index]!.contextWindow)} context${models[index]!.maxOutputTokens ? ` · ${num(models[index]!.maxOutputTokens)} max output` : ""}`, index === recommended ? '<span class="success">recommended</span>' : "", index === setup.modelIndex))) : `<form id="setup-form"><label>MODEL ID<input name="model" value="${h(setup.modelText)}" placeholder="Enter a model id" autofocus></label></form>`}<p class="setup-note">${models.length ? "Models reported by your provider. Context size is checked in Review." : "The server did not list models. Enter the exact id it expects."}</p>`;
    left = `${k("↑↓")} choose ${button("escape", `${k("Esc")} back`)}`;
  }
  if (step === "custom") {
    const result = setup.customResult;
    body = `<h1>Enter your server address</h1><p>Any OpenAI-compatible endpoint: vLLM, llama.cpp, LM Studio, Ollama, or a hosted gateway.</p><form id="setup-form"><label>Base URL<input name="url" type="url" value="${h(setup.custom.text)}" placeholder="http://127.0.0.1:8000/v1" autocomplete="off"></label></form><div class="probe-result ${setup.custom.checking ? "amber" : result?.reachable ? "success" : result ? "amber" : "muted"}">${setup.custom.checking ? "◌ Checking the server…" : result?.reachable ? `✓ Reachable · OpenAI-compatible · ${result.models.length} models` : result ? "○ Server did not respond · you can continue and enter a model id" : "The server is checked as you type."}</div>${setup.custom.error ? `<p class="danger">${h(setup.custom.error)}</p>` : ""}<p class="setup-note">Needs an API key? Add it in ~/.demesne/config.toml after setup; it is never typed here.</p>`;
    left = button("escape", `${k("Esc")} back`);
  }
  if (step === "auth") {
    const auth = setup.auth;
    body = `<h1>Sign in to OpenRouter</h1><p>Your browser opens a secure sign-in page.</p><div class="auth-card ${auth.status === "failed" ? "failed" : ""}"><div><strong>${auth.status === "failed" ? "× Sign-in failed" : auth.status === "loading" ? "Connected · loading models" : "Waiting for sign-in"}</strong>${auth.status === "waiting" ? '<img src="assets/auth-dots.svg" alt=""><span id="auth-timer" class="right"></span>' : ""}</div><p>${h(auth.message)}</p></div>${auth.url ? `<div class="auth-link">${button("o", h(auth.url))}</div>` : ""}<p class="setup-note">A one-time localhost callback receives your sign-in. Your credential is saved only when you write the config in Review.</p><p class="setup-note">Already have a key? Set <code>OPENROUTER_API_KEY</code> before starting setup.</p>`;
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
        "Max output",
        setup.review.maxOutputTokens.toLocaleString(),
        "tokens per request",
      ],
      [
        "Theme",
        setup.review.theme,
        setup.review.theme === "auto" ? "follows your terminal" : "",
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
      ["demesne graphics", "start a session in the current folder"],
      ["demesne doctor", "check the connection any time"],
      ["demesne graphics --setup", "change provider or model later"],
    ]
      .map(
        ([cmd, description]) =>
          `<div><code>${cmd}</code><span>${description}</span></div>`,
      )
      .join("")}</div>`;
    left = button("q", `${k("q")} close`);
    right = button("return", `Open demesne here ${k("Enter")}`);
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
        "#status,header,#rail,.drive-pane,#overlay[hidden],#completion[hidden],time,script,style,textarea",
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
      element.closest(".drive-pane")
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
