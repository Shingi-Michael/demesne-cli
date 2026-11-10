/// Open it, and show it on the right (pass 210 A). `open` opens an app, a
/// file in its app, a folder or a link on this computer, behind Demesne, so
/// the chat keeps the keyboard; where windows can be pictured it comes back
/// with a picture of the window it opened. `show` puts a file, a picture, a
/// web page or the app being built in one preview card on the right of the
/// chat. Opening asks once per app (Always remembers that app); showing
/// never asks. Drive and routines don't get `open` (engine.ts).
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "@demesne/protocol";
import { captureWindow, listWindows, supported, type Shot, type ShotWindow } from "../../../packages/screen/src/index.ts";
import type { StructuredToolResult } from "./artifacts.ts";
import type { PageLook } from "./page-look.ts";
import { toolError, type AgentTool, type ToolContext } from "./tools.ts";

export const OPEN = "open";
export const SHOW = "show";
/// Their pictures are named this, so a model that sees gets them (engine.ts).
export const SHOWN_FILE = "shown.png";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const APP_NAME = /^[\p{L}\p{N} .&+()'_-]{1,100}$/u;
const OWN = ["demesne", "electron"];

/// What runs the open, and pictures what opened; swapped out in tests.
export interface OpenDependencies {
  platform: NodeJS.Platform;
  run(argv: string[], signal: AbortSignal): Promise<{ code: number; stderr: string }>;
  windows?: {
    list(signal: AbortSignal): Promise<ShotWindow[]>;
    capture(window: ShotWindow, signal: AbortSignal): Promise<Shot>;
  };
  /// How long a new window gets to appear before the picture.
  settleMs?: number;
}

function runDetached(argv: string[], signal: AbortSignal): Promise<{ code: number; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"], signal, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 2_000) stderr += chunk.toString("utf8"); });
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 0, stderr }));
  });
}

export const nativeOpen: OpenDependencies = {
  platform: process.platform,
  run: runDetached,
  ...(supported() ? { windows: { list: (signal) => listWindows({ signal }), capture: (window, signal) => captureWindow(window, { signal }) } } : {}),
};

/// A link to open: any scheme but the ones that run or read things.
function linkOf(value: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (["file:", "javascript:", "data:", "vbscript:", "blob:"].includes(url.protocol)) throw toolError("INVALID_TARGET", `${url.protocol} links can't be opened`, "pass the file's path instead");
  return url;
}

/// A file or folder: relative to the chat's folder, absolute, or under ~.
function placeOf(value: string, root: string): string {
  if (value.includes("\0")) throw toolError("INVALID_TARGET", "that is not a path", "pass a file, folder or link");
  const path = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : isAbsolute(value) ? value : resolve(root, value);
  if (!existsSync(path)) throw toolError("NOT_FOUND", `${value} does not exist`, "check the path with list_files");
  return path;
}

/// The command that opens it, behind Demesne where the system can.
export function openCommand(platform: NodeJS.Platform, app: string | undefined, target: string | undefined): string[] {
  if (platform === "darwin") return ["open", "-g", ...(app ? ["-a", app] : []), ...(target ? [target] : [])];
  if (app) return [app, ...(target ? [target] : [])];
  return [platform === "win32" ? "explorer.exe" : "xdg-open", target!];
}

function parseOpen(input: unknown): { app?: string; target?: string } {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "app" && key !== "target")) throw toolError("INVALID_INPUT", "open takes app and/or target", "pass {app: \"Figma\"}, {target: \"report.pdf\"} or both");
  const app = typeof input.app === "string" ? input.app.trim() : undefined;
  const target = typeof input.target === "string" ? input.target.trim() : undefined;
  if (input.app !== undefined && (!app || !APP_NAME.test(app))) throw toolError("INVALID_APP", "app is an application's name, like Figma or Safari", "pass its name without a path");
  if (input.target !== undefined && (!target || target.length > 4000)) throw toolError("INVALID_TARGET", "target is a file, folder or link", "pass a path or an address");
  if (!app && !target) throw toolError("INVALID_INPUT", "open needs an app or a target", "pass {app: \"Figma\"} or {target: \"https://…\"}");
  return { ...(app ? { app } : {}), ...(target ? { target } : {}) };
}

