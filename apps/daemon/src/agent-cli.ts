/// Agents that live in Demesne: the agent tools installed on this machine
/// (Claude Code, Codex, Gemini) run as ordinary chats. Demesne starts the
/// tool itself, headless, in the chat's folder, one run per turn, and keeps
/// the tool's own session going from turn to turn. Nobody opens a terminal:
/// Heartbeat mail to the chat starts its next turn like any other chat's.
///
/// A chat is an agent's when its model is `agent:<id>`. The tool runs its own
/// tools under its own rules; Demesne shows what it did as the turn's
/// working lines and its last message as the answer.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import type { TurnInference } from "./processor.ts";

export const AGENT_MODEL_PREFIX = "agent:";

export type AgentId = "claude" | "codex" | "gemini";

export interface AgentKind { id: AgentId; name: string; command: string }

export const AGENT_KINDS: readonly AgentKind[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
  { id: "gemini", name: "Gemini", command: "gemini" },
];

export interface FoundAgent { id: AgentId; name: string; model: string; path: string }

export function agentModel(id: AgentId): string { return `${AGENT_MODEL_PREFIX}${id}`; }

export function agentIdOf(model: string | null | undefined): AgentId | null {
  if (!model?.startsWith(AGENT_MODEL_PREFIX)) return null;
  const id = model.slice(AGENT_MODEL_PREFIX.length);
  return AGENT_KINDS.some((kind) => kind.id === id) ? id as AgentId : null;
}

/// How far back a chat's earlier words go when an agent joins it without a
/// session of its own (its first turn, or a tool that can't resume).
const TRANSCRIPT_CHARS = 12_000;
/// A turn's answer and working lines are capped like a model's output.
const AGENT_OUTPUT_TOKENS = 32_000;

export interface AgentProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface AgentCliOptions {
  /// Where a command is on PATH, or null (Bun.which by default).
  which?: (command: string) => string | null;
  spawn?: (argv: string[], cwd: string) => AgentProcess;
}

/// One run's command line: the prompt is the last argument, and `resume` is
/// the tool's session to carry on (or, for Claude Code, the id to start).
export function agentArgs(id: AgentId, prompt: string, resume: { id: string; fresh: boolean } | null): string[] {
  if (id === "claude") return ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    ...(resume ? [resume.fresh ? "--session-id" : "--resume", resume.id] : []), prompt];
  if (id === "codex") return ["exec", "--json", "--full-auto", "--skip-git-repo-check", ...(resume ? ["resume", resume.id] : []), prompt];
  return ["-p", prompt, "--output-format", "stream-json", "--approval-mode", "auto_edit"];
}

/// What one line of a tool's output means for the turn.
export interface AgentLine { session?: string; step?: string; said?: string; answer?: string; error?: string }

