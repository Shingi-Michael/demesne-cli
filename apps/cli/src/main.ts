#!/usr/bin/env bun

import {
  EventStreamHttpError,
  isRecord,
  readServerSentEvents,
  type CancelTurnResponse,
  type CreateSessionResponse,
  type EventEnvelope,
  type ModelDescriptor,
  type PermissionDecision,
  type RuntimeProfileStatus,
  type Session,
  type SessionStateResponse,
  type SubmitTurnResponse,
  type UndoTurnResponse,
  type WorkspaceFilesResponse,
} from "@demesne/protocol";
import {
  computePromptVisualLines,
  createPainter,
  formatAssistantHeader,
  formatDiffPreview,
  formatFooterLine,
  formatHelpCard,
  formatInfoCard,
  formatPermissionCard,
  formatSlashCommandMenu,
  formatSessionsTable,
  formatToolPhaseHeader,
  formatToolResultLine,
  formatTurnReceipt,
  formatUserMessage,
  formatWelcomeCard,
  fileUrl,
  formatHyperlink,
  formatMentionMenu,
  humanToolTitle,
  renderBeaconText,
  renderSpinner,
  resolveSlashCommand,
  resolveTerminalTheme,
  SPINNER_PERIOD_MS,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  slashCommandMatches,
  slashCommandValidationError,
  TerminalMarkdownStream,
  TerminalReasoningStream,
  toolKindBadge,
  truncateText,
  visibleLength,
  type BeaconActivity,
  type Painter,
  type PaletteColor,
  type SlashCommandId,
} from "@demesne/brand";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { CliContextRail } from "./context-rail.ts";
import { TurnThroughputTracker } from "./turn-throughput.ts";
import { TurnActivityLedger, type TurnPhase } from "./turn-activity.ts";
import { TerminalTextPacer } from "./terminal-text-pacer.ts";
import { selectSessionInteractive, sessionListItem } from "./session-picker.ts";
import { reducedMotionEnabled } from "./motion.ts";
import { ApiRequestError, isStalePermissionResolution } from "./api-request-error.ts";
import { approvalOptions, formatApprovalSelection, reduceApprovalSelection } from "./approval-selection.ts";
import { applyFooterScrollRegion, resetFooterScrollRegion } from "./terminal-control.ts";
import { reduceInterruptKey } from "./interrupt-key.ts";
import { playTensorIntro } from "./tensor-intro.ts";
import { PromptHistory } from "./prompt-history.ts";
import { composeInEditor } from "./external-editor.ts";
import { createPromptEditorState, mentionMatches, mentionTokenAt, reducePromptEditor, reverseSearchMatches, setPromptValue } from "./prompt-editor.ts";
import { queueSummary, reduceQueuedInput } from "./input-queue.ts";
import { notify, shouldNotifyApproval, shouldNotifyCompletion, type NotificationOptions } from "./notifications.ts";
import { derivePersistedRule } from "./allow-rules.ts";
import { VERSION } from "./version.ts";
import { loadCliSettings, type CliSettings } from "./cli-config.ts";
import {
  createDaemonControlDependencies,
  daemonStatus,
  ensureDaemon,
  readDaemonLog,
  startDaemon,
  stopDaemon,
} from "./daemon-control.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { runSetup } from "./setup.ts";
import { updateUserConfig } from "@demesne/config";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const settings = loadSettings();
const server = validateServerUrl(settings.server);
const daemonToken = loadDaemonToken(settings.dataDirectory);
const colorEnabled = (stream: { isTTY?: boolean }) => Boolean(stream.isTTY) && !process.env.NO_COLOR;
const terminalTheme = resolveTerminalTheme(
  settings.theme === "auto" ? undefined : settings.theme,
  process.env.COLORFGBG,
);
const paint = createPainter(colorEnabled(process.stdout), terminalTheme);
const paintLog = createPainter(colorEnabled(process.stderr), terminalTheme);

function loadSettings(): CliSettings {
  try {
    return loadCliSettings({ serverOverride: takeOption(args, "--server") });
  } catch (error) {
    console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

class CliFixedFooter {
  private active = false;
  private currentLeft = "";
  private currentRight = "";
  private lastRendered = "";
  private lastRows = 0;

  enable(): void {
    if (!process.stdout.isTTY) return;
    this.active = true;
    this.applyScrollRegion();
  }

  disable(): void {
    if (!this.active || !process.stdout.isTTY) return;
    this.active = false;
    this.lastRendered = "";
    this.lastRows = 0;
    const stream = process.stdout;
    const rows = stream.rows ?? 24;
    stream.write(resetFooterScrollRegion(rows));
  }

  isActive(): boolean {
    return this.active && (process.stdout.rows ?? 24) >= 6;
  }

  applyScrollRegion(): void {
    if (!this.active || !process.stdout.isTTY) return;
    const stream = process.stdout;
    const rows = stream.rows ?? 24;
    if (this.lastRows > 0 && this.lastRows !== rows && this.lastRows < rows) {
      stream.write(`\x1b7\x1b[${this.lastRows};1H\x1b[2K\x1b8`);
    }
    stream.write(applyFooterScrollRegion(rows));
    this.lastRows = rows;
    this.lastRendered = "";
    this.redraw();
  }

  update(left = this.currentLeft, right = this.currentRight): void {
    this.currentLeft = left;
    this.currentRight = right;
    this.redraw();
  }

  private redraw(): void {
    if (!this.active || !process.stdout.isTTY) return;
    const stream = process.stdout;
    const rows = stream.rows ?? 24;
    const cols = stream.columns ?? 80;
    if (rows < 6) return;

    const content = formatFooterLine(this.currentLeft, this.currentRight, cols);
    if (content === this.lastRendered) return;
    this.lastRendered = content;

    stream.write(`\x1b7\x1b[${rows};1H\x1b[2K${content}\x1b8`);
  }
}

const chatState: {
  streamActive: boolean;
  permissionActive: boolean;
  interrupt?: () => void;
  refreshStreams?: () => void;
  inputStatusLine?: () => string | null;
  footer?: CliFixedFooter;
  queuedInput?: string;
  refreshQueued?: () => void;
} = { streamActive: false, permissionActive: false };
let restoreTerminalState = () => {};

process.on("exit", () => restoreTerminalState());

function watchForDoubleEscapeInterrupt(): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};
  const wasRaw = input.isRaw;
  let lastEscapeAt = 0;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void => {
    if (chatState.permissionActive) {
      // The approval selector handles Ctrl+C itself; other keys still reach
      // the double-Escape interrupt path.
      if (key.ctrl && key.name === "c") return;
    } else if (chatState.streamActive && key.name !== "escape") {
      const nextQueue = reduceQueuedInput(chatState.queuedInput ?? "", key, _text ?? "");
      if (nextQueue !== chatState.queuedInput) {
        chatState.queuedInput = nextQueue;
        chatState.refreshQueued?.();
      }
    }
    const next = reduceInterruptKey(lastEscapeAt, key, Date.now());
    lastEscapeAt = next.lastEscapeAt;
    if (next.interrupt) chatState.interrupt?.();
  };

  const detach = (): void => {
    input.removeListener("keypress", onKeypress);
    input.setRawMode(wasRaw);
    input.pause();
  };

  input.on("keypress", onKeypress);
  return detach;
}

