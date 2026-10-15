import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addTextNotes, readPageComments } from '../src/pdf/comments';
import { appendPdfs, editPages } from '../src/pdf/edit';

test('sorting, duplicating, rotating, deleting and appending pages keep PDF notes', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 500]);
  pdf.addPage([400, 600]);
  let bytes = await addTextNotes(new Uint8Array(await pdf.save()), [{
    id: 'first-note', page: 2, x: 42, y: 80, author: 'Editor', text: 'Keep me', date: new Date().toISOString()
  }]);
  bytes = await editPages(bytes, { type: 'move', from: 1, to: 0 });
  bytes = await editPages(bytes, { type: 'duplicate', page: 0 });
  bytes = await editPages(bytes, { type: 'rotate', page: 0, degrees: 90 });
  bytes = await editPages(bytes, { type: 'delete', page: 2 });
  const extra = await PDFDocument.create();
  extra.addPage([200, 300]);
  bytes = await appendPdfs(bytes, [new Uint8Array(await extra.save())]);
  const result = await PDFDocument.load(bytes);
  assert.equal(result.getPageCount(), 3);
  assert.equal(result.getPage(0).getRotation().angle, 90);
  assert.equal(result.getPage(2).getWidth(), 200);
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const parsed = await task.promise;
    const first = readPageComments(await (await parsed.getPage(1)).getAnnotations(), 1);
    const second = readPageComments(await (await parsed.getPage(2)).getAnnotations(), 2);
    assert.equal(first[0]?.text, 'Keep me');
    assert.equal(second[0]?.text, 'Keep me');
  } finally { await task.destroy(); }
});

test('group page actions keep selected order and reject deleting every page', async () => {
  const pdf = await PDFDocument.create();
  for (const width of [100, 200, 300, 400]) pdf.addPage([width, 500]);
  let bytes = new Uint8Array(await pdf.save());
  bytes = await editPages(bytes, { type: 'batch', pages: [1, 2], action: 'move-down' });
  let result = await PDFDocument.load(bytes);
  assert.deepEqual(result.getPages().map((page) => page.getWidth()), [100, 400, 200, 300]);
  bytes = await editPages(bytes, { type: 'batch', pages: [2, 3], action: 'duplicate' });
  result = await PDFDocument.load(bytes);
  assert.deepEqual(result.getPages().map((page) => page.getWidth()), [100, 400, 200, 200, 300, 300]);
  const addition = await PDFDocument.create();
  addition.addPage([250, 500]);
  const inserted = await appendPdfs(bytes, [new Uint8Array(await addition.save())], 1);
  assert.deepEqual((await PDFDocument.load(inserted)).getPages().map((page) => page.getWidth()), [100, 400, 250, 200, 200, 300, 300]);
  await assert.rejects(() => editPages(bytes, { type: 'batch', pages: [0, 1, 2, 3, 4, 5], action: 'delete' }), /at least one page/);
});
