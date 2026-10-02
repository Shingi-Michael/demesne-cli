import type { CommandReporter } from "./command-monitor.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { open } from "node:fs/promises";
import { isAbsolute, join, dirname, relative, resolve, sep } from "node:path";
import type { ProviderToolDefinition } from "@demesne/providers";
import { isRecord, MAX_QUESTION_SUGGESTIONS, MAX_USER_QUESTIONS, parseUserQuestions, type UserAnswer, type UserQuestion } from "@demesne/protocol";
import { applyEdits, EditApplyError, type EditHunk } from "./edit-engine.ts";
import { backgroundProcesses } from "./background.ts";
import type { StructuredToolResult } from "./artifacts.ts";

const LIST_FILES_PATH_BUDGET_BYTES = 28 * 1024;

export interface ToolContext {
  commands?: CommandReporter;
  sessionId?: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /// Puts questions to the person at the terminal and waits for the answers.
  /// Absent when nobody can answer (non-interactive turns).
  ask?: (questions: UserQuestion[]) => Promise<UserAnswer[]>;
}

export interface ToolPermission {
  kind: "write" | "execute";
  summary: string;
}

export interface AgentTool {
  definition: ProviderToolDefinition;
  permission(input: unknown): ToolPermission | null;
  execute(input: unknown, context: ToolContext): Promise<string>;
  executeWithArtifacts?(input: unknown, context: ToolContext): Promise<string | StructuredToolResult>;
}

/// Local-first error taxonomy: stable bracketed codes with a recovery hint,
/// so small models can parse failures and self-correct in one turn.
function toolError(code: string, message: string, hint: string): Error {
  return new Error(`[${code}] ${message}. Hint: ${hint}`);
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[] = builtInTools()) {
    for (const tool of tools) this.tools.set(tool.definition.name, tool);
  }

  /// Adds or replaces a tool. Used for MCP servers that become ready after the
  /// daemon has started; definitions are read per turn, so late registration
  /// still reaches the next model request.
  register(tool: AgentTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  definitions(): ProviderToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }
}

/// Lets the agent pause for decisions that are the user's to make. The
/// first suggestion of each question is the recommended answer, which the
/// user accepts with Enter; they can pick another or answer in their own words.
function askUserTool(): AgentTool {
  return {
    definition: {
      name: "ask_user",
      description: `Ask the user up to ${MAX_USER_QUESTIONS} short questions and wait for the answers. Use only when blocked on a decision that is theirs to make (scope, a choice between valid approaches, a missing requirement) and you cannot settle it from the request, the code, or a sensible default. Do not ask for permission to proceed or for facts you can look up. Put your recommended answer first in suggestions.`,
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array", minItems: 1, maxItems: MAX_USER_QUESTIONS,
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "One question, one decision." },
                reason: { type: "string", description: "One short sentence on why it matters or what you would otherwise assume." },
                suggestions: { type: "array", items: { type: "string" }, maxItems: MAX_QUESTION_SUGGESTIONS, description: "Possible answers, recommended first." },
              },
              required: ["question"],
            },
          },
        },
        required: ["questions"],
      },
    },
    permission: () => null,
    async execute(input, context) {
      const questions = parseUserQuestions(isRecord(input) ? input.questions : undefined);
      if (!context.ask) return "Nobody is available to answer. Decide yourself and state the assumption you made.";
      const answers = await context.ask(questions);
      return questions.map((asked, index) => {
        const given = answers[index];
        const answer = !given || given.source === "skipped" || !given.answer
          ? "no answer. Decide yourself and state the assumption you made."
          : given.source === "typed" ? `${given.answer} (the user's own words)` : given.answer;
        return `${index + 1}. ${asked.question}\n   Answer: ${answer}`;
      }).join("\n");
    },
  };
}

function builtInTools(): AgentTool[] {
  return [
    askUserTool(),
    listFilesTool(),
    readFileTool(),
    readFilesTool(),
    searchFilesTool(),
    editFileTool(),
    writeFileTool(),
    gitStatusTool(),
    gitDiffTool(),
    movePathTool(),
    deletePathTool(),
    runCommandTool(),
    commandLogsTool(),
    commandStopTool(),
  ];
}

