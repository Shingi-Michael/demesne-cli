import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { basename, extname } from "node:path";
import { isRecord, type SourceDocument } from "@demesne/protocol";
import type { DemesneStore } from "@demesne/storage";
import { isPrivate, resolveInside } from "./personal-files.ts";
import { isSensitivePath, resolveWorkspacePath } from "./tools.ts";

export const SOURCE_PDF_LIMIT = 20 * 1024 * 1024;
export const SOURCE_TEXT_LIMIT = 2 * 1024 * 1024;
type SourceIssue = NonNullable<SourceDocument["issue"]>;
type Reference = { id: string; path: string; folder?: string };
type Context = { store: DemesneStore; folders: Record<string, string>; trusted: (root: string) => boolean };
const parse = (text: string | null): Record<string, unknown> => {
  try { const value = JSON.parse(text ?? "null"); return isRecord(value) ? value : {}; } catch { return {}; }
};

function references(context: Context, sessionId: string, turnId: string): Reference[] {
  const seen = new Set<string>();
  return context.store.completedFileReads(sessionId, turnId).flatMap(call => {
    const input = parse(call.argumentsJson), result = parse(call.resultText);
    let paths: string[] = [];
    let folder: string | undefined;
    if (call.name === "personal_files") {
      if (input.action !== "read" || typeof input.folder !== "string") return [];
      folder = input.folder;
    }
    if (call.name === "read_files") {
      const requested = Array.isArray(input.files) ? input.files.filter(isRecord).map(file => file.path) : [];
      paths = Array.isArray(result.results) ? result.results.filter(isRecord)
        .filter(file => !file.error && typeof file.path === "string" && requested.includes(file.path))
        .map(file => file.path as string) : [];
    } else if (typeof input.path === "string" && !result.error && result.path === input.path.trim()) {
      paths = [input.path.trim()];
    }
    return paths.flatMap(path => {
      const key = JSON.stringify([folder ?? null, path]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ id: createHash("sha256").update(`${call.id}:${key}`).digest("hex"), path, ...(folder ? { folder } : {}) }];
    });
  });
}

function resolve(context: Context, sessionId: string, ref: Reference): string {
  if (ref.folder !== undefined) {
    const root = Object.hasOwn(context.folders, ref.folder) ? context.folders[ref.folder] : undefined;
    if (!root || isPrivate(ref.path)) throw new Error("unavailable");
    return resolveInside(root, ref.path);
  }
  const root = context.store.getSession(sessionId)?.workspace?.root;
  if (!root || !context.trusted(root) || isSensitivePath(ref.path)) throw new Error("unavailable");
  return resolveWorkspacePath(root, ref.path, false);
}
function revision(stat: Stats): string {
  return createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest("hex");
}
function issueFor(error: unknown): SourceIssue {
  const text = error instanceof Error ? error.message : "";
  return /ENOENT|NOT_FOUND|path does not exist/.test(text) ? "missing" : "unavailable";
}
function descriptor(context: Context, sessionId: string, ref: Reference): SourceDocument {
  const mimeType = extname(ref.path).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain";
  const value: SourceDocument = { id: ref.id, filename: basename(ref.path.replaceAll("\\", "/")),
    path: ref.folder ? `${ref.folder}/${ref.path}` : ref.path, mimeType, byteLength: null, revision: null, issue: null };
  try {
    const stat = lstatSync(resolve(context, sessionId, ref));
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unavailable");
    value.byteLength = stat.size; value.revision = revision(stat);
    if (stat.size > (mimeType === "application/pdf" ? SOURCE_PDF_LIMIT : SOURCE_TEXT_LIMIT)) value.issue = "too_large";
  } catch (error) { value.issue = issueFor(error); }
  return value;
}
export function listSourceDocuments(context: Context, sessionId: string, turnId: string): SourceDocument[] {
  return references(context, sessionId, turnId).map(ref => descriptor(context, sessionId, ref));
}

export function sourceDocumentResponse(context: Context, sessionId: string, turnId: string, id: string, expectedRevision: string | null): Response {
  const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
  const ref = references(context, sessionId, turnId).find(ref => ref.id === id);
  if (!ref) return fail(404, "source_missing", "This file is no longer available in this reply.");
  let fd: number | undefined;
  try {
    const absolute = resolve(context, sessionId, ref);
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    // Recheck the entire path after opening; a renamed directory or symlink
    // cannot substitute another file between validation and the descriptor.
    if (resolve(context, sessionId, ref) !== absolute || realpathSync(absolute) !== absolute) throw new Error("unavailable");
    const current = lstatSync(absolute);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== current.dev || stat.ino !== current.ino) throw new Error("unavailable");
    if (!expectedRevision || expectedRevision !== revision(stat)) return fail(409, "source_changed", "This file changed. Retry to open the current version.");
    const pdf = extname(ref.path).toLowerCase() === ".pdf";
    const limit = pdf ? SOURCE_PDF_LIMIT : SOURCE_TEXT_LIMIT;
    if (stat.size > limit) return fail(413, "source_too_large", "This file is too large to preview on your phone.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    if (offset !== bytes.length || revision(fstatSync(fd)) !== expectedRevision) return fail(409, "source_changed", "This file changed. Retry to open the current version.");
    if (pdf ? bytes.subarray(0, 5).toString() !== "%PDF-" : bytes.includes(0)) return fail(415, "source_unsupported", "This file can't be previewed here.");
    if (!pdf) { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(415, "source_unsupported", "This file isn't readable UTF-8 text."); } }
    return new Response(bytes, { headers: { "content-type": pdf ? "application/pdf" : "text/plain; charset=utf-8",
      "content-length": String(bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff", etag: `"${expectedRevision}"` } });
  } catch (error) { return issueFor(error) === "missing" ? fail(404, "source_missing", "This file was moved or removed from your PC.") : fail(403, "source_unavailable", "This file is no longer shared with Demesne."); }
  finally { if (fd !== undefined) closeSync(fd); }
}
