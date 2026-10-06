const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('aster', {
  openDialog: () => ipcRenderer.invoke('pdf:open-dialog'),
  openPath: (filePath) => ipcRenderer.invoke('pdf:open-path', filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),
  save: (bytes, saveAs, expectedPath) => ipcRenderer.invoke('pdf:save', bytes, saveAs, expectedPath),
  getRecentPdfs: () => ipcRenderer.invoke('recent:list'),
  setRecentPreview: (filePath, preview) => ipcRenderer.invoke('recent:set-preview', filePath, preview),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setAuthorName: (name) => ipcRenderer.invoke('settings:set', name),
  setDirty: (value) => ipcRenderer.send('pdf:set-dirty', value),
  setSaving: (value) => ipcRenderer.send('pdf:set-saving', value),
  onMenu: (channel, handler) => {
    if (!['menu:open', 'menu:save', 'menu:save-as', 'menu:settings'].includes(channel)) return () => {};
    const listener = () => handler();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
