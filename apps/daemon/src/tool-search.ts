import type { ProviderToolDefinition } from "@demesne/providers";

/// Tool search: tools that wait as one line each in the system prompt until
/// the model asks how one is called. The tool list is at the very start of a
/// request, so a tool that joined it later made the provider read the whole
/// chat again (docs/caching.md). So nothing joins it:
///
///  - Demesne's own tools don't wait where there is room. On a model with a
///    large window they all go out whole from the first request, cached
///    after it at a tenth of the price.
///  - A tool that does wait (an MCP server's, or Demesne's own on a small
///    window) is never added to the list. tool_search answers with how it is
///    called, as a tool result at the end of the conversation, and the model
///    calls it through use_tool, which is in the list from the start.
///
/// Everything past the model's call sees the real tool: its row, its
/// approval, its checks. Only the conversation keeps the wrapper.
///
/// Read more: https://developers.openai.com/api/docs/guides/prompt-caching
/// (tools are part of the cached prefix),
/// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
/// (deferring tools that are rarely needed) and
/// https://www.anthropic.com/engineering/code-execution-with-mcp (why a
/// definition is better read when needed than sent every time).

export const TOOL_SEARCH = "tool_search";
export const USE_TOOL = "use_tool";

/// Sent whole every time: reading, editing, running, asking, planning,
/// delegating and searching the web.
export const CORE_TOOLS = new Set([
  "read_file", "read_files", "list_files", "search_files", "edit_file", "write_file", "run_command", "run_tests",
  "git_status", "git_diff", "ask_user", "update_plan", "subagent", "agents", "web_search", "view_image", "propose_next",
  // Small, and in every chat's list (sources.ts, turn-notes.ts).
  "read_source", "recall_turn",
]);
/// Below this, deferring saves less than the list and the search cost.
const MIN_DEFERRED_CHARS = 3000;
/// Demesne's own tools wait only when their descriptions would take more
/// than this share of the model's window (about 85k tokens and up go whole).
const WHOLE_SHARE = 0.08;
const isMcp = (name: string) => name.startsWith("mcp__");
const MAX_RESULTS = 4;

const size = (definition: ProviderToolDefinition) => JSON.stringify(definition).length;

/// Whether Demesne's own tools wait too: only on a window they would crowd.
/// A window nobody told us is taken to be a large one.
export function builtinsWait(definitions: readonly ProviderToolDefinition[], contextCapacity?: number | null): boolean {
  if (!contextCapacity) return false;
  const own = definitions.filter((definition) => !CORE_TOOLS.has(definition.name) && !isMcp(definition.name));
  return own.reduce((total, definition) => total + size(definition), 0) / 4 > contextCapacity * WHOLE_SHARE;
}

/// What goes to the model, and what waits behind tool_search and use_tool.
/// The same definitions give the same list for the whole chat.
export function splitTools(definitions: readonly ProviderToolDefinition[], contextCapacity?: number | null): { sent: ProviderToolDefinition[]; deferrable: ProviderToolDefinition[] } {
  const all = builtinsWait(definitions, contextCapacity);
  const plumbing = (name: string) => name === TOOL_SEARCH || name === USE_TOOL;
  const waits = (definition: ProviderToolDefinition) => !CORE_TOOLS.has(definition.name) && !plumbing(definition.name) && (all || isMcp(definition.name));
  const deferrable = definitions.filter(waits);
  if (deferrable.reduce((total, definition) => total + size(definition), 0) < MIN_DEFERRED_CHARS) return { sent: [...definitions], deferrable: [] };
  return { sent: [...definitions.filter((definition) => !waits(definition)), toolSearchDefinition, useToolDefinition], deferrable };
}

export const toolSearchDefinition: ProviderToolDefinition = {
  name: TOOL_SEARCH,
  description: `See how tools listed under "More tools" in your instructions are called, by name or by what you need. Then call them with ${USE_TOOL}. Ask for several at once when a job needs them.`,
  inputSchema: {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" }, maxItems: 8, description: "Exact tool names from the list." },
      query: { type: "string", description: "What you need, in a few words, when you don't know the name." },
    },
    additionalProperties: false,
  },
};

export const useToolDefinition: ProviderToolDefinition = {
  name: USE_TOOL,
  description: `Call a tool listed under "More tools" in your instructions. ${TOOL_SEARCH} shows its parameters; a first call without them is answered with them and not run.`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The tool's exact name from the list." },
      input: { type: "object", description: "Its arguments, as its parameters describe them." },
    },
    required: ["name", "input"],
    additionalProperties: false,
  },
};

/// What a tool needs said with it beyond its description, such as the
/// design guide a Foundry page follows. It travels with the tool: in the
/// instructions when the tool is in the list, in this answer when it waits.
export type ToolGuide = (definition: ProviderToolDefinition) => string | null | undefined;

/// A tool as tool_search shows it: all the model needs to call it.
const shown = (definition: ProviderToolDefinition, guide?: ToolGuide) => {
  const more = guide?.(definition);
  return { name: definition.name, description: definition.description, parameters: definition.inputSchema, ...(more ? { guide: more } : {}) };
};

/// A call as it was meant: the tool inside a use_tool call, else the call
/// itself. What reads a conversation later (notes, what to forget, the
/// context card) asks this, so a wrapped call counts as the tool it ran.
export function called<Call extends { name: string; arguments: string }>(call: Call): Call & { wrapped: boolean } {
  if (call.name !== USE_TOOL) return { ...call, wrapped: false };
  try {
    const value = JSON.parse(call.arguments) as { name?: unknown; input?: unknown };
    if (typeof value?.name === "string" && value.name.trim()) return { ...call, name: value.name.trim(), arguments: JSON.stringify(value.input ?? {}), wrapped: true };
  } catch { /* Not a whole call: it stays use_tool and is answered as one. */ }
  return { ...call, wrapped: false };
}

