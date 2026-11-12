import type { ProviderToolDefinition } from "@demesne/providers";

/// Tool search, the way Codex does it. A chat's tool descriptions were about
/// 18% of every request's input, mostly tools a turn never calls (Foundry,
/// threads, research, MCP servers…). Only the everyday tools go out whole;
/// the rest are one line each in the system prompt, and tool_search loads
/// the ones a turn needs. A tool loaded once stays loaded for the chat, so
/// the request (and its prompt cache) stays the same from then on.

export const TOOL_SEARCH = "tool_search";

/// Sent whole every time: reading, editing, running, asking, planning,
/// delegating and searching the web.
export const CORE_TOOLS = new Set([
  "read_file", "read_files", "list_files", "search_files", "edit_file", "write_file", "run_command", "run_tests",
  "git_status", "git_diff", "ask_user", "update_plan", "subagent", "agents", "web_search", "view_image", "propose_next",
  // Offered only when a chat has sources (sources.ts), so it rides whole.
  "read_source",
]);
/// Below this, deferring saves less than the list and the search cost.
const MIN_DEFERRED_CHARS = 3000;
const MAX_RESULTS = 4;

const size = (definition: ProviderToolDefinition) => JSON.stringify(definition).length;

/// What goes to the model this round, and what waits behind tool_search.
export function splitTools(definitions: readonly ProviderToolDefinition[], loaded: ReadonlySet<string>): { sent: ProviderToolDefinition[]; deferrable: ProviderToolDefinition[] } {
  const deferrable = definitions.filter((definition) => !CORE_TOOLS.has(definition.name) && definition.name !== TOOL_SEARCH);
  if (deferrable.reduce((total, definition) => total + size(definition), 0) < MIN_DEFERRED_CHARS) return { sent: [...definitions], deferrable: [] };
  const sent = definitions.filter((definition) => CORE_TOOLS.has(definition.name) || loaded.has(definition.name));
  if (deferrable.some((definition) => !loaded.has(definition.name))) sent.push(toolSearchDefinition);
  return { sent, deferrable };
}

export const toolSearchDefinition: ProviderToolDefinition = {
  name: TOOL_SEARCH,
  description: "Load tools listed under \"More tools\" in your instructions, by name or by what you need, before calling them. Loaded tools stay available for the rest of this chat. Load several at once when a job needs them.",
  inputSchema: {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" }, maxItems: 8, description: "Exact tool names from the list." },
      query: { type: "string", description: "What you need, in a few words, when you don't know the name." },
    },
    additionalProperties: false,
  },
};

/// One line per tool: its name and the first sentence of what it does.
export function summary(definition: ProviderToolDefinition): string {
  const first = (definition.description ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 110 ? `${first.slice(0, 107).trimEnd()}…` : first;
}

/// The system prompt's list. It names every tool that can wait, loaded or
/// not, so it never changes within a chat.
export function moreToolsSection(deferrable: readonly ProviderToolDefinition[]): string {
  if (!deferrable.length) return "";
  return `\n\nMore tools (load with ${TOOL_SEARCH} first, then call them):\n${deferrable.map((definition) => `- ${definition.name}: ${summary(definition)}`).join("\n")}`;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);

/// tool_search itself: the tools named, else the best matches for the query.
export function searchTools(deferrable: readonly ProviderToolDefinition[], input: unknown): { found: ProviderToolDefinition[]; result: string } {
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
  if (!found.length) return { found, result: JSON.stringify({ loaded: [], note: `Nothing matched. Tools you can load: ${deferrable.map((definition) => definition.name).join(", ")}` }) };
  return { found, result: JSON.stringify({ loaded: found.map((definition) => definition.name), note: "Loaded. Call them now; they stay available for this chat." }) };
}
