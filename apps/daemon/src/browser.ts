/// The model's own browser. Not the person's: nothing shows, and they never
/// drive it. One hidden tab per chat stays open between calls, with its
/// page, cookies and place, in the desktop app started off screen
/// (`--browser-host`, apps/desktop/electron/browser-host.ts). The model reads
/// a page as an outline with a number on every control, acts by number, and
/// is told what visibly changed, so it rarely needs a picture.
/// Only this computer for now: localhost addresses and project files.
import { isRecord, TRY_KEYS } from "@demesne/protocol";
import type { ImageOutput } from "./artifacts.ts";
import { pageAddress } from "./page-look.ts";
import { toolError, type AgentTool } from "./tools.ts";

export const BROWSER_TOOL = "browser";
/// Its pictures are named this way, so a model that sees gets them (engine.ts).
export const BROWSER_PICTURE_PREFIX = "browser-";
export const BROWSER_PICTURES_PER_TURN = 6;
export const BROWSER_ACTIONS = ["open", "read", "text", "click", "type", "key", "scroll", "hover", "back", "forward", "reload", "wait", "picture", "close"] as const;
export type BrowserAction = typeof BROWSER_ACTIONS[number];

/// Sends one command to a chat's tab and returns what the browser said; null when there is no browser to ask.
export type BrowserDriver = (chat: string, command: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown> | null>;

const COMMAND_TIMEOUT_MS = 40_000;

/// Keeps one hidden browser running for the daemon, started on first use and
/// started again if it dies. `close` ends it, with every chat's tab.
export function electronBrowser(command: string[]): BrowserDriver & { close(): void } {
  let child: ReturnType<typeof Bun.spawn> | null = null, next = 1;
  const waiting = new Map<number, (reply: Record<string, unknown> | null) => void>();
  const drop = () => { for (const resolve of waiting.values()) resolve(null); waiting.clear(); child = null; };
  const start = () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const started = Bun.spawn([...command, "--browser-host"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env });
    child = started;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of started.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
              const reply = JSON.parse(line) as Record<string, unknown>;
              if (typeof reply.id === "number") { waiting.get(reply.id)?.(reply); waiting.delete(reply.id); }
            } catch { /* Chromium's own chatter */ }
          }
        }
      } catch { /* the pipe closed */ }
      if (child === started) drop();
    })();
    return started;
  };
  const driver = ((chat, body, signal) => new Promise<Record<string, unknown> | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    // Nothing to close when no browser was ever started.
    if (!child && body.action === "close") { resolve({ closed: true }); return; }
    let running: ReturnType<typeof Bun.spawn>;
    try { running = child ?? start(); } catch { resolve(null); return; }
    const id = next++;
    const finish = (reply: Record<string, unknown> | null) => { clearTimeout(timer); signal.removeEventListener("abort", stop); waiting.delete(id); resolve(reply); };
    const stop = () => finish(null);
    const timer = setTimeout(stop, COMMAND_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    waiting.set(id, finish);
    try { const stdin = running.stdin as import("bun").FileSink; stdin.write(`${JSON.stringify({ ...body, id, chat })}\n`); stdin.flush(); } catch { finish(null); }
  })) as BrowserDriver & { close(): void };
  driver.close = () => {
    const running = child;
    drop();
    if (!running) return;
    try { (running.stdin as import("bun").FileSink).end(); } catch { /* already gone */ }
    setTimeout(() => running.kill(), 1500).unref?.();
  };
  return driver;
}

const strings = (value: unknown, max = 12) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : [];

/// What the model reads back: short, and only what this call changed.
export function browserReport(action: BrowserAction, reply: Record<string, unknown>): Record<string, unknown> {
  const outline = strings(reply.outline, 200), errors = strings(reply.errors), failed = strings(reply.failed), blocked = strings(reply.blocked), dialogs = strings(reply.dialogs);
  const text = typeof reply.text === "string" ? reply.text : null, total = Number(reply.total) || 0, from = Number(reply.from) || 0;
  return {
    url: typeof reply.url === "string" ? reply.url : "", title: typeof reply.title === "string" ? reply.title : "",
    ...(reply.ok === false ? { failed: typeof reply.did === "string" ? reply.did : "it could not be done" } : typeof reply.did === "string" && reply.did ? { did: reply.did } : {}),
    ...(typeof reply.changed === "string" && reply.changed ? { changed: reply.changed } : {}),
    ...(outline.length ? { outline } : action === "open" || action === "read" ? { outline: ["(no headings or controls on this page; use text to read it)"] } : {}),
    ...(text !== null ? { text, ...(from + text.length < total ? { more: `${total - from - text.length} more characters: text with from ${from + text.length}` } : {}) } : {}),
    ...(dialogs.length ? { page_dialogs: dialogs } : {}),
    ...(errors.length ? { console_errors: errors } : {}), ...(failed.length ? { failed_requests: failed } : {}),
    ...(blocked.length ? { blocked: blocked.map((url) => `${url} is outside this computer, so it was not opened`) } : {}),
  };
}

