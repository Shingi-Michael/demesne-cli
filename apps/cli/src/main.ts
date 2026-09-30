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
  renderPresence,
  renderSpinner,
  resolveSlashCommand,
  resolveTheme,
  themeLabel,
  themeNames,
  SPINNER_PERIOD_MS,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  SLASH_COMMANDS,
  SLASH_MENU_LIMIT,
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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { CliContextRail } from "./context-rail.ts";
import { TurnThroughputTracker } from "./turn-throughput.ts";
import { TurnActivityLedger, isValidationCommand, type TurnPhase } from "./turn-activity.ts";
import { TerminalTextPacer } from "./terminal-text-pacer.ts";
import { loadRecentSessions } from "./recent-sessions.ts";
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
import { AgentDrive, type DriveControl } from "./agent-drive.ts";
import { inspectDrive } from "./drive-inspection.ts";
import { createHash } from "node:crypto";
import { checkForUpdate } from "./update-check.ts";
import { PromptHistory } from "./prompt-history.ts";
import { composeInEditor } from "./external-editor.ts";
import { createPromptEditorState, expandMentions, mentionMatches, mentionTokenAt, reducePromptEditor, reverseSearchMatches, setPromptValue } from "./prompt-editor.ts";
import { queueSummary, reduceQueuedInput, settleQueuedInput } from "./input-queue.ts";
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
import { isPlaceholderTitle, titleFromRequest } from "./session-title.ts";
import { beginOpenRouterLogin, configureOpenRouter } from "./openrouter-auth.ts";
import { renderHarnessDiff, renderHarnessHelp, renderHarnessStatus } from "./harness-panels.ts";
import { replaySession } from "./workbench/history.ts";
import { toolCompletion } from "./workbench/tool-result.ts";
import { narrateTurnEnd, sentence } from "./voice.ts";
import { updateUserConfig } from "@demesne/config";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const settings = loadSettings();
const server = validateServerUrl(settings.server);
const daemonToken = loadDaemonToken(settings.dataDirectory);
const colorEnabled = (stream: { isTTY?: boolean }) => Boolean(stream.isTTY) && !process.env.NO_COLOR;
const activeTheme = resolveTheme(
  settings.theme === "auto" ? undefined : settings.theme,
  process.env.COLORFGBG,
);
const paint = createPainter(colorEnabled(process.stdout), activeTheme);
const paintLog = createPainter(colorEnabled(process.stderr), activeTheme);
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
  lastTurnOutcome?: "completed" | "stopped" | "failed";
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

  const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }): void => {
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

/// Consumes any type-ahead text queued during the previous turn: sent as the
/// next prompt, or returned as an editable draft when the turn did not complete.
function takeQueuedInput(): { send?: string; draft?: string } {
  const settled = settleQueuedInput(chatState.queuedInput, chatState.lastTurnOutcome ?? "completed");
  chatState.queuedInput = undefined;
  return settled;
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
  draft?: string,
): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  let state = draft ? setPromptValue(createPromptEditorState(), draft) : createPromptEditorState();
  let prevCursorVisualLine = 0;
  let prevTotalLines = 1;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const matchingCommands = () => (state.menuDismissed ? [] : slashCommandMatches(state.value, commands).slice(0, SLASH_MENU_LIMIT));

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
      const mentionCandidates = !state.mentionDismissed && mention && mentions.length > 0 ? mentionMatches(mentions, mention.query) : [];
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
    if (!result.open) { console.log(paint.dim("    Next: `demesne doctor`, then `demesne`.")); return; }
    // "Open demesne here": a daemon already running keeps its old provider
    // until it restarts, and stopping it could end other sessions' turns.
    const status = await daemonStatus(createDaemonControlDependencies(server, settings.dataDirectory));
    if (status.running && status.health?.model !== result.model) {
      console.log(paint.dim(`    The running daemon still uses ${sanitizeTerminalText(status.health?.model ?? "the previous model")}. Run \`demesne daemon stop\`, then \`demesne\`.`));
      return;
    }
    await runChat([]);
    return;
  }

  if (command[0] === "auth") {
    if (command[1] !== "login" || command[2] !== "openrouter") throw new Error("Usage: demesne auth login openrouter [--model <id>] [--no-browser]");
    const model = takeOption(command, "--model");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    const login = process.env.OPENROUTER_API_KEY?.trim() ? undefined : beginOpenRouterLogin({ signal: controller.signal });
    try {
      if (login) {
        console.log(`Authorize Demesne in your browser:\n${login.url}`);
        if (!command.includes("--no-browser")) {
          const opener = process.platform === "darwin" ? ["open", login.url]
            : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", login.url] : ["xdg-open", login.url];
          try { await Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" }).exited; }
          catch { console.log("Open the authorization URL above to continue."); }
        }
      }
      const result = await configureOpenRouter({ apiKey: login ? await login.key : process.env.OPENROUTER_API_KEY!,
        configPath: settings.configPath, model, signal: controller.signal });
      console.log(`Connected OpenRouter. Credential saved to ${result.configPath}.`);
      console.log(`Model: ${result.model} · context ${result.contextWindow} · output ${result.maxOutputTokens}`);
      console.log(`Restart the daemon, then select /model ${result.model}.`);
    } finally { process.removeListener("SIGINT", cancel); await login?.close(); }
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

  if (command[0] === "compact") {
    if (!command[1]) throw new Error("Usage: demesne compact <session-id> [instructions]");
    await ensureDaemonOrExit();
    const submitted = await client.compactSession(command[1], { instructions: command.slice(2).join(" ") });
    await renderTurn(command[1], submitted.turn.id, submitted.eventId, { onInterrupt: "exit", interactive: false, thinkingEnabled: false });
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
  compactInstructions?: string,
): Promise<"completed" | "stopped"> {
  const submitted = compactInstructions !== undefined ? await client.compactSession(sessionId, { instructions: compactInstructions })
    : await request<SubmitTurnResponse>(`/v1/sessions/${sessionId}/turns`, {
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
  const mentionFiles: string[] = [];
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
    request<{ provider: string; model: string; contextCapacity?: number }>("/healthz").catch(() => undefined),
    request<RuntimeProfileStatus>("/v1/runtime").catch(() => null),
    request<SessionStateResponse>(`/v1/sessions/${sessionId}`),
  ]);
  if (!useWorkbench) await playTensorIntro(paint);
  const [health, runtimeStatus, initialState] = await boot;
  // Opening the UI needs local daemon facts, not network discovery across every
  // configured provider. Discover the catalog only when opening /model.
  let activeModel: ModelDescriptor = {
    id: health?.model ?? "model",
    provider: health?.provider ?? "local",
  };
  // The configured window is local metadata, available even when inference
  // providers are offline. Saved sessions hydrate their own recorded plan below.
  const configuredWindow = runtimeStatus?.expected?.contextWindow
    ?? runtimeStatus?.observed?.contextWindow
    ?? health?.contextCapacity
    ?? undefined;
  if (activeModel.contextWindow === undefined && configuredWindow !== undefined) {
    activeModel = { ...activeModel, contextWindow: configuredWindow };
  }
  let currentWorkspace = initialState.session.workspace?.root ?? process.cwd();
  let sessionTitle = initialState.session.title;
  refreshCustomCommands(currentWorkspace);
  const contextRail = new CliContextRail(activeModel, currentWorkspace);
  contextRail.hydrate(initialState.latestProviderCall, thinkingEnabled, currentWorkspace);
  contextRail.setBranch(initialState.session.workspace?.gitBranch ?? null);
  contextRail.setRuntime(runtimeStatus);
  const fixedFooter = new CliFixedFooter();
  let drive: AgentDrive | null = null;
  const controlDrive = (control: DriveControl): void => {
    try {
      // A saved mission belongs to its own session; this one starts without it.
      const home = drive?.state?.homeSessionId;
      if (home && home !== sessionId) {
        workbench?.notice(`That Drive mission belongs to another session (/resume ${home}). Start a new one here with /drive <mission>.`, "error");
        return;
      }
      drive?.control(control);
      if (control === "stop" && drive?.state?.homeSessionId === sessionId && chatState.streamActive) chatState.interrupt?.();
    } catch (error) { workbench?.notice(error instanceof Error ? error.message : "Drive could not continue.", "error"); }
  };
  const workbench = useWorkbench
    ? new Workbench({
        paint,
        contextRail,
        sessionTitle: initialState.session.title,
        version: VERSION,
        workspaceRoot: currentWorkspace,
        files: () => sessionId ? client.listWorkspaceFiles(sessionId) : Promise.resolve([]),
        fileInfo: () => sessionId ? client.listWorkspaceFileInfo(sessionId) : Promise.resolve([]),
        preview: {
          preferences: join(settings.dataDirectory, `preview-${Buffer.from(client.server).toString("base64url")}.json`),
          content: (artifact, variant, signal) => client.artifactContent(artifact, variant, signal),
          open: async (artifact) => {
            const bytes = await client.artifactContent(artifact, "original");
            const root = join(settings.dataDirectory, "preview-cache");
            mkdirSync(root, { recursive: true, mode: 0o700 });
            const extension = artifact.mimeType === "image/jpeg" ? "jpg" : artifact.mimeType === "image/webp" ? "webp" : "png";
            const path = join(root, `${artifact.sha256}.${extension}`);
            await Bun.write(path, bytes, { mode: 0o600 });
            const process = Bun.spawn([globalThis.process.platform === "darwin" ? "open" : "xdg-open", path], { stdout: "ignore", stderr: "ignore" });
            if (await process.exited !== 0) throw new Error("Could not open original image");
          },
        },
        onExit: () => leaveChat(),
        onInterrupt: () => chatState.interrupt?.(),
        drive: { control: controlDrive, intervene: () => drive?.intervene() },
        queue: {
          get: () => chatState.queuedInput ?? "",
          set: (value) => {
            chatState.queuedInput = value;
            chatState.refreshQueued?.();
          },
        },
      })
    : null;
  const loadDrive = (): void => {
    if (!workbench) return;
    drive?.dispose();
    drive = new AgentDrive({
      continuous: true,
      limits: settings.loaded.config.drive,
      cancelWorker: async (turnId, signal) => {
        signal.throwIfAborted();
        const result = await client.request<import("@demesne/protocol").CancelTurnResponse>(`/v1/turns/${turnId}/cancel`, { method: "POST", body: "{}", signal });
        return result.turn.status === "cancelled";
      },
      path: join(settings.dataDirectory, "drive", `${createHash("sha256").update(`${client.server}\n${currentWorkspace}`).digest("hex")}.json`),
      observe: () => workbench.observeDrive(), perform: (action, observation, signal) => workbench.performDrive(action, observation, signal),
      inspect: (action, observation, signal, activity) => inspectDrive({ observe: () => workbench.observeDrive(), perform: (action, observation, signal) => workbench.performDrive(action, observation, signal) }, action, observation, signal, activity),
      decide: (body, signal, progress) => client.decideDrive(body, signal, progress), changed: (state) => workbench.setDrive(state),
    });
  };
  loadDrive();
  let mentionRevision = 0;
  const refreshMentionFiles = (targetId: string): void => {
    const revision = ++mentionRevision;
    // Keep the array shared with an already-waiting scrollback prompt too.
    mentionFiles.length = 0;
    workbench?.setMentionFiles(mentionFiles);
    void fetchMentionFiles(targetId).then((files) => {
      if (sessionId !== targetId || revision !== mentionRevision) return;
      for (const file of files) mentionFiles.push(file);
      workbench?.setMentionFiles(mentionFiles);
    });
  };
  const restoreArtifacts = async (targetId: string): Promise<void> => {
    if (!workbench) return;
    try {
      let after = 0;
      do {
        const page = await client.listArtifacts(targetId, after);
        if (sessionId !== targetId) break;
        page.artifacts.forEach((artifact) => workbench.addArtifact(artifact));
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      } while (true);
    } catch { /* Older daemons and sessions without artifact support still load. */ }
  };
  const restoreWorkbench = async (state: SessionStateResponse): Promise<void> => {
    refreshMentionFiles(state.session.id);
    if (!workbench) return;
    try {
      const events = await replaySession(state, (id, after, signal) => client.streamEvents(id, after, signal),
        (id, after, through, signal) => client.replayPage(id, after, through, signal));
      workbench.restoreSession(state, events);
      drive?.reconcileWorker(state, events);
    } catch {
      workbench.restoreSession(state);
      workbench.notice("Saved answers loaded; detailed event history could not be replayed.", "error");
    }
    // Recent sessions feed the start screen and the History panel alike.
    {
      workbench.setRecentSessions([], "loading");
      void loadRecentSessions(state, {
        list: () => request<{ sessions: Session[] }>("/v1/sessions").then((result) => result.sessions),
        state: (id) => request<SessionStateResponse>(`/v1/sessions/${id}`),
      }).then((sessions) => {
        if (sessionId === state.session.id) workbench.setRecentSessions(sessions);
      }).catch(() => {
        if (sessionId === state.session.id) workbench.setRecentSessions([], "unavailable");
      });
    }
    // Artifact metadata and workspace completion lists hydrate independently;
    // neither should hold the prompt hostage while walking a large history/tree.
    void restoreArtifacts(state.session.id);
  };
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
    drive?.dispose();
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
    await restoreWorkbench(initialState);
    workbench.start();
    const refreshAmbient = async (): Promise<void> => {
      const used = await readAmbientMemory();
      if (workbench && used !== null) workbench.setAmbient(formatAmbientMemory(used, paint));
    };
    void refreshAmbient();
    ambientTimer = setInterval(() => void refreshAmbient(), 10_000);
  } else { refreshMentionFiles(initialState.session.id); renderWelcome(); }

  /// Command output helper: the workbench appends blocks to the conversation,
  /// while the scrollback renderer prints directly.
  const emit = (text = ""): void => {
    if (workbench) workbench.showBlock(text.split("\n"));
    else console.log(text);
  };

  /// One-line command feedback in the harness voice.
  ///
  /// The workbench renders it as a notice on the grid with a status glyph from
  /// the harness vocabulary; the scrollback path keeps its long-standing form.
  /// Callers pass plain text so each renderer owns the styling.
  const say = (text: string, tone: "info" | "success" | "error" = "info"): void => {
    if (workbench) {
      workbench.notice(text, tone);
      return;
    }
    const glyph = tone === "success" ? "●" : tone === "error" ? "×" : "·";
    const color = tone === "success" ? "citron" : tone === "error" ? "signal" : "secondary";
    const body = tone === "error" ? paint.text(text, "signal") : paint.dim(text);
    console.log(`  ${paint.text(glyph, color)} ${body}`);
  };

  process.on("SIGINT", () => {
    if (chatState.streamActive) chatState.interrupt?.();
    else leaveChat();
  });

  const executePrompt = async (text: string, planOnly = false, compactInstructions?: string): Promise<void> => {
    if (workbench) {
      chatState.streamActive = true;
      chatState.queuedInput = undefined;
      contextRail.setModel(activeModel);
      workbench.setSessionTitle(sessionTitle);
      contextRail.begin(compactInstructions !== undefined ? false : thinkingEnabled);
      workbench.beginTurn({ userText: text, at: timeLabel(), planOnly, compaction: compactInstructions !== undefined });
      chatState.lastTurnOutcome = "failed";
      try {
        chatState.lastTurnOutcome = await runWorkbenchTurn({
          sessionId: sessionId!,
          content: text,
          permissionMode,
          planOnly,
          compactInstructions,
          workbench,
          workerStarted: (content, turnId) => drive?.workerStarted(sessionId!, content, turnId),
          workerEvent: (event) => drive?.workerEvent(event),
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
    chatState.lastTurnOutcome = "failed";
    try {
      chatState.lastTurnOutcome = await submitAndRender(
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
        compactInstructions,
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
      if (drive?.active && result.session.workspace?.root !== drive.state?.workspace) {
        say("Drive can inspect sessions in its mission workspace. Pause it before switching workspaces."); return;
      }
      const previousWorkspace = currentWorkspace;
      sessionId = result.session.id;
      sessionTitle = result.session.title;
      workbench?.setSessionTitle(sessionTitle);
      currentWorkspace = result.session.workspace?.root ?? process.cwd();
      if (currentWorkspace !== previousWorkspace) loadDrive();
      contextRail.setModel(activeModel);
      // hydrate uses the recorded model and context plan, even if that provider
      // is offline. Resuming a saved conversation never needs model discovery.
      contextRail.hydrate(result.latestProviderCall, thinkingEnabled, currentWorkspace);
      contextRail.setBranch(result.session.workspace?.gitBranch ?? null);
      refreshCustomCommands(currentWorkspace);
      await restoreWorkbench(result);
      const preferred = result.session.preferredModel;
      if (preferred && preferred !== activeModel.id) {
        emit(paint.dim(
          `This session last used ${sanitizeTerminalLine(preferred)}; active model is ${sanitizeTerminalLine(activeModel.id)}. `
            + `Use /model ${sanitizeTerminalLine(preferred)} to switch.`,
        ));
      }
      say(`Switched to ${sanitizeTerminalLine(result.session.title)} (${sessionId.slice(0, 8)})`, "success");
    } catch {
      say(`Could not find session: ${targetId}`, "error");
    }
  };

  const slashHandlers: Partial<Record<SlashCommandId, (argument: string) => Promise<void>>> = {
    exit: async () => leaveChat(),
    drive: async (argument) => {
      if (!workbench || !drive) { say("Agent Drive needs the native workbench.", "error"); return; }
      try {
        const value = argument.trim();
        if (value === "pause" || value === "resume" || value === "stop") controlDrive(value);
        else if (value && value !== "status") drive.start(value);
        workbench.showDrive();
      } catch (error) { say(error instanceof Error ? error.message : "Drive could not start.", "error"); }
    },
    compact: async (instructions) => executePrompt(`/compact${instructions ? ` ${instructions}` : ""}`, false, instructions),
    undo: async (argument) => {
      try {
        const path = argument.trim();
        const result = await request<UndoTurnResponse>(`/v1/sessions/${sessionId}/undo`, {
          method: "POST",
          body: JSON.stringify(path ? { paths: [path] } : {}),
        });
        const suffix = result.complete ? "" : " · partial, run /undo again for the rest";
        const names = result.files.slice(0, 3).map((file) => sanitizeTerminalLine(file)).join(", ");
        const more = result.files.length > 3 ? ` +${result.files.length - 3}` : "";
        say(`Reverted ${result.files.length} path${result.files.length === 1 ? "" : "s"} from turn ${result.turnId.slice(0, 8)} · ${names}${more}${suffix}`, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "undo failed";
        say(message, "error");
      }
    },
    plan: async (argument) => {
      const text = sanitizeTerminalText(argument).trim();
      if (!text) {
        say("Usage: /plan <prompt>", "error");
        return;
      }
      await executePrompt(text, true);
    },
    diff: async () => {
      try {
        const result = await request<TurnChangesResponse>(`/v1/sessions/${sessionId}/changes`);
        if (result.changes.length === 0) {
          say("No changes to review.");
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
        say(message, "error");
      }
    },
    clear: async () => {
      if (workbench) workbench.refresh();
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
      const previousWorkspace = currentWorkspace;
      const title = sanitizeTerminalLine(customTitle).trim() || `Session ${new Date().toLocaleTimeString()}`;
      const created = await request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ title, workspacePath: process.cwd() }),
      });
      sessionId = created.session.id;
      sessionTitle = title;
      workbench?.setSessionTitle(title);
      currentWorkspace = created.session.workspace?.root ?? process.cwd();
      if (currentWorkspace !== previousWorkspace) loadDrive();
      contextRail.setModel(activeModel);
      contextRail.hydrate(null, thinkingEnabled, currentWorkspace);
      contextRail.setBranch(created.session.workspace?.gitBranch ?? null);
      refreshCustomCommands(currentWorkspace);
      await restoreWorkbench({ session: created.session, lastEventId: created.eventId, pendingPermissions: [], latestProviderCall: null });
      say(`Started new session ${title} (${sessionId.slice(0, 8)})`, "success");
    },
    theme: async (argument) => {
      const names = themeNames();
      const query = argument.trim().toLowerCase();
      let chosen: string | undefined;
      if (query) {
        chosen = names.find((name) => name === query)
          ?? names.find((name) => name.startsWith(query))
          ?? names.find((name) => themeLabel(name).toLowerCase().includes(query));
        if (!chosen) {
          say(`No theme matches "${sanitizeTerminalLine(argument.trim())}". Try /theme.`, "error");
          return;
        }
      } else if (workbench) {
        const index = await workbench.choose(
          "Themes",
          names.map((name) => `${themeLabel(name)} · ${name}${name === paint.themeName ? " · active" : ""}`),
          Math.max(0, names.indexOf(paint.themeName)),
          { currentIndex: names.indexOf(paint.themeName), action: "apply", noun: "themes" },
        );
        if (index === null || !names[index]) {
          say("Theme selection cancelled.");
          return;
        }
        chosen = names[index]!;
      } else {
        say(`Themes: ${names.join(", ")}. Use /theme <name>.`);
        return;
      }
      if (chosen === paint.themeName) {
        say(`${themeLabel(chosen)} is already active.`);
        return;
      }
      // The painter is shared by every renderer, so one swap re-themes the
      // whole interface on the next frame.
      paint.setTheme(chosen);
      paintLog.setTheme(chosen);
      say(`${themeLabel(chosen)} · set DEMESNE_THEME=${chosen} to keep it`, "success");
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
      if (state?.checkpoint) {
        const checkpoint = state.checkpoint;
        detail.push(paint.bold("LAST COMPACTION", "secondary"));
        detail.push(paint.dim(`~${formatTokenCount(checkpoint.beforeTokens)} → ~${formatTokenCount(checkpoint.afterTokens)} estimated tokens · ${checkpoint.retainedTurns} recent turns kept`));
        if (checkpoint.instructions) detail.push(...sanitizeTerminalText(checkpoint.instructions).split("\n").map((line) => truncateText(line, contextWidth)));
      }
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
      const recent = (drive?.active ? result.sessions.filter((session) => session.workspace?.root === currentWorkspace) : result.sessions).slice(0, 10);
      if (query && recent.length === 0) {
        say(`No sessions match "${sanitizeTerminalLine(query)}".`);
        return;
      }
      if (recent.length === 0) return;
      if (workbench) {
        const currentIndex = Math.max(0, recent.findIndex((session) => session.id === sessionId));
        const selected = await workbench.choose(
          query ? `Sessions matching "${sanitizeTerminalLine(query)}"` : "Recent sessions",
          recent.map((session) => `${session.title}  ${paint.dim(`(${session.id.slice(0, 8)})`)}`),
          currentIndex,
          { currentIndex: recent.findIndex((session) => session.id === sessionId), action: "open", noun: "sessions" },
        );
        if (selected === null) {
          say("Session selection cancelled.");
        } else if (recent[selected] && recent[selected]!.id !== sessionId) {
          await activateSession(recent[selected]!.id);
        }
        return;
      }
      emit(formatSessionsTable(recent.map(sessionListItem), sessionId, getTerminalWidth(process.stdout), paint));
      const selected = await selectSessionInteractive(recent, sessionId, paint);
      if (selected && selected.id !== sessionId) await activateSession(selected.id);
      else if (!selected) say("Session selection cancelled.");
    },
    resume: activateSession,
    model: async (argument) => {
      const discovered = await request<{ models: ModelDescriptor[] }>("/v1/models");
      const query = argument.trim();
      let selected: ModelDescriptor;
      if (query) {
        const match = matchModel(discovered.models, query);
        if ("error" in match) {
          say(match.error, "error");
          return;
        }
        selected = match.model;
      } else if (workbench) {
        // Figma 31:356: models grouped by provider, with their limits beside them.
        const models = [...discovered.models].sort((a, b) => a.provider.localeCompare(b.provider));
        const current = models.findIndex((model) => model.id === activeModel.id);
        const index = await workbench.choose(
          "Switch model",
          models.map((model) => model.id),
          Math.max(0, current),
          {
            subtitle: `current: ${activeModel.id}`,
            groups: models.map((model) => model.provider),
            details: models.map((model) => [model.contextWindow ? `${formatTokenCount(model.contextWindow)} ctx` : "",
              model.maxOutputTokens ? `${formatTokenCount(model.maxOutputTokens)} out` : ""].filter(Boolean).join(" · ")),
            currentIndex: current >= 0 ? current : undefined,
            action: "switch",
            noun: "models",
          },
        );
        if (index === null || !models[index]) {
          say("Model selection cancelled.");
          return;
        }
        selected = models[index]!;
      } else {
        const picked = await selectModelInteractive(discovered.models, activeModel.id, paint);
        if (!picked) {
          say("Model selection cancelled.");
          return;
        }
        selected = picked;
      }
      if (selected.id === activeModel.id) {
        say(`${sanitizeTerminalLine(selected.id)} is already active.`);
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
      say(`Switched to ${sanitizeTerminalLine(selected.id)}${selected.contextWindow ? ` · ctx ${formatTokenCount(selected.contextWindow)}` : ""}`, "success");
    },
    rename: async (argument) => {
      const title = sanitizeTerminalLine(argument).trim();
      if (!title) {
        say("Usage: /rename <title>", "error");
        return;
      }
      const result = await request<UpdateSessionResponse>(`/v1/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      sessionTitle = result.session.title;
      workbench?.setSessionTitle(sessionTitle);
      say(`Renamed to ${sanitizeTerminalLine(result.session.title)}`, "success");
    },
    delete: async () => {
      const current = await request<{ session: Session }>(`/v1/sessions/${sessionId}`).catch(() => null);
      const title = current?.session.title ?? "this session";
      const confirmed = workbench
        ? await workbench.suspend(() => confirmPrompt(`Archive ${sanitizeTerminalLine(title)}? The transcript is kept. [y/N] `))
        : await confirmPrompt(`Archive ${sanitizeTerminalLine(title)}? The transcript is kept. [y/N] `);
      if (!confirmed) {
        say("Archive cancelled.");
        return;
      }
      await request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
      say(`Archived ${sanitizeTerminalLine(title)}`, "success");
      await slashHandlers.new!("");
    },
    export: async (argument) => {
      const format = argument.trim().toLowerCase() || "md";
      if (format !== "md" && format !== "json") {
        say("Usage: /export [md|json]", "error");
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
      say(`Exported to ${sanitizeTerminalLine(path)}`, "success");
    },
  };

  if (initial) {
    history.add(initial, currentWorkspace);
    await executePrompt(initial);
  }

  while (true) {
    let line: string;
    const queued = takeQueuedInput();
    if (queued.send) {
      line = queued.send;
    } else {
      try {
        line = workbench
          ? await workbench.readPrompt({ history: history.entries(), mentions: mentionFiles, commands: allCommands, draft: queued.draft })
          : await readCommandPrompt(history, mentionFiles, allCommands, queued.draft);
      } catch {
        leaveChat();
      }
    }

    // Short `@name` mentions go out as workspace paths.
    line = expandMentions(line, mentionFiles);
    const input = line.trim();
    if (!input) continue;
    history.add(input, currentWorkspace);

    if (input.startsWith("/")) {
      const invocation = resolveSlashCommand(input, allCommands);
      if (!invocation) {
        say(`Unknown command: ${input.split(/\s/, 1)[0]}. Type /help for available commands.`, "error");
        continue;
      }
      const validationError = slashCommandValidationError(invocation);
      if (validationError) {
        say(validationError, "error");
        continue;
      }
      try {
        const handler = slashHandlers[invocation.command.id];
        if (handler) {
          await handler(invocation.argument);
        } else {
          const custom = customCommands.find((entry) => entry.command.id === invocation.command.id);
          if (!custom) {
            say(`Unknown command: ${invocation.matchedName}`, "error");
            continue;
          }
          await executePrompt(expandCustomCommand(custom, invocation.argument));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : `${invocation.command.name} failed`;
        say(sanitizeTerminalText(message), "error");
      }
      continue;
    }

    // The first request names a session that still has its placeholder title.
    if (isPlaceholderTitle(sessionTitle)) {
      const title = titleFromRequest(sanitizeTerminalLine(input));
      const target = sessionId;
      // Set locally first, so a second request sent meanwhile does not rename it again.
      if (title) { sessionTitle = title; workbench?.setSessionTitle(title); }
      if (title) void request<UpdateSessionResponse>(`/v1/sessions/${target}`, { method: "PATCH", body: JSON.stringify({ title }) })
        .then((result) => { if (sessionId === target) { sessionTitle = result.session.title; workbench?.setSessionTitle(sessionTitle); } })
        .catch(() => undefined);
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
  compactInstructions?: string;
  workbench: Workbench;
  contextRail: CliContextRail;
  paint: Painter;
  workerStarted?: (content: string, turnId: string) => void;
  workerEvent?: (event: EventEnvelope) => void;
}): Promise<"completed" | "stopped" | "failed"> {
  const submitted = options.compactInstructions !== undefined ? await client.compactSession(options.sessionId, { instructions: options.compactInstructions })
    : await request<SubmitTurnResponse>(`/v1/sessions/${options.sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      content: options.content,
      permissionMode: options.permissionMode,
      ...(options.planOnly ? { planOnly: true } : {}),
    }),
  });

  options.workerStarted?.(options.content, submitted.turn.id);
  const controller = new AbortController();
  let interrupted = false;
  let cancelFallback: ReturnType<typeof setTimeout> | undefined;
  chatState.interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    cancelFallback = setTimeout(() => controller.abort(), 3_000);
    void request(`/v1/turns/${submitted.turn.id}/cancel`, { method: "POST", body: JSON.stringify({}) })
      .catch(() => controller.abort());
  };

  const activity = new TurnActivityLedger();
  const throughput = new TurnThroughputTracker();
  const startedAt = Date.now();
  let completedAt: number | undefined;
  let presence: PresenceState = "thinking";
  let status: "completed" | "stopped" | "failed" = "failed";
  let failure: string | undefined = "The event stream ended before the run completed.";
  let softLimitWarned = false;
  const reduceMotion = reducedMotionEnabled();
  let responseAt: string | undefined;
  const pacer = reduceMotion ? null : new TerminalTextPacer({
    sink: (text) => options.workbench.assistantDelta(text, responseAt),
  });

  const updateFooter = () => {
    const elapsed = ((Date.now() - startedAt) / 1_000).toFixed(1);
    const speed = throughput.snapshot().tokensPerSecond;
    // The queued text is not repeated here: the composer draws it, and showing
    // it in both places put the same words on screen twice.
    const left = `  ${renderPresence(presence, Date.now(), options.paint)} `
      + `${options.paint.bold(presenceLabel(presence), "paper")} ${options.paint.dim(
        `· ${elapsed}s${speed === null ? "" : ` · ${speed.toFixed(0)} tok/s`}`,
      )}`;
    options.workbench.setPresence(presence);
    options.workbench.setFooter(left, options.contextRail.statusLine(getTerminalWidth(process.stdout), options.paint));
  };
  const footerTimer = setInterval(updateFooter, 120);
  updateFooter();

  try {
    for await (const event of client.streamEvents(options.sessionId, submitted.eventId, controller.signal)) {
      if (event.turnId !== submitted.turn.id) continue;
      options.workerEvent?.(event);
      options.contextRail.apply(event);
      if (event.type === "artifact.created" && isRecord(event.payload.artifact) && typeof event.payload.artifact.id === "string") {
        try {
          const artifact = await client.getArtifact(options.sessionId, event.payload.artifact.id);
          options.workbench.addArtifact(artifact);
        } catch { options.workbench.notice("Image saved; preview metadata could not be loaded.", "error"); }
      }
      activity.apply(event);
      throughput.apply(event);
      if (/^turn\.(completed|cancelled|failed|interrupted)$/.test(event.type)) completedAt = Date.parse(event.occurredAt);

      if (event.type === "model.request_started") {
        // Flush paced text first so the previous round's prose is complete
        // before the new round opens a fresh paragraph.
        if (pacer) await pacer.drain();
        options.workbench.beginRound();
        responseAt = undefined;
        presence = "thinking";
        const plan = event.payload.contextPlan;
        if (!softLimitWarned && isRecord(plan) && plan.budgetStatus === "over_soft_limit") {
          softLimitWarned = true;
          options.workbench.notice("past the soft limit · history kept · compaction only if required", "info");
        }
      } else if (event.type === "reasoning.delta" && typeof event.payload.delta === "string") {
        presence = "reasoning";
        options.workbench.reasoningDelta(event.payload.delta);
      } else if (event.type === "message.delta" && typeof event.payload.delta === "string") {
        presence = "writing";
        if (event.payload.delta) responseAt ??= event.occurredAt;
        if (pacer) {
          pacer.observe(event.payload.delta);
          pacer.write(event.payload.delta);
        } else {
          options.workbench.assistantDelta(event.payload.delta, responseAt);
        }
      } else if (event.type === "tool.call_draft") {
        if (pacer) await pacer.drain();
        options.workbench.toolDraft(event);
        presence = "working";
      } else if (event.type === "tool.call_requested") {
        // Drain first: the tool row must appear after the prose that announced
        // it, not in the middle of a still-buffered sentence.
        if (pacer) await pacer.drain();
        const name = String(event.payload.name ?? "tool");
        options.workbench.toolRequested({
          toolCallId: String(event.payload.toolCallId ?? ""),
          name,
          arguments: event.payload.arguments,
          draftId: typeof event.payload.draftId === "string" ? event.payload.draftId : undefined,
        });
        presence = presenceForTool(name, isValidationCommand(toolDetailForPresence(name, event.payload.arguments)));
      } else if (event.type === "tool.call_started") {
        const name = String(event.payload.name ?? "tool");
        presence = presenceForTool(name, false);
      } else if (["tool.call_completed", "tool.call_failed", "tool.call_denied", "tool.call_cancelled", "tool.call_interrupted"].includes(event.type)) {
        options.workbench.toolFinished(toolCompletion(event));
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
            cwd: permissionCwd(rawArgs),
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
          try {
            await request(`/v1/permissions/${permissionId}`, { method: "POST", body: JSON.stringify({ decision }) });
          } catch (error) {
            void request(`/v1/turns/${submitted.turn.id}/cancel`, { method: "POST", body: JSON.stringify({}) }).catch(() => undefined);
            throw new Error(`Could not deliver the approval decision: ${error instanceof Error ? error.message : "request failed"}`);
          }
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
        status = "stopped";
        presence = "stopped";
        failure = typeof event.payload.message === "string" ? event.payload.message : "Turn interrupted";
        break;
      }
      updateFooter();
    }
  } finally {
    if (cancelFallback) clearTimeout(cancelFallback);
    clearInterval(footerTimer);
    if (pacer) await pacer.drain();
    chatState.interrupt = undefined;
    controller.abort();
  }

  if (interrupted && status !== "completed") status = "stopped";

  const evidence = activity.snapshot();
  // Use the journal's clock so the response footer is identical after replay;
  // terminal pacing and client scheduling must not extend the recorded turn.
  const recordedDuration = completedAt === undefined ? NaN : completedAt - Date.parse(submitted.turn.createdAt);
  const durationMs = Number.isFinite(recordedDuration) && recordedDuration >= 0 ? recordedDuration : Math.max(0, Date.now() - startedAt);
  const duration = (durationMs / 1_000).toFixed(1);
  const measured = throughput.snapshot();
  const speed = measured.decodeTokensPerSecond ?? measured.tokensPerSecond;
  const counts = `${evidence.rounds} round${evidence.rounds === 1 ? "" : "s"}`
    + ` · ${evidence.tools} tool${evidence.tools === 1 ? "" : "s"}`;
  const details = status === "completed"
    ? `${duration}s · ${counts}`
      + (measured.outputTokens ? ` · ${measured.outputTokens} tok` : "")
      + (speed ? ` · ${speed.toFixed(1)} tok/s` : "")
    : status === "stopped"
      ? `${duration}s · ${counts}${failure ? ` · ${sentence(failure)}` : ""}`
      : failure ? sentence(failure) : "";
  options.workbench.finishTurn(status, narrateTurnEnd(status, details), { durationMs, tokensPerSecond: speed });
  return status;
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

/// A command's own working directory, when its arguments name one.
function permissionCwd(rawArgs: unknown): string | undefined {
  let parsed: unknown = rawArgs;
  if (typeof rawArgs === "string") { try { parsed = JSON.parse(rawArgs); } catch { return undefined; } }
  return isRecord(parsed) && typeof parsed.cwd === "string" && parsed.cwd.trim() && parsed.cwd !== "." ? sanitizeTerminalLine(parsed.cwd) : undefined;
}

/// A command as a person would type it: `bun test "my file.ts"`, quoting only
/// arguments that need it, instead of JSON-quoting every word.
function shellCommand(argv: readonly unknown[]): string {
  return argv.map((value) => {
    const text = String(value);
    return /^[\w@%+=:,./~-]+$/.test(text) ? text : JSON.stringify(text);
  }).join(" ");
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
    rows.push(painter.text(`$ ${shellCommand(parsed.argv)}`, "paper"));
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
  const currentRightStatus = () => {
    return options.contextRail?.statusLine(getTerminalWidth(process.stdout), paint) ?? chatState.inputStatusLine?.() ?? "";
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
    if (fixedFooter?.isActive()) {
      fixedFooter.update(left, currentRightStatus());
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

  const reportStopped = (message = "Turn stopped.") => {
    textPacer?.flushNow();
    closeReasoning();
    stopBeacon();
    if (interactive) {
      console.log(`\n  ${paint.text("■", "secondary")} ${paint.dim(sanitizeTerminalLine(message))}\n`);
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
        const state = activity?.state === "done" ? "done" : activity?.state === "denied" ? "denied" : activity?.state === "stopped" ? "stopped" : "failed";

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
          candidate.state === "queued" || candidate.state === "waiting" || candidate.state === "running"
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
        const message = typeof event.payload.message === "string" ? event.payload.message : "Turn interrupted";
        reportStopped(message);
        return "stopped";
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
        previewRows.push(paintLog.text(`$ ${shellCommand(parsed.argv)}`, "paper"));
      }
    } catch {}
  } else if (isRecord(rawArgs)) {
    if (toolName === "edit_file" && typeof rawArgs.oldText === "string" && typeof rawArgs.newText === "string") {
      previewRows.push(...formatDiffPreview(rawArgs.oldText, rawArgs.newText, 6, paintLog));
    } else if (toolName === "run_command" && Array.isArray(rawArgs.argv)) {
      previewRows.push(paintLog.text(`$ ${shellCommand(rawArgs.argv)}`, "paper"));
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
  demesne auth login openrouter [--model <id>] [--no-browser]
  demesne doctor [--json]
  demesne daemon start|stop|status|logs
  demesne ps [--watch] [--json]
  demesne prompt [--session <session-id>] [--permission ask|deny] [--output text|json|stream-json] [--plan] <text>
  demesne compact <session-id> [instructions]
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
