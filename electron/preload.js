const { contextBridge } = require('electron');
const fs = require('fs');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  readFile: (filePath) => fs.promises.readFile(filePath),
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
  exists: (filePath) => fs.promises.access(filePath).then(() => true).catch(() => false),
  getVersion: () => require('../../package.json').version,
});
