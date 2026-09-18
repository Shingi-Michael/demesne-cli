import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/// Workspace-level instructions for the model.
///
/// `DEMESNE.md` is preferred; `AGENTS.md` is accepted so repositories that
/// already target other agents work without a rename. Files are read per turn
/// with an mtime/size cache so edits take effect without a daemon restart, and
/// content is capped so a large file cannot silently consume the context
/// budget. An empty file counts as absent.

export const INSTRUCTION_FILE_NAMES = ["DEMESNE.md", "AGENTS.md"] as const;
export const INSTRUCTION_MAX_BYTES = 32 * 1024;
const TRUNCATION_NOTICE =
  "\n\n[Project instructions truncated at 32 KiB. Keep this file focused.]";

export interface ProjectInstructions {
  absolutePath: string;
  relativePath: string;
  content: string;
  truncated: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: ProjectInstructions | null;
}

const cache = new Map<string, CacheEntry>();

export function loadProjectInstructions(workspaceRoot: string | undefined): ProjectInstructions | null {
  if (!workspaceRoot) return null;
  for (const name of INSTRUCTION_FILE_NAMES) {
    const result = loadInstructionFile(join(workspaceRoot, name), name);
    if (result) return result;
  }
  return null;
}

/// Appends project instructions to a base system prompt. The instructions are
/// framed as workspace-specific and authoritative over the general prompt so
/// the model does not treat them as optional background.
export function composeSystemPrompt(base: string, instructions: ProjectInstructions | null): string {
  if (!instructions) return base;
  return `${base}\n\n# Project instructions\n\n`
    + `The workspace root contains ${instructions.relativePath}. Its instructions are specific to this `
    + `repository and take precedence over the general guidance above when they conflict.\n\n`
    + instructions.content;
}

/// Test hook: drops cached file metadata so a rewritten fixture is re-read.
export function clearInstructionCache(): void {
  cache.clear();
}

function loadInstructionFile(absolutePath: string, relativePath: string): ProjectInstructions | null {
  if (!existsSync(absolutePath)) {
    cache.delete(absolutePath);
    return null;
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const cached = cache.get(absolutePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;

  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    return null;
  }
  const truncated = buffer.byteLength > INSTRUCTION_MAX_BYTES;
  const body = truncated
    ? buffer.subarray(0, INSTRUCTION_MAX_BYTES).toString("utf8")
    : buffer.toString("utf8");
  const content = truncated ? `${body.trimEnd()}${TRUNCATION_NOTICE}` : body.trim();
  const result = content.length > 0
    ? { absolutePath, relativePath, content, truncated }
    : null;
  cache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}
