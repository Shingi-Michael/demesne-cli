/// The model's browser inside the desktop app's own window. While the app is
/// open, the daemon drives the browser here instead of in a hidden copy of the
/// app (browser-host.ts): each tab is a real view of this window, so the split
/// shows the page itself, at the screen's own sharpness and speed, not a stream
/// of pictures of it. Tabs not on show stay in the window, put away.
/// The app listens on a socket only this user can reach and writes where it is,
/// with a word to say on it, to a file the daemon reads (apps/daemon/src/browser.ts).
/// The lines on the socket are the hidden browser's own: commands in, answers
/// and news out.
import type { BrowserWindow } from "electron";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBrowserHost, type Rect } from "./browser-host.ts";

/// A line longer than this is not a command.
const LINE_MAX = 4 * 1024 * 1024;

export function serveBrowser(options: { window: BrowserWindow; pointer: string; log: (message: string) => void }) {
  const { window, pointer, log } = options;
  const token = randomBytes(24).toString("base64url");
  const path = process.platform === "win32" ? `\\\\.\\pipe\\demesne-browser-${process.pid}-${randomBytes(6).toString("hex")}` : join(tmpdir(), `demesne-browser-${process.pid}.sock`);
  /// One browser per daemon that connects (each keeps its own projects' sign-ins).
  const hosts = new Map<Socket, ReturnType<typeof createBrowserHost>>();
  /// Where the split's page area is, kept for a browser that connects after the page said so.
  let placed: { chat: string; rect: Rect | null } | undefined;
  const server = createServer((socket) => {
    let buffer = "", greeted = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > LINE_MAX) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!greeted) {
          let hello: Record<string, unknown> = {};
          try { hello = JSON.parse(line) as Record<string, unknown>; } catch {}
          if (hello.hello !== token || hosts.size >= 8) { socket.destroy(); return; }
          greeted = true;
          const profile = typeof hello.profile === "string" && hello.profile ? hello.profile : "";
          if (profile) try { mkdirSync(profile, { recursive: true }); } catch {}
          const host = createBrowserHost({ profile, kept: Boolean(profile), inApp: { window }, write: (out) => { if (!socket.destroyed) socket.write(JSON.stringify(out) + "\n"); } });
          hosts.set(socket, host);
          if (placed?.rect) host.place(placed.chat, placed.rect);
          log("The model's browser is in this window.");
          continue;
        }
        hosts.get(socket)?.line(line);
      }
    });
    const gone = () => { const host = hosts.get(socket); hosts.delete(socket); void host?.shutdown(); };
    socket.on("close", gone);
    socket.on("error", gone);
  });
  server.on("error", (error) => log(`The browser can't be held in this window: ${String(error)}`));
  if (process.platform !== "win32") try { rmSync(path, { force: true }); } catch {}
  server.listen(path, () => {
    try {
      if (process.platform !== "win32") chmodSync(path, 0o600);
      mkdirSync(dirname(pointer), { recursive: true });
      writeFileSync(pointer, JSON.stringify({ socket: path, token, pid: process.pid }) + "\n", { mode: 0o600 });
    } catch (error) { log(`The browser can't be held in this window: ${String(error)}`); }
  });
  return {
    /// The page says where the split shows the browser (null: it does not).
    place(chat: string, rect: Rect | null) { placed = { chat, rect }; for (const host of hosts.values()) host.place(chat, rect); },
    /// The app is closing: tabs go, sign-ins are written out.
    async close() {
      try { rmSync(pointer, { force: true }); } catch {}
      server.close();
      const open = [...hosts];
      hosts.clear();
      await Promise.all(open.map(([, host]) => host.shutdown()));
      for (const [socket] of open) socket.destroy();
      if (process.platform !== "win32") try { rmSync(path, { force: true }); } catch {}
    },
  };
}
