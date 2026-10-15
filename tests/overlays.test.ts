import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { attachOverlayPackage, embedOverlays, readOverlayPackage, type OverlayObject } from '../src/pdf/overlays';
import type { PageViewport } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

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
