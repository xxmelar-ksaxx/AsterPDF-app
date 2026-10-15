const { _electron } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listOriginalText } = require('../electron/original-text.cjs');
const { listInstalledFonts, getInstalledFont } = require('../electron/installed-fonts.cjs');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'asterpdf-arabic-source-'));
  let electron;
  try {
    const sourcePath = process.argv[2] || path.join(temporary, 'external.pdf');
    if (!process.argv[2]) {
      const face = (await listInstalledFonts()).find((font) => font.postscriptName === 'SSTArabic-Roman');
      if (!face) { process.stdout.write('Skipped: SST Arabic fixture font is not installed.\n'); return; }
      const pdf = await PDFDocument.create();
      pdf.registerFontkit(fontkit);
      const font = await pdf.embedFont((await getInstalledFont(face.id, 'الأعمال')).bytes, { subset: true });
      pdf.addPage([700, 600]).drawText('منهجية إنجاز الأعمال ', { font, x: 150, y: 400, size: 24 });
      await fs.writeFile(sourcePath, await pdf.save());
    }
    const original = await fs.readFile(sourcePath);
    const selected = (await listOriginalText(original, 0)).find((item) => item.text.includes('الأعمال'));
    if (!selected) throw Error('The original word was not extracted correctly');
    const changed = selected.text.replace('الأعمال', 'الأعمالي');
    electron = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), `--user-data-dir=${temporary}`],
      env: { ...process.env, APPDATA: temporary }, timeout: 60000 });
    const window = await electron.firstWindow();
    window.setDefaultTimeout(15000);
    await window.getByText('Every detail, in view.').waitFor();
    await electron.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, sourcePath);
    await window.getByRole('button', { name: 'Open a file' }).first().click();
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    const frame = (text) => window.locator(`svg[aria-label=${JSON.stringify(`Original text frame: ${text}`)}] .text-frame-interior`);
    await frame(selected.text).waitFor();
    await frame(selected.text).scrollIntoViewIfNeeded();
    const captureRect = await frame(selected.text).boundingBox();
    const editor = window.getByRole('textbox', { name: 'Edit original PDF text', exact: true });
    const capture = async (name) => {
      if (!process.env.ASTERPDF_ARABIC_PREVIEW) return;
      await window.locator('.page-stage > canvas').first().waitFor({ state: 'visible' });
      const rect = name === 'saved' ? await frame(changed).boundingBox() : captureRect;
      await window.screenshot({ path: `${process.env.ASTERPDF_ARABIC_PREVIEW}-${name}.png`,
        clip: { x: rect.x - 20, y: rect.y - 25, width: rect.width + 40, height: rect.height + 50 },
        style: '.text-frame-outline{stroke:transparent!important}' });
      if (name === 'saved') await window.screenshot({ path: `${process.env.ASTERPDF_ARABIC_PREVIEW}-full.png` });
    };
    await capture('before');
    await frame(selected.text).click();
    if (await editor.textContent() !== selected.text) throw Error('Entering edit mode changed the Arabic characters');
    await editor.press('End');
    if (selected.fontName.startsWith('SST'))
      await window.waitForFunction(() => getComputedStyle(document.querySelector('.original-text-editable')).fontFamily.includes('SST'));
    await window.evaluate(() => document.fonts.ready);
    await capture('editing');
    await editor.press('Escape');
    await frame(selected.text).click();
    await editor.fill(changed);
    await editor.press('Enter');
    await frame(changed).waitFor();
    await frame(changed).click();
    if (await editor.textContent() !== changed) throw Error('Repeated editing changed the Arabic characters');
    await editor.press('Escape');
    const savedPath = path.join(temporary, 'edited-copy.pdf');
    await electron.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, savedPath);
    await window.getByRole('button', { name: 'Comments', exact: true }).click();
    await window.getByRole('button', { name: 'Save a copy' }).click();
    await window.locator('.saving-spinner').waitFor({ state: 'hidden', timeout: 30000 });
    const saved = await listOriginalText(await fs.readFile(savedPath), 0);
    if (!saved.some((item) => item.text === changed && item.fontName.replace(/-\d+$/, '') === selected.fontName.replace(/-\d+$/, '')))
      throw Error('Saved copy lost the Arabic text or font');
    await electron.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, savedPath);
    await window.getByRole('button', { name: 'Open file' }).click();
    await window.getByRole('button', { name: 'Edit', exact: true }).click();
    await frame(changed).waitFor();
    await capture('saved');
    await frame(changed).click();
    if (await editor.textContent() !== changed) throw Error('Reopening changed the Arabic characters');
    await editor.press('Escape');
    if (!(await fs.readFile(sourcePath)).equals(original)) throw Error('The source file changed');
    if (await window.locator('.error-banner').count()) throw Error(await window.locator('.error-banner').innerText());
    process.stdout.write('External Arabic text stays correct on entering edit mode, repeated editing, and saving a copy; source unchanged.\n');
  } finally {
    if (electron) {
      await electron.firstWindow().then((window) => window.evaluate(() => window.aster.setDirty(false))).catch(() => {});
      await electron.close().catch(() => {});
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
