import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addTextNotes, changeComments, commentThreads, inMarkupThread, noteAsComment, readAllPageComments, readPageComments, MARKUP_COLORS, type MarkupKind, type NewNote } from '../src/pdf/comments';
import { captureMarkups } from '../src/pdf/markup-history';

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

test('text markups save without a comment and accept an explicitly written note later', async () => {
  const document = await PDFDocument.create();
  document.addPage([600, 800]);
  const original = await document.save();
  const date = '2026-10-20T08:30:00.000Z';
  const kinds: MarkupKind[] = ['Highlight', 'Strikeout', 'Underline'];
  const saved = await addTextNotes(original, kinds.map((kind, index) => ({
    id: `markup-${index}`, page: 1, x: 20, y: 700 - index * 30, author: 'Reviewer', text: '', date,
    markup: { kind, color: MARKUP_COLORS[kind], quadPoints: [20, 720 - index * 30, 180, 720 - index * 30, 20, 700 - index * 30, 180, 700 - index * 30] }
  })));
  const read = async (bytes: Uint8Array) => {
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
      const parsed = await task.promise;
      return readPageComments(await (await parsed.getPage(1)).getAnnotations(), 1);
    } finally { await task.destroy(); }
  };
  const markups = await read(saved);
  assert.deepEqual(markups.map(markup => markup.kind), kinds);
  assert.ok(markups.every(markup => markup.text === '' && markup.quadPoints?.length === 8));
  const recolored = await changeComments(saved, [{
    operationId: 'color', target: markups[0], type: 'color', color: '#00ff00', date
  }]);
  const recoloredMarkups = await read(recolored);
  assert.equal(recoloredMarkups[0].text, '');
  assert.equal(recoloredMarkups[0].color, '#00ff00');
  const annotated = await changeComments(recolored, [{
    operationId: 'note', target: recoloredMarkups[0], type: 'edit', text: 'Please verify this figure.', date
  }]);
  const notes = await read(annotated);
  assert.equal(notes[0].text, 'Please verify this figure.');
  assert.equal(notes[0].kind, 'Highlight');
  assert.equal(notes[0].color, '#00ff00');
  assert.ok(notes.slice(1).every(note => note.text === ''));
  await assert.rejects(addTextNotes(original, [{
    id: 'empty-note', page: 1, x: 20, y: 700, author: 'Reviewer', text: '', date
  }]), /Invalid note/);
});

test('replies retain PDF thread links, author and text through save, edit and parent deletion', async () => {
  const document = await PDFDocument.create();
  document.addPage([600, 800]);
  const date = '2026-10-20T09:00:00.000Z';
  const root: NewNote = { id: 'parent', page: 1, x: 50, y: 600, author: 'Yousif', text: 'Check this total.', date };
  const reply: NewNote = { ...root, id: 'reply', author: 'ليلى', text: 'تم التحقق من الإجمالي.', replyTo: root.id };
  const read = async (bytes: Uint8Array) => {
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
      const parsed = await task.promise;
      return readPageComments(await (await parsed.getPage(1)).getAnnotations(), 1);
    } finally { await task.destroy(); }
  };
  // Reply before parent exercises a batch containing newly created annotations.
  const bytes = await addTextNotes(await document.save(), [reply, root]);
  const comments = await read(bytes);
  const threads = commentThreads(comments);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].text, root.text);
  assert.equal(threads[0].replies?.[0].text, reply.text);
  assert.equal(threads[0].replies?.[0].author, reply.author);
  assert.equal(threads[0].replies?.[0].replyTo, threads[0].id);
  const nextReply: NewNote = { ...reply, id: 'second-reply', text: 'Confirmed.', replyTo: threads[0].replies![0].id };
  const nested = await read(await addTextNotes(bytes, [nextReply]));
  assert.equal(commentThreads(nested)[0].replies?.length, 2);
  const editedBytes = await changeComments(bytes, [{
    operationId: 'edit-reply', target: threads[0].replies![0], type: 'edit', text: 'Corrected reply.', date
  }]);
  const edited = commentThreads(await read(editedBytes));
  assert.equal(edited[0].replies?.[0].text, 'Corrected reply.');
  const deleted = await read(await changeComments(editedBytes, [{
    operationId: 'delete-parent', target: edited[0], type: 'delete', date
  }]));
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].text, 'Corrected reply.');
  assert.equal(deleted[0].replyTo, undefined);
  assert.equal(commentThreads(deleted).length, 1);
  await assert.rejects(addTextNotes(bytes, [{ ...reply, id: 'bad-reply', replyTo: 'missing' }]), /parent comment could not be found/);
});

