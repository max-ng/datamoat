import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('datamoatDesktop', {
  update: {
    getSettings: () => ipcRenderer.invoke('datamoat:update:getSettings'),
    saveSettings: (autoUpdateEnabled: boolean) => ipcRenderer.invoke('datamoat:update:saveSettings', { autoUpdateEnabled }),
    check: () => ipcRenderer.invoke('datamoat:update:check'),
    apply: () => ipcRenderer.invoke('datamoat:update:apply'),
    openLatest: () => ipcRenderer.invoke('datamoat:update:openLatest'),
  },
  transfer: {
    selectFolder: () => ipcRenderer.invoke('datamoat:transfer:selectFolder'),
  },
  chatgptExport: {
    selectSource: () => ipcRenderer.invoke('datamoat:chatgptExport:selectSource'),
  },
})

export {}
