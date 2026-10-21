import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addTextNotes, changeComments, readPageComments } from '../src/pdf/comments';
import { commentDirection, sameComment, trimComment } from '../src/pdf/comment-text';

test('Arabic comments use RTL and formatting-only edits count as changes', () => {
  assert.equal(commentDirection('  «123 مرحباً بالعالم'), 'rtl');
  assert.equal(commentDirection('English ثم عربي'), 'ltr');
  assert.equal(commentDirection(''), 'ltr');
  assert.deepEqual(trimComment({ text: '  bold  ', bold: [[2, 6]] }), { text: 'bold', bold: [[0, 4]] });
  assert.equal(sameComment({ text: 'bold' }, { text: 'bold', bold: [[0, 4]] }), false);
});

test('Arabic bold comments and replies retain their formatting through PDF save, reopen, and edit', async () => {
  const document = await PDFDocument.create(); document.addPage([600, 800]);
  const text = 'مرحبا بالعالم\nسطر <ثان> & (مهم) ✓ \\ unmatched (';
  const bold: [number, number][] = [[0, 5], [14, text.length]];
  const note = { id: 'root', page: 1, x: 40, y: 600, author: 'Reviewer', text, bold, date: '2026-10-21' };
  const read = async (bytes: Uint8Array) => {
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
      const pdf = await task.promise;
      return readPageComments(await (await pdf.getPage(1)).getAnnotations(), 1);
    } finally { await task.destroy(); }
  };
  const bytes = await addTextNotes(await document.save(), [note, { ...note, id: 'reply', replyTo: note.id }]);
  const comments = await read(bytes);
  assert.equal(comments.length, 2);
  for (const comment of comments) {
    assert.equal(comment.text, text);
    assert.deepEqual(comment.bold, bold);
  }
  const edited = await changeComments(bytes, [{ operationId: 'unbold', target: comments[0], type: 'edit', text, bold: [], date: note.date }]);
  const reopened = await read(edited);
  assert.deepEqual(reopened[0].bold, []);
  assert.deepEqual(reopened[1].bold, bold);
});
