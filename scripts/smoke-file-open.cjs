const { _electron } = require('playwright');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const project = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-file-open-'));
  const first = path.join(temporary, 'First عرض جديد.PDF');
  const second = path.join(temporary, 'Second file.pdf');
  const third = path.join(temporary, 'Third file.pdf');
  for (const file of [first, second, third]) {
    const pdf = await PDFDocument.create();
    pdf.addPage([500, 700]).drawText('External open fixture', { x: 80, y: 400, size: 22, font: await pdf.embedFont(StandardFonts.Helvetica) });
    await fs.writeFile(file, await pdf.save());
  }
  const version = require('../package.json').version;
  const now = Date.now();
  await fs.writeFile(path.join(temporary, 'updates.json'), JSON.stringify({ cacheVersion: 2, platform: process.platform,
    arch: process.arch, lastAttemptAt: now, lastCheckedAt: now, release: null }));
  const executablePath = process.env.ASTERPDF_SMOKE_PACKAGED === '1'
    ? path.join(project, 'release', 'win-unpacked', 'AsterPDF.exe') : require('electron');
  const baseArgs = process.env.ASTERPDF_SMOKE_PACKAGED === '1' ? [] : [project];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launchAgain = (file) => new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...baseArgs, `--user-data-dir=${temporary}`, file], { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Second instance did not exit')); }, 20000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Second instance exited ${code}`)); });
  });
  const electron = await _electron.launch({ executablePath, args: [...baseArgs, `--user-data-dir=${temporary}`, first], env, timeout: 60000 });
  try {
    let window = await electron.firstWindow(); window.setDefaultTimeout(15000);
    const errors = [];
    window.on('pageerror', (error) => errors.push(String(error)));
    const shown = async (file) => {
      await window.waitForFunction((expected) => document.querySelector('.document-title')?.getAttribute('title') === expected, file);
      await window.locator('.page-stage canvas').first().waitFor({ state: 'visible' });
    };
    await shown(first);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await launchAgain(second);
    await shown(second);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), false);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

    // A native request has no pointer click: the active inline editor must be
    // committed before asking whether to discard the current PDF changes.
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    await window.locator('[aria-label="Original text frame: External open fixture"] .text-frame-interior').click();
    await window.getByRole('textbox', { name: 'Edit original PDF text', exact: true }).fill('Keep this edit');
    await launchAgain(third);
    await window.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).waitFor();
    await window.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await shown(second);
    await window.locator('[aria-label="Original text frame: Keep this edit"]').waitFor();
    assert.equal(await window.locator('.unsaved-dot').count(), 1);
    await launchAgain(second);
    assert.equal(await window.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).count(), 0);
    await launchAgain(third);
    await window.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await shown(third);

    // Drive Electron's actual macOS event listener on either test host.
    await electron.evaluate(({ app }, filePath) => { app.emit('open-file', { preventDefault() {} }, filePath); }, first);
    await shown(first);
    await launchAgain(path.join(temporary, 'Missing file.pdf'));
    await window.locator('.error-banner').waitFor();
    await shown(first);
    // A failed open must acknowledge the queue so the next valid file can open.
    await launchAgain(second); await shown(second);

    // Requests received while saving are held until the existing operation ends.
    await window.getByRole('button', { name: 'Pages', exact: true }).click();
    await window.getByRole('button', { name: 'Rotate right', exact: true }).click();
    const copy = path.join(temporary, 'Saved copy.pdf');
    await electron.evaluate(({ dialog }) => { dialog.showSaveDialog = () => new Promise((resolve) => { global.__completeSave = resolve; }); });
    await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === 'File').submenu.items.find((item) => item.label === 'Save As…').click());
    await window.locator('.saving-spinner').waitFor();
    await launchAgain(third);
    assert.equal(await window.locator('.document-title').getAttribute('title'), second);
    await electron.evaluate((_electron, filePath) => global.__completeSave({ canceled: false, filePath }), copy);
    await shown(third);
    assert.equal((await PDFDocument.load(await fs.readFile(copy))).getPage(0).getRotation().angle, 90);

    // Keep the debugging transport alive on Windows while closing the document
    // window, then exercise the Mac event's window-recreation path.
    const closedWindow = window.waitForEvent('close', { timeout: 5000 });
    void closedWindow.catch(() => {});
    await electron.evaluate(({ BrowserWindow }) => {
      const documentWindow = BrowserWindow.getAllWindows()[0];
      global.__testKeepAlive = new BrowserWindow({ show: false });
      documentWindow.destroy();
    });
    await closedWindow;
    const nextWindow = electron.waitForEvent('window', { timeout: 10000 });
    void nextWindow.catch(() => {});
    await electron.evaluate(({ app }, filePath) => app.emit('open-file', { preventDefault() {} }, filePath), first);
    window = await nextWindow; window.setDefaultTimeout(15000);
    await shown(first);
    assert.deepEqual(errors, []);
    process.stdout.write('File opening passed: cold launch, real second process, Unicode paths, one window, unsaved inline edit protection, same-file focus, failed request recovery, saving queue, and Mac open-file/window recreation.\n');
  } catch (error) { process.stderr.write(`File-open check failed: ${error.stack || error}\n`); throw error; }
  finally { await electron.close(); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
