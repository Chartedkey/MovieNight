'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, args),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
  onScan: (fn) => ipcRenderer.on('scan', (_e, s) => fn(s)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, u) => fn(u)),
});
