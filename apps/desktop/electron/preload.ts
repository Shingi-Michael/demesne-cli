import { contextBridge, ipcRenderer } from "electron";
const events = new Set(["demesne:update", "demesne:desktop-error", "demesne:desktop-action"]);
contextBridge.exposeInMainWorld("demesneDesktop", {
  // The shell is glass; "sharp" where the desktop shows through unblurred.
  glass: process.argv.some((arg) => arg === "--demesne-glass" || arg === "--demesne-glass=sharp"),
  glassSharp: process.argv.includes("--demesne-glass=sharp"),
  core: {
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command !== "desktop_request") return Promise.reject(new Error("Unsupported desktop command"));
      return ipcRenderer.invoke("demesne:request", args.method, args.args);
    },
  },
  event: {
    async listen(channel: string, callback: (event: { payload: unknown }) => void) {
      if (!events.has(channel) || typeof callback !== "function") throw new Error("Unsupported desktop event");
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback({ payload });
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
});
