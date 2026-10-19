import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { constrainDraw, shapePath } from '../src/pdf/draw-geometry';
import { attachOverlayPackage, embedOverlays, readOverlayPackage, type OverlayObject } from '../src/pdf/overlays';
const { createCanvas } = createRequire(import.meta.url)('@napi-rs/canvas');

test('Shift constraints use physical page dimensions and line angles snap in all directions', () => {
  const start = { x: .5, y: .5 };
  for (const end of [{ x: .7, y: .8 }, { x: .2, y: .8 }, { x: .2, y: .1 }]) {
    const box = constrainDraw(start, end, 300, 600, false);
    assert.ok(Math.abs(Math.abs(box.x - start.x) * 300 - Math.abs(box.y - start.y) * 600) < 1e-8);
    const line = constrainDraw(start, end, 300, 600, true);
    const angle = Math.atan2((line.y - start.y) * 600, (line.x - start.x) * 300) / (Math.PI / 4);
    assert.ok(Math.abs(angle - Math.round(angle)) < 1e-8);
  }
  assert.equal(shapePath('rectangle', 80, 40, 999), shapePath('rectangle', 80, 40, 20));
});

test('rounded fills, opacity, hidden layers and stacking export correctly on normal and rotated pages', async () => {
  for (const rotation of [0, 90]) {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).setRotation(degrees(rotation));
    const base = await pdf.save();
    const original = pdfjs.getDocument({ data: base.slice() });
    const viewport = (await (await original.promise).getPage(1)).getViewport({ scale: 1 });
    await original.destroy();
    const shape: OverlayObject = { id: 'rounded', pageId: 'source-0', kind: 'rectangle', x: .2, y: .2,
      width: .4, height: .3, color: '#000000', lineWidth: 0, fill: '#ff0000', radius: 20, opacity: .5, name: 'Card', locked: true };
    const hidden = { ...shape, id: 'hidden', fill: '#00ff00', opacity: 1, hidden: true };
    const pages = [{ pageId: 'source-0', index: 0, viewport }];
    const bytes = await embedOverlays(base, [shape, hidden], pages);
    const render = async (data: Uint8Array) => {
      const task = pdfjs.getDocument({ data: data.slice() });
      try {
        const page = await (await task.promise).getPage(1);
        const view = page.getViewport({ scale: 1 });
        const canvas = createCanvas(view.width, view.height), context = canvas.getContext('2d');
        await page.render({ canvas, canvasContext: context, viewport: view }).promise;
        return (x: number, y: number) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data];
      } finally { await task.destroy(); }
    };
    const pixel = await render(bytes);
    const center = pixel(viewport.width * .4, viewport.height * .35);
    assert.equal(center[0], 255);
    assert.ok(Math.abs(center[1] - 128) <= 1 && Math.abs(center[2] - 128) <= 1, `Wrong fill/opacity/rotation: ${center}`);
    assert.deepEqual(pixel(viewport.width * .2 + 1, viewport.height * .2 + 1), [255, 255, 255, 255], 'Rounded corner must be unfilled');
    const above = { ...shape, id: 'above', fill: '#0000ff', opacity: 1 };
    const stacked = await render(await embedOverlays(base, [shape, above], pages));
    assert.deepEqual(stacked(viewport.width * .4, viewport.height * .35), [0, 0, 255, 255]);
    const restored = await readOverlayPackage(await attachOverlayPackage(bytes, base, [shape, hidden]));
    assert.deepEqual(restored?.objects, [shape, hidden]);
  }
});
