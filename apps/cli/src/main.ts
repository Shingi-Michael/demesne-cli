#!/usr/bin/env bun

import { NextPromptFilter, splitNextPrompt } from "@demesne/protocol";
import { isRecord, type CancelTurnResponse, type CreateSessionResponse, type EventEnvelope, type ModelDescriptor, type PermissionDecision, type UserAnswer, type UserQuestion, parseUserQuestions, type RuntimeProfileStatus, type Session, type SessionStateResponse, type SubmitTurnResponse, type TokenUsage } from "@demesne/protocol";
import { createPainter, formatAssistantHeader, formatDiffPreview, formatFooterLine, formatPermissionCard, formatToolPhaseHeader, formatToolResultLine, formatTurnReceipt, fileUrl, formatHyperlink, renderSpinner, resolveTheme, SPINNER_PERIOD_MS, sanitizeTerminalLine, sanitizeTerminalText, TerminalMarkdownStream, TerminalReasoningStream, toolKindBadge, type BeaconActivity, type PaletteColor } from "@demesne/brand";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { CliContextRail } from "./context-rail.ts";
import { TurnThroughputTracker } from "./turn-throughput.ts";
import { TurnActivityLedger, type TurnPhase } from "./turn-activity.ts";
import { TerminalTextPacer } from "./terminal-text-pacer.ts";
import { reducedMotionEnabled } from "./motion.ts";
import { DemesneClient, isStalePermissionResolution, isWorkspaceUntrusted } from "@demesne/client";
import { approvalOptions, formatApprovalSelection, reduceApprovalSelection } from "./approval-selection.ts";
import { applyFooterScrollRegion, resetFooterScrollRegion } from "./terminal-control.ts";
import { formatProcessView } from "./process-view.ts";
import { checkForUpdate } from "./update-check.ts";
import { queueSummary } from "./input-queue.ts";
import { notify, shouldNotifyApproval, shouldNotifyCompletion, type NotificationOptions } from "./notifications.ts";
import { derivePersistedRule } from "./allow-rules.ts";
import { VERSION } from "./version.ts";
import { loadAccountSettings, loadCliSettings, type CliSettings } from "./cli-config.ts";
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
import { runChatGPTAuthCommand } from "./chatgpt-auth.ts";
import { runCodexAuthCommand } from "./codex-auth.ts";
import { beginOpenRouterLogin, configureOpenRouter } from "./openrouter-auth.ts";
import { updateUserConfig } from "@demesne/config";
import { createInterface } from "node:readline/promises";
import { runGraphics } from "./graphics-launcher.ts";

const args = process.argv.slice(2);
// Headless runs can't answer the trust question, so they confirm it up front.
const trustWorkspaceFlag = args.includes("--trust-workspace");
if (trustWorkspaceFlag) args.splice(args.indexOf("--trust-workspace"), 1);
let requestedServer: string | undefined;
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
    requestedServer = takeOption(args, "--server");
    return loadCliSettings({ serverOverride: requestedServer, includeProject: !(args[0] === "auth" && args[2] === "codex") });
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

function getTerminalWidth(stream: { columns?: number } = process.stdout): number {
  const cols = stream.columns ?? process.stdout.columns ?? 80;
  if (!cols || cols <= 0) return 80;
  return Math.max(18, cols - 2);
}

function getConversationWidth(stream: { columns?: number } = process.stdout): number {
  return Math.min(100, getTerminalWidth(stream));
}

