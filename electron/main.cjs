const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, powerMonitor } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRecentStore } = require('./recent.cjs');
const { listOriginalText, replaceOriginalText, moveOriginalText, embedShapedOverlays } = require('./original-text.cjs');
const { listInstalledFonts, getInstalledFont } = require('./installed-fonts.cjs');
const { createUpdateService, updateArchitecture } = require('./updates.cjs');
const { createUpdateInstaller } = require('./update-installer.cjs');
const { pdfPathsFromArguments, createFileOpenQueue } = require('./file-open.cjs');
const { createWordExport } = require('./word-export.cjs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'aster', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let mainWindow;
let currentPath = null;
let dirty = false;
let writing = false;
let saving = false;
let preparedCompressedSave = null;
const wordExport = createWordExport({ dialog, getWindow: () => mainWindow, getCurrentPath: () => currentPath,
  sameFile, validatePdfBytes, listInstalledFonts });
const dataExport = createWordExport({ dialog, getWindow: () => mainWindow, getCurrentPath: () => currentPath,
  sameFile, validatePdfBytes, listInstalledFonts, mode: 'data' });
app.on('will-quit', () => { wordExport.dispose(); dataExport.dispose(); });
let recentStore;
let updateService;
let updateInstaller;
const updateState = () => ({ ...updateService.getState(), transfer: updateInstaller.getState() });
const publishUpdate = () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:changed', updateState());
};
let discardPrompt = null;
let closeApproved = false;
let closePromptRunning = false;
let quitRequested = false;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const SUPPORTED = new Set(['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp']);

const fileOpenQueue = createFileOpenQueue({ send: (request) => mainWindow.webContents.send('pdf:external-open', request) });
function focusDocumentWindow() {
  if (!app.isReady() || !recentStore) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function enqueueExternalPdf(filePath) {
  if (updateInstaller?.getState().phase === 'installing') return;
  // Create a replacement window before enqueueing, if the Mac app has no window.
  focusDocumentWindow();
  fileOpenQueue.enqueue(filePath);
}
// Finder can send open-file before app.ready, including the first launch.
app.on('open-file', (event, filePath) => { event.preventDefault(); enqueueExternalPdf(filePath); });
const launchFiles = pdfPathsFromArguments(process.argv, { packaged: app.isPackaged, cwd: process.cwd() });
const primaryInstance = app.requestSingleInstanceLock({ pdfPaths: launchFiles });
if (!primaryInstance) app.quit();
else {
  launchFiles.forEach((filePath) => fileOpenQueue.enqueue(filePath));
  app.on('second-instance', (_event, argv, cwd, data) => {
    const files = Array.isArray(data?.pdfPaths) ? data.pdfPaths : pdfPathsFromArguments(argv, { packaged: app.isPackaged, cwd });
    focusDocumentWindow();
    files.forEach(enqueueExternalPdf);
  });
}

function appOrigin(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents &&
    (event.senderFrame?.url.startsWith('aster://app/') ||
      (process.env.ASTERPDF_DEV_URL && event.senderFrame?.url.startsWith('http://127.0.0.1:5173/'))));
}

function requireApp(event) {
  if (!appOrigin(event)) throw new Error('Untrusted window');
  if (updateInstaller?.getState().phase === 'installing') throw new Error('AsterPDF is restarting to install the update.');
}

function confirmDiscard() {
  if (saving || writing) {
    dialog.showMessageBoxSync(mainWindow, { type: 'info', message: 'AsterPDF is saving the PDF.', detail: 'Please wait for the save to finish.' });
    return Promise.resolve(false);
  }
  if (!dirty) return Promise.resolve(true);
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  if (discardPrompt) return discardPrompt.promise;
  const id = randomUUID();
  let resolvePrompt;
  const promise = new Promise((resolve) => { resolvePrompt = resolve; });
  discardPrompt = { id, promise, resolve: resolvePrompt };
  mainWindow.webContents.send('pdf:confirm-discard', id);
  return promise;
}

