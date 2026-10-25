export { THEME_INPUT_COLORS, createCustomTheme, parseSavedTheme, type ThemeLibrary } from "./custom-theme.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export {
  THEMES,
  resolveTheme,
  themeNames,
  type Theme,
} from "./theme.ts";
import {
  DEFAULT_DARK_THEME,
  THEMES,
  isThemeName,
  type Theme,
} from "./theme.ts";

/// Resolves a name, or an already-resolved theme, to a theme. `dark` and
/// `light` stay accepted for the configurations written before named themes.
export function themeByName(theme: string | Theme | undefined): Theme {
  if (theme && typeof theme === "object") return theme;
  const wanted = theme?.trim().toLowerCase();
  if (!wanted || wanted === "dark") return THEMES[DEFAULT_DARK_THEME]!;
  if (wanted === "light") return THEMES["demesne-light"]!;
  return isThemeName(wanted) ? THEMES[wanted]! : THEMES[DEFAULT_DARK_THEME]!;
}

export type SlashCommandId =
  | "new" | "sessions" | "resume" | "rename" | "delete" | "cleanup" | "model" | "subagent" | "export" | "plan"
  | "status" | "context" | "diff" | "undo" | "compact" | "drive" | "clear" | "help" | "theme" | "themefy" | "providers" | "exit"
  | `custom:${string}` | `workflow:${string}`;
export type SlashCommandArgument = "none" | "optional" | "required";
export type SlashCommandSection = "session" | "inspect" | "control";

export interface SlashCommand {
  id: SlashCommandId;
  name: `/${string}`;
  aliases: readonly `/${string}`[];
  argument: SlashCommandArgument;
  argumentLabel?: string;
  description: string;
  /// A short tag shown beside the command in menus, e.g. "workflow · 4 steps".
  detail?: string;
  /// One line about what running it does, shown while it is selected.
  preview?: string;
  section: SlashCommandSection;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "new", name: "/new", aliases: [], argument: "optional", argumentLabel: "title", description: "Start a fresh session", section: "session" },
  { id: "sessions", name: "/sessions", aliases: [], argument: "optional", argumentLabel: "filter", description: "Browse or search recent sessions", section: "session" },
  { id: "resume", name: "/resume", aliases: ["/switch"], argument: "required", argumentLabel: "id", description: "Switch to a session", section: "session" },
  { id: "rename", name: "/rename", aliases: [], argument: "required", argumentLabel: "title", description: "Rename the current session", section: "session" },
  { id: "delete", name: "/delete", aliases: ["/archive"], argument: "none", description: "Archive the current session", section: "session" },
  { id: "cleanup", name: "/cleanup", aliases: [], argument: "none", description: "Delete empty, quick and old sessions", section: "session" },
  { id: "model", name: "/model", aliases: [], argument: "optional", argumentLabel: "id", description: "Switch the active model", section: "session" },
  { id: "subagent", name: "/subagent", aliases: [], argument: "optional", argumentLabel: "model", description: "Choose the model sub-agents run on", section: "session" },
  { id: "theme", name: "/theme", aliases: [], argument: "optional", argumentLabel: "name", description: "Change the color theme", section: "session" },
  { id: "themefy", name: "/themefy", aliases: [], argument: "optional", argumentLabel: "preferences|undo", description: "Design a theme with a guided interview", section: "session" },
  { id: "providers", name: "/providers", aliases: ["/login", "/logout"], argument: "none", description: "Sign in to or out of model providers", section: "session" },
  { id: "status", name: "/status", aliases: [], argument: "none", description: "Show session and runtime status", section: "inspect" },
  { id: "context", name: "/context", aliases: [], argument: "none", description: "Show context and run details", section: "inspect" },
  { id: "export", name: "/export", aliases: [], argument: "optional", argumentLabel: "md|json", description: "Export the session transcript", section: "inspect" },
  { id: "diff", name: "/diff", aliases: [], argument: "none", description: "Review the last turn's changes", section: "inspect" },
  { id: "plan", name: "/plan", aliases: [], argument: "required", argumentLabel: "prompt", description: "Draft a read-only plan before changing anything", section: "control" },
  { id: "drive", name: "/drive", aliases: [], argument: "optional", argumentLabel: "mission|pause|resume|stop", description: "Give Agent Drive a mission or open its panel", section: "control" },
  { id: "undo", name: "/undo", aliases: [], argument: "optional", argumentLabel: "path", description: "Revert last turn's changes", section: "control" },
  { id: "compact", name: "/compact", aliases: [], argument: "optional", argumentLabel: "instructions", description: "Summarize older context, keeping recent turns", section: "control" },
  { id: "clear", name: "/clear", aliases: [], argument: "none", description: "Refresh the current view", section: "control" },
  { id: "help", name: "/help", aliases: [], argument: "none", description: "Show command help", section: "control" },
  { id: "exit", name: "/exit", aliases: ["/quit", "/leave"], argument: "none", description: "Exit Demesne", section: "control" },
] as const;

export function slashCommandCompletion(command: SlashCommand): string {
  return command.argument === "none" ? command.name : `${command.name} `;
}

/// Operation colors identify what a tool does. Outcome colors are separate:
/// verification uses `execute` while it runs; only confirmed results use citron.
export type ToolPhaseName = "inspect" | "change" | "verify";

export function previousGraphemeBoundary(value: string, index: number): number {
  let previous = 0;
  for (const item of graphemeSegmenter.segment(value)) {
    if (item.index >= index) break;
    previous = item.index;
  }
  return previous;
}

export function nextGraphemeBoundary(value: string, index: number): number {
  for (const item of graphemeSegmenter.segment(value)) {
    const boundary = item.index + item.segment.length;
    if (boundary > index) return boundary;
  }
  return value.length;
}

