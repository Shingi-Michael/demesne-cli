#!/usr/bin/env bun

import {
  isRecord,
  type CancelTurnResponse,
  type CreateSessionResponse,
  type EventEnvelope,
  type ModelDescriptor,
  type PermissionDecision,
  type RuntimeProfileStatus,
  type Session,
  type SessionStateResponse,
  type SubmitTurnResponse,
  type TokenUsage,
  type TurnChangesResponse,
  type UndoTurnResponse,
  type UpdateSessionResponse,
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
  formatRelativeAge,
  formatTokenCount,
  formatToolPhaseHeader,
  formatToolResultLine,
  formatTurnReceipt,
  formatUserMessage,
  formatWelcomeCard,
  fileUrl,
  formatHyperlink,
  formatMentionMenu,
  humanToolTitle,
  presenceForTool,
  presenceLabel,
  renderBeaconText,
  renderPresence,
  renderSpinner,
  resolveSlashCommand,
  resolveTerminalTheme,
  SPINNER_PERIOD_MS,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  SLASH_COMMANDS,
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
  type PresenceState,
  type SlashCommand,
  type SlashCommandId,
} from "@demesne/brand";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { CliContextRail } from "./context-rail.ts";
import { TurnThroughputTracker } from "./turn-throughput.ts";
import { TurnActivityLedger, isValidationCommand, type TurnPhase } from "./turn-activity.ts";
import { TerminalTextPacer } from "./terminal-text-pacer.ts";
import { selectSessionInteractive, sessionListItem } from "./session-picker.ts";
import { matchModel, selectModelInteractive } from "./model-picker.ts";
import { reducedMotionEnabled } from "./motion.ts";
import { DemesneClient, isStalePermissionResolution } from "@demesne/client";
import { approvalOptions, formatApprovalSelection, reduceApprovalSelection } from "./approval-selection.ts";
import { applyFooterScrollRegion, resetFooterScrollRegion } from "./terminal-control.ts";
import { reduceInterruptKey } from "./interrupt-key.ts";
import { playTensorIntro } from "./tensor-intro.ts";
import { formatProcessView } from "./process-view.ts";
import { formatAmbientMemory, readAmbientMemory } from "./ambient.ts";
import { Workbench } from "./workbench/controller.ts";
import { checkForUpdate } from "./update-check.ts";
import { PromptHistory } from "./prompt-history.ts";
import { composeInEditor } from "./external-editor.ts";
import { createPromptEditorState, mentionMatches, mentionTokenAt, reducePromptEditor, reverseSearchMatches, setPromptValue } from "./prompt-editor.ts";
import { queueSummary, reduceQueuedInput } from "./input-queue.ts";
import { notify, shouldNotifyApproval, shouldNotifyCompletion, type NotificationOptions } from "./notifications.ts";
import { derivePersistedRule } from "./allow-rules.ts";
import { expandCustomCommand, loadCustomCommands, mergeSlashCommands, type CustomCommand } from "./custom-commands.ts";
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
import { renderHarnessDiff, renderHarnessHelp, renderHarnessStatus } from "./harness-panels.ts";
import { narrateTurnEnd } from "./voice.ts";
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
const client = new DemesneClient({ server, token: daemonToken });

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

/// Interactive confirmation for destructive commands. Non-interactive use
/// fails safe by returning false.
async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return /^y/i.test(answer);
  } finally {
    rl.close();
  }
}

function getTerminalWidth(stream: { columns?: number } = process.stdout): number {
  const cols = stream.columns ?? process.stdout.columns ?? 80;
  if (!cols || cols <= 0) return 80;
  return Math.max(18, cols - 2);
}

function getConversationWidth(stream: { columns?: number } = process.stdout): number {
  return Math.min(100, getTerminalWidth(stream));
}