function short(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function pathIn(cwd: string, path: unknown): string {
  if (typeof path !== "string") return "";
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") ? inside : path;
}

/// A tool call as one working line, in Demesne's own verbs.
export function stepLine(name: string, input: Record<string, unknown>, cwd: string): string {
  const lower = name.toLowerCase();
  const file = pathIn(cwd, input.file_path ?? input.path ?? input.absolute_path ?? input.notebook_path);
  const command = input.command ?? input.cmd;
  if (typeof command === "string" || Array.isArray(command)) return `Ran ${short(Array.isArray(command) ? command.join(" ") : command)}`;
  if (/^(read|read_file|read_many_files|view)$/.test(lower)) return `Read ${file || "a file"}`;
  if (/edit|write|replace|patch/.test(lower)) return `Edited ${file || "a file"}`;
  if (/grep|glob|search|find|list|ls/.test(lower)) return `Searched ${short(String(input.pattern ?? input.query ?? file ?? ""), 60)}`.trim();
  if (/fetch|web/.test(lower)) return `Looked up ${short(String(input.url ?? input.query ?? ""), 60)}`.trim();
  return name;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/// Reads one JSON line from the tool. Lines it doesn't know mean nothing.
export function parseAgentLine(id: AgentId, line: string, cwd: string): AgentLine[] {
  let event: Record<string, unknown>;
  try { event = record(JSON.parse(line)); } catch { return []; }
  const type = event.type;
  if (id === "claude") {
    if (type === "system" && event.subtype === "init" && typeof event.session_id === "string") return [{ session: event.session_id }];
    if (type === "assistant") {
      const content = record(event.message).content;
      return (Array.isArray(content) ? content : []).flatMap((part): AgentLine[] => {
        const block = record(part);
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return [{ said: block.text }];
        if (block.type === "tool_use" && typeof block.name === "string") return [{ step: stepLine(block.name, record(block.input), cwd) }];
        return [];
      });
    }
    if (type === "result") {
      if (event.is_error === true) return [{ error: typeof event.result === "string" && event.result ? event.result : String(event.subtype ?? "Claude Code failed") }];
      return typeof event.result === "string" ? [{ answer: event.result }] : [];
    }
    return [];
  }
  if (id === "codex") {
    if (type === "thread.started" && typeof event.thread_id === "string") return [{ session: event.thread_id }];
    if (type === "item.completed") {
      const item = record(event.item);
      if (item.type === "agent_message" && typeof item.text === "string") return [{ said: item.text }];
      if (item.type === "command_execution") return [{ step: stepLine("shell", { command: item.command }, cwd) }];
      if (item.type === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
        return changes.map((change) => ({ step: `Edited ${pathIn(cwd, change.path) || "a file"}` }));
      }
      if (item.type === "web_search") return [{ step: `Looked up ${short(String(item.query ?? ""), 60)}`.trim() }];
      return [];
    }
    if (type === "turn.failed") return [{ error: String(record(event.error).message ?? "Codex failed") }];
    if (type === "error") return [{ error: String(event.message ?? "Codex failed") }];
    return [];
  }
  if (type === "init" && typeof event.session_id === "string") return [{ session: event.session_id }];
  if (type === "message" && event.role === "assistant" && typeof event.content === "string") return [{ said: event.content }];
  if (type === "tool_use" && typeof event.tool_name === "string") return [{ step: stepLine(event.tool_name, record(event.parameters), cwd) }];
  if (type === "error") return [{ error: String(event.message ?? "Gemini failed") }];
  if (type === "result" && event.status === "error") return [{ error: String(record(event.error).message ?? "Gemini failed") }];
  return [];
}

function text(message: ProviderMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/// The words the tool is given: the newest message, and, when the tool has
/// no session of its own yet, the chat so far as plain lines before it.
export function agentPrompt(messages: ProviderMessage[], withTranscript: boolean): string {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const asked = lastUser >= 0 ? text(messages[lastUser]!) : "";
  if (!withTranscript) return asked;
  const earlier = messages.slice(0, Math.max(0, lastUser))
    .filter((message) => (message.role === "user" || message.role === "assistant") && text(message).trim())
    .map((message) => `${message.role === "user" ? "Person" : "Assistant"}: ${text(message).trim()}`);
  let transcript = "";
  for (const line of earlier.reverse()) {
    if (transcript.length + line.length > TRANSCRIPT_CHARS) break;
    transcript = `${line}\n\n${transcript}`;
  }
  return transcript ? `Earlier in this chat:\n\n${transcript.trim()}\n\nNow:\n${asked}` : asked;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (buffered.trim()) yield buffered.trim();
}

async function tail(stream: ReadableStream<Uint8Array>): Promise<string> {
  try { return (await new Response(stream).text()).trim().slice(-600); } catch { return ""; }
}

function defaultSpawn(argv: string[], cwd: string): AgentProcess {
  const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  return { stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => child.kill() };
}

export class AgentCli {
  private readonly which: (command: string) => string | null;
  private readonly spawn: (argv: string[], cwd: string) => AgentProcess;
  private readonly sessionsPath: string;

  constructor(dataDirectory: string, options: AgentCliOptions = {}) {
    this.which = options.which ?? ((command) => Bun.which(command));
    this.spawn = options.spawn ?? defaultSpawn;
    this.sessionsPath = join(dataDirectory, "agent-sessions.json");
  }

  /// The agent tools on this machine, looked up each time (one installed
  /// later shows up without a restart).
  agents(): FoundAgent[] {
    return AGENT_KINDS.flatMap((kind) => {
      const path = this.which(kind.command);
      return path ? [{ id: kind.id, name: kind.name, model: agentModel(kind.id), path }] : [];
    });
  }

  private sessions(): Record<string, Partial<Record<AgentId, string>>> {
    try { return existsSync(this.sessionsPath) ? JSON.parse(readFileSync(this.sessionsPath, "utf8")) : {}; } catch { return {}; }
  }

  /// The tool's own session behind a chat, if it has one.
  sessionFor(chatId: string, id: AgentId): string | null { return this.sessions()[chatId]?.[id] ?? null; }

  private remember(chatId: string, id: AgentId, session: string) {
    const all = this.sessions();
    if (all[chatId]?.[id] === session) return;
    all[chatId] = { ...all[chatId], [id]: session };
    mkdirSync(dirname(this.sessionsPath), { recursive: true });
    const temporary = `${this.sessionsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(all, null, 2));
    renameSync(temporary, this.sessionsPath);
  }

  /// A turn's call to the agent: the engine streams it like a model, and it
  /// never asks for Demesne's tools (the agent runs its own).
  inference(id: AgentId, chatId: string, cwd: string | undefined): TurnInference {
    const kind = AGENT_KINDS.find((item) => item.id === id)!;
    const run = (messages: ProviderMessage[], signal: AbortSignal) => this.run(kind, chatId, cwd, messages, signal);
    return Object.freeze({
      providerId: kind.name,
      modelId: agentModel(id),
      profile: null,
      thinkingEnabled: true,
      preservesPromptCache: false,
      maxOutputTokens: AGENT_OUTPUT_TOKENS,
      external: true,
      stream: (messages: ProviderMessage[], _tools: unknown, signal: AbortSignal) => run(messages, signal),
    });
  }

  private async *run(kind: AgentKind, chatId: string, cwd: string | undefined, messages: ProviderMessage[], signal: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const path = this.which(kind.command);
    if (!path) throw new Error(`${kind.name} isn't installed on this machine (no \`${kind.command}\` on PATH).`);
    if (!cwd) throw new Error(`${kind.name} works in a project: open one and start it there.`);
    const known = kind.id === "gemini" ? null : this.sessionFor(chatId, kind.id);
    // Claude Code takes the session id we give it; Codex names its own.
    const resume = known ? { id: known, fresh: false } : kind.id === "claude" ? { id: randomUUID(), fresh: true } : null;
    const prompt = agentPrompt(messages, !known);
    const child = this.spawn([path, ...agentArgs(kind.id, prompt, resume)], cwd);
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    const stderr = tail(child.stderr);
    let said = "", answer: string | null = null, error: string | null = null;
    try {
      // The first event comes at once: an agent may think a long while.
      yield { type: "reasoning_delta", delta: `${kind.name} is working in ${cwd}\n` };
      for await (const line of lines(child.stdout)) {
        if (signal.aborted) throw signal.reason;
        for (const item of parseAgentLine(kind.id, line, cwd)) {
          if (item.session) this.remember(chatId, kind.id, item.session);
          if (item.step) yield { type: "reasoning_delta", delta: `${item.step}\n` };
          if (item.said) {
            // Words between steps are its narration; the last ones are its answer.
            if (said) yield { type: "reasoning_delta", delta: `${short(said, 200)}\n` };
            said = item.said;
          }
          if (item.answer !== undefined) answer = item.answer;
          if (item.error) error = item.error;
        }
      }
      const code = await child.exited;
      if (signal.aborted) throw signal.reason;
      const final = (answer ?? said).trim();
      if (error || (code !== 0 && !final)) {
        const detail = error ?? await stderr;
        throw new Error(`${kind.name} stopped${code ? ` (exit ${code})` : ""}: ${detail || "no output"}`);
      }
      yield { type: "text_delta", delta: final || `${kind.name} finished without a message.` };
      yield { type: "finish", reason: "stop" };
    } finally {
      signal.removeEventListener("abort", stop);
      child.kill();
    }
  }
}
