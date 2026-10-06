import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addTextNotes, readPageComments } from '../src/pdf/comments';

test('saved PDF notes retain their author, text, and page across PDF.js parsing', async () => {
  const document = await PDFDocument.create();
  document.addPage([600, 800]);
  document.addPage([600, 800]);
  const original = await document.save();
  const saved = await addTextNotes(original, [{
    id: 'note-1', page: 2, x: 120, y: 250,
    author: 'ليلى أحمد', text: 'Please check this section. ✓', date: '2026-10-06T08:30:00.000Z'
  }]);
  const task = pdfjs.getDocument({ data: saved.slice() });
  try {
    const parsed = await task.promise;
    assert.equal(parsed.numPages, 2);
    assert.equal((await (await parsed.getPage(1)).getAnnotations()).length, 0);
    const annotations = await (await parsed.getPage(2)).getAnnotations();
    const comments = readPageComments(annotations, 2);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].author, 'ليلى أحمد');
    assert.equal(comments[0].text, 'Please check this section. ✓');
    assert.equal(comments[0].kind, 'Text note');
    assert.equal(comments[0].page, 2);
    assert.equal(comments[0].rect[0], 120);
  } finally {
    await task.destroy();
  }
});
