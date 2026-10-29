const { _electron } = require('playwright');
const { createServer } = require('vite');
const { PDFDocument, PDFName, decodePDFRawStream } = require('pdf-lib');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');

async function main() {
  const project = path.join(__dirname, '..'), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-corners-'));
  const file = path.join(temp, 'Corners.pdf');
  const pdf = await PDFDocument.create(); pdf.addPage([600, 500]); await fs.writeFile(file, await pdf.save());
  const server = await createServer({ configFile: false, root: project, server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  const env = { ...process.env, ASTERPDF_DEV_URL: `http://127.0.0.1:${server.httpServer.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, `--user-data-dir=${temp}`, file], env, timeout: 60000 });
    let doc;
    for (let i = 0; i < 200; i++) {
      doc = app.context().pages().find(p => !p.url().includes('workspace=1') && p.url().startsWith(env.ASTERPDF_DEV_URL));
      if (doc && await doc.locator('.page-control strong').count()) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(doc); doc.setDefaultTimeout(15000);
    const errors = []; doc.on('pageerror', e => errors.push(e.message));
    await doc.locator('dialog.save-feedback').waitFor({ state: 'hidden' });
    await doc.getByRole('button', { name: 'Draw', exact: true }).click();
    await doc.getByRole('button', { name: 'Draw rectangle', exact: true }).click();
    const stage = await doc.locator('.page-stage').first().boundingBox();
    await doc.mouse.move(stage.x + stage.width * .2, stage.y + stage.height * .2); await doc.mouse.down();
    await doc.mouse.move(stage.x + stage.width * .65, stage.y + stage.height * .6, { steps: 8 }); await doc.mouse.up();
    const shape = doc.locator('[data-overlay-kind="rectangle"]'), outline = shape.locator('g[opacity] path');
    assert.equal(await shape.locator('[data-radius-corner]').count(), 4);
    const input = name => doc.getByRole('spinbutton', { name, exact: true });
    await input('Corner radius').fill('15');
    await doc.getByRole('button', { name: 'Individual corner radii', exact: true }).click();
    const old = await outline.getAttribute('d');
    await input('Top-left radius').fill('35');
    assert.notEqual(await outline.getAttribute('d'), old, 'Typing updates before blur');
    assert.equal(await input('Top-right radius').inputValue(), '15');
    assert.equal(await input('Corner radius').getAttribute('placeholder'), 'Mixed');
    await input('Top-left radius').press('Tab');
    const beforeDrag = await outline.getAttribute('d'), originalWidth = await input('Width').inputValue();
    const dot = await shape.locator('[data-radius-corner="br"]').boundingBox();
    await doc.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2); await doc.mouse.down();
    await doc.mouse.move(dot.x + dot.width / 2 - 25, dot.y + dot.height / 2 - 25, { steps: 10 });
    assert.notEqual(await outline.getAttribute('d'), beforeDrag, 'Dot previews while held');
    await doc.mouse.up();
    assert.equal(await input('Width').inputValue(), originalWidth, 'Radius drag must not resize the rectangle');
    const afterDrag = await outline.getAttribute('d');
    await doc.getByRole('button', { name: 'Undo drawing', exact: true }).click(); assert.equal(await outline.getAttribute('d'), beforeDrag);
    await doc.getByRole('button', { name: 'Redo drawing', exact: true }).click(); assert.equal(await outline.getAttribute('d'), afterDrag);
    await doc.getByRole('button', { name: 'Select layer Rectangle', exact: true }).click();
    const shiftDot = await shape.locator('[data-radius-corner="tl"]').boundingBox();
    await doc.keyboard.down('Shift');
    await doc.mouse.move(shiftDot.x + shiftDot.width / 2, shiftDot.y + shiftDot.height / 2); await doc.mouse.down();
    await doc.mouse.move(shiftDot.x + shiftDot.width / 2 + 12, shiftDot.y + shiftDot.height / 2 + 12, { steps: 5 }); await doc.mouse.up();
    await doc.keyboard.up('Shift');
    const uniform = await input('Top-left radius').inputValue();
    for (const corner of ['Top-right', 'Bottom-right', 'Bottom-left']) assert.equal(await input(`${corner} radius`).inputValue(), uniform);
    const cancelPath = await outline.getAttribute('d');
    const cancelDot = await shape.locator('[data-radius-corner="tr"]').boundingBox();
    await doc.mouse.move(cancelDot.x + cancelDot.width / 2, cancelDot.y + cancelDot.height / 2); await doc.mouse.down();
    await doc.mouse.move(cancelDot.x - 12, cancelDot.y + 24, { steps: 5 }); await doc.keyboard.press('Escape'); await doc.mouse.up();
    assert.equal(await outline.getAttribute('d'), cancelPath, 'Escape discards the radius preview');
    await doc.getByRole('button', { name: 'Select layer Rectangle', exact: true }).click();
    await input('Corner radius').fill('12'); await input('Corner radius').press('Tab');
    for (const corner of ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left']) assert.equal(await input(`${corner} radius`).inputValue(), '12');
    await input('Bottom-left radius').fill('28'); await input('Bottom-left radius').press('Tab');
    await doc.getByRole('button', { name: 'Individual corner radii', exact: true }).click();
    await doc.getByRole('button', { name: 'Individual corner radii', exact: true }).click();
    assert.equal(await input('Bottom-left radius').inputValue(), '28');
    await doc.screenshot({ path: path.join(temp, 'corners.png') });
    await doc.getByRole('button', { name: 'Lock layer Rectangle', exact: true }).click();
    assert.equal(await shape.locator('[data-radius-corner]').count(), 0);
    await doc.getByRole('button', { name: 'Unlock layer Rectangle', exact: true }).click();
    await doc.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await doc.locator('[data-radius-corner]').count(), 0);
    await doc.getByRole('button', { name: 'Save PDF', exact: true }).click();
    await doc.locator('dialog.save-feedback').waitFor({ state: 'hidden' }); await doc.waitForFunction(() => !document.querySelector('.unsaved-dot'));
    const saved = await PDFDocument.load(await fs.readFile(file));
    const stream = saved.context.lookup(saved.catalog.get(PDFName.of('AsterPDFEditableObjectsV1')));
    const objects = JSON.parse(new TextDecoder().decode(decodePDFRawStream(stream).decode()));
    assert.deepEqual(objects[0].radiusCorners, [12, 12, 12, 28]);
    assert.deepEqual(errors, []);
    console.log(`Corner radius passed: live fields, individual dots, undo/redo, global reset, mode isolation, PDF save. Preview: ${path.join(temp, 'corners.png')}`);
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); }
    await server.close(); await fs.rm(file, { force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
