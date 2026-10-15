const { _electron } = require('playwright');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const project = path.join(__dirname, '..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-update-ui-'));
  const version = require('../package.json').version;
  const fixture = path.join(directory, 'source.pdf');
  const converted = path.join(directory, 'converted.pdf');
  const blocked = path.join(directory, 'blocked.pdf');
  const png = path.join(directory, 'image.png');
  await fs.mkdir(blocked);
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]).drawText('Before update', { x: 80, y: 400, size: 22, font: await pdf.embedFont(StandardFonts.Helvetica) });
  await fs.writeFile(fixture, await pdf.save());
  const release = (value) => ({ tag_name: `v${value}`, draft: false, prerelease: false,
    assets: [`AsterPDF-${value}-Windows-x64-Setup.exe`, `AsterPDF-${value}-macOS-arm64.dmg`].map((name) =>
      ({ name, state: 'uploaded', browser_download_url: `https://github.com/xxmelar-ksaxx/AsterPDF-app/releases/download/v${value}/${name}` })) });
  const now = Date.now();
  await fs.writeFile(path.join(directory, 'updates.json'), JSON.stringify({ lastAttemptAt: now, lastCheckedAt: now, release: release(version), failed: false }));
  const bootstrap = path.join(directory, 'main.cjs');
  // All network and installer operations are mocked only in this temporary entry
  // point. The real app save path and filesystem writes are exercised below.
  await fs.writeFile(bootstrap, `
    const { app } = require('electron');
    const { EventEmitter } = require('node:events');
    app.setPath('userData', ${JSON.stringify(directory)});
    app.getVersion = () => ${JSON.stringify(version)};
    Object.defineProperty(app, 'isPackaged', { get: () => true });
    const updater = global.__updater = new EventEmitter();
    global.__installs = 0; global.__updateCalls = 0; global.__updateMode = 'new';
    global.__failInstall = false; global.__failDownload = false;
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '99.0.0' } });
    updater.downloadUpdate = async () => {
      if (global.__failDownload) throw new Error('sha512 checksum mismatch');
      await new Promise((resolve) => { global.__finishDownload = resolve; });
    };
    updater.quitAndInstall = () => {
      global.__installs++;
      global.__savedAtInstall = require('node:fs').readFileSync(global.__expectedSave);
      if (global.__failInstall) updater.emit('error', new Error('Mock installation error'));
    };
    require.cache[${JSON.stringify(require.resolve('electron-updater'))}] = { exports: { autoUpdater: updater } };
    global.fetch = async (url) => {
      if (url !== 'https://api.github.com/repos/xxmelar-ksaxx/AsterPDF-app/releases/latest') throw new Error('Unexpected network request');
      global.__updateCalls++;
      if (global.__holdUpdate) await new Promise((resolve) => { global.__finishUpdate = resolve; });
      if (global.__updateMode === 'offline') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(global.__updateMode === 'current' ? ${JSON.stringify(release(version))} : ${JSON.stringify(release('99.0.0'))}), { status: 200 });
    };
    require(${JSON.stringify(path.join(project, 'electron/main.cjs'))});
  `);
  const electron = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], timeout: 60000 });
  try {
    const window = await electron.firstWindow(); window.setDefaultTimeout(15000);
    window.on('pageerror', (error) => process.stderr.write(`Renderer: ${error}\n`));
    const settings = () => window.getByRole('button', { name: 'Settings', exact: true }).click();
    const closeSettings = () => window.getByRole('button', { name: 'Close settings' }).click();
    const install = () => window.getByRole('button', { name: 'Restart and install', exact: true }).click();
    const installs = () => electron.evaluate(() => global.__installs);
    await settings();
    await window.getByText(`Installed: ${version}`, { exact: true }).waitFor();
    await window.getByText('You’re up to date.', { exact: true }).waitFor();
    assert.equal(await electron.evaluate(() => global.__updateCalls), 0);
    await window.getByLabel('Your name').fill('Update Test Author');
    await window.getByRole('button', { name: 'Save settings' }).click();
    await settings();
    await electron.evaluate(() => { global.__holdUpdate = true; });
    await window.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await window.getByText('Checking for updates…', { exact: true }).waitFor();
    assert.equal(await window.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled(), true);
    await electron.evaluate(() => { global.__holdUpdate = false; global.__finishUpdate(); });
    await window.getByText('Version 99.0.0 is available.', { exact: true }).waitFor();
    await electron.evaluate(() => { global.__updateMode = 'offline'; });
    await window.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await window.getByRole('alert').filter({ hasText: 'Could not check for updates.' }).waitFor();
    const update = window.getByRole('button', { name: 'Update AsterPDF', exact: true });
    assert.equal(await update.count(), 1);
    await electron.evaluate(() => { global.__updateMode = 'new'; });
    await window.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await window.getByText('Version 99.0.0 is available.', { exact: true }).waitFor();
    await closeSettings();
    assert.equal(await update.evaluate((element) => element.previousElementSibling?.textContent.includes('Settings')), true);
    await update.click();
    await window.getByRole('progressbar', { name: 'Update download progress' }).waitFor();
    await electron.evaluate(() => global.__updater.emit('download-progress', { percent: 42, transferred: 44_040_192, total: 104_857_600 }));
    await window.getByText('42% · 42.0 MB / 100.0 MB', { exact: true }).waitFor();
    if (process.env.ASTERPDF_UPDATES_PREVIEW) await window.screenshot({ path: process.env.ASTERPDF_UPDATES_PREVIEW });
    assert.equal(await installs(), 0);
    await closeSettings();
    await window.getByText('Downloading 42%', { exact: true }).waitFor();
    await update.click();
    await electron.evaluate(() => global.__finishDownload());
    await window.getByText('Version 99.0.0 is ready to install.', { exact: true }).waitFor();
    assert.equal(await installs(), 0);

    // A real original text edit must reach disk before the installer is called.
    await closeSettings();
    await electron.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, fixture);
    await window.getByRole('button', { name: 'Open a file', exact: true }).first().click();
    await window.locator('.page-stage canvas').first().waitFor();
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    await window.locator('[aria-label="Original text frame: Before update"] .text-frame-interior').click();
    await window.getByRole('textbox', { name: 'Edit original PDF text', exact: true }).fill('Saved before update');
    // Clicking Settings commits the active inline edit as well.
    await settings();
    await window.waitForFunction(() => !document.querySelector('.saving-spinner'));
    assert.equal(await window.locator('.unsaved-dot').count(), 1);
    const refused = await window.evaluate(async () => { try { await window.aster.installUpdate(); return false; } catch { return true; } });
    assert.equal(refused, true, 'Main process must reject a direct install with unsaved changes');
    await electron.evaluate((_electron, filePath) => { global.__expectedSave = filePath; global.__failInstall = true; }, fixture);
    await install();
    await window.getByRole('alert').filter({ hasText: 'The update could not finish.' }).waitFor();
    assert.equal(await installs(), 1);
    const savedAtInstall = await electron.evaluate(() => [...global.__savedAtInstall]);
    const { listOriginalText } = require('../electron/original-text.cjs');
    assert.ok((await listOriginalText(new Uint8Array(savedAtInstall), 0)).some((item) => item.text === 'Saved before update'));
    assert.equal(await window.locator('.unsaved-dot').count(), 0);

    // Verification failures never make Restart available; retry recovers.
    await electron.evaluate(() => { global.__failDownload = true; });
    await window.getByRole('button', { name: 'Retry download' }).click();
    await window.getByRole('alert').filter({ hasText: 'could not be verified' }).waitFor();
    assert.equal(await window.getByRole('button', { name: 'Restart and install', exact: true }).count(), 0);
    await electron.evaluate(() => { global.__failDownload = false; global.__failInstall = false; });
    await window.getByRole('button', { name: 'Retry download' }).click();
    await window.getByRole('progressbar').waitFor();
    await electron.evaluate(() => global.__finishDownload());
    await window.getByText('Version 99.0.0 is ready to install.', { exact: true }).waitFor();

    // A converted image needs Save As: both cancel and a filesystem failure must
    // preserve the open document and prevent the installer from running.
    await closeSettings();
    await window.locator('.page-stage canvas').first().screenshot({ path: png });
    await electron.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, png);
    await window.getByRole('button', { name: 'Open file', exact: true }).click();
    await window.waitForFunction(() => document.querySelector('.document-title')?.textContent.includes('image.pdf') && document.querySelector('.unsaved-dot'));
    await settings();
    await electron.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
    await install();
    await window.getByRole('alert').filter({ hasText: 'The PDF was not saved.' }).waitFor();
    assert.equal(await installs(), 1); assert.equal(await window.locator('.unsaved-dot').count(), 1);
    await electron.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, blocked);
    await install();
    await window.getByRole('alert').filter({ hasText: 'The PDF was not saved.' }).waitFor();
    assert.equal(await installs(), 1); assert.equal(await window.locator('.unsaved-dot').count(), 1);
    await electron.evaluate(({ dialog }, filePath) => { global.__expectedSave = filePath; dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, converted);
    await install();
    await window.getByRole('heading', { name: 'Restarting to install…' }).waitFor();
    assert.equal(await installs(), 2);
    assert.equal((await PDFDocument.load(await fs.readFile(converted))).getPageCount(), 1);
    assert.ok((await fs.stat(png)).size > 0);
    assert.equal((await window.evaluate(() => window.aster.getSettings().catch(() => null))), null, 'Document actions must be locked during installation');
    process.stdout.write('Updates: cached/manual checks, progress, verified download, retry, real edit saved before install, direct install guard, Save As cancellation/failure/success passed.\n');
  } finally { await electron.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
