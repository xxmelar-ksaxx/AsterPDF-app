const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('aster', {
  openDialog: () => ipcRenderer.invoke('pdf:open-dialog'),
  addDialog: () => ipcRenderer.invoke('pdf:add-dialog'),
  openPath: (filePath) => ipcRenderer.invoke('pdf:open-path', filePath),
  closeDocument: (expectedPath) => ipcRenderer.invoke('pdf:close-document', expectedPath),
  onExternalOpen: (handler) => {
    const listener = (_event, request) => handler(request);
    ipcRenderer.on('pdf:external-open', listener);
    ipcRenderer.send('pdf:external-ready', true);
    return () => { ipcRenderer.send('pdf:external-ready', false); ipcRenderer.removeListener('pdf:external-open', listener); };
  },
  completeExternalOpen: (id) => ipcRenderer.send('pdf:external-complete', id),
  pathForFile: (file) => webUtils.getPathForFile(file),
  save: (bytes, saveAs, expectedPath) => ipcRenderer.invoke('pdf:save', bytes, saveAs, expectedPath),
  listOriginalText: (bytes, pageIndex) => ipcRenderer.invoke('pdf:list-original-text', bytes, pageIndex),
  listInstalledFonts: () => ipcRenderer.invoke('fonts:list-installed'),
  readInstalledFont: (id, text) => ipcRenderer.invoke('fonts:read-installed', id, text),
replaceOriginalText: (bytes, pageIndex, objectIndex, expectedText, replacement, fontChoice, color) =>
ipcRenderer.invoke('pdf:replace-original-text', bytes, pageIndex, objectIndex, expectedText, replacement, fontChoice, color),
moveOriginalText: (bytes, pageIndex, objectIndex, expectedText, dx, dy) =>
  ipcRenderer.invoke('pdf:move-original-text', bytes, pageIndex, objectIndex, expectedText, dx, dy),
embedShapedText: (bytes, placements) => ipcRenderer.invoke('pdf:embed-shaped-text', bytes, placements),
  prepareCompressedSave: (expectedPath) => ipcRenderer.invoke('pdf:prepare-compressed-save', expectedPath),
  finishCompressedSave: (bytes, token, expectedPath) => ipcRenderer.invoke('pdf:finish-compressed-save', bytes, token, expectedPath),
  discardCompressedSave: (token) => ipcRenderer.invoke('pdf:discard-compressed-save', token),
  printDocx: () => ipcRenderer.invoke('docx:print'),
  prepareWordExport: expectedPath => ipcRenderer.invoke('word:prepare-export', expectedPath),
  convertToWord: (bytes, token, expectedPath) => ipcRenderer.invoke('word:convert', bytes, token, expectedPath),
  discardWordExport: token => ipcRenderer.invoke('word:discard-export', token),
  prepareDataExport: expectedPath => ipcRenderer.invoke('data:prepare-export', expectedPath),
  convertToData: (bytes, token, expectedPath) => ipcRenderer.invoke('data:convert', bytes, token, expectedPath),
  discardDataExport: token => ipcRenderer.invoke('data:discard-export', token),
  onDataProgress: handler => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on('data:progress', listener);
    return () => ipcRenderer.removeListener('data:progress', listener);
  },
  onWordProgress: handler => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on('word:progress', listener);
    return () => ipcRenderer.removeListener('word:progress', listener);
  },
  getRecentPdfs: () => ipcRenderer.invoke('recent:list'),
  setRecentPreview: (filePath, preview) => ipcRenderer.invoke('recent:set-preview', filePath, preview),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('updates:changed', listener);
    return () => ipcRenderer.removeListener('updates:changed', listener);
  },
  setAuthorName: (name) => ipcRenderer.invoke('settings:set', name),
  setDirty: (value) => ipcRenderer.send('pdf:set-dirty', value),
  setSaving: (value) => ipcRenderer.send('pdf:set-saving', value),
  onDiscardRequest: (handler) => {
    const listener = (_event, id) => handler(id);
    ipcRenderer.on('pdf:confirm-discard', listener);
    return () => ipcRenderer.removeListener('pdf:confirm-discard', listener);
  },
  answerDiscardRequest: (id, discard) => ipcRenderer.send('pdf:confirm-discard-result', id, discard),
  onMenu: (channel, handler) => {
    if (!['menu:open', 'menu:save', 'menu:save-as', 'menu:settings', 'menu:undo', 'menu:redo', 'menu:pdf-to-word', 'menu:pdf-to-data'].includes(channel)) return () => {};
    const listener = () => handler();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
