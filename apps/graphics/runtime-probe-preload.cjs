const { ipcRenderer } = require("electron");
ipcRenderer.send("demesne-runtime-probe", { sandboxed: process.sandboxed === true });
