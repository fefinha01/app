const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ravok', {
  init: () => ipcRenderer.invoke('init'),
  normalizeDir: (dir) => ipcRenderer.invoke('normalize-dir', dir),
  pickDir: (current) => ipcRenderer.invoke('pick-dir', current),
  install: (options) => ipcRenderer.invoke('install', options),
  cancel: () => ipcRenderer.invoke('cancel'),
  launch: (dir) => ipcRenderer.invoke('launch', dir),
  minimize: () => ipcRenderer.send('win-minimize'),
  close: () => ipcRenderer.send('win-close'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('done', (_e, data) => cb(data)),
})
