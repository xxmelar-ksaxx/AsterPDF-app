const { _electron } = require('playwright');
const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const project = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-font-'));
  const sourcePath = path.join(temporary, 'subset.pdf');
  const savedPath = path.join(temporary, 'edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await fs.readFile(path.join(project, 'assets', 'fonts', 'NotoSans.ttf')), { subset: true });
  const page = pdf.addPage([500, 700]);
  // Equivalent to 20pt text, but stored like PDFs that magnified the old caret.
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(20, 0, 0, 20, 60, 500));
  page.drawText('Subset text', { x: 0, y: 0, size: 1, font });
  page.pushOperators(popGraphicsState());
  page.drawText('Keep this', { x: 60, y: 450, size: 16, font });
  await fs.writeFile(sourcePath, await pdf.save());
  const electron = await _electron.launch({ executablePath: require('electron'), args: [project, `--user-data-dir=${temporary}`],
    // Isolate app settings while keeping access to the user's installed fonts.
    env: { ...process.env, APPDATA: temporary }, timeout: 60000 });
  try {
    const window = await electron.firstWindow();
    window.setDefaultTimeout(10000);
    window.on('pageerror', (error) => process.stderr.write(`PAGE ERROR ${error.message}\n`));
    await window.getByText('Every detail, in view.').waitFor();
    await electron.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, sourcePath);
    await window.getByRole('button', { name: 'Open a file' }).first().click();
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    const originalFrame = (text) => window.locator(`svg[aria-label=${JSON.stringify(`Original text frame: ${text}`)}]`);
    await originalFrame('Subset text').locator('.text-frame-interior').click();
    const editor = window.locator('.original-text-editable');
    const fontPicker = window.getByRole('button', { name: 'Text font' });
    await fontPicker.click();
    const installed = await window.evaluate(() => window.aster.listInstalledFonts());
    if (installed.length) {
      await window.getByRole('searchbox', { name: 'Search fonts' }).fill(installed[0].family);
      await window.locator('.font-picker-menu .font-option').filter({ hasText: installed[0].family }).first().waitFor();
    }
    const sstInstalled = await fs.access(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts', 'SST Arabic Roman.ttf'))
      .then(() => true, () => false);
    if (sstInstalled) {
      await window.getByRole('searchbox', { name: 'Search fonts' }).fill('SST');
      await window.locator('.font-picker-menu').getByRole('button', { name: 'SST Arabic', exact: true }).click();
      if (!(await fontPicker.textContent()).includes('SST Arabic')) throw Error('Installed SST font could not be selected');
      await fontPicker.click();
    }
    await window.getByRole('searchbox', { name: 'Search fonts' }).fill('Noto Serif');
    await window.getByRole('button', { name: 'Add Noto Serif to favorites' }).click();
    await window.locator('.font-picker-menu').getByRole('button', { name: 'Noto Serif', exact: true }).click();
    if (!(await fontPicker.textContent()).includes('Noto Serif')) throw Error('Chosen font is missing from the top toolbar');
    await editor.fill('Greek Ω text');
    await editor.press('Enter');
    const newTarget = originalFrame('Greek Ω text').locator('.text-frame-interior');
    await newTarget.waitFor().catch(async (error) => {
      const alert = await window.locator('.error-banner').textContent().catch(() => null);
      throw new Error(`${error.message}${alert ? `\nApp error: ${alert}` : ''}`);
    });
    const outline = originalFrame('Greek Ω text').locator('.text-frame-outline');
    const beforeMove = await outline.boundingBox();
    const border = originalFrame('Greek Ω text').locator('.text-frame-border').first();
    const borderBox = await border.boundingBox();
    if (!beforeMove || !borderBox) throw Error('Original text frame border is missing');
    await window.mouse.move(borderBox.x + borderBox.width / 2, borderBox.y + borderBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(borderBox.x + borderBox.width / 2 + 26, borderBox.y + borderBox.height / 2 + 20, { steps: 5 });
    await window.mouse.up();
    await window.waitForFunction((left) => {
      const rect = document.querySelector('svg[aria-label="Original text frame: Greek Ω text"] .text-frame-outline')?.getBoundingClientRect();
      return rect && rect.left > left + 15;
    }, beforeMove.x);
    await newTarget.click();
    const arabic = '\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645';
    await editor.fill(arabic);
    if (!(await fontPicker.textContent()).includes('Original:')) throw Error('Typing changed the selected original font');
    await fontPicker.click();
    await window.getByRole('searchbox', { name: 'Search fonts' }).fill('Noto Naskh Arabic');
    await window.locator('.font-picker-menu').getByRole('button', { name: 'Noto Naskh Arabic', exact: true }).click();
    await editor.press('Enter');
    await originalFrame(arabic).waitFor();
    let currentArabic = arabic;
    for (const replacement of ['الأعمال', 'الأعمالي', 'منهجية إنجاز كل الأعمالي', arabic]) {
      await originalFrame(currentArabic).locator('.text-frame-interior').click();
      await editor.fill(replacement);
      const inlineStyle = await editor.evaluate((input) => {
        const style = getComputedStyle(input);
        const matrix = new DOMMatrix(getComputedStyle(input.parentElement).transform);
        return { border: style.borderWidth, size: parseFloat(style.fontSize), background: style.backgroundColor,
          direction: style.direction, overflow: style.overflow, caretScale: Math.hypot(matrix.a, matrix.b),
          expectedSize: 20 * document.querySelector('.page-stage > canvas').getBoundingClientRect().width / 500,
          pageOverflow: getComputedStyle(input.closest('.page-stage')).overflow };
      });
      if (inlineStyle.border !== '0px' || inlineStyle.background !== 'rgba(0, 0, 0, 0)' || inlineStyle.direction !== 'rtl'
        || Math.abs(inlineStyle.size - inlineStyle.expectedSize) > 0.1 || Math.abs(inlineStyle.caretScale - 1) > 0.001
        || inlineStyle.overflow !== 'visible' || inlineStyle.pageOverflow !== 'visible')
        throw Error(`Text did not remain inline: ${JSON.stringify(inlineStyle)}`);
      if (replacement === 'الأعمالي' && process.env.ASTERPDF_INLINE_SCREENSHOT) {
        await editor.press('End');
        const box = await editor.boundingBox();
        await window.screenshot({ path: process.env.ASTERPDF_INLINE_SCREENSHOT, caret: 'initial',
          clip: { x: Math.max(0, box.x - 30), y: Math.max(0, box.y - 30), width: box.width + 60, height: box.height + 60 } });
      }
      await editor.press('Enter');
      await originalFrame(replacement).waitFor();
      currentArabic = replacement;
    }
    await electron.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, savedPath);
    await window.getByRole('button', { name: 'Comments', exact: true }).click();
    await window.getByRole('button', { name: 'Save a copy' }).click();
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(savedPath)) });
    const document = await task.promise;
    const text = (await (await document.getPage(1)).getTextContent()).items.map((item) => item.str || '').join(' ');
    await task.destroy();
    if (!text.includes(arabic) || text.includes('Subset text') || !text.includes('Keep this'))
      throw Error(`Saved content is incorrect: ${text}`);
    await electron.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, savedPath);
    await window.getByRole('button', { name: 'Open file' }).click();
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    await originalFrame(arabic).waitFor();
    await window.getByRole('button', { name: 'Add text overlay' }).click();
    const stage = window.locator('.page-stage').first();
    const box = await stage.boundingBox();
    if (!box) throw Error('Missing PDF page for added Arabic text');
    await stage.click({ position: { x: box.width * 0.35, y: box.height * 0.35 } });
    const added = '\u0644\u0627 \u0644\u0623 \u0644\u0625 \u0644\u0622';
    const addedEditor = window.getByRole('textbox', { name: 'Edit text on page', exact: true });
    await addedEditor.fill(added);
    if (!(await fontPicker.textContent()).includes('Noto Naskh Arabic'))
      throw Error('Added Arabic font was not selected automatically');
    await addedEditor.press('Enter');
    const addedPath = path.join(temporary, 'added-arabic.pdf');
    await electron.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, addedPath);
    await window.getByRole('button', { name: 'Comments', exact: true }).click();
    await window.getByRole('button', { name: 'Save a copy' }).click();
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    const addedTask = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(addedPath)) });
    const addedDoc = await addedTask.promise;
    const addedText = (await (await addedDoc.getPage(1)).getTextContent()).items.map((item) => item.str || '').join(' ');
    await addedTask.destroy();
    if (!addedText.includes(added) || !addedText.includes(arabic)) throw Error(`Added Arabic was not saved: ${addedText}`);
    await electron.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, addedPath);
    await window.getByRole('button', { name: 'Open file' }).click();
    await window.locator('[data-overlay-kind="text"]').first().waitFor();
    if (!((await window.locator('[data-overlay-kind="text"]').first().textContent()) || '').includes(added))
      throw Error('Added Arabic was not editable after reopen');
    process.stdout.write('Selected font, original and added Arabic, extraction, and editable reopen passed.\n');
  } finally {
    await electron.firstWindow().then((window) => window.evaluate(() => window.aster.setDirty(false))).catch(() => {});
    await electron.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
