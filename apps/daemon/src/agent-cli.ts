/// Agents that live in Demesne: the agent tools installed on this machine
/// (Claude Code, Codex, and Gemini through Google's Antigravity CLI `agy`)
/// run as ordinary chats. Demesne starts the
/// tool itself, headless, in the chat's folder, one run per turn, and keeps
/// the tool's own session going from turn to turn. Nobody opens a terminal:
/// Heartbeat mail to the chat starts its next turn like any other chat's.
///
/// A chat is an agent's when its model is `agent:<id>`. The tool runs its own
/// tools under its own rules; Demesne shows what it did as the turn's
/// working lines and its last message as the answer.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import type { TurnInference } from "./processor.ts";

export const AGENT_MODEL_PREFIX = "agent:";

export type AgentId = "claude" | "codex" | "gemini";

export interface AgentKind { id: AgentId; name: string; command: string }

export const AGENT_KINDS: readonly AgentKind[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
  // Google stopped serving the Gemini CLI to personal accounts (2026-06-18);
  // Gemini now lives in the Antigravity CLI.
  { id: "gemini", name: "Gemini", command: "agy" },
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
  /// Where the tools keep their own settings (your home folder by default).
  home?: string;
  /// `agy models` output, for Gemini's model picker (runs the tool by default).
  agyModels?: (path: string) => string;
}

/// The model you picked for an agent (pass 143 B), saved per agent and
/// passed to its tool on every turn. Nothing picked: the tool's own default.
/// The tools' own config files are only read, never changed.
export type AgentEffort = "low" | "medium" | "high";
export const AGENT_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high"];
export interface AgentChoice { model?: string; effort?: AgentEffort }
export interface AgentModelOption { id: string; label: string; note: string }
/// What an agent runs on, for its profile: your pick, the tool's own
/// default, the line to show, and what you can pick from.
export interface AgentRunsOn {
  model: string | null;
  effort: AgentEffort | null;
  toolModel: string | null;
  toolEffort: string | null;
  label: string;
  options: AgentModelOption[];
  /// Thinking levels, for the tools that take one (Codex).
  efforts: AgentEffort[] | null;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const ALIASES: Record<AgentId, AgentModelOption[]> = {
  claude: [{ id: "opus", label: "Opus", note: "the strongest" }, { id: "sonnet", label: "Sonnet", note: "balanced" }, { id: "haiku", label: "Haiku", note: "quickest" }],
  codex: [],
  gemini: [],
};
const capital = (text: string) => text ? text[0]!.toUpperCase() + text.slice(1) : text;

function modelLabel(id: AgentId, model: string): string {
  return ALIASES[id].find((option) => option.id === model.toLowerCase())?.label ?? model;
}

/// The model each tool runs when Demesne passes none, read from its own
/// settings: Claude Code's settings.json, Codex's config.toml, Gemini's
/// settings.json. Unreadable or unset: null.
export function toolDefault(id: AgentId, home: string): { model: string | null; effort: string | null } {
  const read = (...parts: string[]) => { try { return readFileSync(join(home, ...parts), "utf8"); } catch { return ""; } };
  if (id === "codex") {
    // Only top-level keys: they end at the first [table].
    const top = read(".codex", "config.toml").split(/^\s*\[/m)[0] ?? "";
    const key = (name: string) => top.match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1] ?? null;
    return { model: key("model"), effort: key("model_reasoning_effort") };
  }
  let settings: { model?: unknown } = {};
  try { settings = JSON.parse((id === "claude" ? read(".claude", "settings.json") : read(".gemini", "antigravity-cli", "settings.json")) || "{}"); } catch { /* unreadable */ }
  const model = typeof settings.model === "string" ? settings.model
    : settings.model && typeof settings.model === "object" && typeof (settings.model as { name?: unknown }).name === "string" ? (settings.model as { name: string }).name : null;
  return { model, effort: null };
}

/// `agy models` lines: a model id, then its label ("gemini-4-argon-high  Gemini 4 Argon (High)").
export function agyModelList(output: string): AgentModelOption[] {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^([a-z0-9][a-z0-9._-]*[a-z0-9])(?:\s+(.+))?$/);
    return match && /\d|-/.test(match[1]!) ? [{ id: match[1]!, label: match[2]?.trim() || match[1]!, note: match[2] ? match[1]! : "" }] : [];
  });
}