/// The window that opened: a new one of that app, else a new one, else
/// one of that app. Never Demesne's own.
function openedWindow(before: ShotWindow[], after: ShotWindow[], app?: string): ShotWindow | undefined {
  const old = new Set(before.map((one) => `${one.app}\u0000${one.id}`));
  const theirs = after.filter((one) => one.id !== "active" && !OWN.includes(one.app.toLowerCase()));
  const fresh = theirs.filter((one) => !old.has(`${one.app}\u0000${one.id}`));
  const named = (list: ShotWindow[]) => app ? list.filter((one) => one.app.toLowerCase() === app.toLowerCase()) : [];
  return named(fresh)[0] ?? (app ? undefined : fresh[0]) ?? named(theirs)[0];
}

const settle = (ms: number, signal: AbortSignal) => new Promise<void>((done) => {
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

export function openTool(deps: OpenDependencies = nativeOpen): AgentTool {
  async function execute(input: unknown, context: ToolContext): Promise<StructuredToolResult> {
    const { app, target } = parseOpen(input);
    const link = target ? linkOf(target) : null;
    const place = target && !link ? placeOf(target, context.workspaceRoot) : undefined;
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
    const before = deps.windows ? await deps.windows.list(signal).catch(() => null) : null;
    const opened = await deps.run(openCommand(deps.platform, app, link?.href ?? place), signal);
    if (opened.code !== 0) throw toolError("OPEN_FAILED", (opened.stderr.trim() || `it exited with ${opened.code}`).slice(0, 400), app ? `is ${app} installed? check its exact name` : "check the path or address");
    const name = app ?? (link ? link.host || link.href : basename(place!) || place!);
    const head = { opened: true, name, ...(app ? { app } : {}), ...(target ? { target: link?.href ?? target } : {}),
      kind: place ? (statSync(place).isDirectory() ? "folder" : "file") : link ? "link" : "app", behind: deps.platform === "darwin" };
    // A picture of what opened, where the system lets windows be pictured.
    if (before && deps.windows) {
      for (const wait of [deps.settleMs ?? 1_500, deps.settleMs ?? 1_500, (deps.settleMs ?? 1_500) * 2]) {
        await settle(wait, signal);
        if (signal.aborted) break;
        const after = await deps.windows.list(signal).catch(() => null);
        const window = after && openedWindow(before, after, app);
        if (!window) continue;
        const shot = await deps.windows.capture(window, signal).catch(() => null);
        if (!shot) break;
        return { text: JSON.stringify({ ...head, app: window.app, title: window.title, next: "It's open behind Demesne and pictured on the right; say what you opened. Don't open it again." }),
          images: [{ data: shot.png, mimeType: "image/png", filename: SHOWN_FILE }] };
      }
    }
    return { text: JSON.stringify({ ...head, next: "It's open behind Demesne; say what you opened. Don't open it again." }), images: [] };
  }
  return {
    definition: {
      name: OPEN,
      description: "Open an app, a file in its app, a folder or a link on the user's computer, behind Demesne so the chat keeps the keyboard. "
        + "Use it when the user asks to open something (\"open Figma\", \"open the report\", \"open the PR in my browser\"). "
        + "app is an application's name (Figma, Safari, Finder); target is a file or folder (relative to the project, absolute, or ~/…) or a link. "
        + "Pass both to open a file in a given app. Where it can, it returns a picture of the window it opened, which also shows on the right. "
        + "To show the user something without opening it, use show.",
      inputSchema: { type: "object", properties: {
        app: { type: "string", maxLength: 100, description: "Application name, e.g. Figma. Omit to use the default app for target." },
        target: { type: "string", maxLength: 4000, description: "A file or folder path, or a link (https://…, figma://…)." },
      }, additionalProperties: false },
    },
    permission: (input) => {
      const args = isRecord(input) ? input : {};
      const what = typeof args.app === "string" && args.app.trim() ? args.app.trim() : typeof args.target === "string" ? args.target.trim() : "";
      return { kind: "execute", summary: `Open ${what.length > 80 ? `${what.slice(0, 79)}…` : what || "something"}${typeof args.app === "string" && typeof args.target === "string" ? ` with ${basename(args.target)}` : ""}` };
    },
    execute: async () => { throw new Error("open requires artifact-aware execution"); },
    executeWithArtifacts: execute,
  };
}

/// A page to show: the app being built (a localhost address) is shown live,
/// a page on the internet as a picture taken in a hidden window.
function pageOf(value: string): { url: string; live: boolean } | null {
  const bare = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value) ? `http://${value}` : value;
  if (!/^https?:\/\//i.test(bare)) return null;
  let url: URL;
  try { url = new URL(bare); } catch { throw toolError("INVALID_URL", "that is not an address", "pass https://… or http://localhost:<port>"); }
  const live = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  return { url: url.href, live };
}

export function showTool(look?: PageLook): AgentTool {
  async function execute(input: unknown, context: ToolContext): Promise<StructuredToolResult> {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "path" && key !== "url" && key !== "title")
      || (typeof input.path === "string") === (typeof input.url === "string")) throw toolError("INVALID_INPUT", "show takes a path or a url", "pass {path: \"design.png\"} or {url: \"http://localhost:5173\"}");
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
    if (typeof input.path === "string") {
      const path = input.path.trim();
      const place = placeOf(path, context.workspaceRoot);
      if (!statSync(place).isFile()) throw toolError("NOT_A_FILE", `${path} is a folder`, "show one file; open shows a folder");
      return { text: JSON.stringify({ shown: "file", name: title || basename(place), path, next: "It's in the preview on the right. Don't describe it unless asked." }), images: [] };
    }
    const page = pageOf(String(input.url).trim());
    if (!page) throw toolError("INVALID_URL", "url is a web address", "pass https://… or http://localhost:<port>; a file goes in path");
    const name = title || new URL(page.url).host;
    if (page.live) return { text: JSON.stringify({ shown: "app", name, url: page.url, live: true, next: "It's live in the preview on the right." }), images: [] };
    const seen = look ? await look(page.url, { width: 1280, steps: [] }, context.signal).catch(() => null) : null;
    const picture = seen?.pictures.at(-1);
    return { text: JSON.stringify({ shown: "page", name: title || seen?.title?.slice(0, 120) || name, url: page.url, next: picture ? "A picture of it is on the right." : "It's on the right as a link; its picture couldn't be taken." }),
      images: picture ? [{ data: Buffer.from(picture.png, "base64"), mimeType: "image/png", filename: SHOWN_FILE }] : [] };
  }
  return {
    definition: {
      name: SHOW,
      description: "Show the user something in a small preview card on the right of the chat, without opening anything or interrupting them: "
        + "a file or picture (path, relative to the project or absolute), the app being built (url http://localhost:<port>, shown live), or a web page (url https://…, shown as a picture). "
        + "Use it when a preview helps: the design you made, the chart you drew, the page you changed. The newest replaces the last. It never asks.",
      inputSchema: { type: "object", properties: {
        path: { type: "string", maxLength: 4000 },
        url: { type: "string", maxLength: 4000 },
        title: { type: "string", maxLength: 120, description: "A short name for the card; defaults to the file's name or the page's title." },
      }, additionalProperties: false },
    },
    permission: () => null,
    execute: async () => { throw new Error("show requires artifact-aware execution"); },
    executeWithArtifacts: execute,
  };
}
