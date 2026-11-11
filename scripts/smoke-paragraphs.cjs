const { _electron } = require('playwright');
const { createServer } = require('vite');
const { PDFDocument } = require('pdf-lib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { listOriginalText, replaceOriginalText } = require('../electron/original-text.cjs');

async function waitFor(check) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for paragraph edit');
}

async function main() {
  const root = path.join(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-paragraphs-'));
  const file = path.join(temp, 'Paragraphs.pdf');
  const fixture = await PDFDocument.create();
  const page = fixture.addPage([600, 680]);
  for (const [row, text] of ['First original line', 'Second original line', 'Third original line'].entries()) {
    page.drawText(text, {x:40, y:550-row*24, size:16});
    page.drawText('Other column '+row, {x:360, y:550-row*24, size:16});
  }
  page.drawText('Arabic one', {x:55, y:360, size:16});
  page.drawText('Arabic two', {x:55, y:336, size:16});
  page.drawText('Arabic three', {x:55, y:302, size:16});
  for (const [y,text] of [[230,'Opening words'],[212,'of the story.'],[185,'Later in the story'],[167,'the author writes.'],[140,'The final remark.']]) {
    page.drawText(text,{x:40,y,size:12});
    page.drawText('Side '+y,{x:360,y,size:12});
  }
  let original = await fixture.save();
  for (const [placeholder, text] of [['Arabic one','مرحبا بالعالم'], ['Arabic two','نص الفقرة'],['Arabic three','فقرة أخرى']]) {
    const object = (await listOriginalText(original, 0)).find(item => item.text === placeholder);
    original = await replaceOriginalText(original,0,object.index,object.text,text,'noto-naskh-arabic');
  }
  await fs.writeFile(file, original);
  const server = await createServer({configFile:false, root, server:{host:'127.0.0.1',port:0}});
  await server.listen();
  const env = {...process.env, ASTERPDF_DEV_URL:'http://127.0.0.1:'+server.httpServer.address().port};
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({executablePath:require('electron'),args:[root,'--user-data-dir='+temp,file],env});
    let doc;
    await waitFor(async () => {
      doc = app.context().pages().find(p => p.url().startsWith(env.ASTERPDF_DEV_URL) && !p.url().includes('workspace=1'));
      return doc && await doc.locator('.rail-page-number').count();
    });
    doc.setDefaultTimeout(10000);
    const button = name => doc.getByRole('button',{name,exact:true});
    const edit = doc.getByRole('textbox',{name:'Edit PDF paragraph',exact:true});
    await button('Edit').click();
    for (const line of ['First original line','Third original line']) {
      await doc.locator(`svg[aria-label^="Original text frame: ${line}"] .text-frame-interior`).click({modifiers:['Control']});
    }
    await button('Edit selected lines as paragraph').click();
    await Promise.race([edit.waitFor(),doc.locator('.error-banner').waitFor().then(async()=>{throw Error(await doc.locator('.error-banner').innerText());})]);
    assert.equal(await edit.inputValue(),'First original line Third original line');
    await edit.press('Escape');
    await button('Edit paragraph').click();
    const english = button('Edit paragraph: First original line Second original line Third original line');
    await english.click({position:{x:8,y:8}});
    const caret = await edit.evaluate(field => [field.selectionStart, field.selectionEnd]);
    assert.ok(caret[0] === caret[1] && caret[0] < 5, 'Click should place the caret near the first word');
    assert.equal(await edit.inputValue(), 'First original line Second original line Third original line');
    await edit.press('Escape');
    await english.click();
    await edit.press('Control+Enter');
    assert.equal(await doc.locator('[data-overlay-kind="text"]').count(),0);
    await english.click();
    await edit.fill('A paragraph with enough new words to wrap onto several lines in the original column width.');
    await edit.press('Control+Enter');
    assert.ok(await doc.locator('[data-overlay-kind="text"] tspan').count() >= 3);
    await button('Undo edit').click();
    await english.click();
    await edit.fill('First');
    await button('Paragraph spacing').click();
    await doc.getByRole('spinbutton',{name:'Line spacing'}).fill('1.75');
    await doc.getByLabel('Spacing after paragraph break').selectOption('1');
    await button('Paragraph spacing').click();
    await edit.focus();
    await edit.press('End');
    await edit.press('Shift+Enter');
    await doc.keyboard.type('Second');
    await edit.press('Enter');
    await doc.keyboard.type('Third');
    assert.equal(await edit.inputValue(),'First\nSecond\n\nThird');
    await edit.press('Control+Enter');
    const overlays = doc.locator('[data-overlay-kind="text"]');
    await waitFor(async () => await overlays.count() === 1);
    const positions = await overlays.locator('tspan').evaluateAll(spans => spans.filter(s=>s.textContent).map(s=>+s.getAttribute('y')));
    assert.ok(Math.abs((positions[2]-positions[1])/(positions[1]-positions[0])-2)<.01);
    await button('Undo edit').click();
    await english.waitFor();
    assert.equal(await overlays.count(),0);
    await button('Redo edit').click();
    const arabic = doc.getByRole('button',{name:/^Edit paragraph: مرحبا بالعالم نص الفقرة/});
    await arabic.click();
    assert.equal(await edit.evaluate(el=>getComputedStyle(el).direction),'rtl');
    await edit.press('Control+a');
    await doc.keyboard.insertText('تعديل الفقرة');
    await edit.press('Enter');
    await doc.keyboard.insertText('نص جديد');
    await edit.press('Control+Enter');
    await waitFor(async () => await overlays.count() === 2);
    // An earlier single-paragraph edit must also join the neighboring native paragraphs.
    await button('Select objects').click();
    for (const line of ['Opening words','of the story.']) {
      await doc.locator(`svg[aria-label^="Original text frame: ${line}"] .text-frame-interior`).click({modifiers:['Control']});
    }
    await button('Edit selected lines as paragraph').click();
    await edit.fill('Opening words of the story!');
    await edit.press('Control+Enter');
    await button('Edit paragraph').click();
    const flowButton = doc.getByRole('button',{name:/^Edit paragraph: Opening words/});
    await flowButton.click();
    const field = doc.locator('.flow-text-field');
    await field.waitFor();
    const paragraphs = field.locator(':scope > div');
    assert.deepEqual(await paragraphs.allTextContents(),['Opening words of the story!','Later in the story the author writes.','The final remark.']);
    assert.equal(await doc.locator('.original-drag-preview canvas').nth(1).evaluate(el=>el.style.visibility),'hidden');
    // Removing a paragraph break should join the two blocks and collapse its gap.
    await paragraphs.nth(1).evaluate(block=>{
      const range=document.createRange();range.setStart(block.firstChild,0);range.collapse(true);
      const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
    });
    await field.press('Backspace');
    assert.equal(await paragraphs.count(),2);
    await field.press('Control+z');
    assert.equal(await paragraphs.count(),3);
    const firstTop = await paragraphs.nth(1).evaluate(el=>el.getBoundingClientRect().top);
    await paragraphs.first().click();
    await doc.keyboard.press('Home');
    await doc.keyboard.type('Additional words inserted here to extend the first paragraph substantially. ');
    assert.ok((await paragraphs.nth(1).evaluate(el=>el.getBoundingClientRect().top))>firstTop+10);
    await field.press('Control+End');
    await field.press('Enter');
    await doc.keyboard.type('Ending');
    assert.equal(await paragraphs.count(),4);
    await field.press('Shift+Enter');
    await doc.keyboard.type('Soft');
    assert.equal(await paragraphs.count(),4);
    await field.press('Control+Enter');
    await waitFor(async()=>await overlays.count()===3);
    await button('Undo edit').click();
    await flowButton.waitFor();
    assert.equal(await overlays.filter({hasText:'Opening words'}).count(),1);
    await button('Redo edit').click();
    await waitFor(async()=>await overlays.filter({hasText:'Ending'}).count()===1);
    assert.deepEqual(new Uint8Array(await fs.readFile(file)),new Uint8Array(original));
    await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='File').submenu.items.find(i=>i.label==='Save').click());
    await waitFor(async () => {
      if (await doc.locator('.error-banner').count()) throw Error(await doc.locator('.error-banner').innerText());
      return !(await fs.readFile(file)).equals(Buffer.from(original));
    });
    const written = await listOriginalText(await fs.readFile(file),0);
    for (const value of ['First','Second','Third','Other column 0','تعديل الفقرة','نص جديد']) assert.ok(written.some(item=>item.text.trim()===value), value);
    assert.ok(!written.some(item=>item.text.includes('original line')));
    const baseline = text => written.find(item=>item.text===text).matrix[5];
    assert.ok(Math.abs(baseline('تعديل الفقرة')-baseline('نص جديد')-34)<.15);
    assert.ok(Math.abs(baseline('First')-baseline('Second')-28)<.1);
    assert.ok(Math.abs(baseline('Second')-baseline('Third')-56)<.1);
    assert.ok(Math.abs(baseline('The final remark.')-baseline('Ending')-27)<.1);
    assert.ok(Math.abs(baseline('Ending')-baseline('Soft')-18)<.1);
    const shell = app.context().pages().find(p=>p.url().includes('workspace=1'));
    await waitFor(async()=> (await shell.evaluate(()=>window.aster.getWorkspace())).tabs.every(tab=>!tab.dirty&&!tab.busy));
    await shell.locator('.workspace-brand').click();
    await button('Open Paragraphs.pdf').click();
    await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});
    await button('Edit').click();
    await waitFor(async()=>await overlays.count()===3);
    await overlays.filter({hasText:'Ending'}).locator('.text-frame-interior').click();
    assert.equal(await doc.locator('.flow-text-field > div').count(),4);
    await doc.locator('.flow-text-field').press('Escape');
    const reopened = overlays.filter({has:doc.getByText('First',{exact:true})}).locator('.text-frame-interior');
    await reopened.click();
    const editor = doc.getByRole('textbox',{name:'Edit text on page'});
    assert.equal(await editor.inputValue(),'First\nSecond\n\nThird');
    await editor.press('Escape');
    console.log('PASS native and previously edited paragraphs, reflow, measured break spacing, preview handoff, RTL, undo/redo and editable reopen.');
  } finally {
    if (app) {
      await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
      await app.close().catch(()=>{});
    }
    await server.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