test('highlight reply threads stay with manual-save and undo history', () => {
  const parent: NewNote = { id: 'highlight', page: 1, x: 0, y: 0, author: 'Reviewer', text: 'Check this.', date: '2026-10-20',
    markup: { kind: 'Highlight', color: '#ffdf32', quadPoints: [0, 10, 50, 10, 0, 0, 50, 0] } };
  const reply: NewNote = { id: 'reply', page: 1, x: 0, y: 0, author: 'Reviewer', text: 'Checked.', date: parent.date, replyTo: parent.id };
  const ordinary: NewNote = { ...reply, id: 'ordinary', replyTo: undefined };
  const drafts = [parent, reply, ordinary];
  const comments = drafts.map(note => noteAsComment(note));
  assert.equal(inMarkupThread(comments[1], comments), true);
  assert.equal(inMarkupThread(comments[2], comments), false);
  const snapshot = captureMarkups(drafts, [], {}, []);
  assert.deepEqual(snapshot.drafts.map(note => note.id), ['highlight', 'reply']);
  assert.deepEqual(snapshot.ids, ['highlight', 'reply']);
});

test('comment loading includes non-viewable annotations and rich-text-only replies', async () => {
  // Build external annotation dictionaries directly, independent of AsterPDF's
  // writer: /RC-only content, NoView flags, /IRT and a separate Popup.
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const root = document.context.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [20, 600, 150, 650], F: 32,
    T: PDFHexString.fromText('Reviewer'),
    RC: PDFString.of('<body xmlns="http://www.w3.org/1999/xhtml"><p>Please check this amount.</p></body>')
  });
  const rootRef = document.context.register(root);
  const reply = document.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 600, 40, 620], F: 32,
    T: PDFHexString.fromText('مراجع'), Contents: PDFHexString.fromText(''),
    RC: PDFString.of(`<body xmlns="http://www.w3.org/1999/xhtml"><p>${Array.from('تمت المراجعة').map(char => `&#${char.codePointAt(0)};`).join('')}</p></body>`),
    IRT: rootRef, RT: 'R'
  });
  const replyRef = document.context.register(reply);
  const popupRef = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Popup', Rect: [160, 600, 300, 700], Parent: rootRef
  }));
  root.set(PDFName.of('Popup'), popupRef);
  page.node.set(PDFName.of('Annots'), document.context.obj([rootRef, replyRef, popupRef]));
  const task = pdfjs.getDocument({ data: await document.save() });
  try {
    const pdf = await task.promise;
    const pdfPage = await pdf.getPage(1);
    const displayed = readPageComments(await pdfPage.getAnnotations({ intent: 'display' }), 1);
    assert.equal(displayed.length, 0, 'display-only reading reproduces missing comments');
    const comments = await readAllPageComments(pdfPage, 1);
    assert.equal(comments.length, 2, 'the popup is not a second copy of its parent');
    const threads = commentThreads(comments);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].text, 'Please check this amount.');
    assert.equal(threads[0].replies?.[0].text, 'تمت المراجعة');
    assert.equal(threads[0].replies?.[0].author, 'مراجع');
  } finally { await task.destroy(); }
});
