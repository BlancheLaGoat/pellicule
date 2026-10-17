const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pellicule', {
  platforms: () => ipcRenderer.invoke('platforms'),
  choose: id => ipcRenderer.send('choose', id),
  back: () => ipcRenderer.send('picker:back'),
});