export function viewImageTool(): AgentTool {
  return {
    definition: { name: "view_image", description: "Import a screenshot or image file from the workspace into Preview. Use after a browser or command saves a screenshot to a file. Vision-enabled providers also receive the image for inspection on the next step.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    permission: () => null,
    execute: async () => { throw new Error("view_image requires artifact-aware execution"); },
    executeWithArtifacts: async (input, context) => {
      if (!isRecord(input) || typeof input.path !== "string" || !input.path.trim() || Object.keys(input).some((key) => key !== "path")) throw new Error("view_image requires a workspace image path");
      context.signal.throwIfAborted();
      const path = resolveWorkspacePath(context.workspaceRoot, input.path, true, true);
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("Image must be a regular file of at most 20 MiB");
        const data = Buffer.alloc(Math.min(stat.size + 1, 20 * 1024 * 1024 + 1));
        let length = 0;
        while (length < data.length) {
          context.signal.throwIfAborted();
          const { bytesRead } = await file.read(data, length, data.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > stat.size) throw new Error("Image changed while reading; try again");
        const bytes = data.subarray(0, length);
        const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
          : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : "image/png";
        return { text: `Image imported from ${input.path}`, images: [{ data: bytes, mimeType, filename: path.split(sep).at(-1) }] };
      } finally { await file.close(); }
    },
  };
}

function listFilesTool(): AgentTool {
  return {
    definition: {
      name: "list_files",
      description: "List workspace files recursively. Start with the default limit or a narrow glob; raise the limit only if truncated. Excludes .git, node_modules, and symlinks. Output is also byte-bounded.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          pattern: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      const value = objectInput(input);
      const requestedPath = optionalString(value.path, "path") ?? ".";
      const path = requestedPath === "/" ? "." : requestedPath;
      const limit = boundedInteger(value.limit, "limit", 1, 1000, 200);
      let pattern: RegExp | undefined;
      if (value.pattern !== undefined) {
        const raw = optionalString(value.pattern, "pattern");
        if (!raw) throw toolError("BAD_PATTERN", "pattern must be a non-empty string", 'use globs like "src/**/*.ts"');
        try {
          pattern = globToRegExp(raw);
        } catch {
          throw toolError("BAD_PATTERN", `invalid glob ${JSON.stringify(raw)}`, 'use globs like "src/**/*.ts"');
        }
      }
      const start = resolveWorkspacePath(context.workspaceRoot, path, false);
      if (!statSync(start).isDirectory()) throw toolError("NOT_A_DIR", `${path} is not a directory`, "list_files requires a directory path");
      const directories = readdirSync(start, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") return [];
        const relativePath = relative(context.workspaceRoot, join(start, entry.name));
        return isSensitivePath(relativePath) ? [] : [relativePath];
      }).sort();
      const output: string[] = [];
      const ignoredDirectories = new Set<string>();
      let outputBytes = 0;
      let byteLimitReached = false;
      walkFiles(start, context.workspaceRoot, context.signal, (absolute, relativePath) => {
        if (output.length >= limit) return;
        if (pattern && !pattern.test(relativePath)) return;
        const pathBytes = Buffer.byteLength(JSON.stringify(relativePath), "utf8") + 1;
        if (outputBytes + pathBytes > LIST_FILES_PATH_BUDGET_BYTES) {
          byteLimitReached = true;
          return;
        }
        output.push(relativePath);
        outputBytes += pathBytes;
      }, limit * 4, () => output.length >= limit || byteLimitReached, (relativeDirectory) => {
        const parts = relativeDirectory.split(sep);
        const ignoredIndex = parts.indexOf("node_modules");
        if (ignoredIndex < 0) return true;
        ignoredDirectories.add(parts.slice(0, ignoredIndex + 1).join("/"));
        return false;
      });
      output.sort();
      return JSON.stringify({
        directories,
        files: output,
        ignoredDirectories: [...ignoredDirectories].sort(),
        returnedFiles: output.length,
        truncated: output.length >= limit || byteLimitReached,
      });
    },
  };
}

function readFileTool(): AgentTool {
  return {
    definition: {
      name: "read_file",
      description: "Read numbered UTF-8 lines. Defaults: offset 1, limit 160; max 500.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      const value = objectInput(input);
      const path = requiredString(value.path, "path");
      const offset = boundedInteger(value.offset, "offset", 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = boundedInteger(value.limit, "limit", 1, 500, 160);
      return JSON.stringify(await readSingleFile(context.workspaceRoot, path, offset, limit));
    },
  };
}

function readFilesTool(): AgentTool {
  return {
    definition: {
      name: "read_files",
      description: "Read 1-8 files. Each {path,offset?,limit?}; default limit 100, max 500. Per-file errors.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                offset: { type: "integer", minimum: 1 },
                limit: { type: "integer", minimum: 1, maximum: 500 },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        required: ["files"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      const value = objectInput(input);
      if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 8) {
        throw toolError("BAD_FILES", "files must contain between 1 and 8 entries", "batch related reads into one call");
      }
      let remaining = READ_BATCH_LIMIT_BYTES;
      const results: unknown[] = [];
      for (const entry of value.files) {
        if (!isRecord(entry)) throw toolError("BAD_FILES", "each file entry must be an object", 'use {"path": "..."}');
        const path = requiredString(entry.path, "path");
        const offset = boundedInteger(entry.offset, "offset", 1, Number.MAX_SAFE_INTEGER, 1);
        const limit = boundedInteger(entry.limit, "limit", 1, 500, 100);
        try {
          const result = await readSingleFile(context.workspaceRoot, path, offset, limit);
          const record = result as Record<string, unknown>;
          const content = typeof record.content === "string" ? record.content : "";
          if (Buffer.byteLength(content) > remaining) {
            record.content = content.slice(0, Math.max(0, remaining)).replace(/\n[^\n]*$/, "");
            record.truncated = true;
            record.note = "content truncated by batch budget";
          }
          remaining -= Buffer.byteLength(record.content as string);
          results.push(record);
        } catch (error) {
          const message = error instanceof Error ? error.message : "read failed";
          results.push({ path, error: message });
        }
        if (remaining <= 0) break;
      }
      return JSON.stringify({ results });
    },
  };
}

const READ_BATCH_LIMIT_BYTES = 256 * 1024;

/// Files the viewer shows in full; larger ones are summarized instead.
export const VIEWER_BYTE_LIMIT = 2 * 1024 * 1024;

/// A workspace file's text for the file viewer, under read_file's rules:
/// inside the workspace, no symlinks, secrets stay protected, text only.
export function readWorkspaceText(workspaceRoot: string, path: string): import("@demesne/protocol").WorkspaceFileText {
  const refuse = (reason: string, byteLength: number | null = null) => ({ path, content: null, byteLength, reason });
  if (isSensitivePath(path)) return refuse("protected: secrets and key material are never shown");
  let absolute: string;
  try { absolute = resolveWorkspacePath(workspaceRoot, path, false); } catch (error) { return refuse(error instanceof Error ? error.message : "invalid path"); }
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(absolute); } catch { return refuse("file not found"); }
  if (!stat.isFile() || stat.nlink > 1) return refuse("not a regular file");
  if (stat.size > VIEWER_BYTE_LIMIT) return refuse("too large to show", stat.size);
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) return refuse("binary file", stat.size);
  try { return { path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), byteLength: bytes.length,
    revision: createHash("sha256").update(bytes).digest("hex"), modifiedAt: stat.mtime.toISOString() }; }
  catch { return refuse("not valid UTF-8", stat.size); }
}

