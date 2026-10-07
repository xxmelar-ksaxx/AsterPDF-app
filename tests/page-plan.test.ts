import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { addTextNotes } from '../src/pdf/comments';
import { composePagePlan } from '../src/pdf/edit';
import { changePagePlan, initialPagePlan, remapPageSelection } from '../src/pdf/page-plan';

test('selection follows pages through moves, rotation, duplication, and deletion', () => {
  let pages = initialPagePlan(4);
  let selected = new Set([1, 2]);
  const apply = (edit: Parameters<typeof changePagePlan>[1]) => {
    const next = changePagePlan(pages, edit);
    selected = remapPageSelection(pages, next, selected);
    pages = next;
  };
  apply({ type: 'batch', pages: [1, 2], action: 'move-down' });
  assert.deepEqual([...selected], [2, 3]);
  apply({ type: 'batch', pages: [...selected], action: 'rotate-right' });
  assert.deepEqual([...selected], [2, 3]);
  apply({ type: 'batch', pages: [...selected], action: 'duplicate' });
  assert.deepEqual([...selected], [2, 4]);
  apply({ type: 'batch', pages: [...selected], action: 'delete' });
  assert.deepEqual([...selected], [2]);
  assert.equal(pages[2].sourceIndex, 1);
});

test('deleting the selected page selects the nearest survivor', () => {
  const pages = initialPagePlan(3);
  const next = changePagePlan(pages, { type: 'batch', pages: [2], action: 'delete' });
  assert.deepEqual([...remapPageSelection(pages, next, new Set([2]))], [1]);
});

test('page actions stay in memory until composition and preserve comments', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 500]);
  pdf.addPage([400, 600]);
  const source = await addTextNotes(new Uint8Array(await pdf.save()), [{
    id: 'note', page: 2, x: 40, y: 50, author: 'Tester', text: 'Second page', date: new Date().toISOString()
  }]);
  const originalSize = source.byteLength;
  let plan = initialPagePlan(2);
  plan = changePagePlan(plan, { type: 'move', from: 1, to: 0 });
  plan = changePagePlan(plan, { type: 'duplicate', page: 0 });
  plan = changePagePlan(plan, { type: 'rotate', page: 0, degrees: 90 });
  assert.equal(source.byteLength, originalSize);
  assert.equal((await PDFDocument.load(source)).getPageCount(), 2);
  const result = await PDFDocument.load(await composePagePlan(source, plan));
  assert.equal(result.getPageCount(), 3);
  assert.deepEqual(result.getPages().map((page) => page.getWidth()), [400, 400, 300]);
  assert.equal(result.getPage(0).getRotation().angle, 90);
  assert.equal(result.getPage(0).node.Annots()?.size(), 1);
  assert.equal(result.getPage(1).node.Annots()?.size(), 1);
});