/// Consumes any type-ahead text queued during the previous turn.
function takeQueuedInput(): string | undefined {
  const queued = chatState.queuedInput?.trim();
  chatState.queuedInput = undefined;
  return queued ? queued : undefined;
}

/// Workspace files for `@` mentions. A missing workspace or a failed listing
/// simply disables the menu.
async function fetchMentionFiles(sessionId: string): Promise<string[]> {
  return request<WorkspaceFilesResponse>(`/v1/sessions/${sessionId}/files`)
    .then((result) => result.files)
    .catch(() => []);
}

function getTerminalWidth(stream: { columns?: number } = process.stdout): number {
  const cols = stream.columns ?? process.stdout.columns ?? 80;
  if (!cols || cols <= 0) return 80;
  return Math.max(18, cols - 2);
}

function getConversationWidth(stream: { columns?: number } = process.stdout): number {
  return Math.min(100, getTerminalWidth(stream));
}

async function readCommandPrompt(history: PromptHistory, mentions: readonly string[] = []): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  let state = createPromptEditorState();
  let prevCursorVisualLine = 0;
  let prevTotalLines = 1;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const matchingCommands = () => (state.menuDismissed ? [] : slashCommandMatches(state.value).slice(0, 10));

    const render = () => {
      const commands = matchingCommands();
      state.menuSelected = Math.min(state.menuSelected, Math.max(0, commands.length - 1));
      const inputWidth = Math.max(10, getConversationWidth(output) - 4);

      // Reverse search replaces the draft with a one-line query display. The
      // draft itself stays in the editor state and is restored on cancel.
      const searchMatches = state.search ? reverseSearchMatches(history.entries(), state.search.query) : [];
      const searchMatch = state.search
        ? searchMatches[Math.min(state.search.index, Math.max(0, searchMatches.length - 1))] ?? ""
        : "";
      const searchLine = state.search
        ? `(reverse-i-search)\`${state.search.query}\`: ${searchMatch || (searchMatches.length === 0 ? "no match" : "")}`
        : null;

      const layout = computePromptVisualLines(
        searchLine ?? state.value,
        searchLine === null ? state.cursor : searchLine.length,
        inputWidth,
      );

      const placeholder = searchLine === null && state.value.length === 0 && commands.length === 0
        ? paint.dim(truncateText("Ask anything or type / for commands...", inputWidth))
        : "";
      const promptLines: string[] = [];
      for (let i = 0; i < layout.lines.length; i++) {
        const prefix = i === 0 ? `  ${paint.text("◆", "electric")} ` : "    ";
        const line = layout.lines[i] ?? "";
        const rendered = searchLine !== null
          ? paint.dim(line)
          : line || (i === 0 ? placeholder : "");
        promptLines.push(`${prefix}${rendered}`);
      }

      const trailingContent: string[] = [];
      const mention = mentionTokenAt(state.value, state.cursor);
      const mentionCandidates = mention && mentions.length > 0 ? mentionMatches(mentions, mention.query) : [];
      if (mentionCandidates.length > 0 && searchLine === null) {
        state.mentionSelected = Math.min(state.mentionSelected, mentionCandidates.length - 1);
        trailingContent.push(...formatMentionMenu(
          mentionCandidates,
          state.mentionSelected,
          getConversationWidth(output),
          paint,
        ).split("\n"));
      } else if (commands.length > 0 && searchLine === null) {
        trailingContent.push(...formatSlashCommandMenu(commands, state.menuSelected, getConversationWidth(output), paint).split("\n"));
      } else if (!chatState.footer?.isActive()) {
        const statusLine = chatState.inputStatusLine?.() ?? "";
        if (statusLine && (!output.rows || output.rows >= 6)) {
          const screenWidth = getTerminalWidth(output);
          const pad = Math.max(0, screenWidth - visibleLength(statusLine));
          trailingContent.push(`${" ".repeat(pad)}${statusLine}`);
        }
      }

      const newTotalLines = promptLines.length + trailingContent.length;

      // 1. Move cursor back to the start of the first prompt line
      output.write("\r");
      if (prevCursorVisualLine > 0) {
        output.write(`\x1b[${prevCursorVisualLine}A`);
      }

      // 2. Write all visual lines of the prompt with line-level clearing
      for (let i = 0; i < promptLines.length; i++) {
        output.write(`${i > 0 ? "\n" : ""}\x1b[2K${promptLines[i]}`);
      }

      // 3. Write trailing lines (slash commands menu or fallback status line)
      for (const line of trailingContent) {
        output.write(`\n\x1b[2K${line}`);
      }

      // 4. Clear any leftover trailing lines from previous render if previous was taller
      if (prevTotalLines > newTotalLines) {
        for (let i = newTotalLines; i < prevTotalLines; i++) {
          output.write("\n\x1b[2K");
        }
        output.write(`\x1b[${prevTotalLines - newTotalLines}A`);
      }

      // 5. Move cursor from the bottom back to the active cursor position
      const linesUp = promptLines.length - 1 - layout.cursorLine + trailingContent.length;
      if (linesUp > 0) {
        output.write(`\x1b[${linesUp}A`);
      }
      output.write(`\r\x1b[${4 + layout.cursorCol}C`);

      prevCursorVisualLine = layout.cursorLine;
      prevTotalLines = newTotalLines;

      // 6. Keep the fixed bottom footer continuously drawn
      const statusLine = chatState.inputStatusLine?.() ?? "";
      if (chatState.footer?.isActive()) {
        chatState.footer.update("", statusLine);
      }
    };

    // A resize reflows the grid and moves the cursor with the text, but the
    // relative tracking from the previous render no longer matches. Drop the
    // stale up-move so the block redraws where the terminal placed it.
    const onResize = () => {
      prevCursorVisualLine = 0;
      render();
    };

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      input.setRawMode(Boolean(wasRaw));
      output.write("\r");
      if (prevCursorVisualLine > 0) {
        output.write(`\x1b[${prevCursorVisualLine}A`);
      }
      for (let i = 0; i < prevTotalLines; i++) {
        output.write("\x1b[2K");
        if (i < prevTotalLines - 1) output.write("\n");
      }
      if (prevTotalLines > 1) {
        output.write(`\x1b[${prevTotalLines - 1}A`);
      }
      output.write("\r");
    };

    const finish = (result: string) => {
      cleanup();
      resolve(result);
    };

    const openExternalEditor = async () => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      input.setRawMode(Boolean(wasRaw));
      try {
        state = setPromptValue(state, await composeInEditor(state.value, { env: process.env }));
      } catch (error) {
        output.write(`${paint.text(`External editor failed: ${error instanceof Error ? error.message : String(error)}`, "signal")}\n`);
      } finally {
        emitKeypressEvents(input);
        input.setRawMode(true);
        input.resume();
        input.on("keypress", onKeypress);
        output.on("resize", onResize);
        prevCursorVisualLine = 0;
        render();
      }
    };

    const onKeypress = (
      text: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
    ) => {
      const result = reducePromptEditor(state, {
        key,
        text,
        commands: matchingCommands(),
        history: history.entries(),
        mentions,
      });
      state = result.state;
      if (result.action.type === "cancel") {
        cleanup();
        leaveChat();
      }
      if (result.action.type === "submit") {
        finish(result.action.value);
        return;
      }
      if (result.action.type === "compose") {
        void openExternalEditor();
        return;
      }
      render();
    };

    input.on("keypress", onKeypress);
    output.on("resize", onResize);
    render();
  });
}

