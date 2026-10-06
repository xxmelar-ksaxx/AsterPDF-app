const { _electron } = require('playwright');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const project = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-smoke-'));
  const fixture = path.join(temporary, 'sample.pdf');
  const sample = await PDFDocument.create();
  const font = await sample.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 24; number += 1) {
    const page = sample.addPage([600, 800]);
    page.drawText(`AsterPDF page ${number}`, { x: 80, y: 700, size: 22, font });
  }
  await fs.writeFile(fixture, await sample.save());
  const executablePath = process.env.ASTERPDF_SMOKE_PACKAGED === '1'
    ? path.join(project, 'release', 'win-unpacked', 'AsterPDF.exe')
    : require('electron');
  const electron = await _electron.launch({
    executablePath,
    args: process.env.ASTERPDF_SMOKE_PACKAGED === '1' ? [] : [project],
    env: { ...process.env, APPDATA: temporary, LOCALAPPDATA: temporary },
    timeout: 60000
  });
  try {
    const window = await electron.firstWindow();
    window.on('console', (message) => { if (message.type() === 'error') process.stderr.write(`Renderer: ${message.text()}\n`); });
    window.on('pageerror', (error) => process.stderr.write(`Page error: ${error.message}\n`));
    await window.getByText('Every detail, in view.').waitFor({ timeout: 30000 });
    await window.getByRole('button', { name: 'Settings' }).click();
    await window.getByLabel('Your name').fill('Test Author');
    await window.getByRole('button', { name: 'Save settings' }).click();
    await electron.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, fixture);
    await window.getByRole('button', { name: 'Open PDF', exact: true }).first().click();
    await window.locator('.page-sheet').last().waitFor({ timeout: 30000 });
    if (await window.locator('.page-sheet').count() !== 24) throw new Error('Continuous page flow did not mount all pages.');
    await window.locator('.page-sheet[data-page-number="1"] canvas').waitFor({ state: 'visible', timeout: 30000 });
    const distantCanvasWidth = await window.locator('.page-sheet[data-page-number="24"] canvas').evaluate((canvas) => canvas.width);
    if (distantCanvasWidth !== 0) throw new Error('A distant page rendered before it entered the viewport buffer.');
    await window.evaluate(() => {
      const viewer = document.querySelector('.viewer-scroll');
      const last = document.querySelector('.page-sheet[data-page-number="24"]');
      viewer.scrollTop = last.offsetTop + 40;
    });
    await window.waitForFunction(() => document.querySelector('.page-control strong')?.textContent === '24', null, { timeout: 30000 });
    await window.locator('.page-sheet[data-page-number="24"] canvas').waitFor({ state: 'visible', timeout: 30000 });
    if (await window.locator('.page-sheet[data-page-number="1"] canvas').evaluate((canvas) => canvas.width) !== 0) {
      throw new Error('A distant page canvas remained allocated after scrolling away.');
    }
    await window.evaluate(() => {
      const viewer = document.querySelector('.viewer-scroll');
      const third = document.querySelector('.page-sheet[data-page-number="3"]');
      viewer.scrollTop = third.offsetTop + 40;
    });
    await window.waitForFunction(() => document.querySelector('.page-control strong')?.textContent === '3', null, { timeout: 30000 });
    await window.locator('.page-sheet[data-page-number="3"] canvas').waitFor({ state: 'visible', timeout: 30000 });
    await electron.evaluate(() => {
      const fileSystem = process.mainModule.require('node:fs/promises');
      const originalRename = fileSystem.rename.bind(fileSystem);
      globalThis.asterSmokeWrites = 0;
      fileSystem.rename = async (...args) => {
        if (String(args[1]).toLowerCase().endsWith('.pdf')) {
          globalThis.asterSmokeWrites += 1;
          if (globalThis.asterSmokeWrites === 1) await new Promise((resolve) => setTimeout(resolve, 1800));
        }
        return originalRename(...args);
      };
    });
    const addComment = async (text, x, y) => {
      await window.getByRole('button', { name: 'Add comment', exact: true }).click();
      await window.locator('.page-sheet[data-page-number="3"] .page-stage').scrollIntoViewIfNeeded();
      await window.locator('.page-sheet[data-page-number="3"] canvas').waitFor({ state: 'visible', timeout: 30000 });
      await window.locator('.page-sheet[data-page-number="3"] .page-stage').click({ position: { x, y } });
      await window.getByPlaceholder('Write your comment…').fill(text);
      await window.getByRole('button', { name: 'Add comment', exact: true }).last().click();
    };
    await addComment('First automatic save', 150, 260);
    await window.locator('.saving-spinner').waitFor({ state: 'visible', timeout: 10000 });
    await window.screenshot({ path: path.join(project, 'release', 'smoke-saving.png'), fullPage: true });
    await addComment('Second automatic save', 190, 320);
    await window.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.comment-card')];
      return cards.some((item) => item.textContent?.includes('First automatic save'))
        && cards.some((item) => item.textContent?.includes('Second automatic save'))
        && cards.every((item) => !item.textContent?.includes('Unsaved') && !item.textContent?.includes('Saving'))
        && !document.querySelector('.saving-spinner');
    }, null, { timeout: 30000 });
    if (await electron.evaluate(() => globalThis.asterSmokeWrites) !== 2) throw new Error('Each rapid comment was not saved in order.');
    const twiceSaved = await PDFDocument.load(await fs.readFile(fixture));
    if (twiceSaved.getPages()[2].node.Annots()?.size() !== 2) throw new Error('Rapid comments were not both embedded on page 3.');

    await electron.evaluate(() => {
      const fileSystem = process.mainModule.require('node:fs/promises');
      const previousRename = fileSystem.rename;
      fileSystem.rename = async (...args) => {
        if (!String(args[1]).toLowerCase().endsWith('.pdf')) return previousRename(...args);
        fileSystem.rename = previousRename;
        globalThis.asterSmokeWrites += 1;
        throw new Error('Simulated write failure');
      };
    });
    await addComment('Retry after failed save', 230, 380);
    await window.getByRole('alert').getByText('Simulated write failure').waitFor({ timeout: 10000 });
    await window.locator('.unsaved-dot').waitFor({ state: 'visible', timeout: 10000 });
    const afterFailure = await PDFDocument.load(await fs.readFile(fixture));
    if (afterFailure.getPages()[2].node.Annots()?.size() !== 2) throw new Error('A failed save changed the original PDF.');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await window.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.comment-card')];
      return cards.length === 3 && cards.every((item) => !item.textContent?.includes('Unsaved') && !item.textContent?.includes('Saving'))
        && !document.querySelector('.saving-spinner') && !document.querySelector('.unsaved-dot');
    }, null, { timeout: 30000 });
    await window.waitForFunction(() => document.querySelector('.page-control strong')?.textContent === '3', null, { timeout: 30000 });
    await window.getByRole('button', { name: 'Zoom in' }).click();
    await window.waitForFunction(() => document.querySelector('.page-control strong')?.textContent === '3', null, { timeout: 30000 });
    await window.getByRole('button', { name: 'Pages', exact: true }).click();
    await window.getByRole('button', { name: 'Page 1', exact: true }).click();
    await window.waitForFunction(() => document.querySelector('.page-control strong')?.textContent === '1', null, { timeout: 30000 });
    await window.getByRole('button', { name: 'Comments', exact: false }).first().click();
    await window.locator('.comment-card').first().click();
    await window.waitForFunction(() => document.querySelector('.page-control strong')?.textContent === '3', null, { timeout: 30000 });
    await window.screenshot({ path: path.join(project, 'release', 'smoke.png'), fullPage: true });
    const saved = await PDFDocument.load(await fs.readFile(fixture));
    if (saved.getPages()[2].node.Annots()?.size() !== 3) throw new Error('Comments were not embedded on page 3.');
    await window.waitForFunction(async () => (await window.aster.getRecentPdfs())[0]?.preview?.startsWith('data:image/jpeg;base64,'), null, { timeout: 30000 });
    await window.reload();
    await window.getByRole('heading', { name: 'Recently opened' }).waitFor({ timeout: 30000 });
    const recent = window.getByRole('button', { name: 'Open sample.pdf' });
    await recent.waitFor();
    await recent.locator('.recent-preview img').waitFor({ state: 'visible' });
    if (!(await recent.locator('.recent-preview img').evaluate((image) => image.naturalWidth > 0))) {
      throw new Error('The recent PDF first-page preview did not load.');
    }
    await window.screenshot({ path: path.join(project, 'release', 'smoke-recent.png'), fullPage: true });
    await recent.click();
    await window.locator('.page-sheet[data-page-number="1"] canvas').waitFor({ state: 'visible', timeout: 30000 });
    process.stdout.write('Recent PDF preview and reopen, automatic saves, queued comments, failed-save retry, and PDF annotations passed.\n');
  } finally {
    await electron.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
