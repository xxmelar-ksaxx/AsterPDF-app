import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addPdfLinks, normalizeLink } from '../src/pdf/links';
import { attachOverlayPackage, readOverlayPackage, type OverlayObject } from '../src/pdf/overlays';

test('selected lines become persistent PDF links without covering the gap between lines', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  const base = await pdf.save();
  const linked = await addPdfLinks(base, [{
    page: 2, text: 'First line\nSecond line', quadPoints: [20, 700, 120, 700, 20, 680, 120, 680, 20, 650, 160, 650, 20, 630, 160, 630]
  }], 'example.com/report?a=1&b=2');
  const task = pdfjs.getDocument({ data: linked.slice() });
  try {
    const reopened = await task.promise;
    assert.equal((await (await reopened.getPage(1)).getAnnotations()).length, 0);
    const annotations = await (await reopened.getPage(2)).getAnnotations();
    assert.equal(annotations.length, 2);
    assert.ok(annotations.every(annotation => annotation.annotationType === 2 && annotation.url === 'https://example.com/report?a=1&b=2'));
    assert.deepEqual(annotations.map(annotation => annotation.rect), [[20, 680, 120, 700], [20, 630, 160, 650]]);
  } finally { await task.destroy(); }
  const object: OverlayObject = { id: 'shape', pageId: 'source-0', kind: 'rectangle', x: .1, y: .1, width: .1, height: .1, color: '#000000', lineWidth: 1 };
  const packageBytes = await attachOverlayPackage(base, base, [object]);
  const externalLink = await addPdfLinks(packageBytes, [{ page: 1, text: 'Link', quadPoints: [10, 30, 40, 30, 10, 10, 40, 10] }], 'https://example.com');
  const restored = await readOverlayPackage(externalLink);
  const parsed = await PDFDocument.load(restored!.base);
  assert.equal(parsed.getPages()[0].node.Annots()?.size(), 1, 'editable restoration retains new links');
  await assert.rejects(addPdfLinks(base, [{ page: 1, text: 'Bad', quadPoints: [NaN, 1] }], 'https://example.com'), /Invalid link selection/);
});

test('only supported URL schemes can be authored', () => {
  assert.equal(normalizeLink(' example.com/path '), 'https://example.com/path');
  assert.equal(normalizeLink('mailto:reader@example.com'), 'mailto:reader@example.com');
  assert.equal(normalizeLink('tel:+966123456789'), 'tel:+966123456789');
  for (const url of ['javascript:alert(1)', 'file:///C:/test.exe', 'data:text/html,hello', 'https://user:password@example.com', 'https://example.com\nbad']) {
    assert.throws(() => normalizeLink(url));
  }
});
