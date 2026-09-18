import { existsSync, statSync } from "node:fs";
import { isRecord } from "@demesne/protocol";
import { parseConfigFile } from "@demesne/config";

/// Persistent approval allowlists.
///
/// Entries in `[permissions] allow` are strings:
///
/// - `edit_file:src` allows edits at `src` and below (never `src2`).
/// - `write_file:README.md` allows exactly that file.
/// - `run_command:git status` allows argv that starts with `git status`;
///   a bare `run_command` entry is rejected because host execution is not
///   sandboxed and must stay explicit.
/// - A bare `tool` entry allows every use of that tool.
///
/// The daemon re-reads the user config when its mtime changes, so a rule saved
/// by the CLI takes effect without a restart.

export interface AllowRule {
  tool: string;
  /// Exact argv prefix for `run_command`.
  argv?: string[];
  /// Workspace-relative file or directory prefix for path tools.
  pathPrefix?: string;
  raw: string;
}

export function parseAllowRule(entry: string): AllowRule | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator === -1) {
    // A bare run_command rule would approve arbitrary host execution.
    if (trimmed === "run_command") return null;
    return { tool: trimmed, raw: trimmed };
  }
  const tool = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim();
  if (!tool || !value) return null;
  if (tool === "run_command") {
    const argv = value.split(/\s+/);
    return { tool, argv, raw: trimmed };
  }
  return { tool, pathPrefix: value, raw: trimmed };
}

export function allowRuleMatches(rule: AllowRule, toolName: string, input: unknown): boolean {
  if (rule.tool !== toolName) return false;
  if (rule.argv) {
    if (!isRecord(input) || !Array.isArray(input.argv)) return false;
    const argv = input.argv;
    if (!argv.every((entry) => typeof entry === "string")) return false;
    if (rule.argv.length > argv.length) return false;
    return rule.argv.every((word, index) => argv[index] === word);
  }
  if (rule.pathPrefix !== undefined) {
    const target = pathOf(input);
    if (!target) return false;
    const normalized = target.split("\\").join("/").replace(/^\.\//, "");
    const prefix = rule.pathPrefix.replace(/\/+$/, "");
    if (!prefix) return false;
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  return true;
}

export class ConfigAllowlist {
  private rules: AllowRule[] = [];
  private invalid: string[] = [];
  private mtimeMs: number | null = null;

  constructor(private readonly path: string | null) {
    this.reload();
  }

  /// Reloads when the file's mtime changes. Parse failures keep the previous
  /// rules so a half-written file cannot silently open or close access.
  reload(): void {
    if (!this.path || !existsSync(this.path)) {
      this.rules = [];
      this.invalid = [];
      this.mtimeMs = null;
      return;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return;
    }
    if (this.mtimeMs === mtimeMs) return;
    let document: Record<string, unknown>;
    try {
      document = parseConfigFile(this.path);
    } catch {
      return;
    }
    const allow = isRecord(document.permissions) && Array.isArray(document.permissions.allow)
      ? document.permissions.allow
      : [];
    const rules: AllowRule[] = [];
    const invalid: string[] = [];
    for (const entry of allow) {
      if (typeof entry !== "string") continue;
      const rule = parseAllowRule(entry);
      if (rule) rules.push(rule);
      else invalid.push(entry);
    }
    this.rules = rules;
    this.invalid = invalid;
    this.mtimeMs = mtimeMs;
  }

  rulesFor(): AllowRule[] {
    this.reload();
    return this.rules;
  }

  invalidEntries(): string[] {
    this.reload();
    return this.invalid;
  }
}

function pathOf(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["path", "from"]) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}