/// A call's arguments rewritten, wrapper kept: `rewrite` sees the real tool
/// and its arguments and answers the new arguments, or null to leave them.
export function rewriteCalled(name: string, args: string, rewrite: (name: string, args: string) => string | null): string | null {
  const inner = called({ name, arguments: args });
  const next = rewrite(inner.name, inner.arguments);
  if (next === null || !inner.wrapped) return next;
  try { return JSON.stringify({ name: inner.name, input: JSON.parse(next) }); } catch { return null; }
}

/// The waiting tools a conversation has been shown how to call: the ones
/// tool_search answered with, and the ones called through use_tool. Read from
/// the conversation itself, so it holds across a restart and stops holding
/// when compaction takes those turns away.
export function shownTools(messages: readonly { role: string; content?: unknown; toolCallId?: string; toolCalls?: readonly { id: string; name: string; arguments: string }[] }[]): Set<string> {
  const shownNames = new Set<string>(), searches = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) {
      if (call.name === TOOL_SEARCH) searches.add(call.id);
      const inner = called(call);
      if (inner.wrapped) shownNames.add(inner.name);
    }
    if (message.role !== "tool" || !searches.has(message.toolCallId ?? "") || typeof message.content !== "string") continue;
    try {
      const value = JSON.parse(message.content) as { tools?: { name?: unknown }[] };
      for (const tool of Array.isArray(value.tools) ? value.tools : []) if (typeof tool?.name === "string") shownNames.add(tool.name);
    } catch { /* A result cut short names nothing. */ }
  }
  return shownNames;
}

/// A use_tool call while the model is still writing it: the tool inside and
/// its arguments so far, once the name is there. The wrapper's own closing
/// brace is held back, so the arguments read as the tool's own.
export function draftOfUse(args: string): { name: string; arguments: string } | null {
  const match = /^\s*\{\s*"name"\s*:\s*"([^"\\]+)"\s*,\s*"input"\s*:\s*/.exec(args);
  if (!match) return null;
  return { name: match[1]!, arguments: args.slice(match[0].length).replace(/\}\s*$/, "") };
}

/// use_tool when it can't run the tool as asked: how the tool is called, the
/// first time, or what is wrong with the call.
export function useToolAnswer(deferrable: readonly ProviderToolDefinition[], sent: ReadonlySet<string>, input: unknown, guide?: ToolGuide): { show?: ProviderToolDefinition; result: string } {
  const value = input && typeof input === "object" ? input as { name?: unknown } : {};
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const definition = deferrable.find((one) => one.name === name);
  if (definition) return { show: definition, result: JSON.stringify({ notRun: true, tool: shown(definition, guide), note: `Not run: this is how ${name} is called. Call ${USE_TOOL} again with input that fits its parameters.` }) };
  if (name && sent.has(name)) return { result: `Error: ${name} is in your tool list. Call it directly, not through ${USE_TOOL}.` };
  return { result: `Error: ${USE_TOOL} takes {"name": a tool from "More tools", "input": its arguments}. ${name ? `${name} is not one of them` : "No name was given"}. They are: ${deferrable.map((one) => one.name).join(", ") || "none"}` };
}

/// One line per tool: its name and the first sentence of what it does.
export function summary(definition: ProviderToolDefinition): string {
  const first = (definition.description ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 110 ? `${first.slice(0, 107).trimEnd()}…` : first;
}

/// The system prompt's list. It names every tool that can wait, loaded or
/// not, so it never changes within a chat.
export function moreToolsSection(deferrable: readonly ProviderToolDefinition[]): string {
  if (!deferrable.length) return "";
  return `\n\nMore tools (not in your tool list: ${TOOL_SEARCH} shows how one is called, ${USE_TOOL} calls it):\n${deferrable.map((definition) => `- ${definition.name}: ${summary(definition)}`).join("\n")}`;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);

/// tool_search itself: how the tools named are called, else the best matches
/// for the query.
export function searchTools(deferrable: readonly ProviderToolDefinition[], input: unknown, guide?: ToolGuide): { found: ProviderToolDefinition[]; result: string } {
  const value = input && typeof input === "object" ? input as { names?: unknown; query?: unknown } : {};
  const names = Array.isArray(value.names) ? value.names.filter((name): name is string => typeof name === "string").map((name) => name.trim().toLowerCase()) : [];
  const query = typeof value.query === "string" ? value.query : "";
  let found = deferrable.filter((definition) => names.includes(definition.name.toLowerCase()));
  if (!found.length && (query || names.length)) {
    const asked = new Set(words(`${query} ${names.join(" ")}`));
    found = deferrable
      .map((definition) => ({ definition, score: words(definition.name).filter((word) => asked.has(word)).length * 3 + words(definition.description ?? "").filter((word) => asked.has(word)).length }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((match) => match.definition);
  }
  if (!found.length) return { found, result: JSON.stringify({ tools: [], note: `Nothing matched. The tools that wait: ${deferrable.map((definition) => definition.name).join(", ")}` }) };
  return { found, result: JSON.stringify({ tools: found.map((definition) => shown(definition, guide)), note: `Call each with ${USE_TOOL}: {"name": its name, "input": arguments that fit its parameters}.` }) };
}
