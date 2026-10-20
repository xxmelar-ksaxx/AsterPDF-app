import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { attachOverlayPackage, embedOverlays, readOverlayPackage, type OverlayObject } from '../src/pdf/overlays';
import type { PageViewport } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addTextNotes, changeComments, commentThreads, readAllPageComments } from '../src/pdf/comments';

test('reopening an editable PDF preserves external comments, replies, edits and deletions', async () => {
  const original = await PDFDocument.create();
  const page = original.addPage([300, 400]);
  page.drawText('Original content', { x: 30, y: 340, size: 15 });
  const date = '2026-10-20T09:00:00.000Z';
  const base = await addTextNotes(await original.save(), [
    { id: 'root', page: 1, x: 20, y: 250, author: 'Aster user', text: 'Original note', date },
    { id: 'deleted', page: 1, x: 50, y: 250, author: 'Aster user', text: 'Delete me', date }
  ]);
  const object: OverlayObject = { id: 'text', pageId: 'source-0', kind: 'text', x: .2, y: .5, width: .3, height: .1,
    color: '#172333', lineWidth: 2, text: 'Editable label' };
  const viewport = { width: 300, height: 400, convertToPdfPoint: (x: number, y: number) => [x, 400 - y] } as PageViewport;
  const pages = [{ pageId: 'source-0', index: 0, viewport }];
  const read = async (bytes: Uint8Array) => {
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
      const page = await (await task.promise).getPage(1);
      return { comments: await readAllPageComments(page, 1),
        text: (await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ') };
    } finally { await task.destroy(); }
  };
  let saved = await attachOverlayPackage(await embedOverlays(base, [object], pages), base, [object]);
  const before = await read(saved);
  saved = await changeComments(saved, [
    { operationId: 'external-edit', target: before.comments[0], type: 'edit', text: 'Edited in Acrobat', date },
    { operationId: 'external-delete', target: before.comments[1], type: 'delete', date }
  ]);
  saved = await addTextNotes(saved, [
    { id: 'external-reply', page: 1, x: 20, y: 250, author: 'Acrobat user', text: 'Reply from Acrobat', date, replyTo: before.comments[0].id },
    { id: 'external-note', page: 1, x: 100, y: 250, author: 'Acrobat user', text: 'Comment from Acrobat', date }
  ]);
  const restored = await readOverlayPackage(saved);
  assert.ok(restored);
  assert.deepEqual(restored.objects, [object]);
  const reopened = await read(restored.base);
  assert.equal(reopened.comments.length, 3);
  assert.ok(!reopened.comments.some(comment => comment.text === 'Delete me'));
  const thread = commentThreads(reopened.comments).find(comment => comment.text === 'Edited in Acrobat')!;
  assert.equal(thread.replies?.[0].text, 'Reply from Acrobat');
  assert.match(reopened.text, /Original content/);
  assert.doesNotMatch(reopened.text, /Editable label/, 'flattened text must not duplicate editable artwork');
  assert.deepEqual(reopened.comments.map(comment => comment.id), (await read(saved)).comments.map(comment => comment.id));
  // Reply using the reopened ID against the visible saved PDF, as background
  // saves do. IDs and relationships must remain usable in both versions.
  const updated = await addTextNotes(saved, [{
    id: 'aster-reply', page: 1, x: 20, y: 250, author: 'Aster user', text: 'Reply after reopening', date, replyTo: thread.id
  }]);
  const next = await readOverlayPackage(updated);
  assert.equal(commentThreads((await read(next!.base)).comments).find(comment => comment.id === thread.id)?.replies?.length, 2);
  const packaged = await attachOverlayPackage(updated, next!.base, [object]);
  assert.deepEqual((await readOverlayPackage(packaged))?.base, next!.base, 'unchanged annotations reuse the embedded base');
});

test('editable PDF package restores a clean base and objects across repeated saves', async () => {
  const original = await PDFDocument.create();
  const page = original.addPage([300, 400]);
  page.drawText('Original content', { x: 30, y: 340, size: 15, font: await original.embedFont(StandardFonts.Helvetica) });
  const base = new Uint8Array(await original.save());
  const viewport = { width: 300, height: 400, convertToPdfPoint: (x: number, y: number) => [x, 400 - y] } as PageViewport;
  const rectangle: OverlayObject = { id: 'shape', pageId: 'source-0', kind: 'rectangle', x: 0.1, y: 0.2,
    width: 0.35, height: 0.2, color: '#d94141', lineWidth: 3 };
  const text: OverlayObject = { id: 'text', pageId: 'source-0', kind: 'text', x: 0.2, y: 0.5,
    width: 0.3, height: 0.1, color: '#172333', lineWidth: 2, text: 'Added label' };
  const saved = await attachOverlayPackage(await embedOverlays(base, [rectangle, text],
    [{ pageId: 'source-0', index: 0, viewport }]), base, [rectangle, text]);
  const restored = await readOverlayPackage(saved);
  assert.ok(restored);
  assert.deepEqual(restored.objects, [rectangle, text]);
  assert.deepEqual(restored.base, base);
  const changed = { ...rectangle, x: 0.4, color: '#3387c7' };
  const resaved = await attachOverlayPackage(await embedOverlays(restored.base, [changed],
    [{ pageId: 'source-0', index: 0, viewport }]), restored.base, [changed]);
  const reopened = await readOverlayPackage(resaved);
  assert.deepEqual(reopened?.objects, [changed]);
  assert.deepEqual(reopened?.base, base);
  assert.equal((await PDFDocument.load(resaved)).getPageCount(), 1);
});

test('images extending beyond the page retain their full geometry after saving and reopening', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  const base = await pdf.save();
  const viewport = { width: 300, height: 400, convertToPdfPoint: (x: number, y: number) => [x, 400 - y] } as PageViewport;
  const image: OverlayObject = { id: 'bleed-image', pageId: 'source-0', kind: 'image', x: -.5, y: -.25,
    width: 2, height: 1.5, color: '#172333', lineWidth: 2,
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAI0lEQVR4AaTKMQ0AAAwCwQZXrX9FNQAOYOCT3w5/Szcm1AMBAAD//6pXaswAAAAGSURBVAMAo+gTKW0QhWMAAAAASUVORK5CYII=' };
  const bytes = await embedOverlays(base, [image], [{ pageId: 'source-0', index: 0, viewport }]);
  const reopened = await readOverlayPackage(await attachOverlayPackage(bytes, base, [image]));
  assert.deepEqual(reopened?.objects, [image]);
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(1);
    assert.deepEqual(page.view, [0, 0, 300, 400]);
    const operators = await page.getOperatorList();
    assert.ok(operators.argsArray.some((args: number[], index: number) => operators.fnArray[index] === pdfjs.OPS.transform && args[4] === -150 && args[5] === -100));
    assert.ok(operators.fnArray.includes(pdfjs.OPS.paintImageXObject));
  } finally { await task.destroy(); }
});

test('new text saves its point size independently of drawing width and retains legacy text sizing', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]);
  const base = await pdf.save();
  const viewport = { width: 500, height: 700, convertToPdfPoint: (x: number, y: number) => [x, 700 - y] } as PageViewport;
  const legacy: OverlayObject = { id: 'legacy', pageId: 'source-0', kind: 'text', x: 0.1, y: 0.2,
    width: 0.3, height: 0.1, color: '#172333', lineWidth: 2, text: 'Legacy text' };
  const modern: OverlayObject = { ...legacy, id: 'modern', y: 0.4, fontSize: 28, lineWidth: 7, text: 'Point size text' };
  const bytes = await embedOverlays(base, [legacy, modern], [{ pageId: 'source-0', index: 0, viewport }]);
  const loading = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await loading.promise).getPage(1);
    const items = (await page.getTextContent()).items.filter((item) => 'str' in item);
    assert.equal(items.find((item) => item.str === 'Legacy text')?.height, 16);
    assert.equal(items.find((item) => item.str === 'Point size text')?.height, 28);
  } finally { await loading.destroy(); }
  const reopened = await readOverlayPackage(await attachOverlayPackage(bytes, base, [legacy, modern]));
  assert.equal(reopened?.objects[1].fontSize, 28);
});
