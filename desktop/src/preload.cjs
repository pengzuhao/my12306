const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('my12306Desktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  setAutoStart: enabled => ipcRenderer.invoke('desktop:auto-start', enabled),
  runInBackground: () => ipcRenderer.invoke('desktop:background'),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  },
}));