try {
  if (args.length === 0 || args[0] === "chat") {
    await runChat(args[0] === "chat" ? args.slice(1) : args);
  } else {
    await run(args);
  }
} catch (error) {
  restoreTerminalState();
  const message = error instanceof Error ? error.message : String(error);
  console.error(paintLog.bold(sanitizeTerminalText(message), "signal"));
  process.exitCode = 1;
}

async function run(command: string[]): Promise<void> {
  if (command[0] === "--version" || command[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (command[0] === "--help" || command[0] === "help") {
    printUsage();
    return;
  }
  if (command[0] === "session" && command[1] === "create") {
    const workspacePath = takeOption(command, "--workspace") ?? process.cwd();
    const title = command.slice(2).join(" ").trim() || undefined;
    const created = await request<CreateSessionResponse>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title, workspacePath }),
    });
    console.log(created.session.id);
    return;
  }

  if (command[0] === "session" && command[1] === "show" && command[2]) {
    const result = await request<{ session: Session }>(`/v1/sessions/${command[2]}`);
    console.log(JSON.stringify(result.session, null, 2));
    return;
  }

  if (command[0] === "session" && command[1] === "list") {
    const result = await request<{ sessions: Session[] }>("/v1/sessions");
    for (const session of result.sessions) {
      console.log(sanitizeTerminalText(`${session.id}\t${session.title}\t${session.workspace?.root ?? "no workspace"}`));
    }
    return;
  }

  if (command[0] === "models") {
    const result = await request<{ models: ModelDescriptor[] }>("/v1/models");
    for (const model of result.models) console.log(sanitizeTerminalText(`${model.id}\t${model.provider}`));
    return;
  }

  if (command[0] === "setup") {
    const result = await runSetup({
      providerUrl: takeOption(command, "--provider-url"),
      providerId: takeOption(command, "--provider-id"),
      model: takeOption(command, "--model"),
      contextWindow: takeNumberOption(command, "--context-window"),
      maxOutputTokens: takeNumberOption(command, "--max-output-tokens"),
      theme: takeThemeOption(command, "--theme"),
      yes: command.includes("--yes"),
      painter: paint,
    });
    console.log(`  ${paint.text("●", "citron")} Wrote ${result.configPath}`);
    if (result.backup) console.log(paint.dim(`    Previous config backed up to ${result.backup}`));
    console.log(paint.dim("    Next: `demesne doctor`, then `demesne`."));
    return;
  }

  if (command[0] === "doctor") {
    const result = await runDoctor({
      server,
      dataDirectory: settings.dataDirectory,
      token: daemonToken,
      loaded: settings.loaded,
      workspaceRoot: process.cwd(),
      runCommand: runCommandCapture,
    });
    if (command.includes("--json")) {
      console.log(JSON.stringify({ ok: result.ok, checks: result.checks }, null, 2));
    } else {
      console.log(formatDoctorReport(result.checks, paint));
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command[0] === "daemon") {
    const deps = createDaemonControlDependencies(server, settings.dataDirectory);
    const action = command[1];
    if (action === "start") {
      const result = await startDaemon(deps);
      console.log(result.message);
      if (!result.started && !result.health) process.exitCode = 1;
      return;
    }
    if (action === "stop") {
      const result = await stopDaemon(deps);
      console.log(result.message);
      if (!result.stopped) process.exitCode = 1;
      return;
    }
    if (action === "status") {
      const status = await daemonStatus(deps);
      if (!status.running) {
        console.log(`Daemon is not running at ${server}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Daemon is running at ${server}.`);
      console.log(`  pid:      ${status.pid ?? "unknown"}`);
      console.log(`  provider: ${status.health?.provider ?? "unknown"}`);
      console.log(`  model:    ${status.health?.model ?? "unknown"}`);
      if (status.health?.version) console.log(`  version:  ${status.health.version}`);
      return;
    }
    if (action === "logs") {
      console.log(readDaemonLog(deps) || "No daemon log yet.");
      return;
    }
    console.log("Usage: demesne daemon start|stop|status|logs");
    process.exitCode = 1;
    return;
  }

  if (command[0] === "prompt") {
    const permissionMode = takeOption(command, "--permission") ?? (process.stdin.isTTY && process.stdout.isTTY ? "ask" : "deny");
    if (permissionMode !== "ask" && permissionMode !== "deny") throw new Error("--permission must be ask or deny");
    const sessionOverride = takeOption(command, "--session");
    const content = command.slice(1).join(" ").trim();
    if (!content) throw new Error("prompt requires text");
    await ensureDaemonOrExit();
    const sessionId = sessionOverride ?? (await createAutomaticSession(command)).id;
    await submitAndRender(sessionId, content, permissionMode, undefined, "exit", false);
    return;
  }

  if (command[0] === "cancel" && command[1]) {
    const cancelled = await request<CancelTurnResponse>(`/v1/turns/${command[1]}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    console.log(`${cancelled.turn.id} cancelled`);
    return;
  }

  if (command[0] === "events" && command[1]) {
    const after = Number(takeOption(command, "--after") ?? "0");
    for await (const event of streamEvents(command[1], after)) console.log(JSON.stringify(event));
    return;
  }

  printUsage();
  if (command.length > 0) process.exitCode = 1;
}

async function createAutomaticSession(command: string[]): Promise<Session> {
  const content = command.slice(1).join(" ").trim();
  const title = content.slice(0, 80) || "New session";
  const created = await request<CreateSessionResponse>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ title, workspacePath: process.cwd() }),
  });
  console.error(`Session ${created.session.id}`);
  return created.session;
}

async function submitAndRender(
  sessionId: string,
  content: string,
  permissionMode: "ask" | "deny",
  thinkingEnabled: boolean | undefined,
  onInterrupt: "exit" | "stop",
  interactive = true,
  providerName?: string,
  contextRail?: CliContextRail,
  workspaceRoot?: string,
): Promise<"completed" | "stopped"> {
  const submitted = await request<SubmitTurnResponse>(`/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      content,
      permissionMode,
      ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    }),
  });
  return renderTurn(sessionId, submitted.turn.id, submitted.eventId, {
    onInterrupt,
    interactive,
    providerName,
    thinkingEnabled: submitted.turn.thinkingEnabled ?? thinkingEnabled,
    contextRail,
    workspaceRoot,
  });
}