async function readCommandPrompt(
  history: PromptHistory,
  mentions: readonly string[] = [],
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): Promise<string> {
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
    const matchingCommands = () => (state.menuDismissed ? [] : slashCommandMatches(state.value, commands).slice(0, 10));

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
  const first = args[0];
  const chatFlags = first !== undefined
    && first.startsWith("--")
    && !["--version", "--help"].includes(first);
  if (args.length === 0 || first === "chat" || chatFlags) {
    await runChat(first === "chat" ? args.slice(1) : args);
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
    const wantsCheck = command.includes("--check")
      || (Boolean(process.stdout.isTTY) && !command.includes("--no-check"));
    if (wantsCheck) {
      const update = await checkForUpdate({
        currentVersion: VERSION,
        cachePath: join(settings.dataDirectory, "update-check.json"),
      });
      if (update.updateAvailable && update.latest) {
        console.log(`Update available: ${update.latest} (current ${VERSION}).`);
      }
    }
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

  if (command[0] === "ps") {
    const json = command.includes("--json");
    const watch = command.includes("--watch");
    const render = async (): Promise<void> => {
      const status = await client.status();
      if (json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(formatProcessView(status, getTerminalWidth(process.stdout), paint));
    };
    if (watch && process.stdout.isTTY) {
      for (;;) {
        process.stdout.write("\x1b[2J\x1b[H");
        await render();
        await Bun.sleep(2_000);
      }
    }
    await render();
    return;
  }

  if (command[0] === "prompt") {
    const permissionMode = takeOption(command, "--permission") ?? (process.stdin.isTTY && process.stdout.isTTY ? "ask" : "deny");
    if (permissionMode !== "ask" && permissionMode !== "deny") throw new Error("--permission must be ask or deny");
    const output = takeOption(command, "--output") ?? "text";
    if (output !== "text" && output !== "json" && output !== "stream-json") {
      throw new Error("--output must be text, json, or stream-json");
    }
    const sessionOverride = takeOption(command, "--session");
    const planOnly = command.includes("--plan");
    if (planOnly) command.splice(command.indexOf("--plan"), 1);
    let content = command.slice(1).join(" ").trim();
    if (!content || content === "-") content = (await Bun.stdin.text()).trim();
    if (!content) throw new Error("prompt requires text");
    await ensureDaemonOrExit();
    const sessionId = sessionOverride ?? (await createAutomaticSession(command, output !== "text")).id;
    if (output === "text") {
      await submitAndRender(sessionId, content, permissionMode, undefined, "exit", false, undefined, undefined, undefined, planOnly);
      return;
    }
    const result = await runHeadlessTurn({ sessionId, content, permissionMode, planOnly, output });
    if (result.status === "failed") process.exitCode = 1;
    else if (result.status === "cancelled" || result.status === "interrupted") process.exitCode = 130;
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
    for await (const event of client.streamEvents(command[1], after)) console.log(JSON.stringify(event));
    return;
  }

  printUsage();
  if (command.length > 0) process.exitCode = 1;
}

async function createAutomaticSession(command: string[], quiet = false): Promise<Session> {
  const content = command.slice(1).join(" ").trim();
  const title = content.slice(0, 80) || "New session";
  const created = await request<CreateSessionResponse>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ title, workspacePath: process.cwd() }),
  });
  if (!quiet) console.error(`Session ${created.session.id}`);
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
  planOnly = false,
): Promise<"completed" | "stopped"> {
  const submitted = await request<SubmitTurnResponse>(`/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      content,
      permissionMode,
      ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
      ...(planOnly ? { planOnly: true } : {}),
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
  const noTui = command.includes("--no-tui") || process.env.DEMESNE_NO_TUI === "1";
  if (command.includes("--no-tui")) command.splice(command.indexOf("--no-tui"), 1);
  const useWorkbench = interactive && !noTui;
  const history = PromptHistory.load(join(settings.dataDirectory, "history.jsonl"));
  let mentionFiles: string[] = [];
  let customCommands: CustomCommand[] = loadCustomCommands(process.cwd());
  let allCommands: SlashCommand[] = mergeSlashCommands(SLASH_COMMANDS, customCommands);
  const refreshCustomCommands = (workspaceRoot: string): void => {
    customCommands = loadCustomCommands(workspaceRoot);
    allCommands = mergeSlashCommands(SLASH_COMMANDS, customCommands);
  };
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
  if (!useWorkbench) await playTensorIntro(paint);
  const [health, discoveredModels, runtimeStatus] = await boot;
  let activeModel = discoveredModels.find((model) => model.id === health?.model) ?? {
    id: health?.model ?? "model",
    provider: health?.provider ?? "local",
  };
  const initialState = await request<SessionStateResponse>(`/v1/sessions/${sessionId}`);
  mentionFiles = await fetchMentionFiles(sessionId);
  let currentWorkspace = initialState.session.workspace?.root ?? process.cwd();
  let sessionTitle = initialState.session.title;
  refreshCustomCommands(currentWorkspace);
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
  const workbench = useWorkbench
    ? new Workbench({
        paint,
        contextRail,
        sessionTitle: initialState.session.title,
        version: VERSION,
        workspaceRoot: currentWorkspace,
        onExit: () => leaveChat(),
        onInterrupt: () => chatState.interrupt?.(),
        queue: {
          get: () => chatState.queuedInput ?? "",
          set: (value) => {
            chatState.queuedInput = value;
            chatState.refreshQueued?.();
          },
        },
      })
    : null;
  if (!workbench) {
    chatState.footer = fixedFooter;
    fixedFooter.enable();
  }

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
  let ambientTimer: ReturnType<typeof setInterval> | undefined;
  restoreTerminalState = () => {
    if (ambientTimer) clearInterval(ambientTimer);
    workbench?.stop();
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
  if (workbench) {
    workbench.start();
    const refreshAmbient = async (): Promise<void> => {
      const used = await readAmbientMemory();
      if (workbench && used !== null) workbench.setAmbient(formatAmbientMemory(used, paint));
    };
    void refreshAmbient();
    ambientTimer = setInterval(() => void refreshAmbient(), 10_000);
    const turns = initialState.session.turns.length;
    if (turns > 0) {
      workbench.notice(
        `resumed · last active ${formatRelativeAge(initialState.session.updatedAt)} · `
          + `${turns} turn${turns === 1 ? "" : "s"} · ${sanitizeTerminalLine(initialState.session.title)}`,
      );
    }
  } else renderWelcome();

  /// Command output helper: the workbench appends blocks to the conversation,
  /// while the scrollback renderer prints directly.
  const emit = (text = ""): void => {
    if (workbench) workbench.showBlock(text.split("\n"));
    else console.log(text);
  };

  process.on("SIGINT", () => {
    if (chatState.streamActive) chatState.interrupt?.();
    else leaveChat();
  });

  const executePrompt = async (text: string, planOnly = false): Promise<void> => {
    if (workbench) {
      chatState.streamActive = true;
      chatState.queuedInput = undefined;
      contextRail.setModel(activeModel);
      workbench.setSessionTitle(sessionTitle);
      workbench.beginTurn({ userText: text, at: timeLabel(), planOnly });
      try {
        await runWorkbenchTurn({
          sessionId: sessionId!,
          content: text,
          permissionMode,
          planOnly,
          workbench,
          contextRail,
          paint,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Turn failed";
        workbench.finishTurn("failed", `Turn failed · ${sanitizeTerminalText(message)}`);
      } finally {
        chatState.streamActive = false;
        workbench.setPresence("idle");
        workbench.setFooter(`  ${renderPresence("idle", Date.now(), paint)} ${paint.dim("ready")}`, statusLineText());
      }
      return;
    }

    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const width = getConversationWidth(process.stdout);
    console.log(formatUserMessage(text, timeStr, width, paint));
    if (planOnly) console.log(`  ${paint.dim("plan · read-only tools · approve before changes")}`);

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
        planOnly,
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
      sessionTitle = result.session.title;
      workbench?.setSessionTitle(sessionTitle);
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
      refreshCustomCommands(currentWorkspace);
      const preferred = result.session.preferredModel;
      if (preferred && preferred !== activeModel.id) {
        emit(paint.dim(
          `This session last used ${sanitizeTerminalLine(preferred)}; active model is ${sanitizeTerminalLine(activeModel.id)}. `
            + `Use /model ${sanitizeTerminalLine(preferred)} to switch.`,
        ));
      }
      emit(`  ${paint.text("●", "citron")} Switched to ${paint.bold(sanitizeTerminalLine(result.session.title), "paper")} ${paint.dim(`(${sessionId.slice(0, 8)})`)}`);
    } catch {
      emit(`  ${paint.text(`Could not find session: ${targetId}`, "signal")}`);
    }
  };

  const slashHandlers: Partial<Record<SlashCommandId, (argument: string) => Promise<void>>> = {
    exit: async () => leaveChat(),
    undo: async (argument) => {
      try {
        const path = argument.trim();
        const result = await request<UndoTurnResponse>(`/v1/sessions/${sessionId}/undo`, {
          method: "POST",
          body: JSON.stringify(path ? { paths: [path] } : {}),
        });
        const suffix = result.complete ? "" : " · partial; run /undo again for the rest";
        emit(`  ${paint.text("●", "citron")} Reverted ${result.files.length} path${result.files.length === 1 ? "" : "s"} from turn ${paint.bold(result.turnId.slice(0, 8), "paper")}${paint.dim(suffix)}`);
        for (const file of result.files) emit(paint.dim(`    ↩ ${sanitizeTerminalLine(file)}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : "undo failed";
        emit(`  ${paint.text(message, "signal")}`);
      }
    },
    plan: async (argument) => {
      const text = sanitizeTerminalLine(argument).trim();
      if (!text) {
        emit(`  ${paint.text("Usage: /plan <prompt>", "signal")}`);
        return;
      }
      await executePrompt(text, true);
    },
    diff: async () => {
      try {
        const result = await request<TurnChangesResponse>(`/v1/sessions/${sessionId}/changes`);
        if (result.changes.length === 0) {
          emit(`  ${paint.dim("No changes to review.")}`);
          return;
        }
        if (workbench) {
          workbench.showPanel(renderHarnessDiff(result.changes, result.turnId, getTerminalWidth(process.stdout), paint));
          return;
        }
        const lines = [`  ${paint.bold("CHANGES", "paper")} ${paint.dim(`turn ${result.turnId.slice(0, 8)}`)}`];
        for (const change of result.changes) {
          const badge = change.operation === "A"
            ? paint.text("A", "citron")
            : change.operation === "D"
              ? paint.text("D", "signal")
              : paint.text("M", "electric");
          const reverted = change.reverted ? paint.dim(" · reverted") : "";
          lines.push(`  ${badge} ${paint.bold(sanitizeTerminalLine(change.path), "paper")}${reverted}`);
          if (change.binary) {
            lines.push(`    ${paint.dim("binary file · diff unavailable")}`);
            continue;
          }
          for (const line of change.diff) {
            const safe = sanitizeTerminalLine(line);
            lines.push(`    ${line.startsWith("+") ? paint.text(safe, "citron") : line.startsWith("-") ? paint.text(safe, "signal") : paint.dim(safe)}`);
          }
        }
        emit(lines.join("\n"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "diff failed";
        emit(`  ${paint.text(message, "signal")}`);
      }
    },
    clear: async () => {
      if (workbench) workbench.notice("view refreshed");
      else renderWelcome();
    },
    help: async () => {
      if (workbench) {
        workbench.showPanel(renderHarnessHelp(allCommands, getTerminalWidth(process.stdout), paint));
        return;
      }
      emit(formatHelpCard(paint, getTerminalWidth(process.stdout)));
    },
    new: async (customTitle) => {
      const title = sanitizeTerminalLine(customTitle).trim() || `Session ${new Date().toLocaleTimeString()}`;
      const created = await request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ title, workspacePath: process.cwd() }),
      });
      sessionId = created.session.id;
      sessionTitle = title;
      workbench?.setSessionTitle(title);
      currentWorkspace = created.session.workspace?.root ?? process.cwd();
      contextRail.setModel(activeModel);
      contextRail.hydrate(null, thinkingEnabled, currentWorkspace);
      contextRail.setBranch(created.session.workspace?.gitBranch ?? null);
      mentionFiles = await fetchMentionFiles(sessionId);
      refreshCustomCommands(currentWorkspace);
      emit(`  ${paint.text("●", "citron")} Started new session ${paint.bold(title, "paper")} ${paint.dim(`(${sessionId.slice(0, 8)})`)}`);
    },
    status: async () => {
      const current = await request<{ session: Session }>(`/v1/sessions/${sessionId}`).catch(() => null);
      if (workbench) {
        const runtime = await request<RuntimeProfileStatus>("/v1/runtime").catch(() => null);
        workbench.showPanel(renderHarnessStatus({
          title: current?.session.title ?? "Untitled",
          sessionId: sessionId!,
          turnCount: current?.session.turns.length ?? 0,
          model: activeModel.id,
          provider: activeModel.provider,
          contextWindow: activeModel.contextWindow,
          workspace: current?.session.workspace?.root ?? currentWorkspace,
          branch: current?.session.workspace?.gitBranch ?? null,
          runtime,
          width: getTerminalWidth(process.stdout),
          paint,
        }));
        return;
      }
      emit(formatInfoCard({
        sessionId: sessionId!,
        title: current?.session.title ?? "Untitled",
        turnCount: current?.session.turns.length ?? 0,
        model: activeModel.id,
        provider: activeModel.provider,
        contextWindow: activeModel.contextWindow,
        workspace: current?.session.workspace?.root ?? currentWorkspace,
        width: getTerminalWidth(process.stdout),
        painter: paint,
      }));
    },
    context: async () => {
      const state = await request<SessionStateResponse>(`/v1/sessions/${sessionId}`).catch(() => null);
      const contextWidth = Math.max(1, Math.min(72, getTerminalWidth(process.stdout) - 4));
      const detail = contextRail.lines(contextWidth, 100, paint);
      const grants = state?.sessionGrants ?? [];
      if (grants.length > 0) {
        detail.push(paint.bold("SESSION GRANTS", "secondary"));
        for (const grant of grants) {
          const scope = grant.pathPrefix ? ` under ${sanitizeTerminalLine(grant.pathPrefix)}/` : " (whole workspace)";
          detail.push(truncateText(paint.dim(`· ${sanitizeTerminalLine(grant.tool)}${scope}`), contextWidth));
        }
      }
      emit(detail.join("\n"));
    },
    sessions: async (argument) => {
      const query = argument.trim();
      const result = await request<{ sessions: Session[] }>(
        query ? `/v1/sessions?query=${encodeURIComponent(query)}` : "/v1/sessions",
      );
      const recent = result.sessions.slice(0, 10);
      if (query && recent.length === 0) {
        emit(`  ${paint.dim(`No sessions match "${sanitizeTerminalLine(query)}".`)}`);
        return;
      }
      if (recent.length === 0) return;
      if (workbench) {
        const currentIndex = Math.max(0, recent.findIndex((session) => session.id === sessionId));
        const selected = await workbench.choose(
          query ? `Sessions matching "${sanitizeTerminalLine(query)}"` : "Recent sessions",
          recent.map((session) => `${session.title}  ${paint.dim(`(${session.id.slice(0, 8)})`)}`),
          currentIndex,
        );
        if (selected === null) {
          emit(`  ${paint.dim("Session selection cancelled.")}`);
        } else if (recent[selected] && recent[selected]!.id !== sessionId) {
          await activateSession(recent[selected]!.id);
        }
        return;
      }
      emit(formatSessionsTable(recent.map(sessionListItem), sessionId, getTerminalWidth(process.stdout), paint));
      const selected = await selectSessionInteractive(recent, sessionId, paint);
      if (selected && selected.id !== sessionId) await activateSession(selected.id);
      else if (!selected) emit(`  ${paint.dim("Session selection cancelled.")}`);
    },
    resume: activateSession,
    model: async (argument) => {
      const discovered = await request<{ models: ModelDescriptor[] }>("/v1/models");
      const query = argument.trim();
      let selected: ModelDescriptor;
      if (query) {
        const match = matchModel(discovered.models, query);
        if ("error" in match) {
          emit(`  ${paint.text(match.error, "signal")}`);
          return;
        }
        selected = match.model;
      } else if (workbench) {
        const index = await workbench.choose(
          "Models",
          discovered.models.map((model) => `${model.id}${model.contextWindow ? paint.dim(` · ctx ${formatTokenCount(model.contextWindow)}`) : ""}`),
          Math.max(0, discovered.models.findIndex((model) => model.id === activeModel.id)),
        );
        if (index === null || !discovered.models[index]) {
          emit(`  ${paint.dim("Model selection cancelled.")}`);
          return;
        }
        selected = discovered.models[index]!;
      } else {
        const picked = await selectModelInteractive(discovered.models, activeModel.id, paint);
        if (!picked) {
          emit(`  ${paint.dim("Model selection cancelled.")}`);
          return;
        }
        selected = picked;
      }
      if (selected.id === activeModel.id) {
        emit(`  ${paint.dim(`${sanitizeTerminalLine(selected.id)} is already active.`)}`);
        return;
      }
      await request("/v1/model", { method: "POST", body: JSON.stringify({ model: selected.id }) });
      activeModel = selected;
      contextRail.setModel(selected);
      if (fixedFooter?.isActive()) fixedFooter.update("", statusLineText());
      await request(`/v1/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ preferredModel: selected.id }),
      }).catch(() => null);
      const context = selected.contextWindow ? paint.dim(` · ctx ${formatTokenCount(selected.contextWindow)}`) : "";
      emit(`  ${paint.text("●", "citron")} Switched to ${paint.bold(sanitizeTerminalLine(selected.id), "paper")}${context}`);
    },
    rename: async (argument) => {
      const title = sanitizeTerminalLine(argument).trim();
      if (!title) {
        emit(`  ${paint.text("Usage: /rename <title>", "signal")}`);
        return;
      }
      const result = await request<UpdateSessionResponse>(`/v1/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      sessionTitle = result.session.title;
      workbench?.setSessionTitle(sessionTitle);
      emit(`  ${paint.text("●", "citron")} Renamed to ${paint.bold(sanitizeTerminalLine(result.session.title), "paper")}`);
    },
    delete: async () => {
      const current = await request<{ session: Session }>(`/v1/sessions/${sessionId}`).catch(() => null);
      const title = current?.session.title ?? "this session";
      const confirmed = workbench
        ? await workbench.suspend(() => confirmPrompt(`Archive ${sanitizeTerminalLine(title)}? The transcript is kept. [y/N] `))
        : await confirmPrompt(`Archive ${sanitizeTerminalLine(title)}? The transcript is kept. [y/N] `);
      if (!confirmed) {
        emit(`  ${paint.dim("Archive cancelled.")}`);
        return;
      }
      await request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
      emit(`  ${paint.text("●", "citron")} Archived ${paint.bold(sanitizeTerminalLine(title), "paper")}`);
      await slashHandlers.new!("");
    },
    export: async (argument) => {
      const format = argument.trim().toLowerCase() || "md";
      if (format !== "md" && format !== "json") {
        emit(`  ${paint.text("Usage: /export [md|json]", "signal")}`);
        return;
      }
      const response = await fetch(new URL(`/v1/sessions/${sessionId}/export?format=${format}`, server), {
        headers: authHeaders(),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(parseApiError(body) ?? `Export failed with HTTP ${response.status}`);
      }
      const text = await response.text();
      const path = join(process.cwd(), `demesne-${sessionId!.slice(0, 8)}.${format}`);
      writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
      emit(`  ${paint.text("●", "citron")} Exported to ${paint.bold(sanitizeTerminalLine(path), "paper")}`);
    },
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
        line = workbench
          ? await workbench.readPrompt({ history: history.entries(), mentions: mentionFiles, commands: allCommands })
          : await readCommandPrompt(history, mentionFiles, allCommands);
      } catch {
        leaveChat();
      }
    }

    const input = line.trim();
    if (!input) continue;
    history.add(input, currentWorkspace);

    if (input.startsWith("/")) {
      const invocation = resolveSlashCommand(input, allCommands);
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
        const handler = slashHandlers[invocation.command.id];
        if (handler) {
          await handler(invocation.argument);
        } else {
          const custom = customCommands.find((entry) => entry.command.id === invocation.command.id);
          if (!custom) {
            console.log(`  ${paint.text(`Unknown command: ${invocation.matchedName}`, "signal")}\n`);
            continue;
          }
          await executePrompt(expandCustomCommand(custom, invocation.argument));
        }
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

/// Machine-readable turn execution for scripting and CI.
///
/// `json` prints one result object; `stream-json` prints every event envelope
/// as it arrives and then a final result line. Permission requests are denied
/// with a note on stderr because there is no interactive approval path.
interface HeadlessResult {
  sessionId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  response: string;
  rounds: number;
  tools: number;
  changes: Array<{ path: string; operation: string; state: string }>;
  validations: Array<{ command: string; state: string; exitCode?: number }>;
  usage: TokenUsage | null;
  metrics: { durationMs: number | null; timeToFirstTokenMs: number | null; queueDurationMs: number | null };
  error?: string;
}

async function runHeadlessTurn(options: {
  sessionId: string;
  content: string;
  permissionMode: "ask" | "deny";
  planOnly: boolean;
  output: "json" | "stream-json";
}): Promise<HeadlessResult> {
  const submitted = await request<SubmitTurnResponse>(`/v1/sessions/${options.sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      content: options.content,
      permissionMode: options.permissionMode,
      ...(options.planOnly ? { planOnly: true } : {}),
    }),
  });
  const ledger = new TurnActivityLedger();
  let response = "";
  let usage: TokenUsage | null = null;
  let metrics: HeadlessResult["metrics"] = { durationMs: null, timeToFirstTokenMs: null, queueDurationMs: null };
  let status: HeadlessResult["status"] = "completed";
  let error: string | undefined;

  for await (const event of client.streamEvents(options.sessionId, submitted.eventId)) {
    if (event.turnId !== submitted.turn.id) continue;
    if (options.output === "stream-json") console.log(JSON.stringify(event));
    ledger.apply(event);
    if (event.type === "message.delta" && typeof event.payload.delta === "string") response += event.payload.delta;
    if (event.type === "model.usage") {
      usage = {
        inputTokens: typeof event.payload.inputTokens === "number" ? event.payload.inputTokens : null,
        outputTokens: typeof event.payload.outputTokens === "number" ? event.payload.outputTokens : null,
        totalTokens: typeof event.payload.totalTokens === "number" ? event.payload.totalTokens : null,
        ...(typeof event.payload.cachedInputTokens === "number" ? { cachedInputTokens: event.payload.cachedInputTokens } : {}),
      };
    }
    if (event.type === "model.metrics") {
      metrics = {
        durationMs: typeof event.payload.durationMs === "number" ? event.payload.durationMs : null,
        timeToFirstTokenMs: typeof event.payload.timeToFirstTokenMs === "number" ? event.payload.timeToFirstTokenMs : null,
        queueDurationMs: typeof event.payload.queueDurationMs === "number" ? event.payload.queueDurationMs : null,
      };
    }
    if (event.type === "permission.requested") {
      const permissionId = typeof event.payload.permissionId === "string" ? event.payload.permissionId : null;
      if (permissionId) {
        console.error(`Permission denied (non-interactive): ${String(event.payload.summary ?? event.payload.name ?? "operation")}`);
        await request(`/v1/permissions/${permissionId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "deny" }),
        }).catch(() => undefined);
      }
    }
    if (event.type === "turn.failed") {
      status = "failed";
      error = typeof event.payload.message === "string" ? event.payload.message : "Turn failed";
      break;
    }
    if (event.type === "turn.cancelled") {
      status = "cancelled";
      break;
    }
    if (event.type === "turn.interrupted") {
      status = "interrupted";
      error = typeof event.payload.message === "string" ? event.payload.message : "Turn interrupted";
      break;
    }
    if (event.type === "turn.completed") break;
  }

  const evidence = ledger.snapshot();
  const result: HeadlessResult = {
    sessionId: options.sessionId,
    turnId: submitted.turn.id,
    status,
    response,
    rounds: evidence.rounds,
    tools: evidence.tools,
    changes: evidence.changes.map((change) => ({
      path: change.path,
      operation: change.operation,
      state: change.state,
    })),
    validations: evidence.validations.map((validation) => ({
      command: validation.command,
      state: validation.state,
      ...(validation.exitCode !== undefined ? { exitCode: validation.exitCode } : {}),
    })),
    usage,
    metrics,
    ...(error ? { error } : {}),
  };
  if (options.output === "json") console.log(JSON.stringify(result));
  else console.log(JSON.stringify({ type: "result", ...result }));
  return result;
}

