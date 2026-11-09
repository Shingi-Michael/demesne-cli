/// Sources you keep with a chat (pass 204). A file, a folder or a link the
/// person adds once; the model gets one short line for each on every message
/// and reads one only when the question needs it (read_source). A file in the
/// project stays where it is; a file from elsewhere is copied into the chat,
/// so it still reads after the original moves.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChatSource } from "@demesne/protocol";
import type { ProviderToolDefinition } from "@demesne/providers";
import { documentText, readable, UnreadableError } from "./documents.ts";
import { isSensitivePath, listWorkspaceFiles, resolveWorkspacePath, type AgentTool } from "./tools.ts";

export const READ_SOURCE = "read_source";
export const MAX_SOURCES = 40;
export const MAX_COPY_BYTES = 30 * 1024 * 1024;
const READ_CHARS = 40_000;
const FOLDER_LIST = 400;

export class SourceError extends Error {}

const SESSION = /^[A-Za-z0-9-]{1,100}$/;

export function sizeWord(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

/// A link's name: the address without its scheme, www or trailing slash.
export function linkName(url: URL): string {
  return `${url.host.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
}

/// The site, for the dim line: "docs.stripe.com" → "Stripe".
function siteWord(url: URL): string {
  const parts = url.hostname.replace(/^www\./, "").split(".");
  const word = parts.length > 2 && parts.at(-2)!.length <= 3 ? parts.at(-3)! : parts.at(-2) ?? parts[0]!;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function within(root: string | undefined, path: string): string | undefined {
  if (!root) return undefined;
  const rel = relative(resolve(root), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : rel === "" ? "" : undefined;
}

export class SourceStore {
  constructor(private readonly directory: string) {}

  private file(sessionId: string) {
    if (!SESSION.test(sessionId)) throw new SourceError("Invalid session id");
    return join(this.directory, `${sessionId}.json`);
  }
  private copies(sessionId: string) { this.file(sessionId); return join(this.directory, sessionId); }

  list(sessionId: string): ChatSource[] {
    const path = this.file(sessionId);
    if (!existsSync(path)) return [];
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { sources?: ChatSource[] };
      return Array.isArray(value.sources) ? value.sources : [];
    } catch { return []; }
  }

  get(sessionId: string, id: string): ChatSource | undefined {
    return this.list(sessionId).find((source) => source.id === id);
  }

  private save(sessionId: string, sources: ChatSource[]) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.file(sessionId), temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ sources }), { mode: 0o600 });
    renameSync(temp, path);
  }

  /// Puts a source at the top; the same target again moves it up instead.
  private keep(sessionId: string, source: Omit<ChatSource, "id" | "addedAt">): ChatSource {
    const before = this.list(sessionId);
    const same = before.find((one) => one.target === source.target);
    const kept: ChatSource = { ...source, id: same?.id ?? randomUUID().slice(0, 8), addedAt: new Date().toISOString() };
    const rest = before.filter((one) => one.target !== source.target);
    if (rest.length >= MAX_SOURCES) throw new SourceError(`A chat keeps up to ${MAX_SOURCES} sources; take one off first`);
    this.save(sessionId, [kept, ...rest]);
    return kept;
  }

  /// A file or folder on this computer, by its absolute path.
  addPath(sessionId: string, path: string, projectRoot?: string): ChatSource {
    if (!isAbsolute(path)) throw new SourceError("Pass the file's full path");
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(path); } catch { throw new SourceError(`${basename(path)} isn't there`); }
    const inProject = within(projectRoot, path);
    if (stat.isDirectory()) {
      const count = listWorkspaceFiles(path, 2_000).length;
      const files = count >= 2_000 ? "2,000+ files" : count === 1 ? "1 file" : `${count} files`;
      return this.keep(sessionId, {
        kind: "folder", target: path, name: `${inProject || basename(path)}/`,
        detail: inProject !== undefined ? `in this project · ${files}` : `on this computer · ${files}`,
        ...(inProject !== undefined ? { inProject } : {}),
      });
    }
    if (!stat.isFile()) throw new SourceError(`${basename(path)} isn't a file or folder`);
    if (isSensitivePath(path)) throw new SourceError(`${basename(path)} holds secrets, so it can't be a source`);
    if (inProject) {
      const folder = dirname(inProject);
      return this.keep(sessionId, { kind: "file", target: path, name: basename(path), detail: folder === "." ? "in this project" : `in this project · ${folder}/`, inProject });
    }
    if (stat.size > MAX_COPY_BYTES) throw new SourceError(`${basename(path)} is over 30 MB`);
    return this.copyIn(sessionId, basename(path), (to) => copyFileSync(path, to), stat.size);
  }

  /// A picture or file sent in the composer, kept as a copy.
  addData(sessionId: string, filename: string, data: Uint8Array): ChatSource {
    if (data.byteLength > MAX_COPY_BYTES) throw new SourceError(`${filename} is over 30 MB`);
    return this.copyIn(sessionId, filename, (to) => writeFileSync(to, data, { mode: 0o600 }), data.byteLength);
  }

  private copyIn(sessionId: string, filename: string, write: (to: string) => void, size: number): ChatSource {
    const name = basename(filename).replace(/[\u0000-\u001f/\\]/g, "").slice(0, 120) || "file";
    const folder = join(this.copies(sessionId), randomUUID().slice(0, 8));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const to = join(folder, name);
    write(to);
    return this.keep(sessionId, { kind: "file", target: to, name, detail: `copied into the chat · ${sizeWord(size)}`, copied: true });
  }

  /// A link: only http(s); the page's title is asked for, briefly, by `title`.
  async addLink(sessionId: string, text: string, title?: (url: URL) => Promise<string | undefined>): Promise<ChatSource> {
    let url: URL;
    try { url = new URL(text.trim()); } catch { throw new SourceError("That isn't a link. Paste one starting with https://"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SourceError("That isn't a link. Paste one starting with https://");
    if (url.username || url.password) throw new SourceError("Paste the link without a login in it");
    url.hash = "";
    let heading: string | undefined;
    try { heading = (await title?.(url))?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined; } catch { /* the site will do */ }
    return this.keep(sessionId, { kind: "link", target: url.href, name: linkName(url), detail: heading ? `${heading} · ${siteWord(url)}` : siteWord(url) });
  }

  remove(sessionId: string, id: string): ChatSource[] {
    const before = this.list(sessionId);
    const gone = before.find((source) => source.id === id);
    if (!gone) return before;
    const after = before.filter((source) => source.id !== id);
    this.save(sessionId, after);
    if (gone.copied && gone.target.startsWith(this.copies(sessionId) + sep)) rmSync(dirname(gone.target), { recursive: true, force: true });
    return after;
  }
}

/// What the model is told about a chat's sources, one line each.
export function sourcesContext(sources: readonly ChatSource[]): string | null {
  if (!sources.length) return null;
  const line = (source: ChatSource) => {
    const where = source.kind === "link" ? source.target
      : source.inProject !== undefined ? `in the project at ${source.inProject || "."}`
      : source.copied ? "a copy kept with this chat" : source.target;
    return `- ${source.id}: ${source.kind} ${source.name} (${where})${source.kind === "link" && source.detail ? ` · ${source.detail}` : ""}`;
  };
  return [
    "## Sources the person keeps with this chat",
    `They added these to have them handy. Read one with ${READ_SOURCE} (its id) only when the question needs it, not on every message; a folder lists its files first, then pass path to read one.`,
    ...sources.map(line),
  ].join("\n");
}

export const readSourceDefinition: ProviderToolDefinition = {
  name: READ_SOURCE,
  description: "Read one of the sources the person keeps with this chat, by its id from the Sources list: a file's text, a folder's file list (pass path to read a file in it), or a link's page. Long text comes in parts; pass the returned nextOffset to read on.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 40, description: "The source's id" },
      path: { type: "string", maxLength: 1000, description: "For a folder: a file in it, relative to the folder" },
      offset: { type: "integer", minimum: 0 },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

function slice(text: string, offset: number, extra: Record<string, unknown>): string {
  const part = text.slice(offset, offset + READ_CHARS), end = offset + part.length;
  return JSON.stringify({ ...extra, length: text.length, ...(end < text.length ? { nextOffset: end } : {}), content: part });
}

/// A file's text: PDF, Word, Excel and PowerPoint through documents.ts,
/// anything else when it is UTF-8 text (code, SQL, CSV, Markdown, JSON).
export async function fileText(absolute: string): Promise<string> {
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new SourceError("not a regular file");
  if (isSensitivePath(absolute)) throw new SourceError("it holds secrets, which are never read");
  const kind = readable(absolute);
  if (kind === "pdf" || kind === "office") return documentText(absolute, stat.size);
  if (stat.size > 4 * 1024 * 1024) throw new SourceError("over 4 MB of text");
  if (/\.(zip|gz|tgz|rar|7z|dmg|iso|exe|mp4|mov|mp3|wav|m4a|webm|avi)$/i.test(absolute)) throw new SourceError(`a ${absolute.split(".").at(-1)!.toLowerCase()} file, not text`);
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw new SourceError("a binary file, not text");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SourceError("not text (not valid UTF-8)"); }
}

/// Runs read_source. `fetchPage` is web_fetch, so a link is read the same
/// way (and with the same guard against local addresses).
export async function readSource(sources: readonly ChatSource[], input: unknown, signal: AbortSignal, fetchPage?: AgentTool): Promise<string> {
  const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const source = sources.find((one) => one.id === record.id);
  if (!source) throw new SourceError(`No source ${String(record.id ?? "")}; the ids are in the Sources list`);
  const offset = typeof record.offset === "number" ? Math.max(0, Math.floor(record.offset)) : 0;
  if (source.kind === "link") {
    if (!fetchPage) throw new SourceError("Reading links is off here");
    return fetchPage.execute({ url: source.target, offset }, { signal, workspaceRoot: "" });
  }
  if (!existsSync(source.target)) throw new SourceError(`${source.name} isn't there any more`);
  try {
    if (source.kind === "file") return slice(await fileText(source.target), offset, { source: source.name });
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) {
      const files = listWorkspaceFiles(source.target, FOLDER_LIST);
      return JSON.stringify({ source: source.name, files, ...(files.length >= FOLDER_LIST ? { more: true } : {}) });
    }
    return slice(await fileText(resolveWorkspacePath(source.target, path, false)), offset, { source: source.name, path });
  } catch (error) {
    if (error instanceof SourceError || error instanceof UnreadableError) throw new SourceError(`${source.name} can't be read: ${error.message}`);
    throw error;
  }
}

/// The page's title for a new link, best effort and quick.
export async function linkTitle(fetchPage: AgentTool | undefined, url: URL): Promise<string | undefined> {
  if (!fetchPage) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const value = JSON.parse(await fetchPage.execute({ url: url.href, maxChars: 1000 }, { signal: controller.signal, workspaceRoot: "" })) as { title?: string };
    return value.title;
  } catch { return undefined; } finally { clearTimeout(timer); }
}

/// The text of a file sent with a message (pass 205 A): its first part, and
/// where the rest is (read_source with the source's id and an offset).
export const ATTACHED_CHARS = 60_000;
export async function attachedFileText(source: ChatSource | undefined, filename: string): Promise<string> {
  if (!source || !existsSync(source.target)) return `[Attached file ${filename}: no longer kept, so it can't be read]`;
  let text: string;
  try { text = await fileText(source.target); }
  catch (error) { return `[Attached file ${filename}: it can't be read (${error instanceof Error ? error.message : String(error)})]`; }
  const part = text.slice(0, ATTACHED_CHARS);
  const rest = text.length > part.length ? `\n[The file goes on for ${text.length - part.length} more characters: read_source with id ${source.id} and offset ${part.length}]` : "";
  return `[Attached file ${filename}, kept as source ${source.id}]\n<file name="${filename.replace(/"/g, "'")}">\n${part}\n</file>${rest}`;
}
