const { _electron } = require('playwright');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const project = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-refresh-'));
  const sourcePath = path.join(temporary, 'four-pages.pdf');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 4; index++) {
    // Different page sizes expose scroll jumps caused by resetting measurements.
    const page = pdf.addPage([500, 650 + index * 50]);
    if (index === 4) page.drawRectangle({ x: 45, y: 480, width: 400, height: 65, color: rgb(0.85, 0.94, 0.85) });
    page.drawText(`Page ${index} text`, { x: 60, y: 500, size: 20, font, color: rgb(0.12, 0.25, 0.5) });
  }
  await fs.writeFile(sourcePath, await pdf.save());
  const electron = await _electron.launch({ executablePath: require('electron'),
    args: [project, `--user-data-dir=${temporary}`], env: { ...process.env, APPDATA: temporary }, timeout: 60000 });
  try {
    const window = await electron.firstWindow();
    window.setDefaultTimeout(15000);
    const errors = [];
    window.on('pageerror', (error) => errors.push(error.message));
    await window.getByText('Every detail, in view.').waitFor();
    await electron.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, sourcePath);
    await window.getByRole('button', { name: 'Open a file' }).first().click();
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    const sheet = window.locator('[data-page-number="4"]');
    await sheet.scrollIntoViewIfNeeded();
    const frame = (text) => sheet.locator(`svg[aria-label=${JSON.stringify(`Original text frame: ${text}`)}] .text-frame-interior`);
    await frame('Page 4 text').click();
    await window.waitForFunction(() => {
      const canvas = document.querySelector('[data-page-number="4"] .page-stage > canvas');
      return canvas?.width > 0 && getComputedStyle(canvas).display !== 'none';
    });
    const editor = window.locator('.original-text-editable');
    const originalBitmap = await sheet.locator('.page-stage > canvas').evaluate((canvas) => canvas.toDataURL());
    const inlineStyle = await editor.evaluate((input) => ({ border: getComputedStyle(input).borderWidth,
      color: getComputedStyle(input).color, background: getComputedStyle(document.querySelector('.original-text-mask')).backgroundColor }));
    if (inlineStyle.border !== '0px' || inlineStyle.color === 'rgb(0, 0, 0)' || inlineStyle.background === 'rgb(255, 255, 255)')
      throw Error(`Inline editor lost the page's text or paper color: ${JSON.stringify(inlineStyle)}`);
    await editor.fill('Cancel this edit');
    await editor.press('Escape');
    await frame('Page 4 text').waitFor();
    if (await sheet.locator('.page-stage > canvas').evaluate((canvas) => canvas.toDataURL()) !== originalBitmap)
      throw Error('Canceling an inline edit changed the page');
    await frame('Page 4 text').click();
    await window.evaluate(() => {
      const sheet = document.querySelector('[data-page-number="4"]');
      const canvas = sheet.querySelector('.page-stage > canvas');
      const viewer = document.querySelector('.viewer-scroll');
      const state = window.refreshCheck = { issues: [], samples: 0, scroll: viewer.scrollTop,
        bitmap: canvas.toDataURL(), changed: false, stopped: false };
      const check = () => {
        if (state.stopped) return;
        state.samples++;
        if (!canvas.isConnected || sheet.querySelector('.page-stage > canvas') !== canvas) state.issues.push('Page canvas was remounted');
        if (!canvas.width || !canvas.height || getComputedStyle(canvas).display === 'none') state.issues.push('Page canvas was cleared or hidden');
        if (sheet.querySelector('.page-rendering') || document.querySelector('.loading-page')) state.issues.push('Loading placeholder appeared');
        if (Math.abs(viewer.scrollTop - state.scroll) > 2) state.issues.push('Scroll position changed');
        if (canvas.width && canvas.toDataURL() !== state.bitmap) state.changed = true;
      };
      state.observer = new MutationObserver(check);
      state.observer.observe(document.querySelector('.viewer-scroll'), { childList: true, subtree: true, attributes: true });
      const tick = () => { check(); if (!state.stopped) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    for (const text of ['Updated fourth page', 'Edited again']) {
      const editor = window.locator('.original-text-editable');
      await editor.fill(text);
      await editor.press('Enter');
      await frame(text).waitFor();
      await window.waitForFunction(() => window.refreshCheck.changed);
      await frame(text).click();
      await window.evaluate(() => {
        window.refreshCheck.bitmap = document.querySelector('[data-page-number="4"] .page-stage > canvas').toDataURL();
        window.refreshCheck.changed = false;
      });
    }
    await window.locator('.original-text-editable').press('Escape');
    for (const [action, expected] of [['Undo edit', 'Updated fourth page'], ['Redo edit', 'Edited again']]) {
      await window.getByRole('button', { name: action, exact: true }).click();
      await frame(expected).waitFor();
      await window.waitForFunction(() => window.refreshCheck.changed);
      await window.evaluate(() => {
        window.refreshCheck.bitmap = document.querySelector('[data-page-number="4"] .page-stage > canvas').toDataURL();
        window.refreshCheck.changed = false;
      });
    }
    const result = await window.evaluate(() => {
      const state = window.refreshCheck;
      state.stopped = true;
      state.observer.disconnect();
      return { issues: [...new Set(state.issues)], samples: state.samples };
    });
    if (result.issues.length) throw Error(result.issues.join('; '));
    if (!result.samples) throw Error('No refresh frames were observed');
    if (await window.locator('.error-banner').count()) throw Error(await window.locator('.error-banner').innerText());
    if (errors.length) throw Error(errors.join('; '));
    process.stdout.write(`Repeated page 4 edits, undo, and redo stayed visible with stable scroll (${result.samples} checks).\n`);
  } finally {
    await electron.firstWindow().then((window) => window.evaluate(() => window.aster.setDirty(false))).catch(() => {});
    await electron.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