function leaveChat(): never {
  restoreTerminalState();
  console.error(`\n  ${paintLog.dim("Demesne line closed.")}\n`);
  process.exit(0);
}

async function runChat(command: string[]): Promise<void> {
  const permissionMode = takeOption(command, "--permission") ?? (process.stdin.isTTY ? "ask" : "deny");
  if (permissionMode !== "ask" && permissionMode !== "deny") throw new Error("--permission must be ask or deny");
  await ensureDaemonOrExit();
  const modelOverride = takeOption(command, "--model");
  const sessionIdOverride = takeOption(command, "--session");
  const initial = command.join(" ").trim();

  if (modelOverride) {
    await request<{ status: string; model: string }>("/v1/model", {
      method: "POST",
      body: JSON.stringify({ model: modelOverride }),
    });
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const history = PromptHistory.load(join(settings.dataDirectory, "history.jsonl"));
  let mentionFiles: string[] = [];
  let sessionId = sessionIdOverride;
  const thinkingEnabled: boolean | undefined = undefined;

  if (!sessionId) {
    const title = initial ? initial.slice(0, 80) : `Session ${new Date().toLocaleTimeString()}`;
    const created = await request<CreateSessionResponse>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title, workspacePath: process.cwd() }),
    });
    sessionId = created.session.id;
  }

  if (!interactive) {
    if (initial) {
      console.error(`Session ${sessionId}`);
      await submitAndRender(sessionId, initial, permissionMode, thinkingEnabled, "exit", false);
    } else {
      throw new Error("chat requires an interactive terminal or an initial message");
    }
    return;
  }

  const boot = Promise.all([
    request<{ provider: string; model: string }>("/healthz").catch(() => undefined),
    request<{ models: ModelDescriptor[] }>("/v1/models").then((result) => result.models).catch(() => []),
    request<RuntimeProfileStatus>("/v1/runtime").catch(() => null),
  ]);
  await playTensorIntro(paint);
  const [health, discoveredModels, runtimeStatus] = await boot;
  const activeModel = discoveredModels.find((model) => model.id === health?.model) ?? {
    id: health?.model ?? "model",
    provider: health?.provider ?? "local",
  };
  const initialState = await request<SessionStateResponse>(`/v1/sessions/${sessionId}`);
  mentionFiles = await fetchMentionFiles(sessionId);
  let currentWorkspace = initialState.session.workspace?.root ?? process.cwd();
  const historicalModel = initialState.latestProviderCall
    ? discoveredModels.find((model) =>
      model.id === initialState.latestProviderCall?.model && model.provider === initialState.latestProviderCall.provider
    )
    : undefined;
  const contextRail = new CliContextRail(historicalModel ?? activeModel, currentWorkspace);
  contextRail.hydrate(initialState.latestProviderCall, thinkingEnabled, currentWorkspace);
  contextRail.setBranch(initialState.session.workspace?.gitBranch ?? null);
  contextRail.setRuntime(runtimeStatus);
  const fixedFooter = new CliFixedFooter();
  chatState.footer = fixedFooter;
  fixedFooter.enable();

  const statusLineText = () => contextRail.statusLine(getTerminalWidth(process.stdout), paint);
  const renderWelcome = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    fixedFooter.applyScrollRegion();
    const card = formatWelcomeCard({
      model: activeModel.id,
      provider: activeModel.provider,
      workspace: currentWorkspace,
      permissionMode,
      width: getTerminalWidth(process.stdout),
      painter: paint,
    });
    console.log(card);
    fixedFooter.update("", statusLineText());
  };
  restoreTerminalState = () => {
    fixedFooter.disable();
    process.stdout.removeListener("resize", onTerminalResize);
    chatState.inputStatusLine = undefined;
    chatState.footer = undefined;
  };
  chatState.inputStatusLine = statusLineText;
  const onTerminalResize = () => {
    fixedFooter.applyScrollRegion();
    chatState.refreshStreams?.();
  };
  process.stdout.on("resize", onTerminalResize);
  renderWelcome();

  process.on("SIGINT", () => {
    if (chatState.streamActive) chatState.interrupt?.();
    else leaveChat();
  });

  const executePrompt = async (text: string): Promise<void> => {
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const width = getConversationWidth(process.stdout);
    console.log(formatUserMessage(text, timeStr, width, paint));

    chatState.streamActive = true;
    chatState.queuedInput = undefined;
    contextRail.setModel(activeModel);
    const stopWatching = watchForDoubleEscapeInterrupt();
    try {
      await submitAndRender(
        sessionId!,
        text,
        permissionMode,
        thinkingEnabled,
        "stop",
        true,
        activeModel.provider,
        contextRail,
        currentWorkspace,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Turn failed";
      console.log(`\n  ${paint.text("×", "signal")} ${paint.dim(`Turn failed · ${sanitizeTerminalText(message)}`)}\n`);
    } finally {
      stopWatching();
      chatState.streamActive = false;
    }
  };

  const activateSession = async (targetId: string): Promise<void> => {
    try {
      const result = await request<SessionStateResponse>(`/v1/sessions/${targetId}`);
      sessionId = result.session.id;
      currentWorkspace = result.session.workspace?.root ?? process.cwd();
      contextRail.setModel(activeModel);
      if (result.latestProviderCall) {
        const models = await request<{ models: ModelDescriptor[] }>("/v1/models")
          .then((response) => response.models)
          .catch(() => []);
        const historical = models.find((model) =>
          model.id === result.latestProviderCall?.model && model.provider === result.latestProviderCall.provider
        );
        if (historical) contextRail.setModel(historical);
      }
      contextRail.hydrate(result.latestProviderCall, thinkingEnabled, currentWorkspace);
      contextRail.setBranch(result.session.workspace?.gitBranch ?? null);
      mentionFiles = await fetchMentionFiles(sessionId);
      console.log(`\n  ${paint.text("●", "citron")} Switched to ${paint.bold(sanitizeTerminalLine(result.session.title), "paper")} ${paint.dim(`(${sessionId.slice(0, 8)})`)}\n`);
    } catch {
      console.log(`  ${paint.text(`Could not find session: ${targetId}`, "signal")}\n`);
    }
  };

  const slashHandlers: Record<SlashCommandId, (argument: string) => Promise<void>> = {
    exit: async () => leaveChat(),
    undo: async () => {
      try {
        const result = await request<UndoTurnResponse>(`/v1/sessions/${sessionId}/undo`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        console.log(`\n  ${paint.text("●", "citron")} Reverted ${result.files.length} path${result.files.length === 1 ? "" : "s"} from turn ${paint.bold(result.turnId.slice(0, 8), "paper")}`);
        for (const file of result.files) console.log(paint.dim(`    ↩ ${sanitizeTerminalLine(file)}`));
        console.log("");
      } catch (error) {
        const message = error instanceof Error ? error.message : "undo failed";
        console.log(`  ${paint.text(message, "signal")}\n`);
      }
    },
    clear: async () => renderWelcome(),
    help: async () => {
      console.log(formatHelpCard(paint, getTerminalWidth(process.stdout)));
    },
    new: async (customTitle) => {
      const title = sanitizeTerminalLine(customTitle).trim() || `Session ${new Date().toLocaleTimeString()}`;
      const created = await request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ title, workspacePath: process.cwd() }),
      });
      sessionId = created.session.id;
      currentWorkspace = created.session.workspace?.root ?? process.cwd();
      contextRail.setModel(activeModel);
      contextRail.hydrate(null, thinkingEnabled, currentWorkspace);
      contextRail.setBranch(created.session.workspace?.gitBranch ?? null);
      mentionFiles = await fetchMentionFiles(sessionId);
      console.log(`\n  ${paint.text("●", "citron")} Started new session ${paint.bold(title, "paper")} ${paint.dim(`(${sessionId.slice(0, 8)})`)}\n`);
    },
    status: async () => {
      const current = await request<{ session: Session }>(`/v1/sessions/${sessionId}`).catch(() => null);
      console.log(
        formatInfoCard({
          sessionId: sessionId!,
          title: current?.session.title ?? "Untitled",
          turnCount: current?.session.turns.length ?? 0,
          model: activeModel.id,
          provider: activeModel.provider,
          contextWindow: activeModel.contextWindow,
          workspace: current?.session.workspace?.root ?? currentWorkspace,
          width: getTerminalWidth(process.stdout),
          painter: paint,
        }),
      );
    },
    context: async () => {
      const state = await request<SessionStateResponse>(`/v1/sessions/${sessionId}`).catch(() => null);
      const contextWidth = Math.max(1, Math.min(72, getTerminalWidth(process.stdout) - 4));
      const detail = contextRail.lines(
        contextWidth,
        100,
        paint,
      ).map((line) => `  ${line}`);
      const grants = state?.sessionGrants ?? [];
      if (grants.length > 0) {
        detail.push(`  ${paint.bold("SESSION GRANTS", "secondary")}`);
        for (const grant of grants) {
          const scope = grant.pathPrefix ? ` under ${sanitizeTerminalLine(grant.pathPrefix)}/` : " (whole workspace)";
          const grantLine = `· ${sanitizeTerminalLine(grant.tool)}${scope}`;
          detail.push(`  ${truncateText(paint.dim(grantLine), contextWidth)}`);
        }
      }
      console.log(`\n${detail.join("\n")}\n`);
    },
    sessions: async () => {
      const result = await request<{ sessions: Session[] }>("/v1/sessions");
      const recent = result.sessions.slice(0, 10);
      console.log(formatSessionsTable(recent.map(sessionListItem), sessionId, getTerminalWidth(process.stdout), paint));
      if (recent.length === 0) return;
      const selected = await selectSessionInteractive(recent, sessionId, paint);
      if (selected && selected.id !== sessionId) await activateSession(selected.id);
      else if (!selected) console.log(`  ${paint.dim("Session selection cancelled.")}\n`);
    },
    resume: activateSession,
  };

  if (initial) {
    history.add(initial, currentWorkspace);
    await executePrompt(initial);
  }

  while (true) {
    let line: string;
    const queued = takeQueuedInput();
    if (queued) {
      line = queued;
    } else {
      try {
        line = await readCommandPrompt(history, mentionFiles);
      } catch {
        leaveChat();
      }
    }

    const input = line.trim();
    if (!input) continue;
    history.add(input, currentWorkspace);

    if (input.startsWith("/")) {
      const invocation = resolveSlashCommand(input);
      if (!invocation) {
        console.log(`  ${paint.text(`Unknown command: ${input.split(/\s/, 1)[0]}. Type /help for available commands.`, "signal")}\n`);
        continue;
      }
      const validationError = slashCommandValidationError(invocation);
      if (validationError) {
        console.log(`  ${paint.text(validationError, "signal")}\n`);
        continue;
      }
      try {
        await slashHandlers[invocation.command.id](invocation.argument);
      } catch (error) {
        const message = error instanceof Error ? error.message : `${invocation.command.name} failed`;
        console.log(`  ${paint.text(sanitizeTerminalText(message), "signal")}\n`);
      }
      continue;
    }

    await executePrompt(input);
  }
}

