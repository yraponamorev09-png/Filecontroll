const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  getVersion: () => require('../../package.json').version,
  onMenuAction: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  },
});
