// The few things the page can ask the desktop app to do.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  openLibraryFolder: () => ipcRenderer.invoke('library:open-folder'),
  showItem: (relativePath) => ipcRenderer.invoke('library:show-item', relativePath),
  chooseLibraryFolder: () => ipcRenderer.invoke('library:choose-folder'),
});
