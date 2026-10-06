const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRecentStore } = require('./recent.cjs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'aster', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let mainWindow;
let currentPath = null;
let dirty = false;
let writing = false;
let saving = false;
let recentStore;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

function appOrigin(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents &&
    (event.senderFrame?.url.startsWith('aster://app/') ||
      (process.env.ASTERPDF_DEV_URL && event.senderFrame?.url.startsWith('http://127.0.0.1:5173/'))));
}

function requireApp(event) {
  if (!appOrigin(event)) throw new Error('Untrusted window');
}

function confirmDiscard() {
  if (saving || writing) {
    dialog.showMessageBoxSync(mainWindow, { type: 'info', message: 'AsterPDF is saving the PDF.', detail: 'Please wait for the save to finish.' });
    return false;
  }
  if (!dirty) return true;
  return dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Keep editing', 'Discard changes'],
    defaultId: 0,
    cancelId: 0,
    message: 'Discard unsaved comments?',
    detail: 'Save your PDF before opening another file or closing AsterPDF.'
  }) === 1;
}

async function readPdf(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new Error('This file is too large or is not a regular file.');
  const bytes = await fs.readFile(filePath);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('This is not a PDF file.');
  currentPath = filePath;
  dirty = false;
  await recentStore.record(filePath, stats.mtimeMs).catch(() => {});
  return { name: path.basename(filePath), path: filePath, bytes: new Uint8Array(bytes) };
}

async function selectPdf() {
  if (!confirmDiscard()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF files', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readPdf(result.filePaths[0]);
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

async function savePdf(rawBytes, saveAs, expectedPath) {
  if (writing) throw new Error('A PDF save is already in progress.');
  if (typeof expectedPath !== 'string' || currentPath !== expectedPath) throw new Error('The open PDF changed before saving.');
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength < 8 || rawBytes.byteLength > MAX_FILE_BYTES) {
    throw new Error('Invalid PDF data.');
  }
  const bytes = Buffer.from(rawBytes);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF data.');
  let target = currentPath;
  if (saveAs || !target) {
    const suggested = currentPath
      ? path.join(path.dirname(currentPath), `${path.parse(currentPath).name}-commented.pdf`)
      : 'AsterPDF-commented.pdf';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save PDF',
      defaultPath: suggested,
      filters: [{ name: 'PDF files', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
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

function createWindow() {
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
  mainWindow.on('close', (event) => { if (!confirmDiscard()) event.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.ASTERPDF_DEV_URL) mainWindow.loadURL(process.env.ASTERPDF_DEV_URL);
  else mainWindow.loadURL('aster://app/index.html');

  const send = (channel) => mainWindow.webContents.send(channel);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File', submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:save-as') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { label: 'Settings', submenu: [{ label: 'Comment author…', click: () => send('menu:settings') }] }
  ]));
}

app.whenReady().then(() => {
  recentStore = createRecentStore(app.getPath('userData'));
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
  ipcMain.handle('pdf:open-dialog', (event) => { requireApp(event); return selectPdf(); });
  ipcMain.handle('pdf:open-path', (event, filePath) => {
    requireApp(event);
    if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.pdf')) throw new Error('Select a PDF file.');
    if (!confirmDiscard()) return null;
    return readPdf(filePath);
  });
  ipcMain.handle('pdf:save', (event, bytes, saveAs, expectedPath) => { requireApp(event); return savePdf(bytes, Boolean(saveAs), expectedPath); });
  ipcMain.handle('recent:list', (event) => { requireApp(event); return recentStore.list(); });
  ipcMain.handle('recent:set-preview', (event, filePath, preview) => {
    requireApp(event);
    if (typeof filePath !== 'string' || filePath !== currentPath) return;
    return recentStore.setPreview(filePath, preview);
  });
  ipcMain.handle('settings:get', (event) => { requireApp(event); return loadSettings(); });
  ipcMain.handle('settings:set', (event, name) => { requireApp(event); return storeSettings(name); });
  ipcMain.on('pdf:set-dirty', (event, value) => { if (appOrigin(event)) dirty = value === true; });
  ipcMain.on('pdf:set-saving', (event, value) => { if (appOrigin(event)) saving = value === true; });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