/// Drives one turn inside the full-screen workbench: submits it, consumes the
/// event stream, updates the conversation and telemetry, and resolves approvals
/// in the workbench's input area. Persisted-rule handling stays here so the UI
/// controller never touches configuration.
async function runWorkbenchTurn(options: {
  sessionId: string;
  content: string;
  permissionMode: "ask" | "deny";
  planOnly: boolean;
  workbench: Workbench;
  contextRail: CliContextRail;
  paint: Painter;
}): Promise<void> {
  const submitted = await request<SubmitTurnResponse>(`/v1/sessions/${options.sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      content: options.content,
      permissionMode: options.permissionMode,
      ...(options.planOnly ? { planOnly: true } : {}),
    }),
  });

  const controller = new AbortController();
  chatState.interrupt = () => {
    void request(`/v1/turns/${submitted.turn.id}/cancel`, { method: "POST", body: JSON.stringify({}) })
      .catch(() => controller.abort());
  };

  const activity = new TurnActivityLedger();
  const throughput = new TurnThroughputTracker();
  const startedAt = Date.now();
  let presence: PresenceState = "thinking";
  let status: "completed" | "stopped" | "failed" = "completed";
  let failure: string | undefined;
  let softLimitWarned = false;
  const reduceMotion = reducedMotionEnabled();
  const pacer = reduceMotion ? null : new TerminalTextPacer({
    sink: (text) => options.workbench.assistantDelta(text),
  });

  const updateFooter = () => {
    const elapsed = ((Date.now() - startedAt) / 1_000).toFixed(1);
    const speed = throughput.snapshot().tokensPerSecond;
    const queued = queueSummary(chatState.queuedInput ?? "");
    const left = `  ${renderPresence(presence, Date.now(), options.paint)} `
      + `${options.paint.bold(presenceLabel(presence), "paper")} ${options.paint.dim(
        `· ${elapsed}s${speed === null ? "" : ` · ${speed.toFixed(0)} tok/s`}${queued ? ` · noted ${queued}` : ""}`,
      )}`;
    options.workbench.setPresence(presence);
    options.workbench.setFooter(left, options.contextRail.statusLine(getTerminalWidth(process.stdout), options.paint));
  };
  const footerTimer = setInterval(updateFooter, 120);
  updateFooter();

  try {
    for await (const event of client.streamEvents(options.sessionId, submitted.eventId, controller.signal)) {
      if (event.turnId !== submitted.turn.id) continue;
      options.contextRail.apply(event);
      activity.apply(event);
      throughput.apply(event);

      if (event.type === "model.request_started") {
        // Flush paced text first so the previous round's prose is complete
        // before the new round opens a fresh paragraph.
        if (pacer) await pacer.drain();
        options.workbench.beginRound();
        presence = "thinking";
        const plan = event.payload.contextPlan;
        if (!softLimitWarned && isRecord(plan) && plan.budgetStatus === "over_soft_limit") {
          softLimitWarned = true;
          options.workbench.notice("I’m past the soft limit — I’ll keep our history intact and compact only if I must.", "info");
        }
      } else if (event.type === "reasoning.delta" && typeof event.payload.delta === "string") {
        presence = "reasoning";
        options.workbench.reasoningDelta(event.payload.delta);
      } else if (event.type === "message.delta" && typeof event.payload.delta === "string") {
        presence = "writing";
        if (pacer) {
          pacer.observe(event.payload.delta);
          pacer.write(event.payload.delta);
        } else {
          options.workbench.assistantDelta(event.payload.delta);
        }
      } else if (event.type === "tool.call_requested") {
        // Drain first: the tool row must appear after the prose that announced
        // it, not in the middle of a still-buffered sentence.
        if (pacer) await pacer.drain();
        const name = String(event.payload.name ?? "tool");
        options.workbench.toolRequested({
          toolCallId: String(event.payload.toolCallId ?? ""),
          name,
          arguments: event.payload.arguments,
        });
        presence = presenceForTool(name, isValidationCommand(toolDetailForPresence(name, event.payload.arguments)));
      } else if (event.type === "tool.call_started") {
        const name = String(event.payload.name ?? "tool");
        presence = presenceForTool(name, false);
      } else if (["tool.call_completed", "tool.call_failed", "tool.call_denied", "tool.call_cancelled", "tool.call_interrupted"].includes(event.type)) {
        const state = event.type === "tool.call_completed" && event.payload.timedOut !== true
          && (typeof event.payload.exitCode !== "number" || event.payload.exitCode === 0)
          ? "done"
          : event.type === "tool.call_denied" ? "denied" : "failed";
        options.workbench.toolFinished({
          toolCallId: String(event.payload.toolCallId ?? ""),
          name: String(event.payload.name ?? "tool"),
          state,
          ...(typeof event.payload.durationMs === "number" ? { durationMs: event.payload.durationMs } : {}),
          ...(state === "failed" && typeof event.payload.message === "string" ? { message: event.payload.message } : {}),
        });
        presence = "thinking";
      } else if (event.type === "model.context_trimmed") {
        const count = Array.isArray(event.payload.droppedTurnIds) ? event.payload.droppedTurnIds.length : 0;
        options.workbench.notice(`Context window reached; dropped ${count} older turn${count === 1 ? "" : "s"}.`, "info");
      } else if (event.type === "permission.requested") {
        if (pacer) await pacer.drain();
        const permissionId = typeof event.payload.permissionId === "string" ? event.payload.permissionId : null;
        const toolName = typeof event.payload.name === "string" ? event.payload.name : undefined;
        const summary = typeof event.payload.summary === "string" ? event.payload.summary : "operation";
        const rawArgs = event.payload.arguments;
        const rule = derivePersistedRule(toolName, rawArgs);
        const toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : null;
        let decision: PermissionDecision = "deny";
        if (permissionId) {
          presence = "waiting";
          if (toolCallId) options.workbench.toolWaiting(toolCallId, true);
          updateFooter();
          decision = await options.workbench.askApproval({
            summary,
            toolName,
            previewRows: permissionPreviewRows(toolName, rawArgs, options.paint),
            allowPersist: rule !== null,
          });
          if (toolCallId) options.workbench.toolWaiting(toolCallId, false);
          presence = "working";
          if (decision === "allow_always" && rule) {
            try {
              const existing = settings.loaded.config.permissions.allow;
              if (!existing.includes(rule)) {
                updateUserConfig(settings.configPath, { permissions: { allow: [...existing, rule] } });
                existing.push(rule);
              }
            } catch {
              decision = "allow_session";
            }
          }
          await request(`/v1/permissions/${permissionId}`, {
            method: "POST",
            body: JSON.stringify({ decision }),
          }).catch(() => undefined);
        }
      } else if (event.type === "turn.completed") {
        status = "completed";
        presence = "done";
        break;
      } else if (event.type === "turn.cancelled") {
        status = "stopped";
        presence = "stopped";
        break;
      } else if (event.type === "turn.failed") {
        status = "failed";
        presence = "error";
        failure = typeof event.payload.message === "string" ? event.payload.message : "Turn failed";
        break;
      } else if (event.type === "turn.interrupted") {
        status = "failed";
        presence = "error";
        failure = typeof event.payload.message === "string" ? event.payload.message : "Turn interrupted";
        break;
      }
      updateFooter();
    }
  } finally {
    clearInterval(footerTimer);
    if (pacer) await pacer.drain();
    chatState.interrupt = undefined;
    controller.abort();
  }

  const evidence = activity.snapshot();
  const duration = ((Date.now() - startedAt) / 1_000).toFixed(1);
  const measured = throughput.snapshot();
  const speed = measured.decodeTokensPerSecond ?? measured.tokensPerSecond;
  const findings = `${evidence.tools} finding${evidence.tools === 1 ? "" : "s"}`;
  const details = status === "completed"
    ? `${duration}s · ${evidence.rounds} round${evidence.rounds === 1 ? "" : "s"} · ${evidence.tools} tool${evidence.tools === 1 ? "" : "s"}`
      + (measured.outputTokens ? ` · ${measured.outputTokens} tok` : "")
      + (speed ? ` · ${speed.toFixed(1)} tok/s` : "")
    : status === "stopped"
      ? `after ${duration}s I kept ${findings}`
      : failure ? sentence(failure) : "";
  options.workbench.finishTurn(status, narrateTurnEnd(status, details));
}

function sentence(value: string): string {
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return (text.length > 200 ? `${text.slice(0, 199)}…` : text).replace(/[.!?]+$/, "");
}

/// Best-effort command extraction for presence purposes; the activity ledger
/// owns the full detail rendering.
function toolDetailForPresence(name: string, rawArguments: unknown): string {
  if (name !== "run_command" || typeof rawArguments !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (isRecord(parsed) && Array.isArray(parsed.argv) && parsed.argv.every((value) => typeof value === "string")) {
      return (parsed.argv as string[]).join(" ");
    }
  } catch {
    // Fall through to the non-validation state.
  }
  return "";
}

function permissionPreviewRows(toolName: string | undefined, rawArgs: unknown, painter: Painter): string[] {
  const rows: string[] = [];
  let parsed: Record<string, unknown> | null = null;
  if (typeof rawArgs === "string") {
    try {
      const value: unknown = JSON.parse(rawArgs);
      if (isRecord(value)) parsed = value;
    } catch {
      parsed = null;
    }
  } else if (isRecord(rawArgs)) {
    parsed = rawArgs;
  }
  if (!parsed) return rows;
  if (toolName === "edit_file" && typeof parsed.oldText === "string" && typeof parsed.newText === "string") {
    rows.push(...formatDiffPreview(parsed.oldText, parsed.newText, 6, painter));
  } else if (toolName === "run_command" && Array.isArray(parsed.argv)) {
    rows.push(painter.text(`$ ${parsed.argv.map((value: unknown) => JSON.stringify(value)).join(" ")}`, "paper"));
  }
  return rows;
}

function timeLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
    for await (const event of client.streamEvents(sessionId, after, stream.signal)) {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return client.request<T>(path, init);
}

function parseApiError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return null;
  return value.error.message;
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
  demesne [chat] [initial message] [--no-tui]
  demesne setup [--provider-url <url> --model <id>] [--context-window <n>] [--max-output-tokens <n>] [--theme auto|dark|light] [--yes]
  demesne doctor [--json]
  demesne daemon start|stop|status|logs
  demesne ps [--watch] [--json]
  demesne prompt [--session <session-id>] [--permission ask|deny] [--output text|json|stream-json] [--plan] <text>
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
