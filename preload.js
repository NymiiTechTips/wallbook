const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallbookAPI', {
  pickWallpaper: (url) => ipcRenderer.invoke('pick-wallpaper', url),
  syncWallpapers: () => ipcRenderer.invoke('sync-wallpapers'),
  onWallpapersSynced: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('wallpapers-synced', listener);
    return () => ipcRenderer.removeListener('wallpapers-synced', listener);
  },
});