async function readSingleFile(
  workspaceRoot: string,
  path: string,
  offset: number,
  limit: number,
): Promise<unknown> {
  if (isSensitivePath(path)) throw toolError("SENSITIVE_PATH", `${path} is protected`, "secrets and key material are never readable");
  let absolute: string;
  try {
    absolute = resolveWorkspacePath(workspaceRoot, path, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid path";
    throw toolError("NOT_FOUND", `${path}: ${message}`, "run list_files to inspect the tree");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw toolError("NOT_FOUND", `no file at ${path}`, "run list_files to inspect the tree");
  }
  if (!stat.isFile() || stat.nlink > 1) throw toolError("NOT_A_FILE", `${path} is not a regular file`, "read_file requires a regular file");
  if (stat.size > 8 * 1024 * 1024) throw toolError("TOO_LARGE", `${path} exceeds the 8 MiB read limit`, "read a narrower file or use search_files");
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw toolError("BINARY_FILE", `${path} is binary`, "use run_command for binary inspection");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw toolError("NOT_UTF8", `${path} is not valid UTF-8`, "use run_command with an appropriate decoder");
  }
  const lines = text.split("\n");
  const totalLines = lines.length - (lines.at(-1) === "" ? 1 : 0);
  const endLine = Math.min(offset - 1 + limit, totalLines);
  const selected = lines.slice(offset - 1, endLine);
  const content = selected.map((line, index) => `${offset + index}: ${line.slice(0, 16_384)}`).join("\n");
  return {
    path,
    totalLines,
    range: { from: offset, to: endLine },
    content: content.slice(0, 256 * 1024),
    truncated: offset - 1 + limit < totalLines,
    remainingLines: Math.max(0, totalLines - endLine),
    ...(endLine < totalLines ? { nextOffset: endLine + 1 } : {}),
  };
}

