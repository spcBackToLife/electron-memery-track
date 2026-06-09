const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('videoApp', {
  onLog: (callback) => ipcRenderer.on('log', (_, ...args) => callback(...args)),
})
