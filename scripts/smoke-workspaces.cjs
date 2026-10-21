const { _electron } = require('playwright');
const { createServer } = require('vite');
const { PDFDocument } = require('pdf-lib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const project = path.join(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-workspaces-'));
  const first = path.join(temp, 'First.pdf'), second = path.join(temp, 'Second.pdf');
  for (const file of [first, second]) {
    const pdf = await PDFDocument.create();
    pdf.addPage([500, 700]).drawText(path.basename(file), { x: 40, y: 600, size: 22 });
    await fs.writeFile(file, await pdf.save());
  }
  await fs.writeFile(path.join(temp, 'settings.json'), JSON.stringify({ authorName: 'Workspace test' }));
  const server = await createServer({ configFile: false, root: project, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const env = { ...process.env, ASTERPDF_DEV_URL: `http://127.0.0.1:${server.httpServer.address().port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [project, `--user-data-dir=${temp}`, first], env, timeout: 60000 });
    const processErrors = [];
    electron.process().stderr.on('data', data => { if (/Object has been destroyed|UnhandledPromiseRejection|Uncaught Exception/.test(String(data))) processErrors.push(String(data)); });
    for (const page of electron.context().pages()) page.on('pageerror', e => console.error('Renderer:', e.message));
    electron.context().on('page', page => page.on('pageerror', e => console.error('Renderer:', e.message)));
    await electron.firstWindow();
    let shell;
    for (let i=0;i<100;i++) { shell=electron.context().pages().find(p=>p.url().includes('workspace=1')); if(shell)break;await new Promise(r=>setTimeout(r,100)); }
    if(!shell)throw Error('Workspace shell missing'); shell.setDefaultTimeout(20000);
    await shell.getByRole('tab', { name: 'First.pdf' }).waitFor();
    const doc = await findDocument(electron, first);
    await doc.locator('dialog.save-feedback').waitFor({ state: 'hidden' });
    await doc.locator('.page-stage canvas').waitFor({ state: 'visible' });
    console.log('Initial document opened in a tab.');
    // Open another file through the same path used by Recents / drag and drop.
    await doc.evaluate(file => window.aster.openPath(file), second);
    await shell.getByRole('tab', { name: 'Second.pdf' }).waitFor();
    const other = await findDocument(electron, second);
    await other.locator('dialog.save-feedback').waitFor({ state: 'hidden' });
    assert.equal(await shell.getByRole('tab').count(), 2);
    await other.evaluate(file => window.aster.openPath(file), first);
    await shell.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'First.pdf');
    assert.equal(await shell.getByRole('tab').count(), 2);
    console.log('Open routes into new tabs; duplicates activate the existing tab.');
    // Save As must not overwrite a file owned by another live tab.
    await electron.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, second);
    const conflict = await doc.evaluate(async ({ bytes, first }) => {
      try { await window.aster.save(new Uint8Array(bytes), true, first); return ''; }
      catch (error) { return error.message; }
    }, { bytes: [...await fs.readFile(first)], first });
    assert.match(conflict, /open in another tab/);
    // Put an unsaved drawing into the first tab, then preserve the live DOM
    // and renderer identity through a detach and cross-window attachment.
    await doc.getByRole('button', { name: 'Draw', exact: true }).click();
    await doc.getByRole('button', { name: /rectangle/i }).first().click();
    await doc.locator('.page-stage').click({ position: { x: 160, y: 180 } });
    await shell.locator('.tab-dirty').waitFor();
    await doc.evaluate(() => { window.workspaceSentinel = { preserved: true }; });
    const firstId = await shell.evaluate(() => document.querySelector('[data-tab-id]')?.getAttribute('data-tab-id'));
    await shell.getByRole('tab', { name: /First.pdf/ }).hover();
    const newWindow = electron.waitForEvent('window');
    newWindow.catch(() => {});
    await shell.getByRole('button', { name: 'Move First.pdf to a new window' }).click();
    const detached = await newWindow; detached.setDefaultTimeout(20000);
    await detached.getByRole('tab', { name: /First.pdf/ }).waitFor();
    assert.equal(await doc.evaluate(() => window.workspaceSentinel.preserved), true);
    assert.equal(await detached.locator('.tab-dirty').count(), 1);
    assert.equal(await shell.getByRole('tab').count(), 1);
    // Drive a drag into the first window's strip, using a fixed OS cursor for
    // deterministic placement on CI (the renderer and reparenting are real).
    await electron.evaluate(({ BrowserWindow, screen }, id) => {
      const target = BrowserWindow.getAllWindows().find(w => w.webContents.id === id);
      const b = target.getContentBounds();
      for (const win of BrowserWindow.getAllWindows()) if (win !== target) win.setPosition(b.x + 320, b.y + 160);
      global.originalCursor = screen.getCursorScreenPoint;
      screen.getCursorScreenPoint = () => ({ x: b.x + 20, y: b.y + 20 });
    }, await (await electron.browserWindow(shell)).evaluate(win => win.webContents.id));
    await detached.evaluate(id => { window.aster.workspaceAction('drag-start', id); window.aster.workspaceAction('drag-move', id); }, firstId);
    await shell.waitForFunction(() => document.querySelector('.drop-before'));
    await detached.evaluate(id => window.aster.workspaceAction('drag-end', id), firstId);
    await shell.getByRole('tab', { name: /First.pdf/ }).waitFor();
    assert.equal(await doc.evaluate(() => window.workspaceSentinel.preserved), true);
    assert.equal(await shell.locator('.tab-dirty').count(), 1);
    assert.equal(await shell.getByRole('tab').count(), 2);
    await electron.evaluate(({ screen }) => { screen.getCursorScreenPoint = global.originalCursor; });
    await doc.keyboard.press('Control+z');
    await doc.getByText('Page 1 · 0', { exact: true }).waitFor();
    await doc.keyboard.press('Control+Shift+z');
    await doc.getByText('Page 1 · 1', { exact: true }).waitFor();
    console.log('Unsaved edits, undo/redo, and live renderer survive detach and cross-window attachment.');
    await shell.getByRole('button', { name: 'Close First.pdf', exact: true }).click();
    await doc.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).waitFor();
    await doc.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await shell.getByRole('tab').count(), 2);
    await doc.getByRole('button', { name: 'Save PDF', exact: true }).click();
    await shell.locator('.tab-dirty').waitFor({ state: 'hidden' });
    const saved = await PDFDocument.load(await fs.readFile(first));
    assert.ok(saved.catalog.get(require('pdf-lib').PDFName.of('AsterPDFEditableObjectsV1')));
    const untouched = await PDFDocument.load(await fs.readFile(second));
    assert.equal(untouched.catalog.get(require('pdf-lib').PDFName.of('AsterPDFEditableObjectsV1')), undefined);
    await shell.getByRole('button', { name: 'Close First.pdf', exact: true }).click();
    await shell.getByRole('tab', { name: /First.pdf/ }).waitFor({ state: 'detached' });
    assert.equal(await shell.getByRole('tab').count(), 1);
    console.log('Close cancellation and per-document saving passed; the other PDF was not changed.');
    await other.getByRole('button', { name: 'Draw', exact: true }).click();
    await other.getByRole('button', { name: 'Draw rectangle', exact: true }).click();
    await other.locator('.page-stage').click({ position: { x: 160, y: 180 } });
    await shell.locator('.tab-dirty').waitFor();
    // Real pointer events start the drag; a deterministic OS cursor places
    // the final drop outside every AsterPDF window.
    await shell.getByRole('button', { name: 'New tab', exact: true }).click();
    await shell.getByRole('tab', { name: 'Home', exact: true }).waitFor();
    let homeDocument;
    for (let i=0;i<100;i++) {
      for (const page of electron.context().pages()) if (!page.isClosed() && !page.url().includes('workspace=1') && page !== other && await page.getByText('Every detail, in view.').count()) homeDocument=page;
      if(homeDocument)break; await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(homeDocument);
    // No update has been downloaded, so installation must fail only AFTER
    // saving the dirty document in the other tab. No updater is installed.
    const installResult = await homeDocument.evaluate(async () => { try { await window.aster.installUpdate(); return ''; } catch(error) { return error.message; } });
    assert.match(installResult, /Download the update before installing/);
    await shell.locator('.tab-dirty').waitFor({state:'hidden'});
    const secondSaved = await PDFDocument.load(await fs.readFile(second));
    assert.ok(secondSaved.catalog.get(require('pdf-lib').PDFName.of('AsterPDFEditableObjectsV1')));
    console.log('Update preflight saves a dirty document in another tab.');
    const homeId = await shell.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.closest('[data-tab-id]')?.getAttribute('data-tab-id'));
    await electron.evaluate(({ screen }) => { global.originalCursor = screen.getCursorScreenPoint; screen.getCursorScreenPoint = () => ({ x: 9000, y: 9000 }); });
    const homeButton = await shell.getByRole('tab', { name: 'Home', exact: true }).boundingBox();
    const detachedEvent = electron.waitForEvent('window'); detachedEvent.catch(() => {});
    await shell.mouse.move(homeButton.x + 20, homeButton.y + 15);
    await shell.mouse.down(); await shell.mouse.move(homeButton.x + 90, homeButton.y + 15, { steps: 4 }); await shell.mouse.up();
    await detachedEvent;
    let newShell;
    for (let i=0;i<100;i++) { newShell=electron.context().pages().find(p=>p!==shell && !p.isClosed() && p.url().includes('workspace=1'));if(newShell)break;await new Promise(r=>setTimeout(r,100)); }
    assert.ok(newShell);
    await newShell.getByRole('tab', { name: 'Home', exact: true }).waitFor();
    await electron.evaluate(({ screen }) => { screen.getCursorScreenPoint = global.originalCursor; });
    // Regression for closing a native window during a tab drag.
    await newShell.evaluate(id => window.aster.workspaceAction('drag-start', id), homeId);
    await shell.waitForFunction(() => document.querySelector('.is-dragging'));
    await (await electron.browserWindow(newShell)).evaluate(win => win.destroy());
    await shell.waitForFunction(() => !document.querySelector('.is-dragging'));
    assert.equal(await shell.getByRole('tab').count(), 1);
    assert.deepEqual(processErrors, []);
    console.log('Pointer drag-out and closing a window during dragging passed without main-process errors.');
  } catch(error) {
    if (electron) for(const page of electron.context().pages()) console.log('Debug',page.url(),await page.locator('body').innerText().catch(()=>''));
    throw error;
  } finally {
    if (electron) {
      await electron.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => {});
      await electron.close().catch(() => {});
    }
    await server.close();
  }
}

async function findDocument(electron, expected) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const page of electron.context().pages()) {
      if (page.isClosed() || page.url().includes('workspace=1')) continue;
      if (await page.locator('.document-title').getAttribute('title').catch(() => null) === expected) return page;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Document did not load: ${expected}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

