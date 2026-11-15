// Exposes a small, explicit API to the window. The window never touches Node or the file system.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leyline', {
  get: () => ipcRenderer.invoke('leyline:get'),
  save: (patch) => ipcRenderer.invoke('leyline:save', patch),
  detect: (wowRoot) => ipcRenderer.invoke('leyline:detect', wowRoot),
  test: (nas, password) => ipcRenderer.invoke('leyline:test', { nas, password }),
  sync: () => ipcRenderer.invoke('leyline:sync'),
  cancel: () => ipcRenderer.invoke('leyline:cancel'),
  pickFolder: () => ipcRenderer.invoke('leyline:pickFolder'),
  onUpdate: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on('leyline:update', handler);
    return () => ipcRenderer.removeListener('leyline:update', handler);
  },
});