/// Notifications follow the configured policy and only fire on an interactive
/// terminal; OSC 9 sequences are harmless elsewhere but pointless.
function notificationOptions(interactive: boolean): NotificationOptions {
  return { enabled: settings.notifications.enabled, isTTY: interactive };
}

async function renderTurn(
  sessionId: string,
  turnId: string,
  after: number,
  options: {
    onInterrupt?: "exit" | "stop";
    interactive?: boolean;
    providerName?: string;
    thinkingEnabled?: boolean;
    contextRail?: CliContextRail;
    workspaceRoot?: string;
  } = {},
): Promise<"completed" | "stopped"> {
  const stream = new AbortController();
  const startTime = Date.now();
  let interrupted = false;
  let responseHeaderWritten = false;
  let roundHasReceivedTokens = false;
  let reasoningOpen = false;
  let reasoningStartTime = 0;
  let beaconTimer: ReturnType<typeof setInterval> | null = null;
  let beaconActivity: BeaconActivity = "thinking";
  let beaconAccent: PaletteColor | undefined;
  let beaconLabel = "Thinking";
  let beaconStartedAt = startTime;
  let beaconVisible = false;
  let modelName = "";
  let cancelFallback: ReturnType<typeof setTimeout> | undefined;
  const throughput = new TurnThroughputTracker();
  const activityLedger = new TurnActivityLedger();
  let visiblePhase: TurnPhase | null = null;

  const interactive = options.interactive ?? true;
  const workspaceRoot = options.workspaceRoot;
  const linkPath = interactive && settings.ui.hyperlinks && workspaceRoot
    ? (styledDisplay: string, path: string): string => {
        try {
          return formatHyperlink(styledDisplay, fileUrl(resolve(workspaceRoot, path)));
        } catch {
          return styledDisplay;
        }
      }
    : undefined;
  const reduceMotion = reducedMotionEnabled();
  const waitingActivity: BeaconActivity = options.thinkingEnabled === false ? "loading" : "thinking";
  const waitingLabel = options.thinkingEnabled === false ? "Working" : "Thinking";
  const termWidth = getConversationWidth(process.stdout);
  const markdownStream = new TerminalMarkdownStream(paint, termWidth, interactive ? 2 : 0);
  const textPacer = interactive && process.stdin.isTTY && process.stdout.isTTY && !reduceMotion
    ? new TerminalTextPacer({ sink: (text) => process.stdout.write(text) })
    : null;
  const writeResponse = (text: string) => {
    if (textPacer) textPacer.write(text);
    else process.stdout.write(text);
  };
  const drainResponse = async () => {
    if (textPacer) await textPacer.drain();
  };
  options.contextRail?.begin(options.thinkingEnabled);

  const fixedFooter = chatState.footer;
  const currentRightStatus = (animatedModelLabel?: string) => {
    return options.contextRail?.statusLine(getTerminalWidth(process.stdout), paint, animatedModelLabel) ?? chatState.inputStatusLine?.() ?? "";
  };

  const updateBeacon = () => {
    const queuedBeaconText = () => {
      const summary = queueSummary(chatState.queuedInput ?? "");
      return summary ? ` ${paint.text(`· ⏎ ${summary}`, "electricBright")}` : "";
    };
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const phase = reduceMotion ? 0 : ((Date.now() - beaconStartedAt) % 2_100) / 2_100;
    const spinPhase = reduceMotion ? 0 : ((Date.now() - beaconStartedAt) % SPINNER_PERIOD_MS) / SPINNER_PERIOD_MS;
    const spinner = renderSpinner(spinPhase, beaconActivity, paint, beaconAccent);
    const tokSpeed = throughput.snapshot().tokensPerSecond;
    const speedLabel = tokSpeed === null ? "" : `${tokSpeed.toFixed(0)} tok/s`;
    const speedStr = speedLabel ? ` · ${speedLabel}` : "";
    const left = `  ${spinner} ${paint.bold(beaconLabel, "paper")} ${paint.dim(`· ${elapsedSec}s${speedStr}`)}${queuedBeaconText()}`;
    const modelText = options.contextRail?.modelId || modelName;
    const animatedModel = modelText ? renderBeaconText(sanitizeTerminalLine(modelText), phase, beaconActivity, paint) : undefined;
    if (fixedFooter?.isActive()) {
      fixedFooter.update(left, currentRightStatus(animatedModel));
    } else {
      process.stdout.write(`\r\x1b[2K${left}`);
      beaconVisible = true;
    }
  };
  chatState.refreshQueued = updateBeacon;

  const stopBeacon = () => {
    const shouldClear = beaconVisible || beaconTimer !== null;
    if (beaconTimer) {
      clearInterval(beaconTimer);
      beaconTimer = null;
    }
    if (fixedFooter?.isActive()) {
      fixedFooter.update("", currentRightStatus());
    } else {
      if (interactive && shouldClear) process.stdout.write("\r\x1b[2K");
      beaconVisible = false;
    }
  };

  const startBeacon = (activity: BeaconActivity, label: string, accent?: PaletteColor) => {
    if (!interactive) return;
    if (beaconTimer && beaconActivity === activity && beaconLabel === label && beaconAccent === accent) return;
    stopBeacon();
    beaconActivity = activity;
    beaconAccent = accent;
    beaconLabel = label;
    beaconStartedAt = Date.now();
    updateBeacon();
    if (!reduceMotion) beaconTimer = setInterval(updateBeacon, 80);
  };

  const reasoningOutput = interactive ? process.stdout : process.stderr;
  const reasoningPainter = interactive ? paint : paintLog;
  const reasoningStream = new TerminalReasoningStream(reasoningPainter, termWidth);
  const resizeStreams = () => {
    const width = getConversationWidth(process.stdout);
    markdownStream.setWidth(width);
    reasoningStream.setWidth(width);
  };
  if (interactive) chatState.refreshStreams = resizeStreams;
  const writeReasoning = (delta: string) => {
    if (options.thinkingEnabled === false) return;
    if (!reasoningOpen) {
      reasoningOpen = true;
      reasoningStartTime = Date.now();
      startBeacon("reasoning", "Reasoning");
      reasoningOutput.write(`\n  ${reasoningPainter.dim("reasoning")}\n`);
    }
    reasoningOutput.write(reasoningStream.write(delta));
  };

  const closeReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOutput.write(reasoningStream.flush());
    const durationSec = Math.max(0.1, (Date.now() - reasoningStartTime) / 1000).toFixed(1);
    reasoningOutput.write(`${reasoningPainter.dim(`  └─ thought for ${durationSec}s`)}\n\n`);
    reasoningOpen = false;
  };

  startBeacon(waitingActivity, waitingLabel);

  const reportStopped = () => {
    textPacer?.flushNow();
    closeReasoning();
    stopBeacon();
    if (interactive) {
      console.log(`\n  ${paint.text("×", "signal")} ${paint.dim("Turn stopped.")}\n`);
    }
  };

  const onInterrupt = () => {
    if (interrupted) {
      stream.abort();
      if (options.onInterrupt === "exit") process.exit(130);
      return;
    }
    interrupted = true;
    stopBeacon();
    const cancellation = request(`/v1/turns/${turnId}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (options.onInterrupt === "exit") {
      void cancellation.catch(() => undefined).finally(() => {
        if (options.onInterrupt === "exit") process.exit(130);
      });
      return;
    }
    cancelFallback = setTimeout(() => stream.abort(), 2_000);
    void cancellation.catch(() => stream.abort());
  };

  const useChatInterrupt = options.onInterrupt === "stop";
  if (useChatInterrupt) chatState.interrupt = onInterrupt;
  else process.once("SIGINT", onInterrupt);

  try {
    for await (const event of streamEvents(sessionId, after, stream.signal)) {
      if (event.turnId !== turnId) continue;
      options.contextRail?.apply(event);
      throughput.apply(event);
      activityLedger.apply(event);

      if (event.type === "model.request_started") {
        visiblePhase = null;
        roundHasReceivedTokens = false;
        if (typeof event.payload.model === "string") {
          modelName = event.payload.model;
        }
      }

      if (event.type === "model.context_trimmed" && interactive) {
        await drainResponse();
        const count = Array.isArray(event.payload.droppedTurnIds) ? event.payload.droppedTurnIds.length : 0;
        stopBeacon();
        console.log(paint.text(
          `Context window reached; dropped ${count} older turn${count === 1 ? "" : "s"}.`,
          "signal",
        ));
        startBeacon(waitingActivity, waitingLabel);
      }

      if (event.type === "reasoning.delta" && typeof event.payload.delta === "string") {
        await drainResponse();
        writeReasoning(event.payload.delta);
      }

      if (event.type === "message.delta" && typeof event.payload.delta === "string") {
        closeReasoning();
        if (!roundHasReceivedTokens) {
          roundHasReceivedTokens = true;
          startBeacon("generating", "Responding");
          if (interactive && !responseHeaderWritten) {
            responseHeaderWritten = true;
            const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            process.stdout.write(formatAssistantHeader(
              modelName,
              getConversationWidth(process.stdout),
              paint,
              options.providerName,
              timestamp,
            ));
          }
        }
        textPacer?.observe(event.payload.delta);
        writeResponse(markdownStream.write(event.payload.delta));
      }

      if (event.type === "permission.requested") {
        await drainResponse();
        closeReasoning();
        stopBeacon();
        if (shouldNotifyApproval(notificationOptions(interactive))) {
          notify(`Approval needed: ${String(event.payload.name ?? "a tool")}`, notificationOptions(interactive));
        }
        chatState.permissionActive = true;
        try {
          await resolvePermission(event, onInterrupt);
        } finally {
          chatState.permissionActive = false;
        }
      }

      if (event.type === "tool.call_started") {
        await drainResponse();
        const toolName = String(event.payload.name ?? "tool");
        const callId = String(event.payload.toolCallId ?? toolName);
        const badge = toolKindBadge(toolName);
        const activity = activityLedger.activity(callId);
        const phase = activity?.phase ?? "inspect";

        closeReasoning();
        stopBeacon();

        if (interactive && visiblePhase !== phase) {
          console.log(formatToolPhaseHeader(phase, Math.max(1, activityLedger.pendingCount(phase)), paint));
          visiblePhase = phase;
        }
        startBeacon(badge.beaconActivity, badge.title, badge.color);
      }

      if (["tool.call_completed", "tool.call_failed", "tool.call_denied", "tool.call_cancelled", "tool.call_interrupted"].includes(event.type)) {
        await drainResponse();
        const toolName = String(event.payload.name ?? "tool");
        const callId = String(event.payload.toolCallId ?? toolName);
        const activity = activityLedger.activity(callId);
        const phase = activity?.phase ?? "inspect";
        const state = activity?.state === "done" ? "done" : activity?.state === "denied" ? "denied" : "failed";

        stopBeacon();
        if (interactive) {
          if (visiblePhase !== phase) {
            console.log(formatToolPhaseHeader(phase, 1, paint));
            visiblePhase = phase;
          }
          const failureMessage = state === "failed" && typeof event.payload.message === "string"
            ? event.payload.message
            : undefined;
          console.log(formatToolResultLine(
            state,
            toolName,
            failureMessage ?? activity?.detail,
            activity?.durationMs,
            activityLedger.pendingCount(phase) === 0,
            getConversationWidth(process.stdout),
            paint,
            { linkPath },
          ));
          const diff = activity?.diff;
          if (state === "done" && diff) {
            for (const line of formatDiffPreview(diff.oldText, diff.newText, 12, paint)) {
              console.log(`    ${line}`);
            }
          }
        }
        const pending = activityLedger.snapshot().activities.find((candidate) =>
          candidate.state === "queued" || candidate.state === "running"
        );
        if (pending) {
          const pendingBadge = toolKindBadge(pending.name);
          startBeacon(pendingBadge.beaconActivity, pendingBadge.title, pendingBadge.color);
        } else {
          startBeacon(waitingActivity, waitingLabel);
        }
      }

      if (event.type === "turn.completed") {
        closeReasoning();
        const remaining = markdownStream.flush();
        if (remaining) writeResponse(remaining);
        await drainResponse();
        process.stdout.write("\n");
        stopBeacon();

        const [runtime, sessionState] = await Promise.all([
          request<RuntimeProfileStatus>("/v1/runtime").catch(() => null),
          request<SessionStateResponse>(`/v1/sessions/${sessionId}`).catch(() => null),
        ]);
        options.contextRail?.setRuntime(runtime);
        options.contextRail?.setBranch(sessionState?.session.workspace?.gitBranch ?? null);
        if (fixedFooter?.isActive()) fixedFooter.update("", currentRightStatus());

        if (interactive) {
          const duration = (Date.now() - startTime) / 1000;
          const measured = throughput.snapshot();
          const evidence = activityLedger.snapshot();
          console.log(formatTurnReceipt({
            durationSeconds: duration,
            rounds: Math.max(evidence.rounds, measured.measuredRounds),
            tools: evidence.tools,
            changes: evidence.changes,
            validations: evidence.validations,
            tokenCount: measured.outputTokens ?? undefined,
            tokensPerSec: measured.tokensPerSecond ?? undefined,
            timeToFirstTokenMs: measured.timeToFirstTokenMs ?? undefined,
            decodeTokensPerSec: measured.decodeTokensPerSecond ?? undefined,
            width: getConversationWidth(process.stdout),
            painter: paint,
          }));
        }
        const completionDurationMs = Date.now() - startTime;
        if (shouldNotifyCompletion({
          ...notificationOptions(interactive),
          durationMs: completionDurationMs,
          minimumDurationMs: settings.notifications.minimumDurationMs,
        })) {
          notify(`Turn complete in ${(completionDurationMs / 1000).toFixed(0)}s`, notificationOptions(interactive));
        }
        return "completed";
      }

      if (event.type === "turn.failed") {
        textPacer?.flushNow();
        closeReasoning();
        stopBeacon();
        const message = typeof event.payload.message === "string" ? event.payload.message : "Turn failed";
        const failureDurationMs = Date.now() - startTime;
        if (shouldNotifyCompletion({
          ...notificationOptions(interactive),
          durationMs: failureDurationMs,
          minimumDurationMs: settings.notifications.minimumDurationMs,
        })) {
          notify(`Turn failed after ${(failureDurationMs / 1000).toFixed(0)}s`, notificationOptions(interactive));
        }
        throw new Error(message);
      }

      if (event.type === "turn.cancelled") {
        reportStopped();
        return "stopped";
      }

      if (event.type === "turn.interrupted") {
        textPacer?.flushNow();
        closeReasoning();
        stopBeacon();
        const message = typeof event.payload.message === "string" ? event.payload.message : "Turn interrupted";
        throw new Error(message);
      }
    }
    stopBeacon();
    if (interrupted) {
      reportStopped();
      return "stopped";
    }
    return "completed";
  } finally {
    textPacer?.flushNow();
    stopBeacon();
    if (interactive && chatState.refreshStreams === resizeStreams) chatState.refreshStreams = undefined;
    if (chatState.refreshQueued === updateBeacon) chatState.refreshQueued = undefined;
    if (cancelFallback) clearTimeout(cancelFallback);
    if (useChatInterrupt) {
      if (chatState.interrupt === onInterrupt) chatState.interrupt = undefined;
    } else {
      process.removeListener("SIGINT", onInterrupt);
    }
    stream.abort();
  }
}

async function resolvePermission(event: EventEnvelope, onCancel?: () => void): Promise<void> {
  const permissionId = typeof event.payload.permissionId === "string" ? event.payload.permissionId : null;
  if (!permissionId) throw new Error("Permission event is missing its ID");
  const summary = sanitizeTerminalLine(typeof event.payload.summary === "string" ? event.payload.summary : "dangerous operation");
  const toolName = typeof event.payload.name === "string" ? event.payload.name : undefined;
  const rawArgs = event.payload.arguments;
  let decision: PermissionDecision = "deny";

  const previewRows: string[] = [];
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (toolName === "edit_file" && typeof parsed.oldText === "string" && typeof parsed.newText === "string") {
        previewRows.push(...formatDiffPreview(parsed.oldText, parsed.newText, 6, paintLog));
      } else if (toolName === "run_command" && Array.isArray(parsed.argv)) {
        previewRows.push(paintLog.text(`$ ${parsed.argv.map((value: unknown) => JSON.stringify(value)).join(" ")}`, "paper"));
      }
    } catch {}
  } else if (isRecord(rawArgs)) {
    if (toolName === "edit_file" && typeof rawArgs.oldText === "string" && typeof rawArgs.newText === "string") {
      previewRows.push(...formatDiffPreview(rawArgs.oldText, rawArgs.newText, 6, paintLog));
    } else if (toolName === "run_command" && Array.isArray(rawArgs.argv)) {
      previewRows.push(paintLog.text(`$ ${rawArgs.argv.map((value: unknown) => JSON.stringify(value)).join(" ")}`, "paper"));
    }
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const width = getTerminalWidth(process.stdout);
    const persistedRule = derivePersistedRule(toolName, rawArgs);
    console.log(formatPermissionCard(summary, toolName, width, paint, previewRows.length > 0 ? previewRows : undefined));
    const selection = await promptApprovalSelection(toolName !== "run_command", onCancel, persistedRule !== null);
    decision = selection.decision;
    if (decision === "allow_always" && persistedRule) {
      try {
        const existing = settings.loaded.config.permissions.allow;
        if (!existing.includes(persistedRule)) {
          updateUserConfig(settings.configPath, { permissions: { allow: [...existing, persistedRule] } });
          existing.push(persistedRule);
        }
      } catch (error) {
        decision = "allow_session";
        console.log(`\n  ${paint.text("!", "signal")} ${paint.dim(
          `Could not save the rule (${error instanceof Error ? error.message : String(error)}); allowed for this session instead.`,
        )}\n`);
      }
    }
    if (!selection.cancelledTurn) {
      const outcome = decision === "deny"
        ? "Denied"
        : decision === "allow_always"
          ? "Always allowed"
          : decision === "allow_session"
            ? "Allowed for session"
            : "Allowed once";
      console.log(`\n  ${paint.text("●", decision === "deny" ? "signal" : "citron")} ${paint.dim(`${outcome} — ${summary}`)}\n`);
    }
  } else {
    console.error(
      `  ${paintLog.bold("◆ APPROVAL", "signal")} ${paintLog.text(summary, "paper")} — ${paintLog.dim("denied (non-interactive)")}`,
    );
  }

  try {
    await request(`/v1/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  } catch (error) {
    // Ctrl-C and double-Escape cancel the turn while the permission selector is
    // still resolving its local keypress. The daemon then correctly rejects the
    // stale decision with 409 invalid_state. The following turn.cancelled event
    // is authoritative, so do not turn this expected race into a fatal CLI error.
    if (isStalePermissionResolution(error)) return;
    throw error;
  }
}

