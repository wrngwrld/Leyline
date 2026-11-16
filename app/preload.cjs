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
  checkUpdates: () => ipcRenderer.invoke('leyline:checkUpdates'),
  run: (id) => ipcRenderer.invoke('leyline:run', id),
  addons: (flavor) => ipcRenderer.invoke('leyline:addons', flavor),
  chooseStart: (flavor, mode) => ipcRenderer.invoke('leyline:chooseStart', { flavor, mode }),
  restore: (req) => ipcRenderer.invoke('leyline:restore', req),
  computers: () => ipcRenderer.invoke('leyline:computers'),
  forgetComputer: (id) => ipcRenderer.invoke('leyline:forgetComputer', id),
  openBackups: () => ipcRenderer.invoke('leyline:openBackups'),
  installUpdate: () => ipcRenderer.invoke('leyline:installUpdate'),
  onUpdate: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on('leyline:update', handler);
    return () => ipcRenderer.removeListener('leyline:update', handler);
  },
});