try {
  const first = args[0];
  const chatFlags = first !== undefined
    && first.startsWith("--")
    && !["--version", "--help"].includes(first);
  if (first === "graphics" || args.includes("--graphics")) {
    const graphicsArgs = process.argv.slice(2);
    if (first === "graphics") graphicsArgs.splice(graphicsArgs.indexOf("graphics"), 1);
    process.exitCode = await runGraphics(graphicsArgs.filter(arg => arg !== "--graphics"));
  } else if (args.length === 0 || first === "chat" || chatFlags) {
    const chatArgs = first === "chat" ? args.slice(1) : args;
    // demesne is the graphics UI. Without a terminal (a pipe or a script),
    // the message runs like `demesne prompt`.
    if (process.stdin.isTTY && process.stdout.isTTY) process.exitCode = await runGraphics(graphicsChatArgs(chatArgs));
    else {
      const model = takeOption(chatArgs, "--model");
      if (model) {
        await ensureDaemonOrExit();
        await request("/v1/model", { method: "POST", body: JSON.stringify({ model }) });
      }
      await run(["prompt", ...chatArgs]);
    }
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
    const created = await createSessionWithTrust({ title, workspacePath });
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
    process.exitCode = await runGraphics([]);
    return;
  }

  if (command[0] === "auth") {
    if (command[2] === "codex") {
      const accountSettings = loadAccountSettings({ serverOverride: requestedServer });
      const accountServer = validateServerUrl(accountSettings.server);
      const accountClient = new DemesneClient({ server: accountServer, token: loadDaemonToken(accountSettings.dataDirectory) });
      await runCodexAuthCommand(command, { configPath: accountSettings.configPath, dataDirectory: accountSettings.dataDirectory,
        open: async url => { try { return await Bun.spawn(process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" }).exited === 0; } catch { return false; } },
        reload: async () => {
          if (!(await daemonStatus(createDaemonControlDependencies(accountServer, accountSettings.dataDirectory))).running) return "stopped";
          await accountClient.reloadProviders();
          return "reloaded";
        },
      });
      return;
    }
    if (["chatgpt", "openai"].includes(command[2] ?? "")) {
      await runChatGPTAuthCommand(command, { configPath: settings.configPath, dataDirectory: settings.dataDirectory,
        open: async url => { try { return await Bun.spawn(process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" }).exited === 0; } catch { return false; } },
        acknowledge: async () => {
          if (!process.stdin.isTTY) return false;
          const { createInterface } = await import("node:readline/promises");
          const input = createInterface({ input: process.stdin, output: process.stdout });
          try { return /^(?:y|yes)$/i.test((await input.question("Got it — continue using your ChatGPT plan? [y/N] ")).trim()); }
          finally { input.close(); }
        },
      });
      return;
    }

    if (command[1] !== "login" || command[2] !== "openrouter") throw new Error("Usage: demesne auth login <codex|chatgpt|openrouter> [--model <id>] [--no-browser]");
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
  const created = await createSessionWithTrust({ title, workspacePath: process.cwd() });
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

/// `demesne [chat] [message] [options]` as graphics UI arguments: options it
/// understands pass through, and the words become its opening message.
function graphicsChatArgs(command: string[]): string[] {
  const out: string[] = [], words: string[] = [];
  if (process.argv.includes("--server") || process.argv.some((arg) => arg.startsWith("--server="))) out.push("--server", settings.server);
  for (let index = 0; index < command.length; index++) {
    const arg = command[index]!;
    if (arg === "--setup") out.push(arg);
    else if (["--session", "--workspace", "--scale", "--model"].includes(arg)) {
      const value = command[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      out.push(arg, value);
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}. Run demesne --help.`);
    else words.push(arg);
  }
  const prompt = words.join(" ").trim();
  return prompt ? [...out, "--prompt", prompt] : out;
}

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
    response: splitNextPrompt(response).text,
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
  // The hidden <next>…</next> suggestion isn't printed.
  const nextFilter = new NextPromptFilter();
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
        writeResponse(markdownStream.write(nextFilter.push(event.payload.delta)));
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

      if (event.type === "question.requested") {
        await drainResponse();
        closeReasoning();
        stopBeacon();
        if (shouldNotifyApproval(notificationOptions(interactive))) notify("The agent has a question for you", notificationOptions(interactive));
        chatState.permissionActive = true;
        try {
          await answerQuestionsInScrollback(event, interactive);
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
        const remaining = markdownStream.write(nextFilter.end()) + markdownStream.flush();
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

/// The scrollback prompt's version of the question card: one question at a
/// time; Enter takes the suggested answer, a number picks another, anything
/// else is the user's own answer. Without a terminal every question is skipped.
async function answerQuestionsInScrollback(event: EventEnvelope, interactive: boolean): Promise<void> {
  const questionId = typeof event.payload.questionId === "string" ? event.payload.questionId : null;
  let questions: UserQuestion[] = [];
  try { questions = parseUserQuestions(event.payload.questions); } catch { return; }
  if (!questionId) return;
  const answers: UserAnswer[] = [];
  const rl = interactive && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    for (const [index, question] of questions.entries()) {
      if (!rl) { answers.push({ answer: null, source: "skipped" }); continue; }
      const count = questions.length > 1 ? ` ${index + 1} of ${questions.length}` : "";
      console.log(`\n  ${paint.text("?", "thinking")} ${paint.bold(`Question${count}`, "paper")}  ${sanitizeTerminalLine(question.question)}`);
      if (question.reason) console.log(paint.dim(`    ${sanitizeTerminalLine(question.reason)}`));
      question.suggestions.forEach((suggestion, option) => console.log(`    ${paint.text(String(option + 1), option === 0 ? "electric" : "muted")}  ${sanitizeTerminalLine(suggestion)}${option === 0 ? paint.dim("  (Enter)") : ""}`));
      const reply = (await rl.question(paint.dim(question.suggestions.length ? "    Enter, a number, or your own answer (Esc-Enter skips): " : "    Your answer (empty skips): "))).trim();
      const picked = /^[1-9]$/.test(reply) ? question.suggestions[Number(reply) - 1] : undefined;
      if (picked) answers.push({ answer: picked, source: "suggestion" });
      else if (!reply && question.suggestions[0]) answers.push({ answer: question.suggestions[0], source: "suggestion" });
      else if (reply && reply !== "\x1b") answers.push({ answer: reply, source: "typed" });
      else answers.push({ answer: null, source: "skipped" });
    }
  } finally {
    rl?.close();
  }
  await request(`/v1/questions/${questionId}`, { method: "POST", body: JSON.stringify({ answers }) });
}

async function resolvePermission(event: EventEnvelope, onCancel?: () => void): Promise<void> {
  const permissionId = typeof event.payload.permissionId === "string" ? event.payload.permissionId : null;
  if (!permissionId) throw new Error("Permission event is missing its ID");
  const toolName = typeof event.payload.name === "string" ? event.payload.name : undefined;
  const summary = toolName === "run_command" ? "Command" : sanitizeTerminalLine(typeof event.payload.summary === "string" ? event.payload.summary : "dangerous operation");
  const rawArgs = event.payload.arguments;
  let decision: PermissionDecision = "deny";

  const previewRows: string[] = [];
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (toolName === "edit_file" && typeof parsed.oldText === "string" && typeof parsed.newText === "string") {
        previewRows.push(...formatDiffPreview(parsed.oldText, parsed.newText, 6, paintLog));
      }
    } catch {}
  } else if (isRecord(rawArgs)) {
    if (toolName === "edit_file" && typeof rawArgs.oldText === "string" && typeof rawArgs.newText === "string") {
      previewRows.push(...formatDiffPreview(rawArgs.oldText, rawArgs.newText, 6, paintLog));
    }
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const width = getTerminalWidth(process.stdout);
    const persistedRule = derivePersistedRule(toolName, rawArgs);
    if (toolName !== "run_command") console.log(formatPermissionCard(summary, toolName, width, paint, previewRows.length > 0 ? previewRows : undefined));
    const selection = await promptApprovalSelection(true, onCancel, persistedRule !== null, toolName === "run_command");
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
  failSafe = !allowSession,
): Promise<{ decision: PermissionDecision; cancelledTurn: boolean }> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  const approval = approvalOptions(allowSession, allowPersist, failSafe);
  let selected = approval.selectedIndex;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const render = () => {
      output.write(`\r\x1b[2K${formatApprovalSelection(selected, allowSession, getTerminalWidth(output), paint, allowPersist, failSafe ? "command" : "action")}`);
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

async function createSessionWithTrust(body: { title?: string; workspacePath: string }): Promise<CreateSessionResponse> {
  const create = (trustWorkspace: boolean) => request<CreateSessionResponse>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ ...body, ...(trustWorkspace ? { trustWorkspace } : {}) }),
  });
  try {
    return await create(trustWorkspaceFlag);
  } catch (error) {
    if (!isWorkspaceUntrusted(error)) throw error;
    const path = resolve(body.workspacePath);
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error(`${path} is not a trusted workspace. Run demesne there interactively to confirm, or pass --trust-workspace.`);
    }
    const input = createInterface({ input: process.stdin, output: process.stderr });
    let answer: string;
    try {
      answer = await input.question(`Do you trust the files in ${path}?\nDemesne will follow its instructions and may run commands there. [y/N] `);
    } finally {
      input.close();
    }
    if (!/^(?:y|yes)$/i.test(answer.trim())) throw new Error("Workspace not trusted; no session was created.");
    return await create(true);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return client.request<T>(path, init);
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
  demesne [chat <message>] [--model <id>] [--workspace <path>] [--session <id>] [--scale auto|0.5-3] [--setup]
      Opens demesne in Ghostty (Kitty graphics), sending <message> first. Without a terminal, runs it like demesne prompt.
  demesne setup [--provider-url <url> --model <id>] [--context-window <n>] [--max-output-tokens <n>] [--theme auto|dark|light] [--yes]
  demesne auth login <codex|chatgpt|openrouter> [--model <id>] [--no-browser]
  demesne auth status|logout codex
  demesne auth accounts|status|use|logout chatgpt [--account <id>]
  demesne auth login chatgpt [--account <id> | --new-account] [--consent] [--accept-plan-usage]
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
  --server <url>     Daemon URL (default: http://127.0.0.1:7337)
  --trust-workspace  Trust the current workspace without asking (for scripted runs)

Configuration:
  ~/.demesne/config.toml and <workspace>/.demesne/config.toml are merged with
  environment variables; environment variables win. Run \`demesne setup\` to
  create the user config.`);
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