async function readFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.has(extension)) throw new Error('Open a PDF, DOCX, PNG, JPEG, or WebP file.');
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new Error('This file is too large or is not a regular file.');
  const bytes = await fs.readFile(filePath);
  if (extension === '.pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('This is not a PDF file.');
  if (extension === '.docx' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('This is not a DOCX file.');
  currentPath = filePath;
  dirty = false;
  if (extension === '.pdf') await recentStore.record(filePath, stats.mtimeMs).catch(() => {});
  return { name: path.basename(filePath), path: filePath, bytes: new Uint8Array(bytes), kind: extension.slice(1) };
}

async function selectFiles(append = false) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: append ? 'Add files to PDF' : 'Open a file',
    properties: append ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'PDF, Word and image files', extensions: ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  if (!append && (!(await confirmDiscard()) || closePromptRunning)) return null;
  if (append) {
    const files = [];
    for (const filePath of result.filePaths) {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new Error('A selected file is too large.');
      const extension = path.extname(filePath).toLowerCase();
      if (!SUPPORTED.has(extension)) throw new Error('A selected file type is unsupported.');
      files.push({ path: filePath, name: path.basename(filePath), kind: extension.slice(1), bytes: new Uint8Array(await fs.readFile(filePath)) });
    }
    return files;
  }
  return readFile(result.filePaths[0]);
}

async function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    const value = JSON.parse(await fs.readFile(await settingsFile(), 'utf8'));
    return { authorName: typeof value.authorName === 'string' ? value.authorName.slice(0, 80) : '' };
  } catch {
    return { authorName: '' };
  }
}

async function storeSettings(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    throw new Error('Enter a name of 1 to 80 characters.');
  }
  const authorName = name.trim();
  const file = await settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ authorName }, null, 2), { mode: 0o600 });
  return { authorName };
}

function validatePdfBytes(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength < 8 || rawBytes.byteLength > MAX_FILE_BYTES) {
    throw new Error('Invalid PDF data.');
  }
  const bytes = Buffer.from(rawBytes);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF data.');
  return bytes;
}

async function sameFile(first, second) {
  const resolvedFirst = path.resolve(first);
  const resolvedSecond = path.resolve(second);
  if ((process.platform === 'win32' ? resolvedFirst.toLowerCase() : resolvedFirst) ===
      (process.platform === 'win32' ? resolvedSecond.toLowerCase() : resolvedSecond)) return true;
  try {
    const [firstStat, secondStat] = await Promise.all([fs.stat(first), fs.stat(second)]);
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
  } catch { return false; }
}

async function writePdfBytes(rawBytes, target) {
  if (writing) throw new Error('A PDF save is already in progress.');
  const bytes = validatePdfBytes(rawBytes);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  writing = true;
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    writing = false;
  }
  currentPath = target;
  await fs.stat(target).then((stats) => recentStore.record(target, stats.mtimeMs)).catch(() => {});
  return { path: target, name: path.basename(target) };
}

