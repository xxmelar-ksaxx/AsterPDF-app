import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { embedSignatures } from '../src/pdf/edit';
import { signatureDrawFromViewport } from '../src/signatures/placement';
import type { PlacedSignature } from '../src/signatures/library';

test('signature placement matches the preview on pages at every rotation', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 500]);
  const task = pdfjs.getDocument({ data: new Uint8Array(await pdf.save()) });
  try {
    const page = await (await task.promise).getPage(1);
    const signature: PlacedSignature = { id: 'placed', pageId: 'source-0', signatureId: 'saved',
      dataUrl: 'data:image/png;base64,AA==', x: 0.2, y: 0.3, width: 0.25, height: 0.1 };
    for (const rotation of [0, 90, 180, 270]) {
      const viewport = page.getViewport({ scale: 1, rotation });
      const draw = signatureDrawFromViewport(signature, viewport, 0);
      const radians = draw.angle * Math.PI / 180;
      const bottomLeft = viewport.convertToViewportPoint(draw.x, draw.y);
      const bottomRight = viewport.convertToViewportPoint(draw.x + draw.width * Math.cos(radians), draw.y + draw.width * Math.sin(radians));
      const topLeft = viewport.convertToViewportPoint(draw.x - draw.height * Math.sin(radians), draw.y + draw.height * Math.cos(radians));
      assert.ok(Math.abs(bottomLeft[0] - signature.x * viewport.width) < 0.01);
      assert.ok(Math.abs(bottomLeft[1] - (signature.y + signature.height) * viewport.height) < 0.01);
      assert.ok(Math.abs(bottomRight[0] - (signature.x + signature.width) * viewport.width) < 0.01);
      assert.ok(Math.abs(topLeft[1] - signature.y * viewport.height) < 0.01);
    }
  } finally { await task.destroy(); }
});

test('drawn signatures save as page strokes while imported signatures remain images', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 500]);
  page.drawText('Searchable contract', { x: 20, y: 400, font: await source.embedFont(StandardFonts.Helvetica) });
  const bytes = new Uint8Array(await source.save());
  const vector = { width: 100, height: 40, strokes: [{ color: '#172333', width: 7,
    points: [{ x: 5, y: 20 }, { x: 45, y: 5 }, { x: 90, y: 25 }] }] };
  const saved = await embedSignatures(bytes, [{ pageIndex: 0, dataUrl: '', vector,
    x: 40, y: 90, width: 150, height: 60, angle: 0 }]);
  const loaded = await PDFDocument.load(saved);
  const imageCount = () => loaded.context.enumerateIndirectObjects().filter(([, object]) =>
    object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image').length;
  assert.equal(imageCount(), 0);
  const task = pdfjs.getDocument({ data: saved.slice() });
  try {
    const parsedPage = await (await task.promise).getPage(1);
    assert.match((await parsedPage.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(''), /Searchable contract/);
    assert.ok((await parsedPage.getOperatorList()).fnArray.includes(pdfjs.OPS.constructPath));
  } finally { await task.destroy(); }

  const png = readFileSync(new URL('./fixtures/pixel.png', import.meta.url)).toString('base64');
  const withImage = await embedSignatures(saved, [{ pageIndex: 0, dataUrl: `data:image/png;base64,${png}`,
    x: 20, y: 20, width: 20, height: 20, angle: 0 }]);
  const imported = await PDFDocument.load(withImage);
  assert.equal(imported.context.enumerateIndirectObjects().filter(([, object]) =>
    object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image').length, 1);
});
