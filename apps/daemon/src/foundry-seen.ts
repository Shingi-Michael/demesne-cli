/// What a chat has looked at of the real thing, so a mockup of something
/// that exists starts from it and not from memory: a window capture, a page
/// in the browser, a picture, or the project's own interface files. Kept
/// per chat while the daemon runs; a mockup's first save checks it
/// (foundry.ts checkStart).
import { isRecord } from "@demesne/protocol";

/// Files that say how an interface looks or is laid out.
const UI_FILE = /\.(css|scss|sass|less|styl|html?|[jt]sx|vue|svelte|astro|swift|kt|xaml|xib|storyboard|dart|erb|hbs|twig|qml)$/i;
const MAX_CHATS = 300, MAX_EACH = 12;
const seen = new Map<string, string[]>();

function add(sessionId: string, what: string) {
  const list = seen.get(sessionId) ?? [];
  seen.delete(sessionId);
  if (!list.includes(what)) list.push(what);
  seen.set(sessionId, list.slice(-MAX_EACH));
  if (seen.size > MAX_CHATS) seen.delete(seen.keys().next().value!);
}

const paths = (name: string, input: unknown): string[] => {
  if (!isRecord(input)) return [];
  if (name === "read_file") return typeof input.path === "string" ? [input.path] : [];
  if (name === "read_files" && Array.isArray(input.files)) return input.files.flatMap((file) => isRecord(file) && typeof file.path === "string" ? [file.path] : []);
  return [];
};

/// Called after a tool finished well.
export function noteSeen(sessionId: string | undefined, name: string, input: unknown, result: string): void {
  if (!sessionId) return;
  if (name === "capture_window") { if (result.startsWith("Captured window")) add(sessionId, "a window capture"); return; }
  if (name === "browser") { add(sessionId, "a page in the browser"); return; }
  if (name === "view_image") { add(sessionId, "a picture"); return; }
  for (const path of paths(name, input)) if (UI_FILE.test(path)) add(sessionId, path);
}

export const seenIn = (sessionId: string | undefined): string[] => sessionId ? seen.get(sessionId) ?? [] : [];
