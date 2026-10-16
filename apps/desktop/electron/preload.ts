import { contextBridge, ipcRenderer } from "electron";
const events = new Set(["demesne:update", "demesne:command", "demesne:desktop-error", "demesne:desktop-action"]);
contextBridge.exposeInMainWorld("demesneDesktop", {
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