async function savePdf(rawBytes, saveAs, expectedPath) {
  if (typeof expectedPath !== 'string' || currentPath !== expectedPath) throw new Error('The open PDF changed before saving.');
  validatePdfBytes(rawBytes);
  let target = currentPath;
  if (saveAs || !target || path.extname(target).toLowerCase() !== '.pdf') {
    const suggested = currentPath
      ? path.join(path.dirname(currentPath), `${path.parse(currentPath).name}${path.extname(currentPath).toLowerCase() === '.pdf' ? '-copy' : ''}.pdf`)
      : 'AsterPDF.pdf';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save PDF',
      defaultPath: suggested,
      filters: [{ name: 'PDF files', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return null;
    target = path.extname(result.filePath) ? result.filePath : `${result.filePath}.pdf`;
    if (path.extname(target).toLowerCase() !== '.pdf') throw new Error('Choose a .pdf filename.');
    if (currentPath && await sameFile(target, currentPath)) throw new Error('Save As needs a different filename to keep the original.');
  }
  return writePdfBytes(rawBytes, target);
}

async function prepareCompressedSave(expectedPath) {
  if (writing || preparedCompressedSave) throw new Error('A PDF save is already in progress.');
  if (typeof expectedPath !== 'string' || currentPath !== expectedPath) throw new Error('The open PDF changed before saving.');
  const suggested = currentPath
    ? path.join(path.dirname(currentPath), `${path.parse(currentPath).name}-compressed.pdf`)
    : 'AsterPDF-compressed.pdf';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save compressed PDF', defaultPath: suggested,
    filters: [{ name: 'PDF files', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return null;
  const target = path.extname(result.filePath) ? result.filePath : `${result.filePath}.pdf`;
  if (path.extname(target).toLowerCase() !== '.pdf') throw new Error('Choose a .pdf filename.');
  if (await sameFile(target, currentPath)) throw new Error('Choose a different filename to keep the original.');
  preparedCompressedSave = { token: randomUUID(), target, expectedPath };
  return { token: preparedCompressedSave.token, path: target };
}

async function finishCompressedSave(rawBytes, token, expectedPath) {
  const prepared = preparedCompressedSave;
  if (!prepared || token !== prepared.token || expectedPath !== prepared.expectedPath || currentPath !== expectedPath) {
    throw new Error('The compressed save location is no longer valid.');
  }
  preparedCompressedSave = null;
  return writePdfBytes(rawBytes, prepared.target);
}

function createWindow() {
  fileOpenQueue.reset();
  currentPath = null;
  dirty = false;
  preparedCompressedSave = null;
  closeApproved = false;
  closePromptRunning = false;
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'AsterPDF',
    backgroundColor: '#f5f6f3',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (closeApproved || (!dirty && !saving && !writing)) return;
    event.preventDefault();
    if (closePromptRunning) return;
    closePromptRunning = true;
    void confirmDiscard().then((discard) => {
      closePromptRunning = false;
      if (!discard || !mainWindow || mainWindow.isDestroyed()) { quitRequested = false; return; }
      closeApproved = true;
      if (quitRequested) app.quit();
      else mainWindow.close();
    }).catch(() => { closePromptRunning = false; quitRequested = false; });
  });
  mainWindow.on('closed', () => {
    fileOpenQueue.reset();
    if (discardPrompt) { discardPrompt.resolve(false); discardPrompt = null; }
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) fileOpenQueue.reset();
  });
  mainWindow.webContents.on('render-process-gone', () => fileOpenQueue.reset());
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.ASTERPDF_DEV_URL) mainWindow.loadURL(process.env.ASTERPDF_DEV_URL);
  else mainWindow.loadURL('aster://app/index.html');

  const send = (channel) => mainWindow.webContents.send(channel);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (input.type !== 'keyDown' || !modifier || input.alt || (input.key.toLowerCase() !== 'z' && input.code !== 'KeyZ')) return;
    // Route once before Chromium/native menu handling, including when focus is
    // inside the PDF canvas. The renderer keeps text-field undo local.
    event.preventDefault();
    send(input.shift ? 'menu:redo' : 'menu:undo');
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File', submenu: [
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:save-as') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('menu:redo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { label: 'Tools', submenu: [
      { label: 'PDF to Word', click: () => send('menu:pdf-to-word') },
      { label: 'PDF to Data', click: () => send('menu:pdf-to-data') }
    ] },
    { label: 'Settings', submenu: [{ label: 'Settings…', click: () => send('menu:settings') }] },
    { label: 'About', ...(process.platform === 'darwin'
      ? { submenu: [{ label: 'About AsterPDF', click: () => send('menu:about') }] }
      : { click: () => send('menu:about') }) }
  ]));
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  recentStore = createRecentStore(app.getPath('userData'));
  updateInstaller = createUpdateInstaller({ updater: require('electron-updater').autoUpdater,
    isPackaged: app.isPackaged, onChange: publishUpdate });
  updateService = createUpdateService({ userDataPath: app.getPath('userData'), currentVersion: app.getVersion(),
    arch: updateArchitecture(process.platform, process.arch, app.runningUnderARM64Translation),
    openExternal: (url) => shell.openExternal(url),
    onChange: publishUpdate });
  const dist = path.join(__dirname, '..', 'dist');
  protocol.handle('aster', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const resolved = path.resolve(dist, relative || 'index.html');
      if (!resolved.startsWith(dist + path.sep)) return new Response('Not found', { status: 404 });
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(resolved)] || 'application/octet-stream';
      return new Response(new Uint8Array(await fs.readFile(resolved)), { headers: { 'content-type': mime } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('aster://app/') ||
      (process.env.ASTERPDF_DEV_URL && details.url.startsWith('http://127.0.0.1:5173/')) ||
      details.url.startsWith('blob:') || details.url.startsWith('data:');
    callback({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ipcMain.on('pdf:confirm-discard-result', (event, id, discard) => {
    if (!appOrigin(event) || !discardPrompt || discardPrompt.id !== id) return;
    const prompt = discardPrompt;
    discardPrompt = null;
    prompt.resolve(discard === true);
  });
  ipcMain.handle('pdf:open-dialog', (event) => { requireApp(event); return selectFiles(); });
  ipcMain.handle('pdf:open-link', async (event, address) => {
    requireApp(event);
    if (typeof address !== 'string' || address.length > 4096 || /[\u0000-\u001f\u007f]/.test(address)) throw new Error('Invalid link.');
    const url = new URL(address);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported link type.');
    await shell.openExternal(url.href);
  });
  ipcMain.on('pdf:external-ready', (event, ready) => { if (appOrigin(event)) fileOpenQueue.setReady(ready === true); });
  ipcMain.on('pdf:external-complete', (event, id) => { if (appOrigin(event)) fileOpenQueue.complete(id); });
  ipcMain.handle('pdf:add-dialog', (event) => { requireApp(event); return selectFiles(true); });
  ipcMain.handle('pdf:open-path', async (event, filePath) => {
    requireApp(event);
    if (typeof filePath !== 'string' || !SUPPORTED.has(path.extname(filePath).toLowerCase())) throw new Error('Select a PDF, DOCX, or image file.');
    if (!(await confirmDiscard()) || closePromptRunning) return null;
    return readFile(filePath);
  });
  ipcMain.handle('pdf:save', (event, bytes, saveAs, expectedPath) => { requireApp(event); return savePdf(bytes, Boolean(saveAs), expectedPath); });
  ipcMain.handle('word:prepare-export', (event, expectedPath) => { requireApp(event); return wordExport.prepare(expectedPath); });
  ipcMain.handle('word:convert', (event, bytes, token, expectedPath) => {
    requireApp(event);
    return wordExport.convert(bytes, token, expectedPath, message => {
      if (!event.sender.isDestroyed()) event.sender.send('word:progress', { token, message });
    });
  });
  ipcMain.handle('word:discard-export', (event, token) => { requireApp(event); wordExport.discard(token); });
  ipcMain.handle('data:prepare-export', (event, expectedPath) => { requireApp(event); return dataExport.prepare(expectedPath); });
  ipcMain.handle('data:convert', (event, bytes, token, expectedPath) => {
    requireApp(event);
    return dataExport.convert(bytes, token, expectedPath, message => {
      if (!event.sender.isDestroyed()) event.sender.send('data:progress', { token, message });
    });
  });
  ipcMain.handle('data:discard-export', (event, token) => { requireApp(event); dataExport.discard(token); });
  ipcMain.handle('pdf:close-document', async (event, expectedPath) => {
    requireApp(event);
    if (typeof expectedPath !== 'string' || currentPath !== expectedPath) return false;
    if (!(await confirmDiscard()) || closePromptRunning || saving || writing || currentPath !== expectedPath) return false;
    currentPath = null;
    dirty = false;
    preparedCompressedSave = null;
    return true;
  });
  ipcMain.handle('pdf:list-original-text', (event, bytes, pageIndex) => {
    requireApp(event); return listOriginalText(bytes, pageIndex);
  });
  ipcMain.handle('fonts:list-installed', async (event) => {
    requireApp(event);
    return (await listInstalledFonts()).map(({ id, family, style, postscriptName }) => ({ id, family, style, postscriptName }));
  });
  ipcMain.handle('fonts:read-installed', async (event, id, text) => {
    requireApp(event);
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id) || typeof text !== 'string' || text.length > 1000000)
      throw new Error('Invalid installed font request.');
    return (await getInstalledFont(id, text)).bytes;
  });
ipcMain.handle('pdf:replace-original-text', (event, bytes, pageIndex, objectIndex, expectedText, replacement, fontChoice, color) => {
  requireApp(event); return replaceOriginalText(bytes, pageIndex, objectIndex, expectedText, replacement, fontChoice, color);
  });
ipcMain.handle('pdf:move-original-text', (event, bytes, pageIndex, objectIndex, expectedText, dx, dy) => {
  requireApp(event); return moveOriginalText(bytes, pageIndex, objectIndex, expectedText, dx, dy);
});
ipcMain.handle('pdf:embed-shaped-text', (event, bytes, placements) => {
  requireApp(event); return embedShapedOverlays(bytes, placements);
});
  ipcMain.handle('pdf:prepare-compressed-save', (event, expectedPath) => { requireApp(event); return prepareCompressedSave(expectedPath); });
  ipcMain.handle('pdf:finish-compressed-save', (event, bytes, token, expectedPath) => {
    requireApp(event); return finishCompressedSave(bytes, token, expectedPath);
  });
  ipcMain.handle('pdf:discard-compressed-save', (event, token) => {
    requireApp(event);
    if (preparedCompressedSave?.token === token) preparedCompressedSave = null;
  });
  ipcMain.handle('docx:print', async (event) => {
    requireApp(event);
    const bytes = await mainWindow.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true, pageSize: 'A4',
      margins: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    return new Uint8Array(bytes);
  });
  ipcMain.handle('recent:list', (event) => { requireApp(event); return recentStore.list(); });
  ipcMain.handle('recent:set-preview', (event, filePath, preview) => {
    requireApp(event);
    if (typeof filePath !== 'string' || filePath !== currentPath) return;
    return recentStore.setPreview(filePath, preview);
  });
  ipcMain.handle('settings:get', (event) => { requireApp(event); return loadSettings(); });
  ipcMain.handle('settings:set', (event, name) => { requireApp(event); return storeSettings(name); });
  ipcMain.handle('updates:status', (event) => { requireApp(event); return updateState(); });
  ipcMain.handle('updates:check', async (event) => { requireApp(event); await updateService.check(true); return updateState(); });
  ipcMain.handle('updates:download', async (event) => {
    requireApp(event);
    const state = updateService.getState();
    if (!state.available) throw new Error('Check for updates first.');
    await updateInstaller.download(updateService.getDownloadTarget());
    return updateState();
  });
  ipcMain.handle('updates:install', (event) => {
    requireApp(event);
    // The renderer awaits a successful PDF save first. Refuse to exit if any
    // document work is still outstanding, even if this IPC is called directly.
    if (dirty || saving || writing || preparedCompressedSave || discardPrompt || closePromptRunning)
      throw new Error('Save your changes and wait for the save to finish before installing.');
    updateInstaller.install();
  });
  ipcMain.on('pdf:set-dirty', (event, value) => { if (appOrigin(event)) dirty = value === true; });
  ipcMain.on('pdf:set-saving', (event, value) => { if (appOrigin(event)) saving = value === true; });
  createWindow();
  void updateService.start();
  powerMonitor.on('resume', () => { void updateService.check(false); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitRequested = true; });
app.on('will-quit', () => { updateService?.stop(); });