/// One run's command line: the prompt is the last argument, and `resume` is
/// the tool's session to carry on (or, for Claude Code, the id to start).
/// `choice` is the model (and Codex thinking level) you picked, if any.
/// `allow` is Antigravity's permission rules for this run (agyAllow).
export function agentArgs(id: AgentId, prompt: string, resume: { id: string; fresh: boolean } | null, choice: AgentChoice = {}, allow: string[] = []): string[] {
  const model = choice.model && MODEL_NAME.test(choice.model) ? choice.model : null;
  if (id === "claude") return ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    ...(model ? ["--model", model] : []), ...(resume ? [resume.fresh ? "--session-id" : "--resume", resume.id] : []), prompt];
  if (id === "codex") {
    // Config overrides (-c) hold for `exec resume` too.
    const effort = choice.effort && AGENT_EFFORTS.includes(choice.effort) ? choice.effort : null;
    const overrides = [...(model ? ["-c", `model="${model}"`] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
    return ["exec", "--json", "--full-auto", "--skip-git-repo-check", ...overrides, ...(resume ? ["resume", resume.id] : []), prompt];
  }
  return ["-p", prompt, "--output-format", "stream-json", "--mode", "accept-edits", ...(allow.length ? ["--settings", JSON.stringify({ permissions: { allow } })] : []),
    ...(model ? ["--model", model] : []), ...(resume ? ["--conversation", resume.id] : [])];
}

/// What Antigravity may do in a headless run, where it can't ask: like
/// Claude Code's accept-edits, read and change files in the project, and
/// run only the commands your own Antigravity settings already allow.
/// Rules take the folder's real path (agy checks /private/var, not /var)
/// and a bare folder covers what's inside it; globs don't work.
export function agyAllow(root: string, home: string): string[] {
  let own: unknown = [];
  try { own = (JSON.parse(readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8")) as { permissions?: { allow?: unknown } }).permissions?.allow ?? []; } catch { /* none */ }
  const yours = Array.isArray(own) ? own.filter((rule): rule is string => typeof rule === "string") : [];
  return [...new Set([`read_file(${root})`, `write_file(${root})`, ...yours])];
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
/// `state` carries Antigravity's streamed words between lines, by step.
export function parseAgentLine(id: AgentId, line: string, cwd: string, state: AgyState = { words: {} }): AgentLine[] {
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
  return parseAgyLine(event, cwd, state);
}

export interface AgyState { words: Record<number, string> }

/// Antigravity's stream-json: `init` names the conversation, `step_update`s
/// stream words (text_delta) and tools by step, and `result` is the answer.
function parseAgyLine(event: Record<string, unknown>, cwd: string, state: AgyState): AgentLine[] {
  const kind = event.event;
  if (kind === "init" && typeof event.conversation_id === "string") return [{ session: event.conversation_id }];
  if (kind === "step_update") {
    const step = record(event.step_update);
    const index = typeof step.step_index === "number" ? step.step_index : -1;
    if (step.step_type === "agent_response") {
      if (typeof step.text_delta === "string") state.words[index] = (state.words[index] ?? "") + step.text_delta;
      if (step.state !== "DONE") return [];
      const words = state.words[index] ?? "";
      delete state.words[index];
      return words.trim() ? [{ said: words.trim() }] : [];
    }
    if (step.step_type === "tool" && (step.state === "DONE" || step.state === "ERROR")) {
      const info = record(step.tool_info);
      // Its parameters are capitalized ("Path", "CommandLine").
      const input = Object.fromEntries(Object.entries(record(info.parameters)).map(([key, value]) => [key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(), value]));
      if (input.command_line !== undefined && input.command === undefined) input.command = input.command_line;
      const line = stepLine(String(step.tool_name ?? info.name ?? "tool"), input, cwd);
      if (step.state === "DONE") return [{ step: line }];
      const why = String(record(step.error).message ?? "");
      return [{ step: `${line} (${/permission/i.test(why) ? "not allowed" : "failed"})` }];
    }
    return [];
  }
  if (kind === "result") {
    const result = record(event.result);
    if (result.status !== "SUCCESS") return [{ error: String(record(result.error).message ?? result.error ?? result.status ?? "Antigravity failed") }];
    return typeof result.response === "string" ? [{ answer: result.response.trim() }] : [];
  }
  if (kind === "error") return [{ error: String(record(event.error).message ?? event.message ?? "Antigravity failed") }];
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
  private readonly modelsPath: string;
  private readonly home: string;

  constructor(dataDirectory: string, options: AgentCliOptions = {}) {
    this.which = options.which ?? ((command) => Bun.which(command));
    this.spawn = options.spawn ?? defaultSpawn;
    this.sessionsPath = join(dataDirectory, "agent-sessions.json");
    this.modelsPath = join(dataDirectory, "agent-models.json");
    this.home = options.home ?? homedir();
    this.whichGiven = Boolean(options.which);
    this.agyModels = options.agyModels ?? ((path) => {
      try { return new TextDecoder().decode(Bun.spawnSync([path, "models"], { stdout: "pipe", stderr: "ignore", timeout: 8_000 }).stdout); } catch { return ""; }
    });
  }
  private readonly whichGiven: boolean;
  private readonly agyModels: (path: string) => string;
  private agyListed: AgentModelOption[] | null = null;

  /// A tool on PATH, or in ~/.local/bin, where Antigravity installs itself
  /// (an app-started daemon's PATH may not have it).
  private find(command: string): string | null {
    const found = this.which(command);
    if (found || this.whichGiven) return found;
    const local = join(this.home, ".local", "bin", command);
    return existsSync(local) ? local : null;
  }

  private choices(): Partial<Record<AgentId, AgentChoice>> {
    try { return existsSync(this.modelsPath) ? JSON.parse(readFileSync(this.modelsPath, "utf8")) : {}; } catch { return {}; }
  }

  /// The model you picked for an agent ({} : the tool's own default).
  choice(id: AgentId): AgentChoice { return this.choices()[id] ?? {}; }

  /// Pick an agent's model (null: back to the tool's default) and, for
  /// Codex, its thinking level (null: the tool's own).
  choose(id: AgentId, model: string | null, effort: AgentEffort | null = null): AgentChoice {
    if (model !== null && !MODEL_NAME.test(model)) throw new Error("That isn't a model name");
    if (effort !== null && (id !== "codex" || !AGENT_EFFORTS.includes(effort))) throw new Error("That thinking level isn't one this agent takes");
    const all = this.choices();
    const next: AgentChoice = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    if (next.model || next.effort) all[id] = next; else delete all[id];
    mkdirSync(dirname(this.modelsPath), { recursive: true });
    const temporary = `${this.modelsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(all, null, 2));
    renameSync(temporary, this.modelsPath);
    return next;
  }

  /// The "Runs on" words alone, without listing any models (for Today's
  /// cards: a model list can take seconds). A pick Antigravity hasn't
  /// named yet shows as its id.
  runsLabel(id: AgentId): string {
    const choice = this.choice(id);
    const tool = toolDefault(id, this.home);
    const model = choice.model ?? tool.model;
    const named = id === "gemini" && choice.model ? this.agyListed?.find((option) => option.id === choice.model)?.label : undefined;
    const effort = id === "codex" ? choice.effort ?? tool.effort : null;
    return (named ?? (model ? modelLabel(id, model) : "Tool default")) + (effort ? ` · ${capital(effort)}` : "");
  }

  /// What an agent runs on, for its profile. `plan` is the Codex models on
  /// Demesne's own Codex plan (their slugs), when it has one.
  runsOn(id: AgentId, plan: string[] = []): AgentRunsOn {
    const choice = this.choice(id);
    const tool = toolDefault(id, this.home);
    const fromTool = id === "claude" ? "your Claude Code settings" : id === "codex" ? "your Codex config" : "your Antigravity settings";
    if (id === "gemini" && !this.agyListed?.length) {
      const path = this.find("agy");
      this.agyListed = path ? agyModelList(this.agyModels(path)) : [];
    }
    const extra = id === "gemini" ? this.agyListed ?? [] : ALIASES[id];
    const fallback: AgentModelOption = { id: "", label: "Tool default", note: tool.model ? `${modelLabel(id, tool.model)}, from ${fromTool}` : `${AGENT_KINDS.find((kind) => kind.id === id)!.name} picks` };
    const listed = id === "codex"
      ? [...new Set([...plan, ...(tool.model ? [tool.model] : []), ...(choice.model ? [choice.model] : [])])].map((slug) => ({ id: slug, label: slug, note: plan.includes(slug) ? "on your Codex plan" : "from your Codex config" }))
      : [...extra, ...(choice.model && !extra.some((option) => option.id === choice.model) ? [{ id: choice.model, label: choice.model, note: "your pick" }] : [])];
    const model = choice.model ?? tool.model;
    const effort = id === "codex" ? choice.effort ?? tool.effort : null;
    const named = choice.model ? extra.find((option) => option.id === choice.model)?.label : undefined;
    const label = (named ?? (model ? modelLabel(id, model) : "Tool default")) + (effort ? ` · ${capital(effort)}` : "");
    return { model: choice.model ?? null, effort: choice.effort ?? null, toolModel: tool.model, toolEffort: tool.effort, label, options: [fallback, ...listed], efforts: id === "codex" ? [...AGENT_EFFORTS] : null };
  }

  /// The agent tools on this machine, looked up each time (one installed
  /// later shows up without a restart).
  agents(): FoundAgent[] {
    return AGENT_KINDS.flatMap((kind) => {
      const path = this.find(kind.command);
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
    const path = this.find(kind.command);
    if (!path) throw new Error(`${kind.name} isn't installed on this machine (no \`${kind.command}\` on PATH).`);
    if (!cwd) throw new Error(`${kind.name} works in a project: open one and start it there.`);
    const known = this.sessionFor(chatId, kind.id);
    // Claude Code takes the session id we give it; Codex names its own.
    const resume = known ? { id: known, fresh: false } : kind.id === "claude" ? { id: randomUUID(), fresh: true } : null;
    const prompt = agentPrompt(messages, !known);
    let root = cwd;
    try { root = realpathSync(cwd); } catch { /* as given */ }
    const allow = kind.id === "gemini" ? agyAllow(root, this.home) : [];
    const child = this.spawn([path, ...agentArgs(kind.id, prompt, resume, this.choice(kind.id), allow)], cwd);
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    const stderr = tail(child.stderr);
    let said = "", answer: string | null = null, error: string | null = null;
    const state: AgyState = { words: {} };
    try {
      // The first event comes at once: an agent may think a long while.
      yield { type: "reasoning_delta", delta: `${kind.name} is working in ${cwd}\n` };
      for await (const line of lines(child.stdout)) {
        if (signal.aborted) throw signal.reason;
        for (const item of parseAgentLine(kind.id, line, cwd, state)) {
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
