const { BrowserWindow, WebContentsView, screen } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TAB_BAR_HEIGHT = 42;

// Documents own their renderer and controller. Windows only own the tab order.
// Reparenting the live view preserves edits, history, selections and scroll.
function createWorkspaces({ createController, trusted, sameFile, onEmpty, installing }) {
  const windows = new Map(), documents = new Map(), requests = new Map(), writes = new Map();
  let lastWindow = null, drag = null, quitting = false, closingAll = false, savingAll = false, focusOrder = 0;
  const url = (shell = false) => `${process.env.ASTERPDF_DEV_URL || 'aster://app/index.html'}${shell ? '?workspace=1' : ''}`;
  const preferences = () => ({ preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true });
  const send = (contents, channel, data) => { if (!contents.isDestroyed()) contents.send(channel, data); };
  const state = (owner) => ({ activeId: owner.activeId, dragging: Boolean(drag), tabs: owner.tabs.map(tab => ({
    id: tab.id, name: tab.controller.currentPath ? path.basename(tab.controller.currentPath) : tab.pendingPath ? path.basename(tab.pendingPath) : 'Home',
    path: tab.controller.currentPath || tab.pendingPath || '', dirty: tab.controller.dirty,
    busy: tab.controller.saving || tab.controller.writing || Boolean(tab.pendingPath), crashed: Boolean(tab.crashed)
  })) });
  function publish(owner) {
    if (!owner || owner.window.isDestroyed()) return;
    send(owner.window.webContents, 'workspace:changed', state(owner));
    const active = owner.tabs.find(tab => tab.id === owner.activeId);
    owner.window.setTitle(`${active?.controller.currentPath ? path.basename(active.controller.currentPath) + ' — ' : ''}AsterPDF`);
    owner.window.setDocumentEdited(owner.tabs.some(tab => tab.controller.dirty));
  }
  function layout(owner) {
    if (owner.window.isDestroyed()) return;
    const [width, height] = owner.window.getContentSize();
    for (const tab of owner.tabs) {
      const top = owner.presentation ? 0 : TAB_BAR_HEIGHT;
      tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
      tab.view.setVisible(tab.id === owner.activeId);
    }
  }
  function endPresentation(owner, restore = true) {
    const previous = owner.presentation;
    if (!previous) return;
    owner.presentation = null;
    if (!owner.window.isDestroyed()) {
      if (restore) {
        if (!previous.fullscreen) owner.restorePresentationMenu = previous.menuVisible;
        owner.window.setFullScreen(previous.fullscreen);
      }
      owner.window.setMenuBarVisibility(previous.menuVisible);
      layout(owner);
    }
    send(previous.tab.contents, 'presentation:changed', false);
  }
  function setPresentation(tab, enabled) {
    const owner = tab.owner;
    if (!enabled) { if (owner.presentation?.tab === tab) endPresentation(owner); return false; }
    if (owner.activeId !== tab.id || !tab.controller.currentPath || tab.crashed) throw new Error('Open a PDF in the active tab to present it.');
    if (owner.presentation?.tab === tab) return true;
    endPresentation(owner);
    owner.presentation = { tab, fullscreen: owner.window.isFullScreen(), menuVisible: owner.window.isMenuBarVisible() };
    owner.window.setMenuBarVisibility(false);
    owner.window.setFullScreen(true);
    layout(owner); tab.contents.focus();
    return true;
  }
  function activate(tab, focus = true) {
    const owner = tab.owner;
    if (owner.window.isDestroyed() || tab.contents.isDestroyed()) return;
    if (owner.presentation && owner.presentation.tab !== tab) endPresentation(owner);
    owner.activeId = tab.id;
    layout(owner); publish(owner);
    if (focus) {
      if (owner.window.isMinimized()) owner.window.restore();
      owner.window.show(); owner.window.focus(); tab.contents.focus();
    }
  }
  function dispose(tab) {
    if (tab.owner.presentation?.tab === tab) endPresentation(tab.owner);
    for (const [id, request] of requests) if (request.tab === tab) { requests.delete(id); clearTimeout(request.timer); request.resolve(false); }
    documents.delete(tab.contentsId); tab.controller.dispose();
    if (!tab.contents.isDestroyed()) tab.contents.close();
  }
  function remove(tab) {
    const owner = tab.owner, index = owner.tabs.indexOf(tab);
    owner.window.contentView.removeChildView(tab.view);
    owner.tabs.splice(index, 1); dispose(tab);
    if (!owner.tabs.length) { owner.approved = true; owner.window.close(); return; }
    if (owner.activeId === tab.id) activate(owner.tabs[Math.min(index, owner.tabs.length - 1)]);
    else publish(owner);
  }
  async function prepare(tab, mode = 'close') {
    if (tab.owner.presentation?.tab === tab) endPresentation(tab.owner);
    if (tab.crashed) return !tab.controller.dirty && !tab.controller.saving && !tab.controller.writing;
    if (!tab.ready || tab.pendingPath || tab.controller.writing) return false;
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { requests.delete(id); resolve(false); }, mode === 'save' ? 600000 : 30000);
      requests.set(id, { tab, resolve, timer });
      send(tab.contents, 'workspace:prepare', { id, mode });
    });
  }
  async function approve(tabs) {
    for (const tab of tabs) {
      activate(tab);
      if (!(await prepare(tab)) || !(await tab.controller.confirmDiscard())) return false;
    }
    return true;
  }
  async function closeTab(tab) {
    if (tab.owner.closing || closingAll || savingAll || installing()) return;
    const owner = tab.owner; owner.closing = true;
    try { if (await approve([tab])) remove(tab); }
    finally { owner.closing = false; }
  }
  async function closeWindow(owner) {
    if (owner.closing || closingAll || savingAll) return;
    owner.closing = true;
    try { if (await approve([...owner.tabs])) { owner.approved = true; owner.window.close(); } }
    finally { owner.closing = false; }
  }
  function newTab(owner, filePath) {
    const view = new WebContentsView({ webPreferences: preferences() });
    const tab = { id: randomUUID(), view, contents: view.webContents, contentsId: view.webContents.id, owner, pendingPath: filePath || null, ready: false, controller: null };
    tab.controller = createController(tab);
    owner.tabs.push(tab); documents.set(view.webContents.id, tab);
    owner.window.contentView.addChildView(view);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('render-process-gone', () => { if (tab.owner.presentation?.tab === tab) endPresentation(tab.owner); tab.crashed = true; tab.ready = false; publish(tab.owner); });
    view.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace && tab.owner.presentation?.tab === tab) endPresentation(tab.owner); });
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (tab.owner.presentation?.tab === tab) {
        if (input.key === 'Escape') { event.preventDefault(); endPresentation(tab.owner); }
        else if ((input.control || input.meta) && input.key.toLowerCase() !== 'q') event.preventDefault();
        return;
      }
      if (drag && input.key === 'Escape') { event.preventDefault(); cancelDrag(); return; }
      const modifier = process.platform === 'darwin' ? input.meta : input.control;
      if (!modifier || input.alt) return;
      const key = input.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); send(view.webContents, input.shift ? 'menu:redo' : 'menu:undo'); }
      if (input.control && key === 'tab') { event.preventDefault(); cycle(tab.owner, input.shift ? -1 : 1); }
    });
    void view.webContents.loadURL(url());
    activate(tab);
    if (filePath) tab.controller.queue.enqueue(filePath);
    return tab;
  }
  function createWindow({ empty = false, point } = {}) {
    const window = new BrowserWindow({ width: 1420, height: 942, minWidth: 940, minHeight: 662, show: false,
      title: 'AsterPDF', backgroundColor: '#f5f6f3', icon: path.join(__dirname, '..', 'assets', 'icon.png'), webPreferences: preferences() });
    const owner = { window, contents: window.webContents, id: window.webContents.id, order: ++focusOrder, tabs: [], activeId: null, approved: false, closing: false };
    windows.set(window.webContents.id, owner); lastWindow = owner;
    if (point) {
      const area = screen.getDisplayNearestPoint(point).workArea;
      const width = Math.min(1420, area.width), height = Math.min(942, area.height);
      window.setBounds({ x: Math.max(area.x, Math.min(point.x - 140, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(point.y - 40, area.y + area.height - height)), width, height });
    }
    window.on('focus', () => { lastWindow = owner; owner.order = ++focusOrder; });
    window.on('resize', () => layout(owner));
    window.on('leave-full-screen', () => {
      endPresentation(owner, false);
      if (owner.restorePresentationMenu !== undefined) {
        window.setMenuBarVisibility(owner.restorePresentationMenu);
        delete owner.restorePresentationMenu;
      }
    });
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
      if (owner.approved || quitting) return;
      event.preventDefault(); void closeWindow(owner);
    });
    window.on('closed', () => {
      windows.delete(owner.id);
      if (drag?.tab.owner === owner) cancelDrag();
      for (const tab of [...owner.tabs]) dispose(tab);
      if (lastWindow === owner) lastWindow = [...windows.values()].at(-1) || null;
      onEmpty?.();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    void window.loadURL(url(true));
    if (!empty) newTab(owner);
    return owner;
  }
  function currentOwner() {
    const focused = BrowserWindow.getFocusedWindow();
    return [...windows.values()].find(owner => owner.window === focused) || lastWindow;
  }
  function cycle(owner, step) {
    if (!owner?.tabs.length) return;
    const index = owner.tabs.findIndex(tab => tab.id === owner.activeId);
    activate(owner.tabs[(index + step + owner.tabs.length) % owner.tabs.length]);
  }
  async function findFile(filePath, exclude) {
    for (const tab of documents.values()) {
      const existing = tab.controller.currentPath || tab.pendingPath;
      if (tab !== exclude && existing && await sameFile(existing, filePath)) return tab;
    }
    return null;
  }
  // Serialize routing so two simultaneous OS requests cannot open competing copies.
  let opening = Promise.resolve();
  function openFile(filePath, preferred, caller) {
    const result = opening.then(async () => {
      if (installing() || closingAll || savingAll) return null;
      for (const target of writes.values()) if (await sameFile(filePath, target)) throw new Error('This file is being saved. Please try opening it again in a moment.');
      const existing = await findFile(filePath, caller);
      if (existing) { activate(existing); return null; }
      if (caller?.controller.currentPath && await sameFile(caller.controller.currentPath, filePath)) { activate(caller); return null; }
      const owner = preferred && !preferred.window.isDestroyed() ? preferred : currentOwner() || createWindow();
      const blank = caller && !caller.controller.currentPath ? caller : owner.tabs.find(tab => !tab.controller.currentPath && !tab.pendingPath);
      if (caller && blank === caller) {
        caller.pendingPath = filePath; publish(owner);
        try { return await caller.controller.readFile(filePath); }
        finally { caller.pendingPath = null; publish(caller.owner); }
      }
      if (blank) { blank.pendingPath = filePath; blank.controller.queue.enqueue(filePath); activate(blank); }
      else newTab(owner, filePath);
      return null;
    });
    opening = result.catch(() => {}); return result;
  }
  function move(tab, target, index = target.tabs.length) {
    const source = tab.owner;
    if (source.closing || target.closing || closingAll || savingAll || installing() || requests.size) return;
    if (source.presentation?.tab === tab) endPresentation(source);
    const old = source.tabs.indexOf(tab);
    source.tabs.splice(old, 1);
    if (source === target && old < index) index--;
    if (source !== target) { source.window.contentView.removeChildView(tab.view); target.window.contentView.addChildView(tab.view); tab.owner = target; }
    target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, tab);
    if (source !== target) {
      if (!source.tabs.length) { source.approved = true; source.window.close(); }
      else if (source.activeId === tab.id) activate(source.tabs[Math.min(old, source.tabs.length - 1)], false);
      else publish(source);
    }
    activate(tab);
  }
  function cancelDrag() {
    drag = null;
    for (const owner of windows.values()) {
      if (owner.window.isDestroyed()) continue;
      send(owner.contents, 'workspace:drop-hint', null); publish(owner);
    }
  }
  function endDrag(owner, cancelled) {
    if (!drag || drag.tab.owner !== owner) return;
    const tab = drag.tab, point = screen.getCursorScreenPoint(), hint = drag.hint;
    cancelDrag();
    if (cancelled || requests.size || owner.closing || closingAll || savingAll || installing()) return;
    // A receiving strip reports an exact insertion index, including scrolled tabs.
    const target = [...windows.values()].sort((a, b) => b.order - a.order).find(candidate => {
      if (candidate.window.isDestroyed()) return false;
      const b = candidate.window.getBounds();
      return candidate.window.isVisible() && !candidate.window.isMinimized() && point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
    });
    const bounds = target?.window.getContentBounds();
    const inStrip = bounds && point.y >= bounds.y && point.y < bounds.y + TAB_BAR_HEIGHT;
    if (target && (target !== owner || inStrip)) move(tab, target, inStrip && hint?.owner === target ? hint.index : target.tabs.length);
    else {
      const b = owner.window.getContentBounds();
      // Dropping back inside the document cancels; dropping out detaches.
      if (point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) return;
      move(tab, createWindow({ empty: true, point }));
    }
  }
  const api = {
    createWindow, newTab, activate, publish, openFile, closeTab, setPresentation,
    get documents() { return [...documents.values()]; },
    documentFor: contents => documents.get(contents.id),
    ownerFor: contents => windows.get(contents.id) || documents.get(contents.id)?.owner,
    currentOwner,
    sendMenu(channel) { const owner = currentOwner(), tab = owner?.tabs.find(t => t.id === owner.activeId); if (tab) { endPresentation(owner); send(tab.contents, channel); } },
    newDocumentWindow() { if (!installing() && !closingAll && !savingAll) createWindow(); },
    newDocumentTab() { if (!installing() && !closingAll && !savingAll) newTab(currentOwner() || createWindow({ empty: true })); },
    closeActive() { const owner = currentOwner(), tab = owner?.tabs.find(t => t.id === owner.activeId); if (tab) void closeTab(tab); },
    cycleActive(step) { cycle(currentOwner(), step); },
    async writeFile(tab, target, work) {
      const key = path.resolve(target), token = randomUUID(); writes.set(token, key);
      try {
        if (await findFile(target, tab)) throw new Error('This file is open in another tab. Choose a different filename.');
        for (const [other, value] of writes) if (other !== token && await sameFile(value, target)) throw new Error('Another tab is saving this file. Please try again.');
        return await work();
      } finally { writes.delete(token); }
    },
    async saveAll() {
      if (savingAll || closingAll) throw new Error('Please wait for the other window to finish.');
      savingAll = true;
      const initial = currentOwner(), active = initial?.tabs.find(t => t.id === initial.activeId);
      try {
      for (const tab of documents.values()) {
        activate(tab);
        if (!(await prepare(tab, 'save')) || tab.controller.dirty || tab.controller.saving || tab.controller.writing) {
          throw new Error('All tabs must finish saving before installing. Check this document and try again.');
        }
      }
      if ([...documents.values()].some(tab => tab.controller.dirty || tab.controller.saving || tab.controller.writing)) {
        throw new Error('A document changed while saving. Save it before installing the update.');
      }
      if (active) activate(active);
      } finally { savingAll = false; }
    },
    async quit() {
      if (closingAll || savingAll) return false;
      closingAll = true;
      try {
        if (!(await approve([...documents.values()]))) return false;
        quitting = true; return true;
      } finally { closingAll = false; }
    },
    get quitting() { return quitting; },
    register(ipcMain) {
      ipcMain.handle('workspace:state', event => { if (!trusted(event)) throw new Error('Untrusted window'); const owner = windows.get(event.sender.id); if (!owner) throw new Error('Not a workspace'); return state(owner); });
      ipcMain.on('workspace:prepared', (event, id, ok) => {
        if (!trusted(event)) return;
        const request = requests.get(id);
        if (!request || request.tab.contents !== event.sender) return;
        requests.delete(id); clearTimeout(request.timer); request.resolve(ok === true);
      });
      ipcMain.on('workspace:action', (event, action, id, value) => {
        if (!trusted(event) || installing() || closingAll || savingAll) return;
        const owner = windows.get(event.sender.id);
        if (!owner || owner.closing) return;
        const tab = owner.tabs.find(t => t.id === id);
        if (action === 'new-tab') newTab(owner);
        else if (action === 'new-window') createWindow();
        else if (action === 'select' && tab) activate(tab);
        else if (action === 'close' && tab) void closeTab(tab);
        else if (action === 'detach' && tab && !requests.size) move(tab, createWindow({ empty: true }));
        else if (action === 'drag-start' && tab) { drag = { tab, hint: null }; for (const entry of windows.values()) publish(entry); }
        else if (action === 'drag-move' && drag?.tab.owner === owner) {
          const point = screen.getCursorScreenPoint();
          for (const entry of windows.values()) {
            if (entry.window.isDestroyed()) continue;
            const bounds = entry.window.getContentBounds(); send(entry.contents, 'workspace:drop-hint', { x: point.x - bounds.x, y: point.y - bounds.y });
          }
        } else if (action === 'drop-index' && drag && Number.isInteger(value) && value >= 0 && value <= owner.tabs.length) drag.hint = { owner, index: value };
        else if (action === 'drag-end') endDrag(owner, value === true);
      });
    }
  };
  return api;
}

module.exports = { createWorkspaces, TAB_BAR_HEIGHT };
