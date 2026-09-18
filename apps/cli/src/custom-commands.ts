import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SlashCommand } from "@demesne/brand";

/// Markdown command files that extend the slash palette.
///
/// Files live in `~/.demesne/commands/` (user) and
/// `<workspace>/.demesne/commands/` (project); the project wins on a name
/// collision. Each file is named `<command>.md`, may open with a `---`
/// frontmatter block containing `description:`, and its body is the prompt.
/// `$ARGUMENTS` is substituted when present, otherwise the argument is
/// appended as a final paragraph. Built-in command names are never shadowed.

export interface CustomCommand {
  command: SlashCommand;
  body: string;
  source: string;
}

export function loadCustomCommands(workspaceRoot: string | undefined, home = homedir()): CustomCommand[] {
  const directories = [
    join(home, ".demesne", "commands"),
    ...(workspaceRoot ? [join(workspaceRoot, ".demesne", "commands")] : []),
  ];
  const byName = new Map<string, CustomCommand>();
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue;
      const parsed = parseCommandFile(join(directory, entry), name);
      if (parsed) byName.set(name.toLowerCase(), parsed);
    }
  }
  return [...byName.values()].sort((left, right) => left.command.name.localeCompare(right.command.name));
}

/// Built-ins first; custom commands that would shadow a built-in name are
/// dropped rather than silently changing existing behavior.
export function mergeSlashCommands(
  builtIns: readonly SlashCommand[],
  customs: readonly CustomCommand[],
): SlashCommand[] {
  const names = new Set(builtIns.map((command) => command.name.toLowerCase()));
  return [
    ...builtIns,
    ...customs.map((custom) => custom.command).filter((command) => !names.has(command.name.toLowerCase())),
  ];
}

export function expandCustomCommand(custom: CustomCommand, argument: string): string {
  const args = argument.trim();
  if (custom.body.includes("$ARGUMENTS")) return custom.body.replaceAll("$ARGUMENTS", args);
  return args ? `${custom.body}\n\n${args}` : custom.body;
}

function parseCommandFile(path: string, name: string): CustomCommand | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let description = "";
  let body = text;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (frontmatter) {
    body = text.slice(frontmatter[0].length);
    for (const line of frontmatter[1]!.split(/\r?\n/)) {
      const entry = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (entry && entry[1]!.toLowerCase() === "description") description = entry[2]!.trim();
    }
  }
  const trimmed = body.trim();
  if (!trimmed) return null;
  return {
    command: {
      id: `custom:${name}`,
      name: `/${name}`,
      aliases: [],
      argument: "optional",
      argumentLabel: "arguments",
      description: description || "Custom command",
      section: "session",
    },
    body: trimmed,
    source: path,
  };
}
