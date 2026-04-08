import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('simAPI', {
  startPush: () => ipcRenderer.invoke('sim:start-push'),
  stopPush: () => ipcRenderer.invoke('sim:stop-push'),
  onData: (callback: (data: unknown) => void) => {
    ipcRenderer.on('sim:data', (_event, data) => callback(data))
  },
  removeDataListener: () => {
    ipcRenderer.removeAllListeners('sim:data')
  },
})