function searchFilesTool(): AgentTool {
  return {
    definition: {
      name: "search_files",
      description: "Literal case-insensitive search; include globs relative to path (*.ts matches any depth). Default 50; max 500 matching lines. Returns workspace-relative path:line:text.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          include: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      const value = objectInput(input);
      const query = requiredString(value.query, "query");
      if (query.length > 4096) throw toolError("QUERY_TOO_LARGE", "query exceeds 4096 characters", "search a narrower literal");
      const path = optionalString(value.path, "path") ?? ".";
      const include = optionalString(value.include, "include");
      let pattern: RegExp | undefined;
      if (include) {
        try {
          pattern = globToRegExp(include.includes("/") ? include : `**/${include}`);
        } catch {
          throw toolError("BAD_PATTERN", `invalid glob ${JSON.stringify(include)}`, 'use globs like "src/**/*.ts"');
        }
      }
      const limit = boundedInteger(value.limit, "limit", 1, 500, 50);
      const start = resolveWorkspacePath(context.workspaceRoot, path, false);
      const relativeStart = relative(context.workspaceRoot, start);
      const searchRoot = statSync(start).isDirectory() ? start : dirname(start);
      const accepts = (path: string) => !isSensitivePath(relative(context.workspaceRoot, join(searchRoot, path)))
        && (!pattern || pattern.test(path.split(sep).join("/")));

      const prefixLines = (rawPath: string): string => {
        const posixPath = rawPath.replace(/^\.\//, "").split(sep).join("/");
        return relativeStart === "" ? posixPath : `${relativeStart.split(sep).join("/")}/${posixPath}`;
      };

      const ripgrepPaths = Bun.which("rg");
      if (ripgrepPaths && searchRoot === start) {
        try {
          const result = await ripgrepSearch({
            rgPath: ripgrepPaths,
            cwd: start,
            query,
            accepts,
            limit,
            signal: context.signal,
          });
          if (!result.failed) {
            const matches = result.lines
              .map((line) => formatRipgrepLine(line))
              .filter((entry): entry is { path: string; line: number; text: string } => entry !== null)
              .map((entry) => ({ ...entry, path: entry.path.replace(/^\.\//, "") }))
              .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
              .slice(0, limit)
              .map((entry) => `${prefixLines(entry.path)}:${entry.line}:${entry.text}`);
            return JSON.stringify({ matches, truncated: result.hadMore });
          }
        } catch (error) {
          if (context.signal.aborted) throw error;
        }
      }

      const matches: string[] = [];
      let truncated = false;
      walkFiles(start, context.workspaceRoot, context.signal, (absolute, relativePath) => {
        if (!accepts(relative(searchRoot, absolute))) return;
        const stat = statSync(absolute);
        if (stat.size > 8 * 1024 * 1024) return;
        const bytes = readFileSync(absolute);
        if (bytes.includes(0)) return;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return;
        }
        for (const [index, line] of text.split("\n").entries()) {
          if (line.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US"))) {
            if (matches.length === limit) { truncated = true; return; }
            matches.push(`${relativePath}:${index + 1}:${line.slice(0, 2000)}`);
          }
        }
      }, limit * 4, () => truncated);
      return JSON.stringify({ matches, truncated });
    },
  };
}

async function ripgrepSearch(options: {
  rgPath: string;
  cwd: string;
  query: string;
  accepts: (path: string) => boolean;
  limit: number;
  signal: AbortSignal;
}): Promise<{ failed: boolean; hadMore: boolean; lines: string[] }> {
  const args = [
    "--no-heading",
    "--color",
    "never",
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
    "--with-filename",
    "--sort", "path",
    "--max-columns",
    "2000",
    "-e",
    options.query,
  ];
  args.push(".");

  options.signal.throwIfAborted();
  const child = Bun.spawn([options.rgPath, ...args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const abort = () => child.kill("SIGKILL");
  options.signal.addEventListener("abort", abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const lines: string[] = [];
    let stoppedEarly = false;
    const collect = (line: string) => {
      const entry = formatRipgrepLine(line);
      if (entry && options.accepts(entry.path.replace(/^\.\//, ""))) lines.push(line);
      return lines.length > options.limit;
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        if (collect(buffer.slice(0, newline))) { stoppedEarly = true; break; }
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (stoppedEarly) {
        child.kill("SIGKILL");
        break;
      }
      if (done) { if (buffer) stoppedEarly = collect(buffer); break; }
    }
    const exitCode = await child.exited;
    options.signal.throwIfAborted();
    return { failed: exitCode > 1 && !stoppedEarly, hadMore: stoppedEarly || lines.length > options.limit, lines: lines.slice(0, options.limit) };
  } finally {
    options.signal.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => undefined);
  }
}

function formatRipgrepLine(line: string): { path: string; line: number; text: string } | null {
  const firstColon = line.indexOf(":");
  if (firstColon <= 0) return null;
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon === -1) return null;
  const lineNumber = Number(line.slice(firstColon + 1, secondColon));
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  return {
    path: line.slice(0, firstColon),
    line: lineNumber,
    text: line.slice(secondColon + 1).slice(0, 2000),
  };
}

function editFileTool(): AgentTool {
  return {
    definition: {
      name: "edit_file",
      description: [
        "Create, append to, or edit a UTF-8 workspace file.",
        "Replace mode applies ordered hunks; each hunk needs oldText with enough surrounding context to be unique unless all:true replaces every match.",
        "Matching falls back from exact text to trimmed-line windows to whitespace-tolerant comparison, so indentation drift is tolerated.",
        "Append mode adds newText after a trailing newline. Creating a new file requires empty oldText (or append mode) and no edits array.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          mode: { type: "string", enum: ["replace", "append"] },
          oldText: { type: "string" },
          newText: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", minLength: 1 },
                newText: { type: "string" },
                all: { type: "boolean" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const value = objectInput(input);
      const mode = parseMode(value.mode);
      const summary = mode === "append" ? `append to ${requiredString(value.path, "path")}` : `edit ${requiredString(value.path, "path")}`;
      return { kind: "write", summary };
    },
    async execute(input, context) {
      const value = objectInput(input);
      const path = requiredString(value.path, "path");
      const mode = parseMode(value.mode);
      const absoluteProbe = resolveWorkspacePath(context.workspaceRoot, path, true, true);
      const fileExists = existsSync(absoluteProbe);
      let hunks = normalizeHunks(value, mode);
      if (!fileExists && hunks.some((hunk) => hunk.oldText === "")) {
        // Creation-via-batch: tolerate models that use the edits array with an
        // empty oldText by collapsing to the legacy single-hunk create shape.
        const content = hunks.map((hunk) => hunk.newText).join(mode === "append" ? "" : "\n");
        hunks = [{ oldText: "", newText: content }];
      }
      const absolute = absoluteProbe;

      if (!existsSync(absolute)) {
        mkdirSync(dirname(absolute), { recursive: true, mode: 0o755 });
        if (mode === "append") {
          const content = hunks.map((hunk) => hunk.newText).join(mode === "append" ? "" : "\n");
          if (Buffer.byteLength(content) > FILE_LIMIT_BYTES) throw new Error("result exceeds 1 MiB");
          writeFileSync(absolute, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
          return JSON.stringify({ path, created: true, bytes: Buffer.byteLength(content), strategy: "append", replacements: 0 });
        }
        if (hunks.length !== 1 || hunks[0]!.oldText !== "") throw new Error("new files require empty oldText");
        const content = hunks[0]!.newText;
        if (Buffer.byteLength(content) > FILE_LIMIT_BYTES) throw new Error("result exceeds 1 MiB");
        writeFileSync(absolute, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
        return JSON.stringify({ path, created: true, bytes: Buffer.byteLength(content), strategy: "create", replacements: 0 });
      }

      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.nlink > 1) throw new Error("path must be a regular, non-hard-linked file");
      if (stat.size > FILE_LIMIT_BYTES) throw new Error("file exceeds the 1 MiB edit limit");
      let current: string;
      try {
        current = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
      } catch {
        throw new Error("file is not valid UTF-8");
      }

      let updated: string;
      let strategy: string;
      let replacements: number;
      if (mode === "append") {
        const addition = hunks.map((hunk) => hunk.newText).join("");
        const separator = current.length > 0 && !current.endsWith("\n") && !addition.startsWith("\n") ? "\n" : "";
        updated = current + separator + addition;
        strategy = "append";
        replacements = 0;
      } else {
        if (!value.edits && hunks[0]!.oldText === "") throw toolError("EMPTY_OLD_TEXT", "empty oldText is only valid when creating a new file", "use mode:\"append\" or provide oldText");
        let applied;
        try {
          applied = applyEdits({ current, hunks });
        } catch (error) {
          if (error instanceof EditApplyError) {
            const ambiguous = error.message.includes("locations");
            throw toolError(
              ambiguous ? "AMBIGUOUS_MATCH" : "EDIT_NOT_FOUND",
              error.message,
              ambiguous
                ? 'add surrounding lines to oldText or pass "all": true'
                : "read_file around the target first; matching tolerates whitespace differences",
            );
          }
          throw error;
        }
        updated = applied.content;
        strategy = applied.strategy;
        replacements = applied.replacements;
      }
      if (Buffer.byteLength(updated) > FILE_LIMIT_BYTES) throw new Error("result exceeds 1 MiB");

      const temporary = `${absolute}.demesne-${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, updated, { encoding: "utf8", flag: "wx", mode: stat.mode & 0o777 });
        if (readFileSync(absolute, "utf8") !== current) throw new Error("file changed while the edit was prepared");
        renameSync(temporary, absolute);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return JSON.stringify({ path, created: false, bytes: Buffer.byteLength(updated), strategy, replacements });
    },
  };
}

const FILE_LIMIT_BYTES = 1024 * 1024;

function parseMode(value: unknown): "replace" | "append" {
  if (value === undefined) return "replace";
  if (value === "replace" || value === "append") return value;
  throw new Error("mode must be replace or append");
}

function normalizeHunks(value: Record<string, unknown>, mode: "replace" | "append"): EditHunk[] {
  if (value.edits !== undefined) {
    if (!Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > 16) {
      throw new Error("edits must contain between 1 and 16 hunks");
    }
    return value.edits.map((entry) => {
      if (!isRecord(entry)) throw new Error("each edit must be an object");
      const oldText = entry.oldText;
      const newText = entry.newText;
      if (typeof oldText !== "string") throw new Error("edit oldText must be a string");
      if (typeof newText !== "string") throw new Error("edit newText must be a string");
      return { oldText, newText, ...(entry.all === true ? { all: true } : {}) };
    });
  }
  const oldText = requiredString(value.oldText ?? (mode === "append" ? "" : undefined), "oldText", true);
  const newText = requiredString(value.newText, "newText", true);
  return [{ oldText, newText }];
}

function writeFileTool(): AgentTool {
  return {
    definition: {
      name: "write_file",
      description: "Create or fully overwrite a UTF-8 workspace file with complete content. Parents are created. Prefer edit_file for partial changes.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", maxLength: 98_304 },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const value = objectInput(input);
      return { kind: "write", summary: `write ${requiredString(value.path, "path")}` };
    },
    async execute(input, context) {
      const value = objectInput(input);
      const path = requiredString(value.path, "path");
      const content = requiredString(value.content, "content", true);
      if (Buffer.byteLength(content) > WRITE_LIMIT_BYTES) throw toolError("TOO_LARGE", "content exceeds the 96 KiB write limit", "split into write_file plus edit_file appends");
      const absolute = resolveWorkspacePath(context.workspaceRoot, path, true, true);
      const exists = existsSync(absolute);
      let mode = 0o644;
      let previous: string | null = null;
      if (exists) {
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.nlink > 1) throw toolError("NOT_A_FILE", `${path} is not a regular file`, "write_file requires a regular file");
        if (stat.size > WRITE_LIMIT_BYTES * 4) throw toolError("TOO_LARGE", "existing file exceeds overwrite guard", "use edit_file for large files");
        mode = stat.mode & 0o777;
        try {
          previous = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
        } catch {
          throw toolError("NOT_UTF8", `${path} is not valid UTF-8`, "overwrite refused; use run_command for binary files");
        }
      } else {
        mkdirSync(dirname(absolute), { recursive: true, mode: 0o755 });
      }

      const temporary = `${absolute}.demesne-${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
        if (previous !== null && readFileSync(absolute, "utf8") !== previous) {
          throw toolError("CONCURRENT_MODIFY", `${path} changed during preparation`, "retry the write");
        }
        renameSync(temporary, absolute);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return JSON.stringify({ path, created: !exists, bytes: Buffer.byteLength(content) });
    },
  };
}

const WRITE_LIMIT_BYTES = 96 * 1024;

interface GitRunResult { code: number; stdout: string; stderr: string }

async function runGit(workspaceRoot: string, args: string[], signal: AbortSignal): Promise<GitRunResult> {
  assertWorkspaceRoot(workspaceRoot);
  const gitPath = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
  if (!gitPath) throw toolError("GIT_MISSING", "git is not installed", "install git to use repository tools");
  const child = Bun.spawn([
    gitPath,
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    ...args,
  ], {
    cwd: workspaceRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
      HOME: join(tmpdir(), `demesne-tool-${process.pid}`),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      LC_ALL: "C",
    },
  });
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      readProcessOutput(child.stdout, GIT_OUTPUT_LIMIT_BYTES),
      readProcessOutput(child.stderr, 4_096),
      child.exited,
    ]);
    if (signal.aborted) throw signal.reason;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024;

function gitStatusTool(): AgentTool {
  return {
    definition: {
      name: "git_status",
      description: "Show branch and working-tree status of the workspace repository. Read-only, no approval needed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    permission: () => null,
    async execute(_input, context) {
      ensureRepository(await runGit(context.workspaceRoot, ["rev-parse", "--is-inside-work-tree"], context.signal));
      const status = await runGit(context.workspaceRoot, ["status", "--porcelain=v1", "-b"], context.signal);
      const lines = status.stdout.split("\n").filter((line) => line.length > 0);
      const branch = lines.shift()?.replace(/^##\s*/, "") ?? "(unknown)";
      const entries = lines.map((line) => {
        const status2 = line.slice(0, 2);
        const rest = line.slice(3);
        const arrow = rest.indexOf(" -> ");
        return arrow === -1
          ? { status: status2.trim(), path: rest }
          : { status: status2.trim(), path: rest.slice(arrow + 4), origPath: rest.slice(0, arrow) };
      });
      return JSON.stringify({ branch, clean: entries.length === 0, entries });
    },
  };
}

function gitDiffTool(): AgentTool {
  return {
    definition: {
      name: "git_diff",
      description: "Unified diff of unstaged (default) or staged changes. Read-only, no approval needed.",
      inputSchema: {
        type: "object",
        properties: {
          staged: { type: "boolean" },
          path: { type: "string" },
          context: { type: "integer", minimum: 0, maximum: 10 },
        },
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      const value = objectInput(input);
      ensureRepository(await runGit(context.workspaceRoot, ["rev-parse", "--is-inside-work-tree"], context.signal));
      const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      if (value.staged === true) args.push("--cached");
      const contextLines = boundedInteger(value.context, "context", 0, 10, 3);
      args.push(`--unified=${contextLines}`);
      const path = optionalString(value.path, "path");
      if (path) args.push("--", path);
      const diff = await runGit(context.workspaceRoot, args, context.signal);
      const truncated = Buffer.byteLength(diff.stdout) >= GIT_OUTPUT_LIMIT_BYTES;
      return JSON.stringify({ empty: diff.stdout.length === 0, truncated, diff: diff.stdout });
    },
  };
}

function ensureRepository(result: GitRunResult): void {
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    throw toolError("NOT_A_REPO", "the workspace is not a git repository", "run git init or scope sessions to a repository");
  }
}

function movePathTool(): AgentTool {
  return {
    definition: {
      name: "move_path",
      description: "Rename or move a workspace file or directory. Creates destination parents. Fails if the target exists unless overwrite:true.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const value = objectInput(input);
      const from = requiredString(value.from, "from");
      const to = requiredString(value.to, "to");
      return { kind: "write", summary: `move ${displayArgument(from)} to ${displayArgument(to)}` };
    },
    async execute(input, context) {
      const value = objectInput(input);
      const fromRel = requiredString(value.from, "from");
      const toRel = requiredString(value.to, "to");
      const overwrite = value.overwrite === true;
      let fromAbs: string;
      let toAbs: string;
      try {
        fromAbs = resolveWorkspacePath(context.workspaceRoot, fromRel, false);
      } catch (error) {
        throw toolError("NOT_FOUND", `${fromRel}: ${error instanceof Error ? error.message : "invalid path"}`, "run list_files to confirm the source");
      }
      try {
        toAbs = resolveWorkspacePath(context.workspaceRoot, toRel, true, true);
      } catch (error) {
        throw toolError("INVALID_TARGET", `${toRel}: ${error instanceof Error ? error.message : "invalid path"}`, "choose a valid workspace-relative destination");
      }

      let sourceStat;
      try {
        sourceStat = lstatSync(fromAbs);
      } catch {
        throw toolError("NOT_FOUND", `nothing at ${fromRel}`, "run list_files to confirm the path");
      }

      if (existsSync(toAbs)) {
        if (!overwrite) throw toolError("TARGET_EXISTS", `${toRel} already exists`, "pass overwrite:true or choose another name");
        const targetStat = lstatSync(toAbs);
        if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
          throw toolError("TYPE_MISMATCH", "cannot overwrite across file and directory types", "match the source kind");
        }
      }

      const inward = relative(fromAbs, toAbs);
      if (inward === "" || (!inward.startsWith(`..${sep}`) && inward !== ".." && !isAbsolute(inward))) {
        throw toolError("INVALID_TARGET", "destination is inside the source directory", "move to a sibling location");
      }

      mkdirSync(dirname(toAbs), { recursive: true });
      renameSync(fromAbs, toAbs);
      return JSON.stringify({ from: fromRel, to: toRel, moved: true, overwrite, kind: sourceStat.isDirectory() ? "directory" : "file" });
    },
  };
}

function deletePathTool(): AgentTool {
  return {
    definition: {
      name: "delete_path",
      description: "Delete a workspace file, or a directory with recursive:true. Protected files (.env, keys) are refused.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const value = objectInput(input);
      return { kind: "write", summary: `delete ${displayArgument(requiredString(value.path, "path"))}` };
    },
    async execute(input, context) {
      const value = objectInput(input);
      const path = requiredString(value.path, "path");
      if (isSensitivePath(path)) throw toolError("SENSITIVE_PATH", `${path} is protected`, "secrets are never deleted through tools");
      const recursive = value.recursive === true;
      let absolute: string;
      try {
        absolute = resolveWorkspacePath(context.workspaceRoot, path, false);
      } catch (error) {
        throw toolError("NOT_FOUND", `${path}: ${error instanceof Error ? error.message : "invalid path"}`, "run list_files to confirm the path");
      }

      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        throw toolError("NOT_FOUND", `nothing at ${path}`, "run list_files to confirm the path");
      }
      if (stat.isDirectory() && !recursive) {
        throw toolError("DIR_NEEDS_RECURSIVE", `${path} is a directory`, 'pass "recursive": true to delete directories');
      }

      rmSync(absolute, { recursive, force: false });
      return JSON.stringify({
        path,
        deleted: true,
        recursive,
        kind: stat.isDirectory() ? "directory" : "file",
        ...(stat.isFile() ? { bytes: stat.size } : {}),
      });
    },
  };
}

function runCommandTool(): AgentTool {
  const backgroundEnv = () => {
    const toolHome = join(tmpdir(), `demesne-tool-${process.pid}`);
    mkdirSync(toolHome, { recursive: true, mode: 0o700 });
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
      HOME: toolHome,
      TMPDIR: toolHome,
      LANG: "C.UTF-8",
      TERM: "dumb",
      NO_COLOR: "1",
      CI: "1",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    };
  };
  return {
    definition: {
      name: "run_command",
      description: "Run argv on the host, not a shell/sandbox. Use for tests, builds, or inspection unavailable through purpose-built tools; do not use for file listing, reading, searching, or unsolicited counts. Keeps 8 KiB head and tail per stream; use background for paged logs.",
      inputSchema: {
        type: "object",
        properties: {
          argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64 },
          cwd: { type: "string" },
          timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
          background: { type: "boolean" },
        },
        required: ["argv"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const value = objectInput(input);
      const argv = stringArray(value.argv, "argv");
      return { kind: "execute", summary: `host command: ${argv.map(displayArgument).join(" ")}` };
    },
    async execute(input, context) {
      const value = objectInput(input);
      const argv = stringArray(value.argv, "argv");
      const cwd = resolveWorkspacePath(context.workspaceRoot, optionalString(value.cwd, "cwd") ?? ".", false);
      if (!statSync(cwd).isDirectory()) throw new Error("cwd is not a directory");

      if (value.background === true) {
        const observer=context.commands?.begin(argv,cwd,true);
        try {
          const spawned = backgroundProcesses.spawn(argv, cwd, backgroundEnv(),observer);
          return JSON.stringify({ handle: spawned.handle, pid: spawned.pid, running: true });
        } catch (error) {
          observer?.finished(null,false,String(error));
          throw error instanceof Error ? error : new Error("background launch failed");
        }
      }

      const timeoutMs = boundedInteger(value.timeoutMs, "timeoutMs", 100, 120_000, 30_000);
      const observer=context.commands?.begin(argv,cwd,false);
      let child: ReturnType<typeof Bun.spawn<"ignore","pipe","pipe">>;
      try { child = Bun.spawn(argv, {
        cwd,
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: backgroundEnv(),
      }); }catch(error){observer?.finished(null,false,String(error));throw error;}
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        killTimer ??= setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, 2_000);
      };
      observer?.started(child.pid,terminate);
      const abort = () => terminate();
      context.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          readCommandOutput(child.stdout, 16 * 1024,text=>observer?.output("stdout",text)),
          readCommandOutput(child.stderr, 16 * 1024,text=>observer?.output("stderr",text)),
          child.exited,
        ]);
        observer?.finished(exitCode,timedOut,context.signal.aborted?"Turn cancelled":undefined);
        if (context.signal.aborted) throw context.signal.reason;
        return JSON.stringify({
          exitCode,
          stdout: stdout.content,
          stderr: stderr.content,
          timedOut,
          ...(stdout.truncated ? { stdoutTruncated: true, stdoutBytes: stdout.totalBytes } : {}),
          ...(stderr.truncated ? { stderrTruncated: true, stderrBytes: stderr.totalBytes } : {}),
        });
      } catch(error){observer?.finished(null,timedOut,String(error));throw error;} finally {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        context.signal.removeEventListener("abort", abort);
      }
    },
  };
}

function commandLogsTool(): AgentTool {
  return {
    definition: {
      name: "command_logs",
      description: "Read new output from a backgrounded command. Pass back the returned offsets next call.",
      inputSchema: {
        type: "object",
        properties: {
          handle: { type: "string" },
          outOffset: { type: "integer", minimum: 0 },
          errOffset: { type: "integer", minimum: 0 },
          maxBytes: { type: "integer", minimum: 128, maximum: 32_768 },
        },
        required: ["handle"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input) {
      const value = objectInput(input);
      const handle = requiredString(value.handle, "handle");
      const fromOut = boundedInteger(value.outOffset, "outOffset", 0, Number.MAX_SAFE_INTEGER, 0);
      const fromErr = boundedInteger(value.errOffset, "errOffset", 0, Number.MAX_SAFE_INTEGER, 0);
      const maxBytes = boundedInteger(value.maxBytes, "maxBytes", 128, 32_768, 8_192);
      const entry = backgroundProcesses.logs(handle, fromOut, fromErr);
      if (!entry) throw toolError("NOT_FOUND", `no background process ${handle}`, "use the handle run_command returned");
      const stdout = entry.stdout.slice(0, maxBytes);
      const stderr = entry.stderr.slice(0, Math.max(0, maxBytes - stdout.length));
      return JSON.stringify({
        running: entry.running,
        exitCode: entry.exitCode,
        timedOut: entry.timedOut,
        stdout,
        stderr,
        outOffset: Math.min(entry.outOffset, fromOut + stdout.length),
        errOffset: Math.min(entry.errOffset, fromErr + stderr.length),
      });
    },
  };
}

function commandStopTool(): AgentTool {
  return {
    definition: {
      name: "command_stop",
      description: "Stop a backgrounded command (SIGTERM, then SIGKILL after 2s).",
      inputSchema: {
        type: "object",
        properties: { handle: { type: "string" } },
        required: ["handle"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input) {
      const value = objectInput(input);
      const handle = requiredString(value.handle, "handle");
      if (!backgroundProcesses.get(handle)) {
        throw toolError("NOT_FOUND", `no background process ${handle}`, "use the handle run_command returned");
      }
      const result = backgroundProcesses.stop(handle);
      await Bun.sleep(50);
      const state = backgroundProcesses.get(handle);
      return JSON.stringify({ stopped: result.stopped, stillRunning: state?.running ?? false });
    },
  };
}

export function canonicalWorkspace(path: string): string {
  if (!isAbsolute(path)) throw new Error("workspace path must be absolute");
  const root = realpathSync(path);
  assertWorkspaceRoot(root);
  return root;
}

function assertWorkspaceRoot(root: string): void {
  const linkStat = lstatSync(root);
  if (linkStat.isSymbolicLink()) throw new Error("workspace root changed");
  const stat = statSync(root);
  if (!stat.isDirectory()) throw new Error("workspace path must be a directory");
  if (root === sep || root === homedir()) throw new Error("workspace root is too broad");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("workspace must be owned by the current user");
  }
  if ((stat.mode & 0o022) !== 0) throw new Error("workspace must not be writable by group or other users");
}

export function resolveWorkspacePath(root: string, input: string, allowMissingFinal: boolean, allowMissingParents = false): string {
  assertWorkspaceRoot(root);
  if (!input || input.includes("\0") || isAbsolute(input)) throw new Error("path must be workspace-relative");
  const components = input.split(/[\\/]/);
  if (components.some((part) => part === ".." || part === "")) throw new Error("path traversal is not allowed");
  const absolute = resolve(root, input);
  const relation = relative(root, absolute);
  if (relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) throw new Error("path escapes workspace");
  let current = root;
  for (const [index, component] of components.entries()) {
    if (component === ".") continue;
    current = join(current, component);
    if (!existsSync(current)) {
      const isFinal = index === components.length - 1;
      if (allowMissingParents || (allowMissingFinal && isFinal)) return absolute;
      throw new Error("path does not exist");
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error("symlinks are not allowed");
  }
  return absolute;
}

function walkFiles(
  start: string,
  root: string,
  signal: AbortSignal,
  visit: (absolute: string, relativePath: string) => void,
  limit: number,
  shouldStop: () => boolean = () => false,
  shouldEnterDirectory: (relativeDirectory: string) => boolean = () => true,
): void {
  const stack = [start];
  let visited = 0;
  while (stack.length && visited < 50_000 && !shouldStop()) {
    if (signal.aborted) throw signal.reason;
    const current = stack.pop()!;
    visited += 1;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      const relativePath = relative(root, current);
      if (!isSensitivePath(relativePath)) visit(current, relativePath);
      if (visited >= 50_000 || shouldStop()) return;
      continue;
    }
    if (!stat.isDirectory()) continue;
    const relativeDirectory = relative(root, current);
    if (!shouldEnterDirectory(relativeDirectory)) continue;
    if (relativeDirectory === ".git" || relativeDirectory.startsWith(`.git${sep}`)) continue;
    const entries = readdirSync(current).sort().reverse();
    for (const entry of entries) stack.push(join(current, entry));
  }
}

export function isSensitivePath(path: string): boolean {
  const parts = path.split(/[\\/]/).map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  const protectedDirectories = new Set([".git", ".ssh", ".aws", ".gnupg", ".docker"]);
  const protectedNames = new Set([
    ".git-credentials", ".netrc", ".npmrc", ".pypirc", "credentials", "id_dsa", "id_ecdsa",
    "id_ed25519", "id_rsa", "service-account.json",
  ]);
  return parts.some((part) => protectedDirectories.has(part)) || name === ".env" || name.startsWith(".env.") ||
    protectedNames.has(name) || /\.(?:pem|key|p12|mobileprovision)$/i.test(name);
}

/// Heavy build and dependency directories that are never useful as prompt
/// mentions and can dominate a workspace listing.
const MENTION_SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".next", "target", "Pods", "DerivedData",
]);

/// Lists workspace files for `@` prompt mentions.
///
/// Paths are relative, lexically sorted, filtered by the same sensitive-path
/// policy as automatic reads, and capped. Symlinks are skipped by the shared
/// walker.
export function listWorkspaceFiles(workspaceRoot: string, limit = 2_000): string[] {
  const controller = new AbortController();
  const files: string[] = [];
  walkFiles(
    workspaceRoot,
    workspaceRoot,
    controller.signal,
    (_absolute, relativePath) => {
      files.push(relativePath);
    },
    limit,
    () => files.length >= limit,
    (relativeDirectory) => !relativeDirectory.split(sep).some((part) => MENTION_SKIPPED_DIRECTORIES.has(part)),
  );
  return files.sort();
}

/// Translates a user/model glob (supports **, *, ?) into a path-matching RegExp.
function globToRegExp(pattern: string): RegExp {
  if (!pattern || pattern.length > 512) throw new Error("invalid glob");
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error("tool input must be an object");
  return input;
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, name);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value as string[];
}

function displayArgument(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

async function readProcessOutput(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let stored = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (stored < limit) {
      const chunk = value.slice(0, limit - stored);
      chunks.push(chunk);
      stored += chunk.byteLength;
    }
  }
  const output = new Uint8Array(stored);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function readCommandOutput(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onText?: (text:string)=>void,
): Promise<{ content: string; totalBytes: number; truncated: boolean }> {
  const decoder=new TextDecoder();
  const reader = stream.getReader();
  const headLimit = Math.ceil(limit / 2);
  const tailLimit = limit - headLimit;
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    onText?.(decoder.decode(value,{stream:true}));
    let remainder = value;
    if (headBytes < headLimit) {
      const retained = remainder.slice(0, headLimit - headBytes);
      head.push(retained);
      headBytes += retained.byteLength;
      remainder = remainder.slice(retained.byteLength);
    }
    if (remainder.byteLength > 0 && tailLimit > 0) {
      tail = Buffer.concat([tail, remainder]);
      if (tail.byteLength > tailLimit) tail = tail.subarray(tail.byteLength - tailLimit);
    }
  }

  onText?.(decoder.decode());
  const headBuffer = Buffer.concat(head.map((chunk) => Buffer.from(chunk)), headBytes);
  if (totalBytes <= limit) {
    return { content: Buffer.concat([headBuffer, tail]).toString("utf8"), totalBytes, truncated: false };
  }
  const marker = `\n... ${totalBytes - limit} bytes omitted ...\n`;
  return { content: `${headBuffer.toString("utf8")}${marker}${tail.toString("utf8")}`, totalBytes, truncated: true };
}
