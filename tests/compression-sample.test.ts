import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFRawStream } from 'pdf-lib';
import { compressionSamples } from '../src/pdf/compression-sample';

test('samples image-heavy pages and counts shared resources once', async () => {
  const pdf = await PDFDocument.create();
  const image = (bytes: number) => {
    const stream = pdf.context.stream(new Uint8Array(bytes), { Type: 'XObject', Subtype: 'Image', Width: bytes, Height: 1,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    return pdf.context.register(stream);
  };
  const logo = image(100);
  const photos = Array.from({ length: 4 }, (_, i) => image(2000 + i * 100));
  for (let i = 0; i < 20; i++) {
    const page = pdf.addPage();
    page.node.newXObject('logo', logo);
    if (i % 5 === 2) page.node.newXObject('photo', photos[Math.floor(i / 5)]);
  }
  const input = await PDFDocument.load(await pdf.save());
  const { all, sampled } = compressionSamples(input, new Set());
  assert.equal(all.size, 5);
  for (const ref of [logo, ...photos]) assert.ok(sampled.has(input.context.lookup(ref, PDFRawStream)));
});

test('visits resources on every page but measures at most four pages', async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 16; i++) pdf.addPage().drawText('Text on page ' + (i + 1));
  const input = await PDFDocument.load(await pdf.save());
  const { all, sampled } = compressionSamples(input, new Set());
  assert.equal(all.size, 16);
  assert.equal(sampled.size, 4);
});

test('includes a second image format alongside larger repeated examples of the first', async () => {
  const pdf = await PDFDocument.create();
  let grayRef;
  for (let i = 0; i < 12; i++) {
    const gray = i === 7;
    const length = gray ? 8000 : 12000;
    const stream = pdf.context.stream(new Uint8Array(length), { Type: 'XObject', Subtype: 'Image', Width: gray ? length : length / 3,
      Height: 1, ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8 });
    const ref = pdf.context.register(stream);
    pdf.addPage().node.newXObject('scan', ref);
    if (gray) grayRef = ref;
  }
  const input = await PDFDocument.load(await pdf.save());
  assert.ok(grayRef);
  const { sampled } = compressionSamples(input, new Set());
  assert.ok(sampled.has(input.context.lookup(grayRef, PDFRawStream)));
});
