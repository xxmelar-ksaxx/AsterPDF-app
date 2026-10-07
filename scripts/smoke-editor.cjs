const { _electron } = require('playwright');
const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const imageCount = (pdf) => pdf.context.enumerateIndirectObjects().filter(([, object]) =>
    object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image').length;
  const project = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-editor-'));
  const pdfPath = path.join(temporary, 'pages.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.addPage([500, 700]);
  await fs.writeFile(pdfPath, await pdf.save());
  const compressible = await PDFDocument.create();
  const noisy = await compressible.embedPng(await fs.readFile(path.join(project, 'tests', 'fixtures', 'noise.png')));
  compressible.addPage([400, 400]).drawImage(noisy, { x: 0, y: 0, width: 400, height: 400 });
  const compressiblePath = path.join(temporary, 'large.pdf');
  await fs.writeFile(compressiblePath, await compressible.save());
  const electron = await _electron.launch({
    executablePath: process.env.ASTERPDF_SMOKE_EXECUTABLE || (process.env.ASTERPDF_SMOKE_PACKAGED === '1'
      ? path.join(project, 'release', 'win-unpacked', 'AsterPDF.exe') : require('electron')),
    args: process.env.ASTERPDF_SMOKE_PACKAGED === '1'
      ? [`--user-data-dir=${temporary}`] : [project, `--user-data-dir=${temporary}`],
    env: { ...process.env, APPDATA: temporary, LOCALAPPDATA: temporary }, timeout: 60000
  });
  try {
    const window = await electron.firstWindow();
    window.on('pageerror', (error) => process.stderr.write(`Page error: ${error.message}\n`));
    const choose = async (filePath) => electron.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, filePath);
    await window.getByText('Every detail, in view.').waitFor({ timeout: 30000 });
    await choose(path.join(project, 'tests', 'fixtures', 'basic.docx'));
    await window.getByRole('button', { name: 'Open a file' }).first().click();
    await window.waitForFunction(() => document.querySelector('.page-sheet') || document.querySelector('.error-banner'), null, { timeout: 30000 });
    const conversionError = await window.locator('.error-banner').count() ? await window.locator('.error-banner').textContent() : null;
    if (conversionError) throw new Error(conversionError);
    await window.locator('.page-sheet').first().waitFor({ timeout: 30000 });
    await window.locator('.page-sheet canvas').first().waitFor({ state: 'visible', timeout: 30000 });
    await window.screenshot({ path: path.join(project, 'release', 'smoke-docx.png'), fullPage: true });
    const wordOutput = path.join(temporary, 'word.pdf');
    await electron.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, wordOutput);
    await window.getByRole('button', { name: 'Save PDF' }).click();
    await window.waitForFunction(() => !document.querySelector('.unsaved-dot'), null, { timeout: 30000 });
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    if ((await PDFDocument.load(await fs.readFile(wordOutput))).getPageCount() < 1) throw new Error('DOCX conversion produced no PDF page.');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const wordTask = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(wordOutput)) });
    try {
      const parsed = await wordTask.promise;
      const text = [];
      for (let page = 1; page <= parsed.numPages; page += 1) {
        text.push((await (await parsed.getPage(page)).getTextContent()).items.map((item) => item.str || '').join(' '));
      }
      if (!text.join(' ').includes('Hello from a Word document') || !text.join(' ').includes('Second page text')) {
        throw new Error(`DOCX PDF text or page break was missing: ${text.join(' | ')}`);
      }
    } finally { await wordTask.destroy(); }
    await choose(path.join(project, 'tests', 'fixtures', 'pixel.png'));
    await window.getByRole('button', { name: 'Open file' }).click();
    await window.locator('.page-sheet').first().waitFor({ timeout: 30000 });
    const imageOutput = path.join(temporary, 'image.pdf');
    await electron.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, imageOutput);
    await window.getByRole('button', { name: 'Save PDF' }).click();
    await window.waitForFunction(() => !document.querySelector('.unsaved-dot'), null, { timeout: 30000 });
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    if ((await PDFDocument.load(await fs.readFile(imageOutput))).getPageCount() !== 1) throw new Error('Image conversion failed.');
    await choose(pdfPath);
    await window.getByRole('button', { name: 'Open file' }).click();
    await window.waitForFunction(() => document.querySelectorAll('.page-sheet').length === 2, null, { timeout: 30000 });
    await window.getByRole('button', { name: 'Pages', exact: true }).click();
    await window.getByRole('checkbox', { name: 'Select page 1' }).check();
    await window.getByRole('button', { name: 'Duplicate page' }).click();
    await window.waitForFunction(() => document.querySelectorAll('.page-sheet').length === 3, null, { timeout: 30000 });
    if (!await window.getByRole('checkbox', { name: 'Select page 1' }).isChecked()) throw new Error('Page selection was lost after duplication.');
    if ((await PDFDocument.load(await fs.readFile(pdfPath))).getPageCount() !== 2) throw new Error('Page editing wrote to disk before Save PDF.');
    if (await window.locator('.saving-spinner').count()) throw new Error('Page editing started an automatic save.');
    await window.getByRole('button', { name: 'Rotate right' }).click();
    if (!await window.getByRole('checkbox', { name: 'Select page 1' }).isChecked()) throw new Error('Page selection was lost after rotation.');
    await window.getByRole('button', { name: 'Move page down' }).click();
    if (!await window.getByRole('checkbox', { name: 'Select page 2' }).isChecked()) throw new Error('Page selection did not follow the moved page.');
    await window.getByRole('button', { name: 'Move page up' }).click();
    if (!await window.getByRole('checkbox', { name: 'Select page 1' }).isChecked()) throw new Error('Page selection did not follow the moved page.');
    await window.getByRole('button', { name: 'Undo edit' }).click();
    if (!await window.getByRole('checkbox', { name: 'Select page 2' }).isChecked()) throw new Error('Page selection was lost after undo.');
    await window.getByRole('button', { name: 'Redo edit' }).click();
    if (!await window.getByRole('checkbox', { name: 'Select page 1' }).isChecked()) throw new Error('Page selection was lost after redo.');
    await window.getByRole('button', { name: 'Save PDF' }).click();
    await window.waitForFunction(() => !document.querySelector('.unsaved-dot'), null, { timeout: 30000 });
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    const edited = await PDFDocument.load(await fs.readFile(pdfPath));
    if (edited.getPageCount() !== 3 || edited.getPage(0).getRotation().angle !== 90) throw new Error('Page actions did not save.');
    const beforeSignatureSize = (await fs.stat(pdfPath)).size;
    await window.getByRole('button', { name: 'Sign', exact: true }).click();
    await window.getByRole('menuitem', { name: '+ Signature' }).click();
    const pad = window.locator('.signature-canvas');
    const box = await pad.boundingBox();
    await window.mouse.move(box.x + 40, box.y + 80);
    await window.mouse.down();
    await window.mouse.move(box.x + 200, box.y + 35, { steps: 8 });
    await window.mouse.up();
    await window.getByRole('button', { name: 'Save signature' }).click();
    const firstStage = window.locator('.page-sheet[data-page-number="1"] .page-stage');
    await firstStage.hover({ position: { x: 100, y: 100 } });
    await firstStage.locator('.signature-cursor').waitFor({ state: 'visible' });
    await firstStage.click({ position: { x: 100, y: 100 } });
    const overlay = firstStage.locator('.editable-signature');
    await overlay.waitFor({ state: 'visible' });
    if (!await overlay.evaluate((element) => element.classList.contains('selected'))) throw new Error('New signature was not selected.');
    await firstStage.click({ position: { x: 20, y: 20 } });
    if (await overlay.evaluate((element) => element.classList.contains('selected'))) throw new Error('Clicking elsewhere did not deselect the signature.');
    await overlay.click();
    if (!await overlay.evaluate((element) => element.classList.contains('selected'))) throw new Error('Clicking the signature did not reselect it.');
    const beforeMove = await overlay.boundingBox();
    await window.mouse.move(beforeMove.x + beforeMove.width / 2, beforeMove.y + beforeMove.height / 2);
    await window.mouse.down();
    await window.mouse.move(beforeMove.x + beforeMove.width / 2 + 30, beforeMove.y + beforeMove.height / 2 + 25, { steps: 5 });
    await window.mouse.up();
    const afterMove = await overlay.boundingBox();
    if (afterMove.x < beforeMove.x + 20) throw new Error('Placed signature did not move.');
    const resize = overlay.locator('.signature-resize');
    const resizeBox = await resize.boundingBox();
    await window.mouse.move(resizeBox.x + 7, resizeBox.y + 7);
    await window.mouse.down();
    await window.mouse.move(resizeBox.x + 42, resizeBox.y + 27, { steps: 5 });
    await window.mouse.up();
    const afterResize = await overlay.boundingBox();
    if (afterResize.width < afterMove.width + 15) throw new Error('Placed signature did not resize.');
    await window.screenshot({ path: path.join(project, 'release', 'smoke-signature.png'), fullPage: true });
    await overlay.click({ button: 'right' });
    await window.getByRole('button', { name: 'Delete signature' }).click();
    await window.getByRole('alertdialog', { name: 'Remove signature?' }).waitFor({ state: 'visible' });
    await window.getByRole('button', { name: 'Cancel' }).click();
    if (!await firstStage.locator('.editable-signature').count()) throw new Error('Cancel removed the placed signature.');
    await overlay.click({ button: 'right' });
    await window.getByRole('button', { name: 'Delete signature' }).click();
    await window.getByRole('alertdialog').getByRole('button', { name: 'Remove signature' }).click();
    if (await firstStage.locator('.editable-signature').count()) throw new Error('Right-click deletion failed.');
    if ((await fs.stat(pdfPath)).size !== beforeSignatureSize) throw new Error('Signature edit wrote to disk before Save PDF.');
    await window.getByRole('button', { name: 'Sign', exact: true }).click();
    await window.getByRole('menuitem', { name: 'Signature 1' }).click();
    await firstStage.click({ position: { x: 110, y: 110 } });
    await firstStage.locator('.editable-signature').waitFor({ state: 'visible' });
    await window.locator('.unsaved-dot').waitFor({ state: 'visible', timeout: 30000 });
    await window.getByRole('button', { name: 'Save PDF' }).click();
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    if (await window.locator('.editable-signature').count()) throw new Error('Saved signature remained editable.');
    if ((await fs.stat(pdfPath)).size <= beforeSignatureSize) throw new Error('Signature did not add PDF drawing content.');
    if (imageCount(await PDFDocument.load(await fs.readFile(pdfPath))) !== 0) throw new Error('Drawn signature was embedded as an image.');
    await window.waitForFunction(() => { const canvas = document.querySelector('.page-sheet[data-page-number="1"] .page-stage canvas');
      return canvas && getComputedStyle(canvas).display !== 'none' && canvas.width > 0; }, null, { timeout: 30000 });
    await window.screenshot({ path: path.join(project, 'release', 'smoke-signed.png'), fullPage: true });
    await window.getByRole('button', { name: 'Sign', exact: true }).click();
    await window.getByRole('menuitem', { name: 'Signature 1' }).waitFor({ state: 'visible' });
    const svgPath = path.join(temporary, 'imported-signature.svg');
    await fs.writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90" viewBox="0 0 320 90"><path d="M10 62 C80 4 150 83 309 21" fill="none" stroke="#203f8c" stroke-width="7" stroke-linecap="round"/></svg>');
    await window.getByRole('menuitem', { name: '+ Signature' }).click();
    await window.locator('input[type="file"]').setInputFiles(svgPath);
    await window.getByAltText('New signature preview').waitFor({ state: 'visible' });
    await window.getByRole('button', { name: 'Save signature' }).click();
    await firstStage.click({ position: { x: 180, y: 190 } });
    await firstStage.locator('.editable-signature').waitFor({ state: 'visible' });
    await window.getByRole('button', { name: 'Save PDF' }).click();
    await window.waitForFunction(() => !document.querySelector('.unsaved-dot'), null, { timeout: 30000 });
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    if (imageCount(await PDFDocument.load(await fs.readFile(pdfPath))) === 0) throw new Error('Imported signature was not embedded as an image.');
    await window.getByRole('button', { name: 'Sign', exact: true }).click();
    await window.getByRole('button', { name: 'Remove imported-signature' }).click();
    await window.getByRole('alertdialog', { name: 'Remove signature?' }).getByText(/imported-signature/).waitFor();
    await window.getByRole('button', { name: 'Cancel' }).click();
    await window.getByRole('button', { name: 'Sign', exact: true }).click();
    await window.getByRole('menuitem', { name: 'imported-signature' }).waitFor({ state: 'visible' });
    await window.getByRole('button', { name: 'Remove imported-signature' }).click();
    await window.getByRole('alertdialog').getByRole('button', { name: 'Remove signature' }).click();
    await window.getByRole('button', { name: 'Sign', exact: true }).click();
    if (await window.getByRole('menuitem', { name: 'imported-signature' }).count()) throw new Error('Saved signature was not removed.');
    await window.getByRole('button', { name: 'Sign', exact: true }).click();

    await choose(compressiblePath);
    await window.getByRole('button', { name: 'Open file' }).click();
    await window.getByText('large.pdf', { exact: true }).waitFor({ timeout: 30000 });
    await window.getByRole('button', { name: 'Compress', exact: true }).click();
    await window.getByRole('button', { name: /Smallest/ }).click();
    await window.locator('.unsaved-dot').waitFor({ state: 'visible', timeout: 30000 });
    const compressedPath = path.join(temporary, 'compressed.pdf');
    await electron.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, compressedPath);
    await window.getByRole('button', { name: 'Save PDF' }).click();
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    if ((await fs.stat(compressedPath)).size >= (await fs.stat(compressiblePath)).size) throw new Error('Compression did not reduce size.');
    process.stdout.write('DOCX/image conversion, page edits, signature, and offline compression passed.\n');
  } finally {
    await electron.firstWindow().then((window) => window.evaluate(() => window.aster.setDirty(false))).catch(() => {});
    await electron.close();
    const resolved = path.resolve(temporary);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe temporary path.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
