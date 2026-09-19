import { shellWords } from "./voice-shell.ts";

/// The agent's voice: tool activity narrated in the first person.
///
/// Each action becomes a natural sentence with a distinct beginning and
/// outcome, so the interface reads like a presence describing its work rather
/// than a log of machinery. Sentences are plain and honest: they never claim
/// understanding or feelings the turn does not support.

export type ToolOutcome =
  | { state: "running" }
  | { state: "done"; exitCode?: number; created?: boolean }
  | { state: "failed"; message?: string }
  | { state: "denied" };

export function narrateToolStart(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `reading ${path(input, "path")}.`;
    case "read_files": {
      const count = pathList(input).length;
      return count > 0 ? `reading ${count} file${count === 1 ? "" : "s"}.` : "reading files.";
    }
    case "list_files":
      return `looking around ${path(input, "path") ?? "the workspace"}.`;
    case "search_files":
      return `searching for ${quote(input, "query")}.`;
    case "edit_file":
      return `changing ${path(input, "path")}.`;
    case "write_file":
      return `writing ${path(input, "path")}.`;
    case "move_path":
      return `moving ${path(input, "from")} to ${path(input, "to")}.`;
    case "delete_path":
      return `deleting ${path(input, "path")}.`;
    case "run_command":
      return `running ${command(input)}.`;
    case "git_status":
      return "checking git.";
    case "git_diff":
      return "reviewing the diff.";
    case "command_logs":
      return "reading the log.";
    case "command_stop":
      return "stopping the command.";
    default:
      if (name.startsWith("mcp__")) {
        const [server, tool] = mcpParts(name);
        return `using ${safeWord(server ?? "")}${server && tool ? "’s " : ""}${safeWord(tool ?? "")}.`;
      }
      return `working with ${name}.`;
  }
}

/// A pending-action line in the agent's voice.
export function narrateToolIntent(name: string, input: Record<string, unknown>): string {
  return `I’m ${narrateToolStart(name, input)}`;
}

export function narrateToolOutcome(
  name: string,
  input: Record<string, unknown>,
  outcome: ToolOutcome,
): string {
  if (outcome.state === "running") return narrateToolStart(name, input);
  if (outcome.state === "denied") {
    return `I didn’t ${gerundBase(narrateToolStart(name, input))}.`;
  }
  if (outcome.state === "failed") {
    const suffix = outcome.message ? ` — ${sentence(outcome.message)}` : "";
    return `I couldn’t ${gerundBase(narrateToolStart(name, input))}.${suffix}`;
  }

  switch (name) {
    case "read_file":
      return `I read ${path(input, "path")}.`;
    case "read_files": {
      const count = pathList(input).length;
      return `I read ${count} file${count === 1 ? "" : "s"}.`;
    }
    case "list_files":
      return "I looked around.";
    case "search_files":
      return `I searched for ${quote(input, "query")}.`;
    case "edit_file":
      return `I changed ${path(input, "path")}.`;
    case "write_file":
      return (outcome.created ?? false) ? `I created ${path(input, "path")}.` : `I wrote ${path(input, "path")}.`;
    case "move_path":
      return `I moved ${path(input, "from")} to ${path(input, "to")}.`;
    case "delete_path":
      return `I deleted ${path(input, "path")}.`;
    case "run_command": {
      const passed = outcome.exitCode === undefined || outcome.exitCode === 0;
      return passed
        ? `I ran ${command(input)} — it passed.`
        : `I ran ${command(input)} — exit ${outcome.exitCode}.`;
    }
    case "git_status":
      return "I checked git.";
    case "git_diff":
      return "I reviewed the diff.";
    case "command_logs":
      return "I read the log.";
    case "command_stop":
      return "I stopped the command.";
    default:
      if (name.startsWith("mcp__")) {
        const [server, tool] = mcpParts(name);
        return `I used ${safeWord(server ?? "")}${server && tool ? "’s " : ""}${safeWord(tool ?? "")}.`;
      }
      return `I finished with ${name}.`;
  }
}

/// Closers for turn ends, in the agent's voice.
export function narrateTurnEnd(
  kind: "completed" | "stopped" | "failed",
  details: string,
): string {
  switch (kind) {
    case "completed":
      return `I’m done${details ? ` — ${details}` : "."}`;
    case "stopped":
      return `I stopped${details ? ` — ${details}` : "."}`;
    case "failed":
      return `I hit a problem${details ? ` — ${details}` : "."}`;
  }
}

/// A soft first-person cue for a turn that needs approval.
export function narrateWaiting(summary: string): string {
  return `I need your go-ahead: ${sentence(summary)}`;
}

function path(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : "a file";
}

function pathList(input: Record<string, unknown>): string[] {
  return Array.isArray(input.paths) && input.paths.every((value) => typeof value === "string")
    ? input.paths as string[]
    : [];
}

function quote(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) return "something";
  return `“${value.trim()}”`;
}

function command(input: Record<string, unknown>): string {
  if (Array.isArray(input.argv) && input.argv.every((value) => typeof value === "string")) {
    return `\`${shellWords(input.argv as string[])}\``;
  }
  return "a command";
}

function mcpParts(name: string): [string | undefined, string | undefined] {
  const [, server, tool] = name.split("__");
  return [server, tool];
}

/// Keeps tokenized voice output inside the sentence: never empty, never
/// containing control characters.
function safeWord(value: string): string {
  const sanitized = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return sanitized || "the tool";
}

function sentence(value: string): string {
  const sanitized = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const text = sanitized.length > 200 ? `${sanitized.slice(0, 199)}…` : sanitized;
  return text.replace(/[.!?]+$/, "");
}

/// Elides a repeated letter on "I didn't / I couldn't" when the verb starts
/// with a vowel sound; the narration keeps apostrophes ASCII for width math.
const apos = "’";

/// Turns a gerund-led start ("reading x.ts.") into a bare verb phrase
/// ("read x.ts.").
const IRREGULAR_GERUNDS: Record<string, string> = {
  writing: "write",
  moving: "move",
  deleting: "delete",
  making: "make",
  using: "use",
  running: "run",
};

function gerundBase(start: string): string {
  const space = start.indexOf(" ");
  if (space === -1) return start.replace(/ing$/, "").replace(/\.+$/, "");
  const first = start.slice(0, space);
  const rest = start.slice(space);
  const base = IRREGULAR_GERUNDS[first] ?? first.replace(/ing$/, "");
  return `${base}${rest.replace(/\.+$/, "")}`;
}