function promptApprovalSelection(
  allowSession: boolean,
  onCancel?: () => void,
  allowPersist = false,
): Promise<{ decision: PermissionDecision; cancelledTurn: boolean }> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  const approval = approvalOptions(allowSession, allowPersist);
  let selected = approval.selectedIndex;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const render = () => {
      output.write(`\r\x1b[2K${formatApprovalSelection(selected, allowSession, getTerminalWidth(output), paint, allowPersist)}`);
    };

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", render);
      input.setRawMode(Boolean(wasRaw));
      output.write("\r\x1b[2K");
    };

    const finish = (decision: PermissionDecision, cancelledTurn = false) => {
      cleanup();
      resolve({ decision, cancelledTurn });
    };

    const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      const next = reduceApprovalSelection(selected, allowSession, key, allowPersist);
      selected = next.selectedIndex;
      if (next.cancelledTurn) onCancel?.();
      if (next.decision) finish(next.decision, next.cancelledTurn);
      else render();
    };

    input.on("keypress", onKeypress);
    output.on("resize", render);
    render();
  });
}

async function* streamEvents(
  sessionId: string,
  after: number,
  signal?: AbortSignal,
): AsyncGenerator<EventEnvelope> {
  let cursor = after;
  let retryDelay = 100;
  while (!signal?.aborted) {
    try {
      const url = new URL("/v1/events", server);
      url.searchParams.set("session_id", sessionId);
      url.searchParams.set("after", String(cursor));
      const response = await fetch(url, {
        headers: {
          ...(cursor > 0 ? { "Last-Event-ID": String(cursor) } : {}),
          ...authHeaders(),
        },
        signal,
      });
      for await (const event of readServerSentEvents(response)) {
        cursor = Math.max(cursor, event.eventId);
        retryDelay = 100;
        yield event;
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof SyntaxError) throw error;
      if (error instanceof EventStreamHttpError && error.status >= 400 && error.status < 500) throw error;
    }
    await Bun.sleep(retryDelay);
    retryDelay = Math.min(retryDelay * 2, 2_000);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, server), {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = parseApiError(body) ?? `Request failed with HTTP ${response.status}`;
    throw new ApiRequestError(message, response.status, parseApiErrorCode(body));
  }
  return body as T;
}

