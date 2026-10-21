const { chromium } = require('playwright');
const { createServer } = require('vite');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const harness = { name: 'comment-editor-harness', configureServer(server) {
  server.middlewares.use('/__comment_editor.html', async (_req, res) => {
    const html = `<div id="root"></div><script type="module">
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import CommentEditor, {CommentBody} from '/src/components/CommentEditor.tsx';
      import '/src/styles.css';
      function Harness() {
        const [value, setValue] = useState({text:'',bold:[]});
        window.commentValue = value;
        window.setCommentValue = setValue;
        return React.createElement(React.Fragment, null,
          React.createElement(CommentEditor, {value:value.text, bold:value.bold, label:'Write a comment', onChange:(text,bold)=>setValue({text,bold})}),
          React.createElement(CommentBody, value));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script>`;
    res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__comment_editor.html', html));
  });
  } };
  const server = await createServer({ configFile: false, root: path.join(__dirname, '..'), plugins:[harness], esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge', headless:true});
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__comment_editor.html`);
    const editor=page.getByRole('textbox', {name:'Write a comment'});
    await editor.fill('مرحبا بالعالم');
    assert.equal(await editor.getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('.comment-formatted-text').getAttribute('dir'), 'rtl');
    await editor.press('Control+a'); await editor.press('Control+b');
    assert.deepEqual(await page.evaluate(()=>window.commentValue.bold), [[0,13]]);
    assert.equal(await page.locator('.comment-formatted-text strong').textContent(), 'مرحبا بالعالم');
    await editor.press('Control+b');
    assert.deepEqual(await page.evaluate(()=>window.commentValue.bold), []);
    // The Mac shortcut takes the same route, including toggling off.
    await editor.press('Meta+b');
    assert.deepEqual(await page.evaluate(()=>window.commentValue.bold), [[0,13]]);
    await editor.press('Meta+b');
    // Collapsed selection: bold only the text typed after the shortcut.
    await editor.press('ArrowRight'); await editor.press('Control+End');
    await editor.press('Control+b'); await page.keyboard.insertText(' مهم');
    assert.deepEqual(await page.evaluate(()=>window.commentValue.bold), [[13,17]]);
    await editor.press('Control+b'); await editor.press('Enter');
    await page.keyboard.insertText('سطر جديد');
    assert.equal(await page.evaluate(()=>window.commentValue.text), 'مرحبا بالعالم مهم\nسطر جديد');
    assert.deepEqual(await page.evaluate(()=>window.commentValue.bold), [[13,17]]);
    // Synchronize a saved edit back into the editor, then switch direction live.
    await page.evaluate(()=>window.setCommentValue({text:'English text',bold:[[0,7]]}));
    await page.waitForFunction(()=>document.querySelector('.comment-editor').getAttribute('dir')==='ltr');
    assert.equal(await editor.textContent(), 'English text');
    assert.equal(await page.locator('.comment-formatted-text strong').textContent(), 'English');
    // Submitted multiline comments keep one base direction, even when the
    // next line begins with a different script (including its punctuation).
    for (const sample of [
      { text: '- النقطة الاولى\n- fsd 324', direction: 'rtl', edge: 'right' },
      { text: '- First point\n- النقطة التالية', direction: 'ltr', edge: 'left' }
    ]) {
      await page.evaluate(text=>window.setCommentValue({text,bold:[]}), sample.text);
      await page.waitForFunction(text=>document.querySelector('.comment-formatted-text').textContent===text, sample.text);
      const bounds = await page.locator('.comment-formatted-text').evaluate(body=>{
        body.style.width='320px';
        const node=body.firstChild.firstChild;
        const range=document.createRange();
        range.setStart(node, node.textContent.indexOf('\n')+1);
        range.setEnd(node, node.textContent.length);
        const line=range.getBoundingClientRect(), box=body.getBoundingClientRect();
        return { direction:getComputedStyle(body).direction, left:line.left-box.left, right:box.right-line.right };
      });
      assert.equal(bounds.direction, sample.direction);
      assert.ok(Math.abs(bounds[sample.edge])<1, `Second line must follow ${sample.direction}: ${JSON.stringify(bounds)}`);
    }
    assert.deepEqual(errors, []);
    console.log('Comment editor: Arabic direction, Ctrl+B / Cmd+B, selection and typing bold, multiline, and restored formatting passed.');
  } finally { await browser?.close(); await server.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
