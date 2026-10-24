import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadWorkflows } from "@demesne/drive/workflows.ts";
import { loadCustomCommands } from "./custom-commands.ts";

/// Customize: everything that shapes how Demesne works in a project, in one
/// page. The files stay where they are (the project's instructions file and
/// its `.demesne/commands` and `.demesne/workflows`, and yours under
/// `~/.demesne`); the page lists them and edits them in place.

export const INSTRUCTION_NAMES = ["DEMESNE.md", "AGENTS.md"] as const;

export interface CustomizeFile { name: string; description: string; path: string; mine: boolean; steps?: number; checks?: number }
export interface CustomizeView {
  root: string | null;
  /// The instructions file the model reads, or where a new one would go.
  instructions: { path: string; name: string; exists: boolean; lines: number; first: string } | null;
  commands: CustomizeFile[];
  workflows: CustomizeFile[];
}

const firstLine = (text: string) => text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line && !line.startsWith("---")) ?? "";

export function customizeView(root: string | null, home = homedir()): CustomizeView {
  const mine = (path: string) => path.startsWith(join(home, ".demesne") + sep);
  let instructions: CustomizeView["instructions"] = null;
  if (root) {
    const found = INSTRUCTION_NAMES.map((name) => join(root, name)).find((path) => existsSync(path));
    const path = found ?? join(root, INSTRUCTION_NAMES[0]);
    let text = "";
    try { if (found) text = readFileSync(found, "utf8"); } catch { /* unreadable reads as empty */ }
    instructions = { path, name: basename(path), exists: Boolean(found), lines: text ? text.split("\n").length : 0, first: firstLine(text) };
  }
  let commands: CustomizeFile[] = [], workflows: CustomizeFile[] = [];
  try { commands = loadCustomCommands(root ?? undefined, home).map((custom) => ({ name: custom.command.name.replace(/^\//, ""), description: custom.command.description, path: custom.source, mine: mine(custom.source) })); } catch { /* none */ }
  try { workflows = loadWorkflows(root ?? undefined, home).map((workflow) => ({ name: workflow.name, description: workflow.description, path: workflow.source, mine: mine(workflow.source), steps: workflow.steps.length, checks: workflow.steps.filter((step) => step.check).length })); } catch { /* none */ }
  return { root, instructions, commands, workflows };
}

/// Only these files can be read or written from the page: the project's
/// instructions, and command and workflow files, the project's or yours.
export function customizable(path: string, root: string | null, home = homedir()): boolean {
  const absolute = resolve(path);
  if (!absolute.endsWith(".md")) return false;
  const inside = (folder: string) => {
    const rel = relative(folder, absolute);
    return Boolean(rel) && !rel.startsWith("..") && !rel.includes(sep);
  };
  const real = (folder: string) => { try { return realpathSync(folder); } catch { return folder; } };
  // A symlink could lead a write out of the folder it seems to be in.
  try { if (lstatSync(absolute).isSymbolicLink()) return false; } catch { /* a new file */ }
  if (root && INSTRUCTION_NAMES.some((name) => absolute === join(root, name) || absolute === join(real(root), name))) return true;
  const folders = [join(home, ".demesne", "commands"), join(home, ".demesne", "workflows"), ...(root ? [join(root, ".demesne", "commands"), join(root, ".demesne", "workflows")] : [])];
  return folders.some((folder) => inside(folder) || inside(real(folder)));
}

export function readCustomizable(path: string, root: string | null, home = homedir()): string {
  if (!customizable(path, root, home)) throw new Error("That file isn't one Customize edits");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeCustomizable(path: string, text: string, root: string | null, home = homedir()) {
  if (!customizable(path, root, home)) throw new Error("That file isn't one Customize edits");
  if (text.length > 256 * 1024) throw new Error("That's too long for one file");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

/// A new command or workflow file in the project (or yours, without one),
/// started with a line saying what goes where.
export function newCustomizable(kind: "command" | "workflow", name: string, root: string | null, home = homedir()) {
  const slug = name.trim().replace(/^\//, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("Name it with letters, numbers and dashes, like ship-it");
  const path = join(root ?? home, ".demesne", kind === "command" ? "commands" : "workflows", `${slug}.md`);
  if (existsSync(path)) throw new Error(`/${slug} already exists`);
  writeCustomizable(path, kind === "command"
    ? "---\ndescription: What /" + slug + " does, in a few words\n---\nWhat to ask, as if you typed it. $ARGUMENTS is what follows the command.\n"
    : "---\ndescription: What /" + slug + " does, in a few words\n---\n## First step\nWhat the coder does in this step.\ncheck: bun test\n\n## Second step\nWhat comes next.\n", root, home);
  return path;
}