function parseApiError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return null;
  return value.error.message;
}

function parseApiErrorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return null;
  return value.error.code;
}

function takeOption(command: string[], name: string): string | undefined {
  const index = command.indexOf(name);
  if (index === -1) return undefined;
  const value = command[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  command.splice(index, 2);
  return value;
}

function takeNumberOption(command: string[], name: string): number | undefined {
  const value = takeOption(command, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} requires a positive integer`);
  return parsed;
}

function takeThemeOption(command: string[], name: string): "dark" | "light" | "auto" | undefined {
  const value = takeOption(command, name);
  if (value === undefined) return undefined;
  if (!["dark", "light", "auto"].includes(value)) throw new Error(`${name} must be auto, dark, or light`);
  return value as "dark" | "light" | "auto";
}

async function ensureDaemonOrExit(): Promise<void> {
  const deps = createDaemonControlDependencies(server, settings.dataDirectory);
  const prompt = async (question: string): Promise<boolean> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(question)).trim();
      return answer === "" || /^y/i.test(answer);
    } finally {
      rl.close();
    }
  };
  const result = await ensureDaemon(deps, settings.autoStart, prompt);
  if (result.remember) {
    try {
      updateUserConfig(settings.configPath, { daemon: { auto_start: "always" } });
    } catch (error) {
      console.error(paintLog.dim(
        `  Could not save the auto-start preference: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }
}

