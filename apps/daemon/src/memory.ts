import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/// Demesne's memory (pass 249 A): what the model learned from what you said,
/// kept in two halves. "About you" (~/.demesne/memory/MEMORY.md) goes with you
/// to every project: how you like to work, what you dislike. "This project"
/// (.demesne/memory/MEMORY.md in the project) holds facts about the project
/// that the code doesn't already show. Rules you say in words ("always…")
/// still go to DEMESNE.md, which is shared with anyone on the repo.
///
/// The model saves a line quietly with remember (learned: you | project) and
/// the window says so with the silver pill (pass 254), which can undo it.
/// Both halves are read once, when a chat's first request goes out, and kept
/// for the rest of the chat, so learning something never changes the start of
/// a chat that is running and its prompt cache keeps holding.
///
/// Read more: https://code.claude.com/docs/en/memory (Claude Code's auto
/// memory, the same two-level idea) and
/// https://www.anthropic.com/research/components-of-agent-memory (layers of
/// agent memory, and why the part every session sees stays small).

export type MemoryScope = "you" | "project";
export interface MemoryLine { text: string; from: string; day: string }

export const MEMORY_FILE = join(".demesne", "memory", "MEMORY.md");
/// Lines kept per half: past this the oldest goes, so the start of a chat stays small.
export const MEMORY_KEPT = 60;
export const MEMORY_LINE_MAX = 200;
const BLOCK_MAX = 6000;
const HEADER: Record<MemoryScope, string> = {
  you: "# About you\n\nWhat Demesne learned about how you work. It goes with you to every project. Edit or delete lines freely.\n",
  project: "# This project\n\nWhat Demesne learned about this project. Edit or delete lines freely.\n",
};

export function memoryFile(scope: MemoryScope, workspaceRoot: string | undefined, home = homedir()): string | null {
  if (scope === "you") return join(home, MEMORY_FILE);
  return workspaceRoot ? join(workspaceRoot, MEMORY_FILE) : null;
}

/// A chat outside a project works in your home folder: its "project" half is the "you" half.
export function scopeFor(scope: MemoryScope, workspaceRoot: string | undefined, home = homedir()): MemoryScope {
  return scope === "project" && (!workspaceRoot || samePath(workspaceRoot, home)) ? "you" : scope;
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
const LINE = /^\s*[-*]\s+(.+?)\s*$/;
const TAIL = /\s+\(([^()]*)\)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/// The lines of one half's file, oldest first. Anything that isn't a bullet is ignored.
export function parseMemory(content: string): MemoryLine[] {
  const lines: MemoryLine[] = [];
  for (const raw of content.split("\n")) {
    const bullet = LINE.exec(raw)?.[1];
    if (!bullet) continue;
    const tail = TAIL.exec(bullet);
    if (!tail) { lines.push({ text: bullet, from: "", day: "" }); continue; }
    const parts = tail[1]!.split(",").map((part) => part.trim());
    const day = DAY.test(parts.at(-1) ?? "") ? parts.pop()! : "";
    lines.push({ text: bullet.slice(0, tail.index).trim(), from: parts.join(", "), day });
  }
  return lines.filter((line) => line.text);
}

const lineOf = (line: MemoryLine) => `- ${line.text}${line.from || line.day ? ` (${[line.from, line.day].filter(Boolean).join(", ")})` : ""}`;
const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/// The file with its bullets replaced by `lines`, keeping any text you wrote above them.
export function withLines(content: string, lines: MemoryLine[], scope: MemoryScope): string {
  const kept = content.split("\n").filter((raw) => !LINE.test(raw)).join("\n").replace(/\s+$/, "");
  return `${kept || HEADER[scope].trimEnd()}\n\n${lines.map(lineOf).join("\n")}\n`;
}

export function readMemory(path: string | null): MemoryLine[] {
  if (!path || !existsSync(path)) return [];
  try { return parseMemory(readFileSync(path, "utf8")); } catch { return []; }
}

/// Adds a line (the same words again only move it to the newest place). The
/// oldest go past MEMORY_KEPT.
export function addMemory(path: string, scope: MemoryScope, text: string, from: string, day: string): { saved: boolean; text: string } {
  const clean = text.replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "").replace(/[()]/g, "").slice(0, MEMORY_LINE_MAX);
  if (!clean) return { saved: false, text: clean };
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = parseMemory(before);
  const had = lines.findIndex((line) => key(line.text) === key(clean));
  if (had === lines.length - 1 && had >= 0) return { saved: false, text: clean };
  if (had >= 0) lines.splice(had, 1);
  lines.push({ text: clean, from: from.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60), day });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, withLines(before, lines.slice(-MEMORY_KEPT), scope), "utf8");
  return { saved: true, text: clean };
}

/// Drops the line with these words: the same text first, else the one line that contains them.
export function forgetMemory(path: string | null, scope: MemoryScope, words: string): { forgotten: boolean; text?: string; left: string[] } {
  const lines = readMemory(path);
  const wanted = key(words);
  let at = lines.findIndex((line) => key(line.text) === wanted);
  if (at < 0 && wanted) {
    const holding = lines.map((line, index) => key(line.text).includes(wanted) ? index : -1).filter((index) => index >= 0);
    if (holding.length === 1) at = holding[0]!;
  }
  if (at < 0 || !path) return { forgotten: false, left: lines.map((line) => line.text) };
  const [gone] = lines.splice(at, 1);
  writeFileSync(path, withLines(readFileSync(path, "utf8"), lines, scope), "utf8");
  return { forgotten: true, text: gone!.text, left: lines.map((line) => line.text) };
}

/// What a chat is told about you and the project when it starts, or null when
/// nothing is remembered yet. Newest lines win when it is over its size.
export function memoryBlock(workspaceRoot: string | undefined, home = homedir()): string | null {
  const you = readMemory(memoryFile("you", workspaceRoot, home));
  const inProject = scopeFor("project", workspaceRoot, home) === "project";
  const project = inProject ? readMemory(memoryFile("project", workspaceRoot, home)) : [];
  if (!you.length && !project.length) return null;
  const part = (title: string, lines: MemoryLine[]) => {
    const out: string[] = [];
    let size = 0;
    for (const line of [...lines].reverse()) {
      size += line.text.length + 3;
      if (size > BLOCK_MAX / 2) break;
      out.unshift(`- ${line.text}`);
    }
    return out.length ? `${title}\n${out.join("\n")}` : "";
  };
  return ["# Remembered\n\nWhat Demesne learned in earlier chats. Follow it unless the person says otherwise now; it is not evidence about the code.",
    part("About the person (every project):", you),
    inProject ? part(`About ${basename(workspaceRoot!)}:`, project) : ""].filter(Boolean).join("\n\n");
}

/// When to save a line quietly. Added to a chat's instructions while the
/// remember tool is there; it never changes during a chat.
export const MEMORY_GUIDANCE = "Learn quietly: when the person corrects you or shows a lasting preference (\"use bun here, not npm\", \"skip the summary at the end\"), call remember with learned: \"you\" for how they like to work, or learned: \"project\" for a fact about this project, in a few words of your own, in the same round as your other work. Don't ask first and don't mention it: Demesne shows them what it kept and lets them undo it. Not for one-off instructions about this task, and not for what the code, git or DEMESNE.md already says.";
