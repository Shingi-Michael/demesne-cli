const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("demesne", {
  request: (method, args = {}) =>
    ipcRenderer.invoke("demesne:request", { method, args }),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("demesne:update", listener);
    return () => ipcRenderer.removeListener("demesne:update", listener);
  },
  commands: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("demesne:command", listener);
    return () => ipcRenderer.removeListener("demesne:command", listener);
  },
  ready: () => ipcRenderer.send("demesne:ready"),
});