async function runCommandCapture(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function printUsage(): void {
  console.log(`Usage:
  demesne [chat] [initial message]
  demesne setup [--provider-url <url> --model <id>] [--context-window <n>] [--max-output-tokens <n>] [--theme auto|dark|light] [--yes]
  demesne doctor [--json]
  demesne daemon start|stop|status|logs
  demesne prompt [--session <session-id>] [--permission ask|deny] <text>
  demesne session list
  demesne session create [--workspace <path>] [title]
  demesne session show <session-id>
  demesne models
  demesne cancel <turn-id>
  demesne events <session-id> [--after <event-id>]
  demesne --version

Options:
  --server <url>  Daemon URL (default: http://127.0.0.1:7337)

Configuration:
  ~/.demesne/config.toml and <workspace>/.demesne/config.toml are merged with
  environment variables; environment variables win. Run \`demesne setup\` to
  create the user config.`);
}

function authHeaders(): Record<string, string> {
  return daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {};
}

function loadDaemonToken(dataDirectory: string): string | undefined {
  const configured = process.env.DEMESNE_DAEMON_TOKEN?.trim();
  if (configured) return configured;
  const hostname = new URL(server).hostname;
  if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) return undefined;
  const path = join(dataDirectory, "daemon.token");
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

function validateServerUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Daemon URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Daemon URL must not contain credentials");
  const loopback = ["127.0.0.1", "[::1]", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Remote daemon connections require HTTPS");
  }
  return url.href;
}