export function browserTool(drive: BrowserDriver, pictures = new Map<string, number>()): AgentTool {
  return {
    definition: {
      name: BROWSER_TOOL,
      description: "Your own browser. The person never sees or drives it; it is hidden and stays open for this chat, keeping its page, cookies and place between calls, so you can sign in, go several pages deep and come back. "
        + "It opens this computer's own apps: a local dev server (http://localhost:5173/settings; start it with run_command background and wait_for first) or an .html file in the project. "
        + "A page comes back as an outline: its headings, and every control on a numbered line, like [12] button \"Save\". Act on a control by its number (ref: 12); a visible name also works. A number holds for as long as that control is on the page. "
        + "Actions: open (url, width?) · read (the outline again) · text (the page's words; from continues a long page) · click (ref) · type (text, ref?, clear?, enter?) · key (key) · hover (ref) · scroll (px, negative for up) · back · forward · reload · wait (for: text to appear, or ms) · picture · close. "
        + "Each action says what visibly changed and reports new console errors and failed requests. The outline is sent again only when the address changes; call read if you need it. Take a picture only when how it looks matters: the outline and text are far cheaper. "
        + "Use it to check a web UI you changed really works, end to end, before you answer.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...BROWSER_ACTIONS] },
          url: { type: "string", maxLength: 2000, description: "open: a localhost address or a project .html file" },
          width: { type: "string", enum: ["desktop", "phone"], description: "open: desktop is 1280px (default), phone is 390px" },
          ref: { type: ["integer", "string"], description: "click, hover, type: the control's number from the outline, or its visible name" },
          text: { type: "string", maxLength: 4000, description: "type: what to type" },
          clear: { type: "boolean", description: "type: empty the field first" },
          enter: { type: "boolean", description: "type: press Enter after" },
          key: { type: "string", enum: [...TRY_KEYS] },
          px: { type: "integer", description: "scroll: pixels down, negative for up" },
          for: { type: "string", maxLength: 200, description: "wait: text that should appear on the page" },
          ms: { type: "integer", description: "wait: how long, up to 15000" },
          from: { type: "integer", description: "text: where to continue from" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    // Only this computer's own app, in a window nobody sees: like reading a file.
    permission: () => null,
    async execute() { throw toolError("UNAVAILABLE", "the browser needs the desktop app", "check the page with run_command instead"); },
    async executeWithArtifacts(input, context) {
      const args = isRecord(input) ? input : {};
      const action = BROWSER_ACTIONS.find((name) => name === args.action);
      if (!action) throw toolError("INVALID_ACTION", "action must be one of " + BROWSER_ACTIONS.join(", "), "start with action open and a url");
      const chat = context.sessionId ?? "";
      if (!chat) throw toolError("UNAVAILABLE", "the browser belongs to a chat", "check the page with run_command instead");
      const command: Record<string, unknown> = { action };
      if (action === "open") {
        if (typeof args.url !== "string" || !args.url.trim()) throw toolError("MISSING_URL", "open needs a url", "pass http://localhost:<port> or a project .html file");
        try { command.url = pageAddress(args.url, context.workspaceRoot); }
        catch (error) { if (error instanceof Error) error.message = error.message.replace("look_at_page opens", "the browser opens"); throw error; }
        if (args.width === "phone" || args.width === "desktop") command.width = args.width;
      }
      if (action === "click" || action === "hover") {
        if (typeof args.ref !== "number" && (typeof args.ref !== "string" || !args.ref.trim())) throw toolError("MISSING_REF", `${action} needs a ref`, "pass the control's number from the outline, or its visible name");
        command.ref = args.ref;
      }
      if (action === "type") {
        if (typeof args.text !== "string") throw toolError("MISSING_TEXT", "type needs text", "pass the text, and ref for the field to type into");
        Object.assign(command, { text: args.text, ...(args.ref !== undefined ? { ref: args.ref } : {}), ...(args.clear === true ? { clear: true } : {}), ...(args.enter === true ? { enter: true } : {}) });
      }
      if (action === "key") {
        const key = TRY_KEYS.find((name) => name.toLowerCase() === String(args.key).toLowerCase());
        if (!key) throw toolError("INVALID_KEY", `key must be one of ${TRY_KEYS.join(", ")}`, "pass one of those keys");
        command.key = key;
      }
      if (action === "scroll") command.px = Math.max(-20_000, Math.min(20_000, Math.round(Number(args.px) || 600)));
      if (action === "wait") Object.assign(command, { ...(typeof args.for === "string" && args.for ? { for: args.for } : {}), ...(Number.isFinite(Number(args.ms)) && args.ms !== undefined ? { ms: Number(args.ms) } : {}) });
      if (action === "text") command.from = Math.max(0, Math.round(Number(args.from) || 0));
      if (action === "picture") {
        const key = context.turnId ?? "", seen = pictures.get(key) ?? 0;
        if (seen >= BROWSER_PICTURES_PER_TURN) throw toolError("LIMIT", `${BROWSER_PICTURES_PER_TURN} pictures were taken this turn`, "read the outline or the text instead");
        pictures.set(key, seen + 1);
        if (pictures.size > 200) pictures.delete(pictures.keys().next().value!);
      }
      const reply = await drive(chat, command, context.signal);
      if (!reply) throw toolError("UNAVAILABLE", "the browser did not answer", "try once more; if it keeps failing, check the page with run_command");
      if (typeof reply.error === "string") throw toolError(action === "open" ? "UNREACHABLE" : "FAILED", reply.error.slice(0, 400), action === "open" ? "is the dev server running? start it in the background and wait_for its ready line" : "open a page first, or read it again");
      if (action === "close") return { text: JSON.stringify({ closed: true }), images: [] };
      const report = browserReport(action, reply);
      const images: ImageOutput[] = typeof reply.png === "string" ? [{ data: Buffer.from(reply.png, "base64"), mimeType: "image/png", filename: `${BROWSER_PICTURE_PREFIX}page.png` }] : [];
      return { text: JSON.stringify(report), images };
    },
  };
}
