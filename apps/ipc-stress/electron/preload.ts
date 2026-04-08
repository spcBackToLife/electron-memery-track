import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ipcStressAPI', {
  startPush: (config: { interval: number; dataSize: number }) =>
    ipcRenderer.invoke('ipc-stress:start', config),
  stopPush: () => ipcRenderer.invoke('ipc-stress:stop'),
  echo: (data: unknown) => ipcRenderer.invoke('ipc-stress:echo', data),
  onData: (callback: (data: unknown) => void) => {
    ipcRenderer.on('ipc-stress:data', (_event, data) => callback(data))
  },
  removeDataListener: () => {
    ipcRenderer.removeAllListeners('ipc-stress:data')
  },
})
